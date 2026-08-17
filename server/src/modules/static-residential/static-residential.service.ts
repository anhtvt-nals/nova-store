import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DatabaseService } from '../database/database.service';
import { ProxyCredentialService } from '../proxy/proxy-credential.service';
import { ProxySecretService } from '../proxy/proxy-secret.service';
import { StaticGostService, type StaticGostNode } from './static-gost.service';

const MAX_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const QUOTA_OPTIONS_GB = [1, 3, 5];
const ROTATION_MS = 60 * 60 * 1000;
const DAYS = [1, 3, 7, 15, 30];

@Injectable()
export class StaticResidentialService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaticResidentialService.name);
  private readonly enabled: boolean;
  private readonly usagePollMs: number;
  private timer?: NodeJS.Timeout;
  private reconciling = false;
  private readonly repairAttemptAt = new Map<number, number>();

  constructor(
    private readonly db: DatabaseService,
    private readonly credentials: ProxyCredentialService,
    private readonly secrets: ProxySecretService,
    private readonly gost: StaticGostService,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('STATIC_RESIDENTIAL_ENABLED') === 'true';
    const configuredPoll = Number(config.get<string>('STATIC_GOST_USAGE_POLL_MS') || 1_000);
    this.usagePollMs = Number.isFinite(configuredPoll) ? Math.max(500, Math.min(configuredPoll, 5_000)) : 1_000;
  }

  onModuleInit() {
    if (!this.enabled) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.usagePollMs);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async quote(rentalDays: number, quotaGb: number) {
    this.validateDays(rentalDays);
    this.validateQuotaGb(quotaGb);
    const price = await this.pricePerGbDay();
    const creditRate = await this.creditRate();
    const amount = Number((price * quotaGb * rentalDays).toFixed(4));
    const available = await this.availableCapacity();
    return { nodeCount: 5, quotaBytes: quotaGb * 1024 * 1024 * 1024, quotaGb, rentalDays, pricePerGbDay: price, amount,
      creditCost: Number((Math.ceil(amount * creditRate * 100) / 100).toFixed(2)), availableNodes: available, canFulfill: available >= 5 };
  }

  async listForUser(profileId: number) {
    const ordersResult = await this.db.client.from('static_residential_orders')
      .select('id,status,node_count,quota_bytes,used_bytes,price_per_gb_day,amount,credit_cost,activated_at,expires_at,created_at,static_residential_nodes(id,public_port,status,next_upstream_rotation_at)')
      .eq('profile_id', profileId).order('created_at', { ascending: false });
    const credential = await this.credentials.get(profileId);
    const rows = this.db.unwrap(ordersResult, 'Unable to load static residential orders') as any[];
    return rows.map(row => ({
      id: row.id, status: row.status, nodeCount: row.node_count, quotaBytes: Number(row.quota_bytes), usedBytes: Number(row.used_bytes),
      quotaGb: Number(row.quota_bytes) / (1024 * 1024 * 1024), pricePerGbDay: Number(row.price_per_gb_day), amount: Number(row.amount), creditCost: Number(row.credit_cost),
      activatedAt: row.activated_at, expiresAt: row.expires_at, createdAt: row.created_at,
      nodes: (row.static_residential_nodes || []).sort((a: any, b: any) => a.public_port - b.public_port).map((node: any) => ({
        id: node.id, port: node.public_port, status: node.status, nextRotationAt: node.next_upstream_rotation_at,
        connection: credential ? { host: process.env.GOST_PUBLIC_HOST || process.env.GOST_MASTER_HOST || '', port: node.public_port, username: credential.username, password: credential.password, protocol: 'SOCKS5' } : null,
      })),
    }));
  }

  async create(profileId: number, rentalDays: number, quotaGb: number) {
    if (!this.enabled) throw new BadRequestException('Static residential proxy is not enabled');
    this.validateDays(rentalDays);
    this.validateQuotaGb(quotaGb);
    const result = await this.db.client.rpc('create_static_residential_order_v2', { target_profile_id: profileId, requested_days: rentalDays, requested_quota_gb: quotaGb });
    if (result.error) throw new BadRequestException(result.error.message);
    const orderId = Number(result.data);
    try { await this.provisionOrder(orderId); }
    catch (error: any) {
      // Keep the allocated order active. The reconciler will provision it as
      // soon as the loopback control plane recovers; suspending here stranded
      // paid orders and their five assigned upstreams indefinitely.
      this.logger.error(`Unable to provision static residential order ${orderId}: ${error?.message || error}`);
      throw new BadRequestException(`Order #${orderId} is pending while the proxy control plane reconnects. Do not place another order; it will retry automatically.`);
    }
    return (await this.listForUser(profileId)).find(order => order.id === orderId);
  }

  async extend(profileId: number, orderId: number, rentalDays: number) {
    this.validateDays(rentalDays);
    const result = await this.db.client.rpc('extend_static_residential_order', { target_profile_id: profileId, target_order_id: orderId, requested_days: rentalDays });
    if (result.error) throw new BadRequestException(result.error.message);
    await this.provisionOrder(orderId);
    return (await this.listForUser(profileId)).find(order => order.id === orderId);
  }

  async exportConnections(profileId: number) {
    const orders = await this.listForUser(profileId);
    const connections = orders.filter(order => order.status === 'active' && new Date(order.expiresAt) > new Date()).flatMap(order => order.nodes)
      .map(node => node.connection).filter(Boolean) as Array<{ host: string; port: number; username: string; password: string }>;
    const encode = encodeURIComponent;
    const content = connections.map(item => `socks5://${encode(item.username)}:${encode(item.password)}@${item.host}:${item.port}`).join('\n');
    return { filename: 'nodenesia-static-residential-socks5.txt', content: content ? `${content}\n` : '', count: connections.length };
  }

  async adminInventory() {
    const result = await this.db.client.from('static_residential_proxies').select('id,label,host,port,username,status,assigned_order_id,created_at,updated_at').order('created_at', { ascending: false });
    return this.db.unwrap(result, 'Unable to load static residential inventory').map((item: any) => ({ ...item, username: this.mask(item.username) }));
  }

  async importInventory(content: string, label?: string) {
    const parsed: Array<{ host: string; port: number; username: string; password: string }> = [];
    const errors: string[] = [];
    for (const [index, raw] of content.split(/\r?\n/).entries()) {
      const value = raw.trim(); if (!value || value.startsWith('#')) continue;
      try {
        const url = new URL(value);
        if (url.protocol !== 'socks5:' || !url.hostname || !url.port || !url.username || !url.password) throw new Error('expected socks5://user:pass@host:port');
        const host = await this.resolvePublicHost(url.hostname);
        parsed.push({ host, port: Number(url.port), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
      } catch { errors.push(`Line ${index + 1}`); }
    }
    if (!parsed.length) throw new BadRequestException('No valid SOCKS5 proxy was found in the import file');
    if (errors.length) throw new BadRequestException(`Invalid SOCKS5 entries: ${errors.slice(0, 10).join(', ')}`);
    const rows = parsed.map(proxy => {
      const encrypted = this.secrets.encrypt(proxy.password);
      return { label: label || null, host: proxy.host, port: proxy.port, username: proxy.username, password_ciphertext: encrypted.ciphertext, password_iv: encrypted.iv, password_tag: encrypted.tag };
    });
    const result = await this.db.client.from('static_residential_proxies').upsert(rows, { onConflict: 'host,port,username', ignoreDuplicates: true }).select('id');
    return { imported: this.db.unwrap(result, 'Unable to import static residential proxies').length, skipped: parsed.length - (result.data?.length || 0) };
  }

  async pricing() { return { pricePerGbDay: await this.pricePerGbDay(), fixedNodeCount: 5, fixedQuotaGb: 5 }; }
  async updatePricing(pricePerGbDay: number) {
    const result = await this.db.client.from('app_settings').upsert({ key: 'static_residential_price_per_gb_day', value: pricePerGbDay }, { onConflict: 'key' });
    this.db.unwrap(result, 'Unable to update static residential price'); return this.pricing();
  }

  private async reconcile() {
    if (this.reconciling) return; this.reconciling = true;
    try {
      const now = new Date().toISOString();
      const ordersResult = await this.db.client.from('static_residential_orders').select('id,status,expires_at,quota_bytes,used_bytes,static_residential_nodes(id,service_name,upstream_proxy_id,public_port,status,next_upstream_rotation_at,metric_bytes_observed,static_residential_proxies(host,port,username,password_ciphertext,password_iv,password_tag))').in('status', ['active', 'quota_exceeded', 'expired']);
      const orders = this.db.unwrap(ordersResult, 'Unable to reconcile static residential orders') as any[];
      const usage = await this.gost.usageByService();
      for (const order of orders) {
        const nodes = order.static_residential_nodes || [];
        if (order.status === 'active' && new Date(order.expires_at) <= new Date()) { await this.stopOrder(order.id, nodes, 'expired'); continue; }
        if (order.status !== 'active') continue;
        // A service emits transfer counters only after it carries traffic, so
        // metrics cannot be used as a listener-health probe. Recreating an
        // otherwise healthy service resets its Prometheus counter to zero.
        if (!(await this.gost.hasServices(nodes.map((node: any) => node.service_name)))) {
          const lastAttempt = this.repairAttemptAt.get(order.id) || 0;
          if (Date.now() - lastAttempt >= 10_000) {
            this.repairAttemptAt.set(order.id, Date.now());
            try {
              await this.provisionOrder(order.id);
              this.logger.log(`Restored static residential services for order ${order.id}`);
            } catch (error: any) {
              this.logger.warn(`Static residential order ${order.id} is waiting for control plane recovery: ${error?.message || error}`);
            }
          }
          continue;
        }
        let delta = 0;
        for (const node of nodes) {
          const observed = usage.get(node.service_name) || 0;
          const previous = Number(node.metric_bytes_observed || 0);
          // Prometheus counters reset when GOST restarts. In that case the new
          // counter is additional traffic, not a reason to erase prior usage.
          const increment = observed >= previous ? observed - previous : observed;
          if (increment > 0 || observed !== previous) {
            delta += increment;
            await this.db.client.from('static_residential_nodes').update({ metric_bytes_observed: Math.floor(observed), updated_at: now }).eq('id', node.id);
          }
        }
        const quotaBytes = Number(order.quota_bytes || MAX_QUOTA_BYTES);
        const used = Math.min(quotaBytes, Number(order.used_bytes || 0) + delta);
        if (delta > 0) await this.db.client.from('static_residential_orders').update({ used_bytes: used, updated_at: now }).eq('id', order.id);
        if (used >= Number(order.quota_bytes || MAX_QUOTA_BYTES)) { await this.stopOrder(order.id, nodes, 'quota_exceeded'); continue; }
        const due = nodes.filter((node: any) => node.status === 'active' && new Date(node.next_upstream_rotation_at) <= new Date());
        for (const node of due) await this.rotateNode(node.id, order.id);
      }
    } catch (error: any) { this.logger.error(`Static residential reconciliation failed: ${error?.message || error}`); }
    finally { this.reconciling = false; }
  }

  private async provisionOrder(orderId: number) {
    const result = await this.db.client.from('static_residential_orders').select('id,activated_at,expires_at,status,static_residential_nodes(id,public_port,service_name,static_residential_proxies(host,port,username,password_ciphertext,password_iv,password_tag))').eq('id', orderId).maybeSingle();
    const order: any = this.db.unwrap(result, 'Unable to load static residential order');
    if (!order) throw new NotFoundException('Static residential order not found');
    const profileResult = await this.db.client.from('static_residential_orders').select('profile_id').eq('id', orderId).single();
    const profileId = Number(this.db.unwrap(profileResult, 'Unable to load static residential account').profile_id);
    const credential = await this.credentials.getOrCreate(profileId);
    await this.gost.upsertOrder((order.static_residential_nodes || []).map((node: any) => this.gostNode(node, order, credential)));
  }

  private async rotateNode(nodeId: number, orderId: number) {
    const result = await this.db.client.rpc('rotate_static_residential_node_v2', { target_node_id: nodeId });
    if (result.error) { this.logger.warn(`Static node ${nodeId} rotation deferred: ${result.error.message}`); return; }
    await this.provisionOrder(orderId);
  }

  private async stopOrder(orderId: number, nodes: any[], status: 'expired' | 'quota_exceeded') {
    await this.gost.removeOrder(orderId, nodes.map(node => ({ id: node.id, serviceName: node.service_name })));
    await this.db.client.from('static_residential_nodes').update({ status, updated_at: new Date().toISOString() }).eq('order_id', orderId);
    await this.db.client.from('static_residential_orders').update({ status, updated_at: new Date().toISOString() }).eq('id', orderId);
  }

  private gostNode(node: any, order: any, credential: { username: string; password: string }): StaticGostNode {
    const proxy = Array.isArray(node.static_residential_proxies) ? node.static_residential_proxies[0] : node.static_residential_proxies;
    if (!this.isPublicAddress(proxy.host)) throw new BadRequestException('Static residential inventory contains an unvalidated upstream address; re-import it');
    return { id: node.id, orderId: order.id, port: node.public_port, serviceName: node.service_name, host: proxy.host, upstreamPort: proxy.port,
      upstreamUsername: proxy.username, upstreamPassword: this.secrets.decrypt({ ciphertext: proxy.password_ciphertext, iv: proxy.password_iv, tag: proxy.password_tag }),
      username: credential.username, password: credential.password, activatedAt: order.activated_at, expiresAt: order.expires_at };
  }
  private async availableCapacity() { const result = await this.db.client.from('static_residential_proxies').select('id', { count: 'exact', head: true }).eq('status', 'available'); return Number(result.count || 0); }
  private async pricePerGbDay() { const result = await this.db.client.from('app_settings').select('value').eq('key', 'static_residential_price_per_gb_day').maybeSingle(); return Number(this.db.unwrap(result, 'Unable to load static residential price')?.value || 0); }
  private async creditRate() { const result = await this.db.client.from('app_settings').select('value').eq('key', 'credits_per_usd').maybeSingle(); return Number(this.db.unwrap(result, 'Unable to load credit conversion')?.value || 100); }
  private validateDays(value: number) { if (!DAYS.includes(value)) throw new BadRequestException('Rental days must be one of: 1, 3, 7, 15, or 30'); }
  private validateQuotaGb(value: number) { if (!QUOTA_OPTIONS_GB.includes(value)) throw new BadRequestException('Quota must be 1GB, 3GB, or 5GB'); }
  private mask(value: string) { return value.length <= 3 ? '***' : `${value.slice(0, 2)}***${value.slice(-1)}`; }
  private async resolvePublicHost(rawHost: string) {
    const host = rawHost.replace(/^\[(.*)\]$/, '$1').toLowerCase();
    let address = host;
    if (!isIP(host)) {
      try { address = (await lookup(host, { family: 0, verbatim: true })).address; }
      catch { throw new BadRequestException(`Upstream hostname ${host} cannot be resolved`); }
    }
    if (!this.isPublicAddress(address)) throw new BadRequestException(`Upstream ${host} resolves to a non-public address and was rejected`);
    return address;
  }
  private isPublicAddress(address: string) {
    const family = isIP(address);
    if (family === 4) {
      const [a, b] = address.split('.').map(Number);
      return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)));
    }
    if (family === 6) {
      const normalized = address.toLowerCase();
      return normalized !== '::' && normalized !== '::1' && !/^fe[89ab]/.test(normalized) && !normalized.startsWith('fc') && !normalized.startsWith('fd') && !normalized.startsWith('::ffff:127.') && !normalized.startsWith('::ffff:10.') && !normalized.startsWith('::ffff:192.168.');
    }
    return false;
  }
}
