import { Injectable } from '@nestjs/common';
import { mapOrder } from '../../common/mappers';
import type { AuthUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class DashboardService {
  constructor(private db: DatabaseService) {}

  async clientOverview(user: AuthUser) {
    const now = new Date().toISOString();
    const [orderResult, usageResult, nodeResult] = await Promise.all([
      this.db.client.from('orders').select('id,order_group_id,amount,unit_price,node_count,rental_days,status,payment_method,created_at,expires_at,activated_at,plan_name_snapshot,resource_name_snapshot,products(code,name,service_type),plans(rotation_minutes),resources(name)').eq('profile_id', user.profileId).eq('status', 'active').gt('expires_at', now).order('activated_at', { ascending: false }).limit(1).maybeSingle(),
      this.db.client.from('usage_daily').select('requests,successful_requests,bytes_transferred,usage_date').eq('profile_id', user.profileId),
      this.db.client.from('proxy_nodes').select('*', { count: 'exact', head: true }).eq('profile_id', user.profileId).eq('status', 'online').gt('expires_at', now),
    ]);
    const row = this.db.unwrap(orderResult, 'Unable to load active order') as any;
    const usage = this.db.unwrap(usageResult, 'Unable to load usage') as Array<{ requests: number; successful_requests: number; bytes_transferred: number; usage_date: string }>;
    if (nodeResult.error) throw nodeResult.error;
    const today = now.slice(0, 10);
    const requests = usage.filter(item => item.usage_date === today).reduce((sum, item) => sum + Number(item.requests), 0);
    const successful = usage.filter(item => item.usage_date === today).reduce((sum, item) => sum + Number(item.successful_requests), 0);
    const totalRequests = usage.reduce((sum, item) => sum + Number(item.requests), 0);
    const totalBandwidthBytes = usage.reduce((sum, item) => sum + Number(item.bytes_transferred), 0);
    let nextRotationAt: string | null = null;
    if (row) {
      const plan = Array.isArray(row.plans) ? row.plans[0] : row.plans;
      const windowMs = Number(plan?.rotation_minutes || 60) * 60_000;
      const start = new Date(row.activated_at).getTime();
      nextRotationAt = new Date(start + (Math.floor((Date.now() - start) / windowMs) + 1) * windowMs).toISOString();
    }
    return {
      displayName: user.name,
      activeNodes: nodeResult.count || 0,
      requestsToday: requests,
      totalRequests,
      totalBandwidthBytes,
      successRate: requests ? Number(((successful / requests) * 100).toFixed(1)) : 100,
      nextRotationAt,
      activeOrder: row ? mapOrder(row) : null,
    };
  }
}
