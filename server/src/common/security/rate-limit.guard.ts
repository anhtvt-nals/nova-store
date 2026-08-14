import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../modules/auth/auth.types';

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();
  private requests = 0;

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const path = request.path || request.url.split('?')[0];
    const method = request.method.toUpperCase();
    const identity = request.user ? `profile:${request.user.profileId}` : `ip:${request.ip || request.socket.remoteAddress || 'unknown'}`;
    const policy = this.policy(method, path);
    const key = `${identity}:${method}:${policy.scope}`;
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + policy.windowMs });
    } else {
      bucket.count += 1;
      if (bucket.count > policy.limit) {
        throw new HttpException('Too many requests', 429);
      }
    }

    // Cheap bounded cleanup so arbitrary IPs cannot grow the map forever.
    this.requests += 1;
    if (this.requests % 500 === 0) {
      for (const [bucketKey, value] of this.buckets) {
        if (value.resetAt <= now) this.buckets.delete(bucketKey);
      }
    }
    return true;
  }

  private policy(method: string, path: string) {
    if (method === 'POST' && path === '/orders') return { scope: 'order-create', limit: 5, windowMs: 60_000 };
    if (method === 'POST' && path === '/orders/quote') return { scope: 'order-quote', limit: 30, windowMs: 60_000 };
    if (path.includes('/nodes/events')) return { scope: 'proxy-events', limit: 10, windowMs: 60_000 };
    if (path.startsWith('/admin')) return { scope: 'admin', limit: 180, windowMs: 60_000 };
    if (path.startsWith('/internal/')) return { scope: 'internal', limit: 300, windowMs: 60_000 };
    return { scope: 'general', limit: 300, windowMs: 60_000 };
  }
}

