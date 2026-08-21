import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { createConnection, isIP } from 'node:net';
import { DatabaseService } from '../database/database.service';
import { ProxyCredentialService } from '../proxy/proxy-credential.service';
import { ProxySecretService } from '../proxy/proxy-secret.service';
import { StaticGostService, type StaticGostNode } from './static-gost.service';

const MAX_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const QUOTA_OPTIONS_GB = [1, 3, 5];
const DAYS = [1, 3, 7, 15, 30];

@Injectable()
export class StaticResidentialService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaticResidentialService.name);
  private readonly enabled: boolean;
  private readonly usagePollMs: number;
  private readonly healthFailureThreshold: number;
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
    const configuredThreshold = Number(config.get<string>('STATIC_RESIDENTIAL_HEALTH_FAILURE_THRESHOLD') || 2);
    this.healthFailureThreshold = Number.isInteger(configuredThreshold) ? Math.max(1, Math.min(configuredThreshold, 10)) : 2;
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
      .select('id,status,node_count,quota_bytes,used_bytes,price_per_gb_day,amount,credit_cost,replacement_count,activated_at,expires_at,created_at,static_residential_nodes(id,public_port,status,last_upstream_rotation_at,static_residential_proxies(host))')
      .eq('profile_id', profileId).order('created_at', { ascending: false });
    const credential = await this.credentials.get(profileId);
    const rows = this.db.unwrap(ordersResult, 'Unable to load static residential orders') as any[];
    return rows.map(row => ({
      id: row.id, status: row.status, nodeCount: row.node_count, quotaBytes: Number(row.quota_bytes), usedBytes: Number(row.used_bytes),
      quotaGb: Number(row.quota_bytes) / (1024 * 1024 * 1024), pricePerGbDay: Number(row.price_per_gb_day), amount: Number(row.amount), creditCost: Number(row.credit_cost),
      replacementCount: Number(row.replacement_count || 0), replacementsRemaining: Math.max(0, 5 - Number(row.replacement_count || 0)),
      activatedAt: row.activated_at, expiresAt: row.expires_at, createdAt: row.created_at,
      nodes: (row.static_residential_nodes || []).sort((a: any, b: any) => a.public_port - b.public_port).map((node: any) => ({
        id: node.id, port: node.public_port, status: node.status, lastReplacedAt: node.last_upstream_rotation_at,
        egressIp: (Array.isArray(node.static_residential_proxies) ? node.static_residential_proxies[0] : node.static_residential_proxies)?.host || null,
        connection: credential ? { host: process.env.GOST_PUBLIC_HOST || process.env.GOST_MASTER_HOST || '', port: node.public_port, username: credential.username, password: credential.password, protocol: 'HTTP + SOCKS5' } : null,
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
    const result = await this.db.client.rpc('extend_static_residential_order_v2', { target_profile_id: profileId, target_order_id: orderId, requested_days: rentalDays });
    if (result.error) throw new BadRequestException(result.error.message);
    await this.provisionOrder(orderId);
    return (await this.listForUser(profileId)).find(order => order.id === orderId);
  }

  async replaceNode(profileId: number, orderId: number, nodeId: number) {
    if (!this.enabled) throw new BadRequestException('Static residential proxy is not enabled');
    const result = await this.db.client.rpc('replace_static_residential_node_v3', {
      target_profile_id: profileId, target_order_id: orderId, target_node_id: nodeId,
    });
    if (result.error) throw new BadRequestException(result.error.message);
    try {
      await this.provisionOrder(orderId);
    } catch (error: any) {
      // The allocation transaction has completed safely. Keep the new
      // assignment and let reconciliation publish it when GOST recovers.
      this.logger.warn(`Static residential node ${nodeId} replacement is waiting for control plane recovery: ${error?.message || error}`);
    }
    return (await this.listForUser(profileId)).find(order => order.id === orderId);
  }

  async exportConnections(profileId: number) {
    const orders = await this.listForUser(profileId);
    const connections = orders.filter(order => order.status === 'active' && new Date(order.expiresAt) > new Date()).flatMap(order => order.nodes)
      .map(node => node.connection).filter(Boolean) as Array<{ host: string; port: number; username: string; password: string }>;
    const encode = encodeURIComponent;
    const content = connections.flatMap(item => {
      const endpoint = `${encode(item.username)}:${encode(item.password)}@${item.host}:${item.port}`;
      return [`socks5://${endpoint}`, `http://${endpoint}`];
    }).join('\n');
    return { filename: 'nodenesia-static-residential-http-socks5.txt', content: content ? `${content}\n` : '', count: connections.length };
  }

  async adminInventory(requestedPage?: number, requestedPageSize?: number) {
    const page = Number.isInteger(requestedPage) ? Math.max(1, Math.min(requestedPage!, 10_000)) : 1;
    const pageSize = Number.isInteger(requestedPageSize) ? Math.max(1, Math.min(requestedPageSize!, 50)) : 5;
    const from = (page - 1) * pageSize;
    const [inventory, availability] = await Promise.all([
      this.db.client.from('static_residential_proxies')
        .select('id,label,host,port,username,status,assigned_order_id,health_failure_count,last_health_checked_at,last_health_error,created_at,updated_at', { count: 'exact' })
        .order('created_at', { ascending: false }).range(from, from + pageSize - 1),
      this.db.client.from('static_residential_proxies').select('id', { count: 'exact', head: true }).eq('status', 'available'),
    ]);
    const items = this.db.unwrap(inventory, 'Unable to load static residential inventory').map((item: any) => ({ ...item, username: this.mask(item.username) }));
    if (availability.error) throw new BadRequestException('Unable to load static residential inventory availability');
    const total = inventory.count || 0;
    return { items, total, available: availability.count || 0, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
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
    // Keep the final occurrence from a TXT file. PostgreSQL cannot upsert the
    // same conflict target twice in one statement.
    const unique = [...new Map(parsed.map(proxy => [`${proxy.host}\u0000${proxy.port}\u0000${proxy.username}`, proxy])).values()];
    const rows = unique.map(proxy => {
      const encrypted = this.secrets.encrypt(proxy.password);
      return {
        ...(label ? { label } : {}), host: proxy.host, port: proxy.port, username: proxy.username,
        password_ciphertext: encrypted.ciphertext, password_iv: encrypted.iv, password_tag: encrypted.tag,
        status: 'available', health_failure_count: 0, last_health_checked_at: null, last_health_error: null,
      };
    });
    const result = await this.db.client.from('static_residential_proxies').upsert(rows, { onConflict: 'host,port,username' }).select('id');
    const ids = this.db.unwrap(result, 'Unable to import static residential proxies').map((row: any) => Number(row.id));
    const affectedResult = await this.db.client.from('static_residential_nodes').select('order_id')
      .in('upstream_proxy_id', ids).eq('status', 'active');
    const affectedOrders = [...new Set(this.db.unwrap(affectedResult, 'Unable to find static residential orders for updated upstreams').map((row: any) => Number(row.order_id)))];
    for (const orderId of affectedOrders) await this.provisionOrder(orderId);
    return { createdOrUpdated: ids.length, duplicatesInFile: parsed.length - unique.length, reconfiguredOrders: affectedOrders.length };
  }

  async checkInventoryStatus() {
    const result = await this.db.client.from('static_residential_proxies')
      .select('id,host,port,username,password_ciphertext,password_iv,password_tag,health_failure_count')
      .neq('status', 'disabled');
    const proxies = this.db.unwrap(result, 'Unable to load static residential inventory') as any[];
    const failed: Array<{ id: number; error: string }> = [];
    const healthyIds: number[] = [];
    let healthy = 0;
    const concurrency = 10;
    for (let offset = 0; offset < proxies.length; offset += concurrency) {
      const batch = proxies.slice(offset, offset + concurrency);
      const outcomes = await Promise.all(batch.map(async proxy => {
        try {
          if (!this.isPublicAddress(proxy.host)) throw new Error('non-public upstream address');
          const password = this.secrets.decrypt({ ciphertext: proxy.password_ciphertext, iv: proxy.password_iv, tag: proxy.password_tag });
          await this.verifySocks5(proxy.host, Number(proxy.port), proxy.username, password);
          healthyIds.push(Number(proxy.id));
          return true;
        } catch (error: any) {
          const message = String(error?.message || error).slice(0, 500);
          this.logger.warn(`Static residential upstream #${proxy.id} failed health check: ${message}`);
          failed.push({ id: Number(proxy.id), error: message });
          return false;
        }
      }));
      healthy += outcomes.filter(Boolean).length;
    }
    let nodesSuspended = 0;
    const checkedAt = new Date().toISOString();
    if (healthyIds.length) {
      const update = await this.db.client.from('static_residential_proxies')
        .update({ health_failure_count: 0, last_health_checked_at: checkedAt, last_health_error: null, updated_at: checkedAt }).in('id', healthyIds);
      this.db.unwrap(update, 'Unable to record healthy static residential proxies');
    }
    const failedIds = failed.filter(proxy => Number(proxy.id) > 0).map(proxy => proxy.id);
    const disableIds = failed.filter(proxy => {
      const inventory = proxies.find(item => Number(item.id) === proxy.id);
      return Number(inventory?.health_failure_count || 0) + 1 >= this.healthFailureThreshold;
    }).map(proxy => proxy.id);
    await Promise.all(failed.map(async proxy => {
      const update = await this.db.client.from('static_residential_proxies').update({
        health_failure_count: (Number(proxies.find(item => Number(item.id) === proxy.id)?.health_failure_count || 0) + 1),
        last_health_checked_at: checkedAt,
        last_health_error: proxy.error,
        updated_at: checkedAt,
      }).eq('id', proxy.id);
      this.db.unwrap(update, 'Unable to record failed static residential proxy');
    }));
    if (disableIds.length) {
      const update = await this.db.client.from('static_residential_proxies')
        .update({ status: 'disabled', updated_at: new Date().toISOString() }).in('id', disableIds);
      this.db.unwrap(update, 'Unable to disable unhealthy static residential proxies');
      const nodesResult = await this.db.client.from('static_residential_nodes').select('id,order_id,service_name')
        .in('upstream_proxy_id', disableIds).eq('status', 'active');
      const nodes = this.db.unwrap(nodesResult, 'Unable to find active static nodes using unhealthy upstreams') as Array<{ id: number; order_id: number; service_name: string }>;
      await this.gost.removeNodes(nodes.map(node => ({ id: node.id, serviceName: node.service_name })));
      if (nodes.length) {
        const suspended = await this.db.client.from('static_residential_nodes').update({ status: 'suspended', updated_at: checkedAt }).in('id', nodes.map(node => node.id));
        this.db.unwrap(suspended, 'Unable to suspend unhealthy static residential nodes');
        nodesSuspended = nodes.length;
      }
    }
    return { checked: proxies.length, healthy, failed: failedIds.length, disabled: disableIds.length, nodesSuspended, failureThreshold: this.healthFailureThreshold };
  }

  async enableInventoryProxy(id: number) {
    const result = await this.db.client.from('static_residential_proxies').update({
      status: 'available', health_failure_count: 0, last_health_error: null, updated_at: new Date().toISOString(),
    }).eq('id', id).eq('status', 'disabled').select('id').maybeSingle();
    const row = this.db.unwrap(result, 'Unable to re-enable static residential proxy');
    if (!row) throw new NotFoundException('Disabled static residential proxy not found');
    return { id: Number(row.id), status: 'available' };
  }

  async pricing() { return { pricePerGbDay: await this.pricePerGbDay(), fixedNodeCount: 5, quotaOptionsGb: QUOTA_OPTIONS_GB }; }
  async updatePricing(pricePerGbDay: number) {
    const result = await this.db.client.from('app_settings').upsert({ key: 'static_residential_price_per_gb_day', value: pricePerGbDay }, { onConflict: 'key' });
    this.db.unwrap(result, 'Unable to update static residential price'); return this.pricing();
  }

  private async reconcile() {
    if (this.reconciling) return; this.reconciling = true;
    try {
      const now = new Date().toISOString();
      const ordersResult = await this.db.client.from('static_residential_orders').select('id,status,expires_at,quota_bytes,used_bytes,static_residential_nodes(id,service_name,upstream_proxy_id,public_port,status,metric_bytes_observed,static_residential_proxies(host,port,username,password_ciphertext,password_iv,password_tag))').in('status', ['active', 'quota_exceeded', 'expired']);
      const orders = this.db.unwrap(ordersResult, 'Unable to reconcile static residential orders') as any[];
      const usage = await this.gost.usageByService();
      for (const order of orders) {
        const nodes = order.static_residential_nodes || [];
        if (order.status === 'active' && new Date(order.expires_at) <= new Date()) { await this.stopOrder(order.id, nodes, 'expired'); continue; }
        if (order.status !== 'active') continue;
        // A service emits transfer counters only after it carries traffic, so
        // metrics cannot be used as a listener-health probe. Recreating an
        // otherwise healthy service resets its Prometheus counter to zero.
        const activeNodes = nodes.filter((node: any) => node.status === 'active');
        if (!(await this.gost.hasServices(activeNodes.map((node: any) => node.service_name)))) {
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
      }
    } catch (error: any) { this.logger.error(`Static residential reconciliation failed: ${error?.message || error}`); }
    finally { this.reconciling = false; }
  }

  private async provisionOrder(orderId: number) {
    const result = await this.db.client.from('static_residential_orders').select('id,activated_at,expires_at,status,static_residential_nodes(id,public_port,service_name,status,static_residential_proxies(host,port,username,password_ciphertext,password_iv,password_tag))').eq('id', orderId).maybeSingle();
    const order: any = this.db.unwrap(result, 'Unable to load static residential order');
    if (!order) throw new NotFoundException('Static residential order not found');
    const profileResult = await this.db.client.from('static_residential_orders').select('profile_id').eq('id', orderId).single();
    const profileId = Number(this.db.unwrap(profileResult, 'Unable to load static residential account').profile_id);
    const credential = await this.credentials.getOrCreate(profileId);
    const activeNodes = (order.static_residential_nodes || []).filter((node: any) => node.status === 'active');
    await this.gost.upsertOrder(activeNodes.map((node: any) => this.gostNode(node, order, credential)));
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
  private async verifySocks5(host: string, port: number, username: string, password: string) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid upstream port');
    const usernameBytes = Buffer.from(username);
    const passwordBytes = Buffer.from(password);
    if (!usernameBytes.length || !passwordBytes.length || usernameBytes.length > 255 || passwordBytes.length > 255) throw new Error('invalid SOCKS5 credentials');
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port });
      let buffer = Buffer.alloc(0);
      let phase: 'method' | 'auth' | 'connect' = 'method';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        error ? reject(error) : resolve();
      };
      socket.setTimeout(8_000);
      socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x02])));
      socket.on('timeout', () => finish(new Error('connection timed out')));
      socket.on('error', error => finish(error));
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (phase === 'method' && buffer.length >= 2) {
          const [version, method] = [buffer[0], buffer[1]];
          buffer = buffer.subarray(2);
          if (version !== 0x05 || method !== 0x02) return finish(new Error('SOCKS5 username/password authentication was rejected'));
          phase = 'auth';
          socket.write(Buffer.concat([Buffer.from([0x01, usernameBytes.length]), usernameBytes, Buffer.from([passwordBytes.length]), passwordBytes]));
        }
        if (phase === 'auth' && buffer.length >= 2) {
          const [version, status] = [buffer[0], buffer[1]];
          if (version !== 0x01 || status !== 0x00) return finish(new Error('SOCKS5 credentials were rejected'));
          buffer = buffer.subarray(2);
          phase = 'connect';
          socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0, 80]));
        }
        if (phase === 'connect' && buffer.length >= 2) {
          const [version, status] = [buffer[0], buffer[1]];
          if (version !== 0x05 || status !== 0x00) return finish(new Error(`SOCKS5 egress CONNECT failed (${status ?? 'unknown'})`));
          finish();
        }
      });
    });
  }
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
