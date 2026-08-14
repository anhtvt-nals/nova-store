import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mapOrder } from '../../common/mappers';
import { DatabaseService } from '../database/database.service';
import type { AuthUser } from '../auth/auth.types';
import type { CreateCategoryDto, CreateProductDto, CreateProviderApiKeyDto, CreateProviderDto, CreateUserDto, UpdateCategoryDto, UpdateGeneralSettingsDto, UpdateProductDto, UpdateProviderDto, UpdateProxyPriceDto, UpdateUserDto } from './admin.dto';

const orderSelect = 'id,profile_id,order_group_id,amount,unit_price,node_count,rental_days,status,payment_method,created_at,activated_at,expires_at,plan_name_snapshot,resource_name_snapshot,profiles(email),products(code,name,service_type),resources(name)';

@Injectable()
export class AdminService {
  constructor(private db: DatabaseService, private config: ConfigService) {}

  async overview() {
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const [users, nodes, pending, activeOrders, usage, activity] = await Promise.all([
      this.db.client.from('profiles').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      this.db.client.from('proxy_nodes').select('*', { count: 'exact', head: true }).eq('status', 'online'),
      this.db.client.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      this.db.client.from('orders').select('amount,plans(duration_hours)').eq('status', 'active'),
      this.db.client.from('usage_daily').select('requests,successful_requests').gte('usage_date', monthStart.toISOString().slice(0, 10)),
      this.db.client.from('activity_logs').select('id,event_type,description,tone,created_at').order('created_at', { ascending: false }).limit(6),
    ]);
    for (const result of [users, nodes, pending, activeOrders, usage, activity]) if (result.error) throw result.error;
    const monthlyRevenue = (activeOrders.data || []).reduce((sum: number, row: any) => {
      const plan = Array.isArray(row.plans) ? row.plans[0] : row.plans;
      return sum + Number(row.amount) * (720 / Number(plan?.duration_hours || 720));
    }, 0);
    const requestCount = (usage.data || []).reduce((sum, row) => sum + Number(row.requests), 0);
    const successCount = (usage.data || []).reduce((sum, row) => sum + Number(row.successful_requests), 0);
    return {
      mrr: Number(monthlyRevenue.toFixed(2)), mrrChange: 0,
      activeUsers: users.count || 0, activeNodes: nodes.count || 0, pendingOrders: pending.count || 0,
      successRate: requestCount ? Number(((successCount / requestCount) * 100).toFixed(1)) : 100,
      recentActivity: (activity.data || []).map(row => ({ id: row.id, title: row.event_type.replaceAll('_', ' '), detail: row.description, time: new Date(row.created_at).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' }), tone: row.tone })),
    };
  }

  async users() {
    const [profiles, orders] = await Promise.all([
      this.db.client.from('profiles').select('id,name,email,status').order('created_at', { ascending: false }),
      this.db.client.from('orders').select('profile_id,plan_name_snapshot,created_at').eq('status', 'active').order('created_at', { ascending: false }),
    ]);
    const rows = this.db.unwrap(profiles, 'Unable to load users');
    const activeOrders = this.db.unwrap(orders, 'Unable to load user plans');
    return rows.map(profile => ({ ...profile, planName: activeOrders.find(order => order.profile_id === profile.id)?.plan_name_snapshot || 'No active plan' }));
  }

  async createUser(dto: CreateUserDto) {
    const email = dto.email.toLowerCase();
    const created = await this.db.client.auth.admin.createUser({
      email,
      password: dto.password,
      email_confirm: true,
      user_metadata: { name: dto.name },
    });
    if (created.error) {
      if (/already|registered|exists/i.test(created.error.message)) throw new ConflictException('Email already exists');
      throw new ConflictException(created.error.message);
    }
    const result = await this.db.client.from('profiles').select('id,name,email,status').eq('auth_user_id', created.data.user.id).maybeSingle();
    const profile = this.db.unwrap(result, 'Account was created but its profile could not be loaded');
    if (!profile) throw new NotFoundException('Account profile was not created');
    return { ...profile, planName: 'No active plan' };
  }

  async updateUser(id: number, dto: UpdateUserDto) {
    const result = await this.db.client.from('profiles').update(dto).eq('id', id).select('id,name,email,status').maybeSingle();
    const profile = this.db.unwrap(result, 'Unable to update user');
    if (!profile) throw new NotFoundException('User not found');
    return { ...profile, planName: 'No active plan' };
  }

  async deleteUser(id: number, actor: AuthUser) {
    if (id === actor.profileId) throw new ConflictException('Administrators cannot delete their own account');
    const profileResult = await this.db.client.from('profiles').select('id,auth_user_id').eq('id', id).maybeSingle();
    const profile = this.db.unwrap(profileResult, 'Unable to load user');
    if (!profile) throw new NotFoundException('User not found');
    const orders = await this.db.client.from('orders').select('id', { count: 'exact', head: true }).eq('profile_id', id);
    if (orders.error) throw orders.error;
    if ((orders.count || 0) > 0) throw new ConflictException('User has order history and cannot be deleted; suspend the account instead');

    if (profile.auth_user_id) {
      const deleted = await this.db.client.auth.admin.deleteUser(profile.auth_user_id);
      if (deleted.error) throw new ConflictException(`Unable to revoke login account: ${deleted.error.message}`);
      return;
    }
    const deleted = await this.db.client.from('profiles').delete().eq('id', id);
    if (deleted.error) throw deleted.error;
  }

  async categories() {
    const result = await this.db.client.from('categories').select('id,slug,name,description,is_active,sort_order,products(count)').order('sort_order').order('name');
    return this.db.unwrap(result, 'Unable to load categories').map((row: any) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      productCount: Number((Array.isArray(row.products) ? row.products[0] : row.products)?.count || 0),
    }));
  }

  async createCategory(dto: CreateCategoryDto) {
    const result = await this.db.client.from('categories').insert({
      name: dto.name,
      slug: dto.slug.toLowerCase(),
      description: dto.description || '',
      is_active: dto.isActive ?? true,
      sort_order: dto.sortOrder ?? 0,
    }).select('id,slug,name,description,is_active,sort_order').single();
    if (result.error?.code === '23505') throw new ConflictException('Category slug already exists');
    const row = this.db.unwrap(result, 'Unable to create category');
    return { id: row.id, slug: row.slug, name: row.name, description: row.description, isActive: row.is_active, sortOrder: row.sort_order, productCount: 0 };
  }

  async updateCategory(id: number, dto: UpdateCategoryDto) {
    const values: Record<string, unknown> = {};
    if (dto.name !== undefined) values.name = dto.name;
    if (dto.slug !== undefined) values.slug = dto.slug.toLowerCase();
    if (dto.description !== undefined) values.description = dto.description;
    if (dto.isActive !== undefined) values.is_active = dto.isActive;
    if (dto.sortOrder !== undefined) values.sort_order = dto.sortOrder;
    const result = await this.db.client.from('categories').update(values).eq('id', id).select('id,slug,name,description,is_active,sort_order').maybeSingle();
    if (result.error?.code === '23505') throw new ConflictException('Category slug already exists');
    const row = this.db.unwrap(result, 'Unable to update category');
    if (!row) throw new NotFoundException('Category not found');
    return { id: row.id, slug: row.slug, name: row.name, description: row.description, isActive: row.is_active, sortOrder: row.sort_order };
  }

  async deleteCategory(id: number) {
    const result = await this.db.client.from('categories').delete().eq('id', id).select('id').maybeSingle();
    if (result.error?.code === '23503') throw new ConflictException('Move or delete the products in this category first');
    const row = this.db.unwrap(result, 'Unable to delete category');
    if (!row) throw new NotFoundException('Category not found');
  }

  async products() {
    const result = await this.db.client.from('products').select('id,category_id,code,sku,name,description,service_type,country_code,product_kind,fulfillment_type,base_price,currency,stock_quantity,image_url,is_active,is_featured,categories(name)').order('created_at', { ascending: false });
    return this.db.unwrap(result, 'Unable to load products').map((row: any) => this.mapProduct(row));
  }

  async createProduct(dto: CreateProductDto) {
    const result = await this.db.client.from('products').insert(this.productValues(dto)).select('id,category_id,code,sku,name,description,service_type,country_code,product_kind,fulfillment_type,base_price,currency,stock_quantity,image_url,is_active,is_featured,categories(name)').single();
    if (result.error?.code === '23505') throw new ConflictException('Product code or SKU already exists');
    if (result.error?.code === '23503') throw new ConflictException('Category does not exist');
    return this.mapProduct(this.db.unwrap(result, 'Unable to create product'));
  }

  async updateProduct(id: number, dto: UpdateProductDto) {
    const result = await this.db.client.from('products').update(this.productValues(dto)).eq('id', id).select('id,category_id,code,sku,name,description,service_type,country_code,product_kind,fulfillment_type,base_price,currency,stock_quantity,image_url,is_active,is_featured,categories(name)').maybeSingle();
    if (result.error?.code === '23505') throw new ConflictException('Product code or SKU already exists');
    if (result.error?.code === '23503') throw new ConflictException('Category does not exist');
    const row = this.db.unwrap(result, 'Unable to update product');
    if (!row) throw new NotFoundException('Product not found');
    return this.mapProduct(row);
  }

  async deleteProduct(id: number) {
    const result = await this.db.client.from('products').delete().eq('id', id).select('id').maybeSingle();
    if (result.error?.code === '23503') throw new ConflictException('This product has plans, resources, or orders; deactivate it instead');
    const row = this.db.unwrap(result, 'Unable to delete product');
    if (!row) throw new NotFoundException('Product not found');
  }

  async providers() {
    const result = await this.db.client.from('proxy_providers').select('id,code,name,api_base_url,status,max_sandboxes,reserved_replacement_slots,max_concurrent_provisions,provider_api_keys(count),resources(count)').order('name');
    const rows = this.db.unwrap(result, 'Unable to load providers') as any[];
    const capacity = await this.db.client.from('proxy_nodes').select('provider_id').in('status', ['queued', 'provisioning', 'online', 'rotating', 'degraded', 'offline', 'error', 'terminating']);
    const activeByProvider = new Map<number, number>();
    for (const node of this.db.unwrap(capacity, 'Unable to load provider capacity')) {
      if (node.provider_id) activeByProvider.set(node.provider_id, (activeByProvider.get(node.provider_id) || 0) + 1);
    }
    return rows.map((row: any) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      apiBaseUrl: row.api_base_url,
      status: row.status,
      maxSandboxes: row.max_sandboxes,
      reservedReplacementSlots: row.reserved_replacement_slots,
      maxConcurrentProvisions: row.max_concurrent_provisions,
      keyCount: Number((Array.isArray(row.provider_api_keys) ? row.provider_api_keys[0] : row.provider_api_keys)?.count || 0),
      resourceCount: Number((Array.isArray(row.resources) ? row.resources[0] : row.resources)?.count || 0),
      activeSandboxes: activeByProvider.get(row.id) || 0,
    }));
  }

  async createProvider(dto: CreateProviderDto) {
    this.validateProviderCapacity(dto.maxSandboxes, dto.reservedReplacementSlots);
    const result = await this.db.client.from('proxy_providers').insert({
      code: dto.code.toLowerCase(), name: dto.name, api_base_url: dto.apiBaseUrl || null, status: dto.status || 'active',
      max_sandboxes: dto.maxSandboxes || null,
      reserved_replacement_slots: dto.reservedReplacementSlots ?? 1,
      max_concurrent_provisions: dto.maxConcurrentProvisions ?? 2,
    }).select('id,code,name,api_base_url,status,max_sandboxes,reserved_replacement_slots,max_concurrent_provisions').single();
    if (result.error?.code === '23505') throw new ConflictException('Provider code already exists');
    const row = this.db.unwrap(result, 'Unable to create provider');
    return { id: row.id, code: row.code, name: row.name, apiBaseUrl: row.api_base_url, status: row.status, maxSandboxes: row.max_sandboxes, reservedReplacementSlots: row.reserved_replacement_slots, maxConcurrentProvisions: row.max_concurrent_provisions, keyCount: 0, resourceCount: 0, activeSandboxes: 0 };
  }

  async updateProvider(id: number, dto: UpdateProviderDto) {
    const existingResult = await this.db.client.from('proxy_providers').select('max_sandboxes,reserved_replacement_slots').eq('id', id).maybeSingle();
    const existing = this.db.unwrap(existingResult, 'Unable to validate provider capacity');
    if (!existing) throw new NotFoundException('Provider not found');
    this.validateProviderCapacity(dto.maxSandboxes ?? existing.max_sandboxes ?? undefined, dto.reservedReplacementSlots ?? existing.reserved_replacement_slots);
    const values: Record<string, unknown> = {};
    if (dto.code !== undefined) values.code = dto.code.toLowerCase();
    if (dto.name !== undefined) values.name = dto.name;
    if (dto.apiBaseUrl !== undefined) values.api_base_url = dto.apiBaseUrl || null;
    if (dto.status !== undefined) values.status = dto.status;
    if (dto.maxSandboxes !== undefined) values.max_sandboxes = dto.maxSandboxes;
    if (dto.reservedReplacementSlots !== undefined) values.reserved_replacement_slots = dto.reservedReplacementSlots;
    if (dto.maxConcurrentProvisions !== undefined) values.max_concurrent_provisions = dto.maxConcurrentProvisions;
    const result = await this.db.client.from('proxy_providers').update(values).eq('id', id).select('id,code,name,api_base_url,status,max_sandboxes,reserved_replacement_slots,max_concurrent_provisions').maybeSingle();
    if (result.error?.code === '23505') throw new ConflictException('Provider code already exists');
    const row = this.db.unwrap(result, 'Unable to update provider');
    if (!row) throw new NotFoundException('Provider not found');
    return { id: row.id, code: row.code, name: row.name, apiBaseUrl: row.api_base_url, status: row.status, maxSandboxes: row.max_sandboxes, reservedReplacementSlots: row.reserved_replacement_slots, maxConcurrentProvisions: row.max_concurrent_provisions };
  }

  private validateProviderCapacity(maxSandboxes?: number, reservedReplacementSlots?: number) {
    if (maxSandboxes !== undefined && reservedReplacementSlots !== undefined && reservedReplacementSlots >= maxSandboxes) {
      throw new BadRequestException('Reserved replacement slots must be lower than max sandboxes');
    }
  }

  async deleteProvider(id: number) {
    const result = await this.db.client.from('proxy_providers').delete().eq('id', id).select('id').maybeSingle();
    const row = this.db.unwrap(result, 'Unable to delete provider');
    if (!row) throw new NotFoundException('Provider not found');
  }

  async providerApiKeys() {
    const result = await this.db.client.from('provider_api_keys').select('id,provider_id,label,key_prefix,key_last4,status,created_at,proxy_providers(name)').order('created_at', { ascending: false });
    return this.db.unwrap(result, 'Unable to load provider API keys').map((row: any) => {
      const provider = Array.isArray(row.proxy_providers) ? row.proxy_providers[0] : row.proxy_providers;
      return { id: row.id, providerId: row.provider_id, providerName: provider?.name || 'Unknown', label: row.label, maskedKey: `${row.key_prefix}••••${row.key_last4}`, status: row.status, createdAt: row.created_at };
    });
  }

  async createProviderApiKey(providerId: number, dto: CreateProviderApiKeyDto) {
    const provider = await this.db.client.from('proxy_providers').select('id').eq('id', providerId).maybeSingle();
    if (!this.db.unwrap(provider, 'Unable to validate provider')) throw new NotFoundException('Provider not found');
    const encrypted = this.encryptProviderSecret(dto.secret);
    const result = await this.db.client.from('provider_api_keys').insert({ provider_id: providerId, label: dto.label, key_prefix: dto.secret.slice(0, 4), key_last4: dto.secret.slice(-4), ...encrypted }).select('id,provider_id,label,key_prefix,key_last4,status,created_at').single();
    const row = this.db.unwrap(result, 'Unable to save provider API key');
    return { id: row.id, providerId: row.provider_id, label: row.label, maskedKey: `${row.key_prefix}••••${row.key_last4}`, status: row.status, createdAt: row.created_at };
  }

  async revokeProviderApiKey(id: number) {
    const result = await this.db.client.from('provider_api_keys').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('id', id).select('id').maybeSingle();
    if (!this.db.unwrap(result, 'Unable to revoke provider API key')) throw new NotFoundException('Provider API key not found');
  }

  async proxySettings() {
    const result = await this.db.client.from('products').select('id,code,name,country_code,base_price,currency,is_active').eq('service_type', 'proxy').order('name');
    return this.db.unwrap(result, 'Unable to load proxy settings').map(row => ({ id: row.id, code: row.code, name: row.name, countryCode: row.country_code, basePrice: Number(row.base_price), currency: row.currency, isActive: row.is_active }));
  }

  async updateProxyPrice(id: number, dto: UpdateProxyPriceDto) {
    const result = await this.db.client.from('products').update({ base_price: dto.basePrice, currency: dto.currency }).eq('id', id).eq('service_type', 'proxy').select('id,code,name,country_code,base_price,currency,is_active').maybeSingle();
    const row = this.db.unwrap(result, 'Unable to update proxy price');
    if (!row) throw new NotFoundException('Proxy product not found');
    return { id: row.id, code: row.code, name: row.name, countryCode: row.country_code, basePrice: Number(row.base_price), currency: row.currency, isActive: row.is_active };
  }

  async generalSettings() {
    const result = await this.db.client.from('app_settings').select('key,value').in('key', ['site_name', 'support_email', 'default_currency', 'usd_to_idr_rate']);
    const rows = this.db.unwrap(result, 'Unable to load settings');
    const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
    const usdToIdrRate = Number(values.usd_to_idr_rate);
    return {
      siteName: String(values.site_name || 'Nodenesia'),
      supportEmail: String(values.support_email || ''),
      defaultCurrency: String(values.default_currency || 'USD'),
      usdToIdrRate: Number.isFinite(usdToIdrRate) && usdToIdrRate > 0 ? usdToIdrRate : 16000,
    };
  }

  async updateGeneralSettings(dto: UpdateGeneralSettingsDto) {
    const rows = [
      { key: 'site_name', value: dto.siteName },
      { key: 'support_email', value: dto.supportEmail || '' },
      { key: 'default_currency', value: dto.defaultCurrency },
      { key: 'usd_to_idr_rate', value: dto.usdToIdrRate },
    ];
    const result = await this.db.client.from('app_settings').upsert(rows, { onConflict: 'key' });
    if (result.error) throw result.error;
    return this.generalSettings();
  }

  private encryptProviderSecret(secret: string) {
    const configured = this.config.get<string>('PROVIDER_SECRET_ENCRYPTION_KEY');
    if (!configured || configured.length < 32) throw new BadRequestException('PROVIDER_SECRET_ENCRYPTION_KEY must contain at least 32 characters');
    const key = createHash('sha256').update(configured).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return { secret_ciphertext: ciphertext.toString('base64'), secret_iv: iv.toString('base64'), secret_tag: cipher.getAuthTag().toString('base64') };
  }

  private productValues(dto: CreateProductDto | UpdateProductDto) {
    const values: Record<string, unknown> = {};
    if (dto.categoryId !== undefined) values.category_id = dto.categoryId;
    if (dto.code !== undefined) values.code = dto.code.toLowerCase();
    if (dto.name !== undefined) values.name = dto.name;
    if (dto.sku !== undefined) values.sku = dto.sku || null;
    if (dto.description !== undefined) values.description = dto.description;
    if (dto.productKind !== undefined) values.product_kind = dto.productKind;
    if (dto.fulfillmentType !== undefined) values.fulfillment_type = dto.fulfillmentType;
    if (dto.serviceType !== undefined) values.service_type = dto.serviceType;
    if (dto.countryCode !== undefined) values.country_code = dto.countryCode || null;
    if (dto.basePrice !== undefined) values.base_price = dto.basePrice;
    if (dto.currency !== undefined) values.currency = dto.currency.toUpperCase();
    if (dto.stockQuantity !== undefined) values.stock_quantity = dto.stockQuantity;
    if (dto.imageUrl !== undefined) values.image_url = dto.imageUrl || null;
    if (dto.isActive !== undefined) values.is_active = dto.isActive;
    if (dto.isFeatured !== undefined) values.is_featured = dto.isFeatured;
    return values;
  }

  private mapProduct(row: any) {
    const category = Array.isArray(row.categories) ? row.categories[0] : row.categories;
    return {
      id: row.id,
      categoryId: row.category_id,
      categoryName: category?.name || 'Uncategorized',
      code: row.code,
      sku: row.sku,
      name: row.name,
      description: row.description,
      serviceType: row.service_type,
      countryCode: row.country_code,
      productKind: row.product_kind,
      fulfillmentType: row.fulfillment_type,
      basePrice: Number(row.base_price),
      currency: row.currency,
      stockQuantity: row.stock_quantity,
      imageUrl: row.image_url,
      isActive: row.is_active,
      isFeatured: row.is_featured,
    };
  }

  async apiKeys() {
    const result = await this.db.client.from('api_keys').select('id,label,prefix,request_count,status').order('created_at', { ascending: false });
    return this.db.unwrap(result, 'Unable to load API keys').map(row => ({ id: row.id, label: row.label, prefix: row.prefix, requests: row.request_count, status: row.status }));
  }

  async createApiKey(profileId: number, label: string) {
    const secret = `pn_sbx_${randomBytes(24).toString('base64url')}`;
    const prefix = secret.slice(0, 12);
    const result = await this.db.client.from('api_keys').insert({ profile_id: profileId, label, prefix, key_hash: createHash('sha256').update(secret).digest('hex') }).select('id,label,prefix,request_count,status').single();
    const row = this.db.unwrap(result, 'Unable to create API key');
    return { id: row.id, label: row.label, prefix: row.prefix, requests: row.request_count, status: row.status, secret };
  }

  async revokeApiKey(id: number) {
    const result = await this.db.client.from('api_keys').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('id', id).select('id').maybeSingle();
    if (!this.db.unwrap(result, 'Unable to revoke API key')) throw new NotFoundException('API key not found');
  }

  async orders() {
    const result = await this.db.client.from('orders').select(orderSelect).order('created_at', { ascending: false });
    return this.db.unwrap(result, 'Unable to load orders').map((row: any) => {
      const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      return { ...mapOrder(row), customerEmail: profile?.email || 'Unknown customer' };
    });
  }

  async updateOrder(id: number, status: 'active' | 'rejected', actorId: number) {
    const transition = await this.db.client.rpc('transition_order', { target_order_id: id, next_status: status, actor_profile_id: actorId });
    if (transition.error) throw new ConflictException(transition.error.message);
    const result = await this.db.client.from('orders').select(orderSelect).eq('id', id).maybeSingle();
    const row = this.db.unwrap(result, 'Unable to reload order') as any;
    if (!row) throw new NotFoundException('Order not found');
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    return { ...mapOrder(row), customerEmail: profile?.email || 'Unknown customer' };
  }
}
