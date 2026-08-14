import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { mapOrder } from '../../common/mappers';
import { DatabaseService } from '../database/database.service';
import { ProxyCredentialService } from '../proxy/proxy-credential.service';
import type { CreateOrderDto, QuoteOrderDto } from './orders.dto';

const orderSelect = 'id,order_group_id,amount,unit_price,node_count,rental_days,status,payment_method,created_at,activated_at,expires_at,plan_name_snapshot,resource_name_snapshot,products(code,name,service_type),resources(name)';

@Injectable()
export class OrdersService {
  constructor(private db: DatabaseService, private credentials: ProxyCredentialService) {}

  async listForUser(profileId: number) {
    const result = await this.db.client.from('orders').select(orderSelect).eq('profile_id', profileId).order('created_at', { ascending: false });
    return this.db.unwrap(result, 'Unable to load orders').map(mapOrder);
  }

  async quote(dto: QuoteOrderDto) {
    const product = await this.getProxyPricing(dto.productId);
    const unitPrice = Number(product.unitPrice);
    const rateResult = await this.db.client.from('app_settings').select('value').eq('key', 'credits_per_usd').maybeSingle();
    const rateRow = this.db.unwrap(rateResult, 'Unable to load credit conversion');
    const creditsPerUsd = Number(rateRow?.value) > 0 ? Number(rateRow?.value) : 100;
    const total = Number((unitPrice * dto.nodeCount * dto.rentalDays).toFixed(4));
    return {
      unitPrice,
      nodeCount: dto.nodeCount,
      rentalDays: dto.rentalDays,
      total,
      currency: product.currency,
      creditCost: product.currency === 'USD' ? Number(Math.ceil(total * creditsPerUsd * 100) / 100) : null,
    };
  }

  async creditBalance(profileId: number) {
    const result = await this.db.client.from('credit_wallets').select('balance').eq('profile_id', profileId).maybeSingle();
    const row = this.db.unwrap(result, 'Unable to load credit balance');
    return { balance: Number(row?.balance || 0) };
  }

  async create(profileId: number, dto: CreateOrderDto) {
    await this.getProxyPricing(dto.productId);
    const created = await this.db.client.rpc('create_proxy_order', {
      target_profile_id: profileId,
      target_product_id: dto.productId,
      requested_nodes: dto.nodeCount,
      requested_days: dto.rentalDays,
      requested_payment_method: dto.paymentMethod,
    });
    if (created.error) throw new BadRequestException(created.error.message);
    const result = await this.db.client.from('orders').select(orderSelect).eq('id', created.data).maybeSingle();
    const order = this.db.unwrap(result, 'Order was created but could not be reloaded');
    if (!order) throw new NotFoundException('Order was created but could not be reloaded');
    return mapOrder(order);
  }

  private async getProxyPricing(productId: number) {
    const result = await this.db.client.from('products').select('id,base_price,currency,is_active,service_type').eq('id', productId).maybeSingle();
    const product = this.db.unwrap(result, 'Unable to validate product');
    if (!product || !product.is_active) throw new NotFoundException('Product not found');
    if (product.service_type !== 'proxy') throw new BadRequestException('This product does not support node/day ordering');
    if (Number(product.base_price) <= 0) throw new BadRequestException('Proxy daily price has not been configured by admin');
    return { productId: product.id, unitPrice: Number(product.base_price), currency: product.currency };
  }

  async connection(profileId: number, orderId: number, nodeId?: number) {
    const result = await this.db.client.from('orders').select('id,profile_id,status,expires_at,activated_at,plans(rotation_minutes),resources(capabilities,secrets)').eq('id', orderId).maybeSingle();
    const order = this.db.unwrap(result, 'Unable to load connection') as any;
    if (!order) throw new NotFoundException('Order not found');
    if (order.profile_id !== profileId) throw new ForbiddenException();
    if (order.status !== 'active' || (order.expires_at && new Date(order.expires_at) <= new Date())) throw new BadRequestException('Order is not active');
    const resource = Array.isArray(order.resources) ? order.resources[0] : order.resources;
    let nodeQuery = this.db.client.from('proxy_nodes')
      .select('id,public_host,tunnel_port,next_rotation_at,status')
      .eq('order_id', orderId);
    if (nodeId) nodeQuery = nodeQuery.eq('id', nodeId);
    const nodeResult = await nodeQuery.order('id').limit(1).maybeSingle();
    const node = this.db.unwrap(nodeResult, 'Unable to load proxy node');
    if (!node) throw new NotFoundException('Proxy node not found for this order');
    const plan = Array.isArray(order.plans) ? order.plans[0] : order.plans;
    const rotationMs = Number(plan?.rotation_minutes || 60) * 60_000;
    const activatedAt = new Date(order.activated_at).getTime();
    const nextRotation = new Date(activatedAt + (Math.floor((Date.now() - activatedAt) / rotationMs) + 1) * rotationMs);
    const accountCredential = await this.credentials.get(profileId);
    return {
      host: node.public_host || resource?.secrets?.host,
      port: Number(node.tunnel_port || resource?.secrets?.port),
      username: accountCredential?.username || resource?.secrets?.username,
      password: accountCredential?.password || resource?.secrets?.password,
      protocol: resource?.capabilities?.protocol || 'SOCKS5',
      nextRotationAt: node.next_rotation_at || nextRotation.toISOString(),
    };
  }
}
