import { Injectable } from '@nestjs/common';
import net from 'node:net';

@Injectable()
export class SocksHealthService {
  check(host: string, port: number, username: string, password: string, timeoutMs = 5000): Promise<boolean> {
    return new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      // socket.setTimeout is an idle timeout and can be extended by partial
      // traffic. Keep a wall-clock guard so a provisioning job can never hold
      // its lease forever while a SOCKS server stalls mid-handshake.
      let buffer = Buffer.alloc(0);
      let stage: 'greeting' | 'auth' | 'connect' = 'greeting';
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        socket.destroy();
        resolve(ok);
      };
      deadline = setTimeout(() => finish(false), timeoutMs);
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

  /** Verify the HTTP CONNECT path once during provisioning. Runtime polling
   * intentionally remains SOCKS-only to avoid doubling per-node checks. */
  checkHttp(host: string, port: number, username: string, password: string, timeoutMs = 5000): Promise<boolean> {
    return new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      let response = '';
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        socket.destroy();
        resolve(ok);
      };
      deadline = setTimeout(() => finish(false), timeoutMs);
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.on('error', () => finish(false));
      socket.on('connect', () => {
        const authorization = Buffer.from(`${username}:${password}`).toString('base64');
        socket.write(`CONNECT 1.1.1.1:80 HTTP/1.1\r\nHost: 1.1.1.1:80\r\nProxy-Authorization: Basic ${authorization}\r\nConnection: close\r\n\r\n`);
      });
      socket.on('data', chunk => {
        response += chunk.toString('latin1');
        const lineEnd = response.indexOf('\r\n');
        if (lineEnd < 0) return;
        finish(/^HTTP\/1\.[01] 2\d\d\b/.test(response.slice(0, lineEnd)));
      });
    });
  }

  async waitUntilHttpReady(host: string, port: number, username: string, password: string, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.checkHttp(host, port, username, password)) return;
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error(`HTTP proxy endpoint ${host}:${port} did not become reachable`);
  }

  async waitUntilUnavailable(host: string, port: number, username: string, password: string, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.check(host, port, username, password))) return;
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error(`Previous SOCKS5 endpoint ${host}:${port} did not shut down`);
  }

  /** Best-effort egress lookup through the ready SOCKS5 endpoint. */
  egressIp(host: string, port: number, username: string, password: string, timeoutMs = 8000): Promise<string | null> {
    return new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      let buffer = Buffer.alloc(0);
      let stage: 'greeting' | 'auth' | 'connect' | 'http' = 'greeting';
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        socket.destroy();
        resolve(value);
      };
      const parseIp = (response: Buffer) => {
        const body = response.toString('utf8').split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(body) || /^[0-9a-f:]+$/i.test(body) ? body : null;
      };
      deadline = setTimeout(() => finish(null), timeoutMs);
      socket.setTimeout(timeoutMs, () => finish(null));
      socket.on('error', () => finish(null));
      socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x02])));
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 'greeting' && buffer.length >= 2) {
          if (buffer[0] !== 0x05 || buffer[1] !== 0x02) return finish(null);
          buffer = buffer.subarray(2);
          const user = Buffer.from(username);
          const pass = Buffer.from(password);
          if (user.length > 255 || pass.length > 255) return finish(null);
          socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
          stage = 'auth';
        }
        if (stage === 'auth' && buffer.length >= 2) {
          if (buffer[1] !== 0x00) return finish(null);
          buffer = buffer.subarray(2);
          const domain = Buffer.from('ifconfig.me');
          socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain, Buffer.from([0x00, 0x50])]));
          stage = 'connect';
        }
        if (stage === 'connect') {
          if (buffer.length < 5) return;
          if (buffer[0] !== 0x05 || buffer[1] !== 0x00) return finish(null);
          const addressLength = buffer[3] === 0x01 ? 4 : buffer[3] === 0x04 ? 16 : buffer[3] === 0x03 ? buffer[4] + 1 : 0;
          const replyLength = 4 + addressLength + 2;
          if (!addressLength || buffer.length < replyLength) return finish(null);
          buffer = buffer.subarray(replyLength);
          socket.write('GET /ip HTTP/1.1\r\nHost: ifconfig.me\r\nConnection: close\r\nUser-Agent: Nodenesia/1.0\r\n\r\n');
          stage = 'http';
        }
        if (stage === 'http') {
          const ip = parseIp(buffer);
          if (ip) finish(ip);
        }
      });
      socket.on('end', () => finish(parseIp(buffer)));
    });
  }
}
