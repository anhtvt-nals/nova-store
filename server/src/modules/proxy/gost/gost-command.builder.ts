import { Injectable } from '@nestjs/common';
import type { ProvisionNodeInput } from '../provider/compute-provider';

@Injectable()
export class GostCommandBuilder {
  install(version: string) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('GOST_VERSION must be a numeric semantic version');
    const base = `https://github.com/ginuerzh/gost/releases/download/v${version}`;
    const assets = ['linux_amd64', 'linux_amd64v3', 'linux_amd64v2'];
    const downloads = assets.map(asset => `curl -fsSL -o /tmp/gost.tar.gz "${base}/gost_${version}_${asset}.tar.gz"`).join(' || ');
    return `cd /tmp && (${downloads}) && tar -xzf /tmp/gost.tar.gz -C /tmp gost && chmod +x /tmp/gost && /tmp/gost -V`;
  }

  localSocks(input: ProvisionNodeInput) {
    return {
      command: 'while true; do /tmp/gost -L="socks5://${SOCKS_USER}:${SOCKS_PASS}@127.0.0.1:${LOCAL_PORT}" >> /tmp/gost-socks.log 2>&1; sleep 1; done',
      envs: {
        SOCKS_USER: encodeURIComponent(input.gost.socksUsername),
        SOCKS_PASS: encodeURIComponent(input.gost.socksPassword),
        LOCAL_PORT: String(input.gost.localPort),
      },
    };
  }

  probeLocal(localPort: number) {
    return `for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/${localPort}) 2>/dev/null && echo UP && exit 0; sleep 0.5; done; exit 1`;
  }

  reverseTunnel(input: ProvisionNodeInput) {
    const scheme = input.gost.tunnelTransport === 'tcp' ? 'socks5' : `socks5+${input.gost.tunnelTransport}`;
    return {
      command: 'while true; do /tmp/gost -L="rtcp://:${BIND_PORT}/127.0.0.1:${LOCAL_PORT}" -F="${TUNNEL_SCHEME}://${TUNNEL_USER}:${TUNNEL_PASS}@${MASTER_HOST}:${RENDEZVOUS_PORT}?mbind=true" >> /tmp/gost-tunnel.log 2>&1; sleep 2; done',
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
}
