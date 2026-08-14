import { Injectable } from '@nestjs/common';
import net from 'node:net';

@Injectable()
export class SocksHealthService {
  check(host: string, port: number, username: string, password: string, timeoutMs = 5000): Promise<boolean> {
    return new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      let settled = false;
      let buffer = Buffer.alloc(0);
      let stage: 'greeting' | 'auth' | 'connect' = 'greeting';
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.on('error', () => finish(false));
      socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x02])));
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 'greeting' && buffer.length >= 2) {
          if (buffer[0] !== 0x05 || buffer[1] !== 0x02) return finish(false);
          buffer = buffer.subarray(2);
          const user = Buffer.from(username);
          const pass = Buffer.from(password);
          if (user.length > 255 || pass.length > 255) return finish(false);
          socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
          stage = 'auth';
        }
        if (stage === 'auth' && buffer.length >= 2) {
          if (buffer[1] !== 0x00) return finish(false);
          buffer = buffer.subarray(2);
          socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x50]));
          stage = 'connect';
        }
        if (stage === 'connect' && buffer.length >= 2) finish(buffer[0] === 0x05 && buffer[1] === 0x00);
      });
    });
  }

  async waitUntilReady(host: string, port: number, username: string, password: string, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.check(host, port, username, password)) return;
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error(`SOCKS5 endpoint ${host}:${port} did not become reachable`);
  }
}

