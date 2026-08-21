import { Injectable } from '@nestjs/common';
import type { ProvisionNodeInput } from '../provider/compute-provider';

@Injectable()
export class GostCommandBuilder {
  install(version: string) {
    if (!/^3\.\d+\.\d+$/.test(version)) throw new Error('GOST_VERSION must be a stable v3 semantic version');
    const base = `https://github.com/go-gost/gost/releases/download/v${version}`;
    const assets = ['linux_amd64', 'linux_amd64v3'];
    const downloads = assets.map(asset => `curl -fsSL -o /tmp/gost.tar.gz "${base}/gost_${version}_${asset}.tar.gz"`).join(' || ');
    return `cd /tmp && (${downloads}) && tar -xzf /tmp/gost.tar.gz -C /tmp gost && chmod +x /tmp/gost && /tmp/gost -V`;
  }

  localSocks(input: ProvisionNodeInput): { command: string; envs: Record<string, string> } {
    if (input.gost.usageObserverUrl) {
      const service: Record<string, unknown> = {
        name: 'nodenesia-socks',
        addr: `127.0.0.1:${input.gost.localPort}`,
        handler: {
          // `auto` identifies HTTP proxy and SOCKS4/5 requests on one TCP
          // listener while retaining node-scoped authentication and limits.
          type: 'auto',
          auth: { username: input.gost.socksUsername, password: input.gost.socksPassword },
          observer: 'usage-observer',
          metadata: { 'observer.period': '5s', 'observer.resetTraffic': false },
        },
        listener: { type: 'tcp' },
      };
      const config: Record<string, unknown> = {
        services: [service],
        observers: [{ name: 'usage-observer', plugin: { type: 'http', addr: input.gost.usageObserverUrl, timeout: '5s' } }],
      };
      if (input.gost.bandwidthIn || input.gost.bandwidthOut) {
        service.limiter = 'node-bandwidth';
        config.limiters = [{ name: 'node-bandwidth', limits: [`$ ${input.gost.bandwidthIn || '0'} ${input.gost.bandwidthOut || '0'}`] }];
      }
      if (input.gost.maxConnections) {
        service.climiter = 'node-connections';
        config.climiters = [{ name: 'node-connections', limits: [`$ ${input.gost.maxConnections}`] }];
      }
      return {
        command: 'printf %s "$GOST_CONFIG_B64" | base64 -d > /tmp/nodenesia-socks.json; while true; do /tmp/gost -C /tmp/nodenesia-socks.json >> /tmp/gost-socks.log 2>&1; sleep 1; done',
        envs: { GOST_CONFIG_B64: Buffer.from(JSON.stringify(config)).toString('base64') },
      };
    }
    return {
      command: 'while true; do /tmp/gost -L="auto://${SOCKS_USER}:${SOCKS_PASS}@127.0.0.1:${LOCAL_PORT}${SOCKS_QUERY}" >> /tmp/gost-socks.log 2>&1; sleep 1; done',
      envs: {
        SOCKS_USER: encodeURIComponent(input.gost.socksUsername),
        SOCKS_PASS: encodeURIComponent(input.gost.socksPassword),
        LOCAL_PORT: String(input.gost.localPort),
        SOCKS_QUERY: this.socksQuery(input),
      },
    };
  }

  probeLocal(localPort: number) {
    return `for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/${localPort}) 2>/dev/null && echo UP && exit 0; sleep 0.5; done; exit 1`;
  }

  reverseTunnel(input: ProvisionNodeInput) {
    const scheme = input.gost.tunnelTransport === 'tcp' ? 'socks5' : `socks5+${input.gost.tunnelTransport}`;
    const query = this.tunnelQuery(input);
    return {
      command: 'while true; do /tmp/gost -L="rtcp://:${BIND_PORT}/127.0.0.1:${LOCAL_PORT}" -F="${TUNNEL_SCHEME}://${TUNNEL_USER}:${TUNNEL_PASS}@${MASTER_HOST}:${RENDEZVOUS_PORT}${TUNNEL_QUERY}" >> /tmp/gost-tunnel.log 2>&1; sleep 2; done',
      envs: {
        BIND_PORT: String(input.gost.bindPort),
        LOCAL_PORT: String(input.gost.localPort),
        TUNNEL_SCHEME: scheme,
        TUNNEL_USER: encodeURIComponent(input.gost.tunnelUsername),
        TUNNEL_PASS: encodeURIComponent(input.gost.tunnelPassword),
        MASTER_HOST: input.gost.masterHost,
        RENDEZVOUS_PORT: String(input.gost.rendezvousPort),
        TUNNEL_QUERY: query,
      },
    };
  }

  private tunnelQuery(input: ProvisionNodeInput) {
    if (!['ws', 'wss'].includes(input.gost.tunnelTransport)) return '';
    const params = [`path=${encodeURIComponent(input.gost.wsPath || '/ws')}`];
    if (input.gost.tunnelTransport === 'wss' && input.gost.tlsSecure !== false) {
      params.push('secure=true');
      params.push(`serverName=${encodeURIComponent(input.gost.tlsServerName || input.gost.masterHost)}`);
    }
    return `?${params.join('&')}`;
  }

  private socksQuery(input: ProvisionNodeInput) {
    const params: string[] = [];
    if (input.gost.bandwidthIn) params.push(`limiter.in=${encodeURIComponent(input.gost.bandwidthIn)}`);
    if (input.gost.bandwidthOut) params.push(`limiter.out=${encodeURIComponent(input.gost.bandwidthOut)}`);
    if (input.gost.maxConnections) params.push(`climiter=${input.gost.maxConnections}`);
    return params.length > 0 ? `?${params.join('&')}` : '';
  }
}
