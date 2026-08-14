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

  localSocks(input: ProvisionNodeInput) {
    return {
      command: 'while true; do /tmp/gost -L="socks5://${SOCKS_USER}:${SOCKS_PASS}@127.0.0.1:${LOCAL_PORT}${SOCKS_QUERY}" >> /tmp/gost-socks.log 2>&1; sleep 1; done',
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
    return {
      command: 'while true; do /tmp/gost -L="rtcp://:${BIND_PORT}/127.0.0.1:${LOCAL_PORT}" -F="${TUNNEL_SCHEME}://${TUNNEL_USER}:${TUNNEL_PASS}@${MASTER_HOST}:${RENDEZVOUS_PORT}" >> /tmp/gost-tunnel.log 2>&1; sleep 2; done',
      envs: {
        BIND_PORT: String(input.gost.bindPort),
        LOCAL_PORT: String(input.gost.localPort),
        TUNNEL_SCHEME: scheme,
        TUNNEL_USER: encodeURIComponent(input.gost.tunnelUsername),
        TUNNEL_PASS: encodeURIComponent(input.gost.tunnelPassword),
        MASTER_HOST: input.gost.masterHost,
        RENDEZVOUS_PORT: String(input.gost.rendezvousPort),
      },
    };
  }

  private socksQuery(input: ProvisionNodeInput) {
    const params: string[] = [];
    if (input.gost.bandwidthIn) params.push(`limiter.in=${encodeURIComponent(input.gost.bandwidthIn)}`);
    if (input.gost.bandwidthOut) params.push(`limiter.out=${encodeURIComponent(input.gost.bandwidthOut)}`);
    if (input.gost.maxConnections) params.push(`climiter=${input.gost.maxConnections}`);
    return params.length > 0 ? `?${params.join('&')}` : '';
  }
}
