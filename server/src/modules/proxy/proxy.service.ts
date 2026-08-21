import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ProxyCredentialService } from './proxy-credential.service';
import type { ReportProxyNodeStatusDto } from './proxy.dto';

@Injectable()
export class ProxyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly credentials: ProxyCredentialService,
    private readonly config: ConfigService,
  ) {}

  async listForUser(profileId: number) {
    const [result, credential] = await Promise.all([
      this.db.client
        .from('proxy_nodes')
        .select('id,order_id,status,public_host,tunnel_port,egress_ip,egress_country_code,last_health_at,last_status_change_at,next_rotation_at,expires_at,error_message,metadata,orders!inner(status,expires_at)')
        .eq('profile_id', profileId)
        .neq('status', 'terminated')
        .order('created_at', { ascending: false }),
      // Credentials are per account, not per node: fetch once for the list.
      this.credentials.get(profileId),
    ]);

    const now = Date.now();
    return this.db.unwrap(result, 'Unable to load proxy nodes').map((row: any) => {
      const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
      const orderIsActive = order?.status === 'active' && (!order.expires_at || new Date(order.expires_at).getTime() > now);
      return {
        id: row.id,
        orderId: row.order_id,
        status: row.status,
        host: row.public_host,
        port: row.tunnel_port,
        egressIp: row.egress_ip,
        egressCountryCode: row.egress_country_code,
        lastHealthAt: row.last_health_at,
        lastStatusChangeAt: row.last_status_change_at,
        nextRotationAt: row.next_rotation_at,
        expiresAt: row.expires_at,
        errorMessage: row.error_message ? 'Node provisioning failed. Please contact support.' : null,
        rotationUrl: orderIsActive ? this.rotationPath(row.id, profileId, row.order_id, order.expires_at) : null,
        connection: orderIsActive && credential && row.public_host && row.tunnel_port
          ? { username: credential.username, password: credential.password, protocol: row.metadata?.httpProxyEnabled ? 'HTTP + SOCKS5' : 'SOCKS5' }
          : null,
      };
    });
  }

  async restartForUser(profileId: number, nodeId: number) {
    const result = await this.db.client.rpc('request_proxy_node_restart', {
      target_node_id: nodeId,
      target_profile_id: profileId,
    });
    if (result.error) {
      const message = result.error.message;
      if (message.includes('Proxy node not found')) throw new NotFoundException('Proxy node not found');
      if (message.includes('already in progress') || message.includes('cooling down')) throw new ConflictException(message);
      throw new BadRequestException(message);
    }
    return { jobId: Number(result.data), nodeId, status: 'rotating' as const };
  }

  async restartWithRotationUrl(nodeId: number, token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Rotation URL not found');
    const result = await this.db.client
      .from('proxy_nodes')
      .select('id,profile_id,order_id,orders!inner(status,expires_at)')
      .eq('id', nodeId)
      .maybeSingle();
    const row = this.db.unwrap(result, 'Unable to validate rotation URL') as any;
    const order = Array.isArray(row?.orders) ? row.orders[0] : row?.orders;
    const isActive = order?.status === 'active' && order?.expires_at && new Date(order.expires_at).getTime() > Date.now();
    if (!row || !isActive || !this.matchesRotationToken(token, row.id, row.profile_id, row.order_id, order.expires_at)) {
      throw new NotFoundException('Rotation URL not found');
    }
    return this.restartForUser(Number(row.profile_id), nodeId);
  }

  private rotationPath(nodeId: number, profileId: number, orderId: number, expiresAt: string) {
    return `/api/client/proxy/nodes/${nodeId}/rotate?token=${this.rotationToken(nodeId, profileId, orderId, expiresAt)}`;
  }

  private matchesRotationToken(token: string, nodeId: number, profileId: number, orderId: number, expiresAt: string) {
    const expected = Buffer.from(this.rotationToken(nodeId, profileId, orderId, expiresAt));
    const supplied = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private rotationToken(nodeId: number, profileId: number, orderId: number, expiresAt: string) {
    const secret = String(this.config.get<string>('PROXY_ROTATION_URL_SECRET') || this.config.get<string>('PROXY_SECRET_ENCRYPTION_KEY') || '');
    if (secret.length < 32) throw new BadRequestException('Proxy rotation URLs are not configured');
    return createHmac('sha256', secret)
      .update(`proxy-rotation-url:v1:${nodeId}:${profileId}:${orderId}:${expiresAt}`)
      .digest('base64url');
  }

  async recreateAllForUser(profileId: number, proxyType?: 'datacenter' | 'residential') {
    const result = await this.db.client.rpc('request_all_proxy_nodes_recreation', {
      target_profile_id: profileId,
      target_proxy_type: proxyType || null,
    });
    const rows = this.db.unwrap(result, 'Unable to request proxy node recreation') as Array<{
      scheduled_job_id: number;
      scheduled_node_id: number;
    }>;
    if (rows.length === 0) {
      throw new ConflictException('No active proxy nodes are eligible for recreation');
    }
    return {
      nodeIds: rows.map(row => Number(row.scheduled_node_id)),
      status: 'rotating' as const,
    };
  }

  async reportStatus(nodeId: number, dto: ReportProxyNodeStatusDto) {
    const result = await this.db.client.rpc('report_proxy_node_status', {
      target_node_id: nodeId,
      next_status: dto.status,
      reported_instance_id: dto.instanceId || null,
      reported_egress_ip: dto.egressIp || null,
      reported_public_host: dto.publicHost || null,
      reported_tunnel_port: dto.tunnelPort || null,
      reported_next_rotation_at: dto.nextRotationAt || null,
      reported_health: dto.health || {},
      reported_error_code: dto.errorCode || null,
      reported_error_message: dto.errorMessage || null,
    });
    if (result.error?.message.includes('Proxy node not found')) throw new NotFoundException('Proxy node not found');
    return { eventId: this.db.unwrap(result, 'Unable to update proxy node status') as number };
  }
}
