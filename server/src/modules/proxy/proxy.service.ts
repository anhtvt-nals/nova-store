import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { ReportProxyNodeStatusDto } from './proxy.dto';

@Injectable()
export class ProxyService {
  constructor(private readonly db: DatabaseService) {}

  async listForUser(profileId: number) {
    const result = await this.db.client
      .from('proxy_nodes')
      .select('id,order_id,status,public_host,tunnel_port,egress_ip,last_health_at,last_status_change_at,next_rotation_at,expires_at,error_message')
      .eq('profile_id', profileId)
      .neq('status', 'terminated')
      .order('created_at', { ascending: false });

    return this.db.unwrap(result, 'Unable to load proxy nodes').map((row: any) => ({
        id: row.id,
        orderId: row.order_id,
        status: row.status,
        host: row.public_host,
        port: row.tunnel_port,
        egressIp: row.egress_ip,
        lastHealthAt: row.last_health_at,
        lastStatusChangeAt: row.last_status_change_at,
        nextRotationAt: row.next_rotation_at,
        expiresAt: row.expires_at,
        errorMessage: row.error_message ? 'Node provisioning failed. Please contact support.' : null,
      }));
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
