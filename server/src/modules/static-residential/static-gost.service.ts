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

  constructor(config: ConfigService) {
    const address = config.get<string>('STATIC_GOST_API_ADDR') || '127.0.0.1:18081';
    const parsed = new URL(`http://${address}`);
    if (!['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname) || !parsed.port || (parsed.hostname !== 'localhost' && !isIP(parsed.hostname))) {
      throw new Error('STATIC_GOST_API_ADDR must be a loopback IP address and port');
    }
    this.apiUrl = `${parsed.origin}/config`;
  }

  async upsertOrder(nodes: StaticGostNode[]) {
    if (!nodes.length) return;
    const first = nodes[0];
    const quotaName = this.quotaName(first.orderId);
    await this.put(`/quotas/${quotaName}`, {
      name: quotaName,
      limit: '5GB', direction: 'total', startsAt: first.activatedAt, expiresAt: first.expiresAt, flush: '5s',
      store: { type: 'file', file: `/var/lib/nodenesia-static-gost/${quotaName}.json` },
    }, true);
    for (const node of nodes) await this.upsertNode(node, quotaName);
  }

  async upsertNode(node: StaticGostNode, quotaName = this.quotaName(node.orderId)) {
    const chainName = this.chainName(node.id);
    await this.put(`/chains/${chainName}`, {
      name: chainName,
      hops: [{ name: 'upstream', nodes: [{ name: 'residential', addr: this.address(node.host, node.upstreamPort),
        connector: { type: 'socks5', auth: { username: node.upstreamUsername, password: node.upstreamPassword } }, dialer: { type: 'tcp' } }] }],
    }, true);
    await this.put(`/services/${node.serviceName}`, {
      name: node.serviceName, addr: `:${node.port}`, quotas: [quotaName], limiter: 'static-bandwidth', climiter: 'static-connections', rlimiter: 'static-requests',
      handler: { type: 'socks5', auth: { username: node.username, password: node.password }, chain: chainName }, listener: { type: 'tcp' },
    }, true);
  }

  async removeOrder(orderId: number, nodes: Array<{ id: number; serviceName: string }>) {
    await Promise.all(nodes.flatMap(node => [this.remove(`/services/${node.serviceName}`), this.remove(`/chains/${this.chainName(node.id)}`)]));
    await this.remove(`/quotas/${this.quotaName(orderId)}`);
  }

  async quota(orderId: number): Promise<{ used: number; limit: number; blocked: boolean } | null> {
    try {
      const result: any = await this.request(`/quotas/${this.quotaName(orderId)}`);
      const status = result?.data?.status || result?.status;
      return status ? { used: Number(status.used || 0), limit: Number(status.limit || 0), blocked: Boolean(status.blocked) } : null;
    } catch (error: any) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  private quotaName(orderId: number) { return `static-residential-order-${orderId}`; }
  private chainName(nodeId: number) { return `static-residential-node-${nodeId}`; }
  private address(host: string, port: number) { return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`; }

  private async put(path: string, body: unknown, allowCreate: boolean) {
    try { await this.request(path, { method: 'PUT', body: JSON.stringify(body) }); }
    catch (error: any) {
      if (allowCreate && error?.status === 404) {
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
