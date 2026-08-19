import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { mapOrder } from '../../common/mappers';
import { DatabaseService } from '../database/database.service';
import { ProxyCredentialService } from '../proxy/proxy-credential.service';
import type { CreateOrderDto, ExtendOrderDto, QuoteOrderDto } from './orders.dto';

const orderSelect = 'id,order_group_id,amount,unit_price,node_count,rental_days,status,payment_method,created_at,activated_at,expires_at,plan_name_snapshot,resource_name_snapshot,products(code,name,service_type,proxy_type),resources(name)';

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
    const availableNodes = await this.availableCustomerCapacity();
    return {
      unitPrice,
      nodeCount: dto.nodeCount,
      rentalDays: dto.rentalDays,
      total,
      currency: product.currency,
      creditCost: product.currency === 'USD' ? Number(Math.ceil(total * creditsPerUsd * 100) / 100) : null,
      availableNodes,
      canFulfill: dto.nodeCount <= availableNodes,
    };
  }

  async creditBalance(profileId: number) {
    const result = await this.db.client.from('credit_wallets').select('balance').eq('profile_id', profileId).maybeSingle();
    const row = this.db.unwrap(result, 'Unable to load credit balance');
    return { balance: Number(row?.balance || 0) };
  }

  async create(profileId: number, dto: CreateOrderDto) {
    await this.getProxyPricing(dto.productId);
    if (await this.isTrialAlreadyUsed(profileId)) {
      throw new BadRequestException('Your one-day trial has already been used. Upgrade to a regular account to rent more nodes.');
    }
    const availableNodes = await this.availableCustomerCapacity();
    if (dto.nodeCount > availableNodes) {
      throw new BadRequestException(`Only ${availableNodes} proxy node${availableNodes === 1 ? '' : 's'} are currently available`);
    }
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

  async extend(profileId: number, orderId: number, dto: ExtendOrderDto) {
    if (![1, 3, 7, 15, 30].includes(dto.rentalDays)) {
      throw new BadRequestException('Extension days must be one of: 1, 3, 7, 15, or 30');
    }
    const result = await this.db.client.rpc('extend_proxy_order', {
      target_profile_id: profileId,
      target_order_id: orderId,
      requested_days: dto.rentalDays,
    });
    if (result.error) throw new BadRequestException(result.error.message);
    const orderResult = await this.db.client.from('orders').select(orderSelect).eq('id', orderId).maybeSingle();
    const order = this.db.unwrap(orderResult, 'Order was extended but could not be reloaded');
    if (!order) throw new NotFoundException('Order not found');
    return mapOrder(order);
  }

  async exportConnections(profileId: number) {
    const now = new Date().toISOString();
    const [nodesResult, credential] = await Promise.all([
      this.db.client.from('proxy_nodes')
        .select('id,order_id,public_host,tunnel_port,status,orders!inner(profile_id,status,expires_at)')
        .eq('orders.profile_id', profileId)
        .eq('orders.status', 'active')
        .gt('orders.expires_at', now)
        .in('status', ['online', 'rotating', 'degraded']),
      this.credentials.get(profileId),
    ]);
    const nodes = this.db.unwrap(nodesResult, 'Unable to load proxy connections') as any[];
    if (!credential) throw new NotFoundException('Proxy credentials are not available');
    const encode = (value: string) => encodeURIComponent(value);
    const lines = nodes
      .filter(node => node.public_host && node.tunnel_port)
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(node => `socks5://${encode(credential.username)}:${encode(credential.password)}@${node.public_host}:${node.tunnel_port}`);
    return { filename: 'nodenesia-socks5.txt', content: `${lines.join('\n')}${lines.length ? '\n' : ''}`, count: lines.length };
  }

  private async availableCustomerCapacity() {
    const result = await this.db.client.rpc('available_proxy_customer_capacity');
    return Math.max(0, Number(this.db.unwrap(result, 'Unable to check proxy capacity') || 0));
  }

  private async isTrialAlreadyUsed(profileId: number) {
    const profileResult = await this.db.client.from('profiles').select('is_trial').eq('id', profileId).maybeSingle();
    const profile = this.db.unwrap(profileResult, 'Unable to validate trial account');
    if (!profile?.is_trial) return false;
    const orderResult = await this.db.client.from('orders').select('id').eq('profile_id', profileId).limit(1);
    return this.db.unwrap(orderResult, 'Unable to validate trial usage').length > 0;
  }

  private async getProxyPricing(productId: number) {
    const result = await this.db.client.from('products').select('id,base_price,currency,is_active,service_type,proxy_type').eq('id', productId).maybeSingle();
    const product = this.db.unwrap(result, 'Unable to validate product');
    if (!product || !product.is_active) throw new NotFoundException('Product not found');
    if (product.service_type !== 'proxy') throw new BadRequestException('This product does not support node/day ordering');
    if (Number(product.base_price) <= 0) throw new BadRequestException('Proxy daily price has not been configured by admin');
    return { productId: product.id, unitPrice: Number(product.base_price), currency: product.currency, proxyType: product.proxy_type || 'datacenter' };
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
