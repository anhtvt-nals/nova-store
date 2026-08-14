import { HttpException, Injectable, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { DatabaseService } from '../database/database.service';

interface StoredProxyEvent {
  id: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

@Injectable()
export class ProxyEventsService {
  private readonly activeByProfile = new Map<number, number>();

  constructor(private readonly db: DatabaseService) {}

  stream(profileId: number, lastEventId?: string): Observable<MessageEvent> {
    const active = this.activeByProfile.get(profileId) || 0;
    if (active >= 3) throw new HttpException('Too many proxy event streams', 429);
    this.activeByProfile.set(profileId, active + 1);
    return new Observable<MessageEvent>(subscriber => {
      let cursor = Number.isSafeInteger(Number(lastEventId)) && Number(lastEventId) > 0 ? Number(lastEventId) : 0;
      let initialized = cursor > 0;
      let polling = false;
      let closed = false;

      const poll = async () => {
        if (polling || closed) return;
        polling = true;
        try {
          if (!initialized) {
            const latest = await this.db.client
              .from('proxy_node_events')
              .select('id')
              .eq('profile_id', profileId)
              .order('id', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (latest.error) throw latest.error;
            cursor = Number(latest.data?.id || 0);
            initialized = true;
            subscriber.next({ type: 'proxy.connected', data: { cursor } });
          } else {
            const result = await this.db.client
              .from('proxy_node_events')
              .select('id,event_type,payload,created_at')
              .eq('profile_id', profileId)
              .gt('id', cursor)
              .order('id')
              .limit(100);
            if (result.error) throw result.error;
            for (const event of (result.data || []) as StoredProxyEvent[]) {
              cursor = Number(event.id);
              subscriber.next({
                id: String(event.id),
                type: event.event_type,
                data: { ...event.payload, createdAt: event.created_at },
                retry: 3000,
              });
            }
          }
        } catch (error) {
          subscriber.next({
            type: 'proxy.stream.warning',
            data: { message: error instanceof Error ? error.message : 'Unable to read proxy events' },
          });
        } finally {
          polling = false;
        }
      };

      void poll();
      const pollTimer = setInterval(() => void poll(), 5000);
      const heartbeatTimer = setInterval(() => subscriber.next({
        type: 'proxy.heartbeat',
        data: { timestamp: new Date().toISOString() },
      }), 15000);

      return () => {
        closed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        const remaining = (this.activeByProfile.get(profileId) || 1) - 1;
        if (remaining > 0) this.activeByProfile.set(profileId, remaining);
        else this.activeByProfile.delete(profileId);
      };
    });
  }
}
