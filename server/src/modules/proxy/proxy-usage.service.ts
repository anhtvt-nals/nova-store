import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../database/database.service';

type ObserverEvent = { kind?: string; type?: string; stats?: { totalConns?: unknown; inputBytes?: unknown; outputBytes?: unknown } };

@Injectable()
export class ProxyUsageService {
  constructor(private readonly db: DatabaseService, private readonly config: ConfigService) {}

  tokenForNode(nodeId: number) {
    const secret = this.secret();
    return createHmac('sha256', secret).update(`proxy-usage:${nodeId}`).digest('hex');
  }

  async observe(nodeId: number, token: string | undefined, body: { events?: unknown[] }) {
    const expected = this.tokenForNode(nodeId);
    const received = Buffer.from(token || '', 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (received.length !== expectedBuffer.length || !timingSafeEqual(received, expectedBuffer)) {
      throw new UnauthorizedException('Invalid proxy usage observer token');
    }
    const events = Array.isArray(body?.events) ? body.events.slice(0, 20) : [];
    let latest: { connections: number; input: number; output: number } | null = null;
    for (const event of events as ObserverEvent[]) {
      if (event?.kind !== 'handler' || event.type !== 'stats') continue;
      const connections = this.counter(event.stats?.totalConns);
      const input = this.counter(event.stats?.inputBytes);
      const output = this.counter(event.stats?.outputBytes);
      if (connections !== null && input !== null && output !== null) latest = { connections, input, output };
    }
    if (latest) {
      const result = await this.db.client.rpc('record_proxy_node_usage_observation', {
        target_node_id: nodeId,
        observed_connections: latest.connections,
        observed_input_bytes: latest.input,
        observed_output_bytes: latest.output,
      });
      this.db.unwrap(result, 'Unable to record proxy usage');
    }
    return { ok: true };
  }

  private counter(value: unknown) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  private secret() {
    const value = this.config.get<string>('PROXY_USAGE_OBSERVER_SECRET');
    if (!value || value.length < 32) throw new Error('PROXY_USAGE_OBSERVER_SECRET must contain at least 32 characters');
    return value;
  }
}
