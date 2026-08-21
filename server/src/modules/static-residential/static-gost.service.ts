import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIP } from 'node:net';

export interface StaticGostNode {
  id: number;
  orderId: number;
  port: number;
  serviceName: string;
  host: string;
  upstreamPort: number;
  upstreamUsername: string;
  upstreamPassword: string;
  username: string;
  password: string;
  activatedAt: string;
  expiresAt: string;
}

@Injectable()
export class StaticGostService {
  private readonly apiUrl: string;
  private readonly metricsUrl: string;

  constructor(config: ConfigService) {
    const address = config.get<string>('STATIC_GOST_API_ADDR') || '127.0.0.1:18081';
    const parsed = new URL(`http://${address}`);
    if (!['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname) || !parsed.port || (parsed.hostname !== 'localhost' && !isIP(parsed.hostname))) {
      throw new Error('STATIC_GOST_API_ADDR must be a loopback IP address and port');
    }
    this.apiUrl = `${parsed.origin}/config`;
    const metricsAddress = config.get<string>('STATIC_GOST_METRICS_ADDR') || '127.0.0.1:19000';
    const metrics = new URL(`http://${metricsAddress}/metrics`);
    if (!['127.0.0.1', '::1', 'localhost'].includes(metrics.hostname) || !metrics.port) {
      throw new Error('STATIC_GOST_METRICS_ADDR must be a loopback IP address and port');
    }
    this.metricsUrl = metrics.toString();
  }

  async upsertOrder(nodes: StaticGostNode[]) {
    if (!nodes.length) return;
    // GOST applies dynamic chain configuration asynchronously. Creating a
    // service in the same turn can therefore fail with "chain ... not found".
    // Build and verify all chains first, then attach listeners.
    for (const node of nodes) await this.upsertChain(node);
    for (const node of nodes) await this.waitForChain(this.chainName(node.id));
    for (const node of nodes) await this.upsertService(node);
  }

  async upsertNode(node: StaticGostNode) {
    await this.upsertChain(node);
    await this.waitForChain(this.chainName(node.id));
    await this.upsertService(node);
  }

  private async upsertChain(node: StaticGostNode) {
    const chainName = this.chainName(node.id);
    await this.put(`/chains/${chainName}`, {
      name: chainName,
      hops: [{ name: 'upstream', nodes: [{ name: 'residential', addr: this.address(node.host, node.upstreamPort),
        connector: { type: 'socks5', auth: { username: node.upstreamUsername, password: node.upstreamPassword } }, dialer: { type: 'tcp' } }] }],
    }, true);
  }

  private async upsertService(node: StaticGostNode) {
    const chainName = this.chainName(node.id);
    await this.put(`/services/${node.serviceName}`, {
      name: node.serviceName, addr: `:${node.port}`, limiter: 'static-bandwidth', climiter: 'static-connections', rlimiter: 'static-requests',
      // A single public endpoint accepts authenticated HTTP proxy and SOCKS5.
      // The private upstream chain remains SOCKS5.
      handler: { type: 'auto', auth: { username: node.username, password: node.password }, chain: chainName }, listener: { type: 'tcp' },
    }, true);
  }

  private async waitForChain(chainName: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.request(`/chains/${chainName}`);
        return;
      } catch (error: any) {
        lastError = error;
        if (error?.status !== 404 || attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async removeOrder(orderId: number, nodes: Array<{ id: number; serviceName: string }>) {
    await Promise.all(nodes.flatMap(node => [this.remove(`/services/${node.serviceName}`), this.remove(`/chains/${this.chainName(node.id)}`)]));
    void orderId;
  }

  async usageByService() {
    let response: Response;
    try { response = await fetch(this.metricsUrl, { signal: AbortSignal.timeout(3_000) }); }
    catch { throw new ServiceUnavailableException('Static GOST metrics are unavailable'); }
    if (!response.ok) throw new ServiceUnavailableException(`Static GOST metrics returned ${response.status}`);
    const totals = new Map<string, number>();
    const pattern = /^gost_service_transfer_(?:input|output)_bytes_total\{([^}]*)\}\s+([0-9.eE+-]+)$/;
    for (const line of (await response.text()).split('\n')) {
      const match = line.match(pattern);
      if (!match) continue;
      const service = /(?:^|,)service="((?:\\.|[^"])*)"/.exec(match[1])?.[1];
      const bytes = Number(match[2]);
      if (!service || !Number.isFinite(bytes) || bytes < 0) continue;
      totals.set(service.replace(/\\"/g, '"').replace(/\\\\/g, '\\'), (totals.get(service) || 0) + bytes);
    }
    return totals;
  }

  async hasServices(serviceNames: string[]) {
    for (const serviceName of serviceNames) {
      try {
        const service = await this.request(`/services/${serviceName}`) as any;
        // Existing services created before HTTP support used a SOCKS5-only
        // handler. Treat them as stale so reconciliation rewrites them once.
        const handler = service?.handler || service?.service?.handler;
        if (handler?.type !== 'auto') return false;
      } catch (error: any) {
        if (error?.status === 404 || /\bnot found\b/i.test(String(error?.message))) return false;
        throw error;
      }
    }
    return true;
  }

  private chainName(nodeId: number) { return `static-residential-node-${nodeId}`; }
  private address(host: string, port: number) { return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`; }

  private async put(path: string, body: unknown, allowCreate: boolean) {
    try { await this.request(path, { method: 'PUT', body: JSON.stringify(body) }); }
    catch (error: any) {
      // GOST 3.2.x returns either HTTP 404 or an API error whose message is
      // "<object> ... not found", depending on the API build.
      if (allowCreate && (error?.status === 404 || /\bnot found\b/i.test(String(error?.message)))) {
        const base = path.replace(/^\/(services|chains|quotas)\/[^/]+$/, '/$1');
        await this.request(base, { method: 'POST', body: JSON.stringify(body) });
        return;
      }
      throw error;
    }
  }

  private async remove(path: string) {
    try { await this.request(path, { method: 'DELETE' }); } catch (error: any) { if (error?.status !== 404) throw error; }
  }

  private async request(path: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await fetch(`${this.apiUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(8_000) }); }
    catch { throw new ServiceUnavailableException('Static GOST control plane is unavailable'); }
    const text = await response.text();
    let payload: any = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) {
      const error: any = new Error(typeof payload === 'string' ? payload : payload?.msg || payload?.message || `GOST API ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }
}
