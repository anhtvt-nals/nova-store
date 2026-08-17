import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { mapOrder } from '../../common/mappers';
import { DatabaseService } from '../database/database.service';
import type { AuthUser } from '../auth/auth.types';
import type { CreateBlaxelEgressGatewayDto, CreateCategoryDto, CreateProductDto, CreateProviderApiKeyDto, CreateProviderDto, CreateUserDto, UpdateBlaxelEgressGatewayDto, UpdateCategoryDto, UpdateGeneralSettingsDto, UpdateProductDto, UpdateProviderApiKeyDto, UpdateProviderDto, UpdateProxyPriceDto, UpdateUserDto } from './admin.dto';

const orderSelect = 'id,profile_id,order_group_id,amount,unit_price,node_count,rental_days,status,payment_method,created_at,activated_at,expires_at,plan_name_snapshot,resource_name_snapshot,profiles(email),products(code,name,service_type),resources(name)';

// Generates a random strong password for newly created accounts and admin
// password resets. Each character is picked with crypto.randomInt (unbiased),
// and the charset guarantees upper/lower/digit/symbol variety.
function generateStrongPassword(length = 20) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+';
  let password = '';
  for (let index = 0; index < length; index += 1) password += charset[randomInt(charset.length)];
  return password;
}

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
    const today = new Date().toISOString().slice(0, 10);
    const [profiles, orders, usage] = await Promise.all([
      this.db.client.from('profiles').select('id,name,email,status,is_trial').neq('role', 'admin').order('created_at', { ascending: false }),
      this.db.client.from('orders').select('profile_id,plan_name_snapshot,created_at').eq('status', 'active').order('created_at', { ascending: false }),
      this.db.client.from('usage_daily').select('profile_id,usage_date,requests,successful_requests'),
    ]);
    const rows = this.db.unwrap(profiles, 'Unable to load users');
    const activeOrders = this.db.unwrap(orders, 'Unable to load user plans');
    const usageRows = this.db.unwrap(usage, 'Unable to load user usage') as Array<{ profile_id: number; usage_date: string; requests: number; successful_requests: number }>;
    const usageByProfile = new Map<number, { requests: number; successful: number; today: number }>();
    for (const entry of usageRows) {
      const current = usageByProfile.get(entry.profile_id) || { requests: 0, successful: 0, today: 0 };
      current.requests += Number(entry.requests || 0);
      current.successful += Number(entry.successful_requests || 0);
      if (entry.usage_date === today) current.today += Number(entry.requests || 0);
      usageByProfile.set(entry.profile_id, current);
    }
    return rows.map(profile => ({
      id: profile.id,
      name: profile.name,
      email: profile.email,
      status: profile.status,
      isTrial: profile.is_trial,
      planName: activeOrders.find(order => order.profile_id === profile.id)?.plan_name_snapshot || 'No active plan',
      usage: usageByProfile.get(profile.id) || { requests: 0, successful: 0, today: 0 },
    }));
  }

  async createUser(dto: CreateUserDto) {
    const email = dto.email.toLowerCase();
    const temporaryPassword = generateStrongPassword();
    const created = await this.db.client.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { name: dto.name },
    });
    if (created.error) {
      if (/already|registered|exists/i.test(created.error.message)) throw new ConflictException('Email already exists');
      throw new ConflictException(created.error.message);
    }
    const result = await this.db.client.from('profiles').select('id,name,email,status,is_trial').eq('auth_user_id', created.data.user.id).maybeSingle();
    const profile = this.db.unwrap(result, 'Account was created but its profile could not be loaded');
    if (!profile) throw new NotFoundException('Account profile was not created');
    return { id: profile.id, name: profile.name, email: profile.email, status: profile.status, isTrial: profile.is_trial, planName: 'No active plan', temporaryPassword };
  }

  async resetUserPassword(id: number) {
    const profileResult = await this.db.client.from('profiles').select('id,auth_user_id,role').eq('id', id).maybeSingle();
    const profile = this.db.unwrap(profileResult, 'Unable to load user');
    if (!profile) throw new NotFoundException('User not found');
    if (profile.role === 'admin') throw new BadRequestException('Cannot reset an administrator password from this endpoint');
    if (!profile.auth_user_id) throw new ConflictException('User has no login account to reset');
    const temporaryPassword = generateStrongPassword();
    const updated = await this.db.client.auth.admin.updateUserById(profile.auth_user_id, { password: temporaryPassword });
    if (updated.error) throw new ConflictException(`Unable to reset password: ${updated.error.message}`);
    return { id, temporaryPassword };
  }

  async updateUser(id: number, dto: UpdateUserDto) {
    const update: Record<string, unknown> = {};
    if (dto.name !== undefined) update.name = dto.name;
    if (dto.status !== undefined) update.status = dto.status;
    if (dto.isTrial !== undefined) update.is_trial = dto.isTrial;
    if (!Object.keys(update).length) throw new BadRequestException('No user fields to update');
    const result = await this.db.client.from('profiles').update(update).eq('id', id).select('id,name,email,status,is_trial').maybeSingle();
    const profile = this.db.unwrap(result, 'Unable to update user');
    if (!profile) throw new NotFoundException('User not found');
    return { id: profile.id, name: profile.name, email: profile.email, status: profile.status, isTrial: profile.is_trial, planName: 'No active plan' };
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

  async credits(requestedPage?: number, requestedPageSize?: number) {
    const page = Number.isInteger(requestedPage) ? Math.max(1, Math.min(requestedPage!, 10_000)) : 1;
    const pageSize = Number.isInteger(requestedPageSize) ? Math.max(1, Math.min(requestedPageSize!, 50)) : 5;
    const from = (page - 1) * pageSize;
    const result = await this.db.client.from('profiles')
      .select('id,name,email,is_trial,credit_wallets(balance,updated_at)', { count: 'exact' })
      .order('created_at', { ascending: false }).range(from, from + pageSize - 1);
    const items = this.db.unwrap(result, 'Unable to load credit wallets').map((row: any) => {
      const wallet = Array.isArray(row.credit_wallets) ? row.credit_wallets[0] : row.credit_wallets;
      return { id: row.id, name: row.name, email: row.email, isTrial: row.is_trial, balance: Number(wallet?.balance || 0), updatedAt: wallet?.updated_at || null };
    });
    const total = result.count || 0;
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async adjustCredit(profileId: number, amount: number, note: string, actorProfileId: number) {
    if (!Number.isFinite(amount) || amount === 0) throw new BadRequestException('Credit adjustment cannot be zero');
    if (amount < 0 && !note.trim()) throw new BadRequestException('A deduction note is required');
    const result = await this.db.client.rpc('grant_profile_credits', {
      target_profile_id: profileId, credit_amount: amount, entry_type: amount > 0 ? 'admin_grant' : 'admin_adjustment', entry_note: note, actor_profile_id: actorProfileId, entry_reference: null,
    });
    const balance = Number(this.db.unwrap(result, 'Unable to adjust credit'));
    return { profileId, balance };
  }

  async topUpCredit(profileId: number, amount: number, currency: 'USD' | 'IDR', note: string, actorProfileId: number) {
    const settingsResult = await this.db.client.from('app_settings').select('key,value').in('key', ['credits_per_usd', 'usd_to_idr_rate']);
    const settings = this.db.unwrap(settingsResult, 'Unable to load credit conversion settings');
    const values = Object.fromEntries(settings.map(row => [row.key, Number(row.value)]));
    const creditsPerUsd = values.credits_per_usd;
    const usdToIdrRate = values.usd_to_idr_rate;
    if (!Number.isFinite(creditsPerUsd) || creditsPerUsd <= 0 || !Number.isFinite(usdToIdrRate) || usdToIdrRate <= 0) {
      throw new BadRequestException('Credit conversion settings are invalid');
    }
    const creditAmount = Number((currency === 'USD' ? amount * creditsPerUsd : (amount / usdToIdrRate) * creditsPerUsd).toFixed(2));
    if (!Number.isFinite(creditAmount) || creditAmount <= 0) throw new BadRequestException('Top-up amount is too small');
    return this.adjustCredit(profileId, creditAmount, note, actorProfileId);
  }

  async deductCredit(profileId: number, amount: number, note: string, actorProfileId: number) {
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Credit deduction must be greater than zero');
    if (!note.trim()) throw new BadRequestException('A deduction note is required');
    // grant_profile_credits locks the wallet and rejects a negative result, so
    // concurrent checkout cannot make a balance fall below zero.
    return this.adjustCredit(profileId, -amount, note.trim(), actorProfileId);
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

  private validateProviderCapacity(maxSandboxes?: number | null, reservedReplacementSlots?: number) {
    if (maxSandboxes !== undefined && maxSandboxes !== null && reservedReplacementSlots !== undefined && reservedReplacementSlots >= maxSandboxes) {
      throw new BadRequestException('Reserved replacement slots must be lower than max sandboxes');
    }
  }

  async deleteProvider(id: number) {
    const result = await this.db.client.from('proxy_providers').delete().eq('id', id).select('id').maybeSingle();
    const row = this.db.unwrap(result, 'Unable to delete provider');
    if (!row) throw new NotFoundException('Provider not found');
  }

  async providerApiKeys() {
    const result = await this.db.client.from('provider_api_keys').select('id,provider_id,label,key_prefix,key_last4,status,max_sandboxes,created_at,revoked_reason,proxy_providers(name)').order('created_at', { ascending: false });
    return this.db.unwrap(result, 'Unable to load provider API keys').map((row: any) => {
      const provider = Array.isArray(row.proxy_providers) ? row.proxy_providers[0] : row.proxy_providers;
      return { id: row.id, providerId: row.provider_id, providerName: provider?.name || 'Unknown', label: row.label, maskedKey: `${row.key_prefix}••••${row.key_last4}`, status: row.status, maxSandboxes: row.max_sandboxes, createdAt: row.created_at, revokedReason: row.revoked_reason || null };
    });
  }

  async provisioningJobs(requestedPage?: number) {
    const page = Number.isInteger(requestedPage) ? Math.max(1, Math.min(requestedPage!, 10_000)) : 1;
    const pageSize = 20;
    const from = (page - 1) * pageSize;
    // proxy_provisioning_jobs stores only the latest failure and clears it on
    // success/requeue. proxy_node_events is the append-only history, so use it
    // for an operational error log that survives subsequent retries.
    const result = await this.db.client.from('proxy_node_events')
      .select('id,node_id,event_type,payload,created_at,proxy_nodes(id,order_id,status,provider_id,proxy_providers(name,code))', { count: 'exact' })
      .not('payload->>errorMessage', 'is', null)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    const rows = this.db.unwrap(result, 'Unable to load provisioning jobs').map((row: any) => {
      const node = Array.isArray(row.proxy_nodes) ? row.proxy_nodes[0] : row.proxy_nodes;
      const provider = Array.isArray(node?.proxy_providers) ? node.proxy_providers[0] : node?.proxy_providers;
      const payload = row.payload || {};
      return {
        id: row.id,
        nodeId: row.node_id,
        orderId: node?.order_id || null,
        eventType: row.event_type,
        status: payload.status || node?.status || 'error',
        error: String(payload.errorMessage || ''),
        nodeStatus: node?.status || null,
        providerName: provider?.name || null,
        providerCode: provider?.code || null,
        createdAt: row.created_at,
      };
    });
    const total = result.count || 0;
    return { items: rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async createProviderApiKey(providerId: number, dto: CreateProviderApiKeyDto) {
    const provider = await this.db.client.from('proxy_providers').select('id,code').eq('id', providerId).maybeSingle();
    if (!this.db.unwrap(provider, 'Unable to validate provider')) throw new NotFoundException('Provider not found');
    const storedSecret = dto.secret.trim();
    const blaxelWorkspace = provider.data?.code === 'blaxel' ? this.blaxelWorkspace(storedSecret) : null;
    const githubOwner = provider.data?.code === 'github' ? this.githubOwner(storedSecret) : null;
    const encrypted = this.encryptProviderSecret(storedSecret);
    const result = await this.db.client.from('provider_api_keys').insert({
      provider_id: providerId,
      label: dto.label,
      key_prefix: githubOwner ? `${githubOwner}|` : blaxelWorkspace ? `${blaxelWorkspace}|` : storedSecret.slice(0, 4),
      key_last4: storedSecret.slice(-4),
      max_sandboxes: dto.maxSandboxes ?? 10,
      ...encrypted,
    }).select('id,provider_id,label,key_prefix,key_last4,status,max_sandboxes,created_at').single();
    const row = this.db.unwrap(result, 'Unable to save provider API key');
    if (githubOwner) {
      const repository = `nodenesia-gost-${row.id}`;
      try {
        await this.ensureGithubSandboxRepository(githubOwner, storedSecret.slice(storedSecret.indexOf('|') + 1), repository);
        const update = await this.db.client.from('provider_api_keys').update({ github_repository: repository }).eq('id', row.id);
        if (update.error) throw update.error;
      } catch (error) {
        await this.db.client.from('provider_api_keys').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('id', row.id);
        throw error;
      }
    }
    return { id: row.id, providerId: row.provider_id, label: row.label, maskedKey: `${row.key_prefix}••••${row.key_last4}`, status: row.status, maxSandboxes: row.max_sandboxes, createdAt: row.created_at };
  }

  async updateProviderApiKey(id: number, dto: UpdateProviderApiKeyDto) {
    const result = await this.db.client.from('provider_api_keys').update({ max_sandboxes: dto.maxSandboxes }).eq('id', id)
      .select('id,provider_id,label,key_prefix,key_last4,status,max_sandboxes,created_at,revoked_reason,proxy_providers(name)').maybeSingle();
    const row: any = this.db.unwrap(result, 'Unable to update provider API key');
    if (!row) throw new NotFoundException('Provider API key not found');
    const provider = Array.isArray(row.proxy_providers) ? row.proxy_providers[0] : row.proxy_providers;
    return { id: row.id, providerId: row.provider_id, providerName: provider?.name || 'Unknown', label: row.label, maskedKey: `${row.key_prefix}••••${row.key_last4}`, status: row.status, maxSandboxes: row.max_sandboxes, createdAt: row.created_at, revokedReason: row.revoked_reason || null };
  }

  private githubOwner(secret: string) {
    const separator = secret.indexOf('|');
    if (separator < 1 || separator !== secret.lastIndexOf('|')) {
      throw new BadRequestException('GitHub provider secret must use GITHUB_OWNER|GITHUB_API_KEY');
    }
    const owner = secret.slice(0, separator).trim();
    const apiKey = secret.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9-]+$/.test(owner) || apiKey.length < 8) {
      throw new BadRequestException('GitHub provider secret must use a valid owner and API key');
    }
    return owner;
  }

  private blaxelWorkspace(secret: string) {
    const separator = secret.indexOf('|');
    if (separator < 1 || separator !== secret.lastIndexOf('|')) {
      throw new BadRequestException('Blaxel provider secret must use BLAXEL_WORKSPACE|BLAXEL_API_KEY');
    }
    const workspace = secret.slice(0, separator).trim();
    const apiKey = secret.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(workspace) || apiKey.length < 8) {
      throw new BadRequestException('Blaxel provider secret must use a valid workspace and API key');
    }
    return workspace;
  }

  private async ensureGithubSandboxRepository(owner: string, apiKey: string, repository: string) {
    const controlPlaneUrl = String(this.config.get('GITHUB_CONTROL_PLANE_URL') || '').replace(/\/$/, '');
    if (!/^https:\/\//.test(controlPlaneUrl)) throw new BadRequestException('GITHUB_CONTROL_PLANE_URL must be an HTTPS URL before adding a GitHub provider key');
    const user = await this.githubRequest<{ login?: string }>('/user', apiKey, 'GET', [200]);
    if (user.login?.toLowerCase() !== owner.toLowerCase()) {
      throw new BadRequestException('The owner in the GitHub provider secret must match the API key owner');
    }

    const existing = await this.githubRequest(`/repos/${owner}/${repository}`, apiKey, 'GET', [200, 404]);
    if (existing.status !== 200) {
      await this.githubRequest('/user/repos', apiKey, 'POST', [201], { name: repository, description: 'Public short-lived GOST v3 runner for Nodenesia', private: false, auto_init: false, has_issues: false, has_projects: false, has_wiki: false });
      await this.githubRequest(`/repos/${owner}/${repository}/contents/.github/workflows/gost-sandbox.yml`, apiKey, 'PUT', [201], {
        message: 'Add Nodenesia GOST runner workflow',
        content: Buffer.from(this.githubGostWorkflow()).toString('base64'),
      });
    }
    const variablePath = `/repos/${owner}/${repository}/actions/variables/NODENESIA_CONTROL_PLANE_URL`;
    const updated = await this.githubRequest(variablePath, apiKey, 'PATCH', [204, 404], { name: 'NODENESIA_CONTROL_PLANE_URL', value: controlPlaneUrl });
    if (updated.status === 404) await this.githubRequest(`/repos/${owner}/${repository}/actions/variables`, apiKey, 'POST', [201], { name: 'NODENESIA_CONTROL_PLANE_URL', value: controlPlaneUrl });
  }

  private async githubRequest<T extends Record<string, unknown> = Record<string, unknown>>(
    path: string,
    apiKey: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    expectedStatuses: number[],
    body?: Record<string, unknown>,
  ): Promise<T & { status: number }> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${apiKey}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({})) as T;
    if (expectedStatuses.includes(response.status)) return { ...payload, status: response.status };
    if (response.status === 401 || response.status === 403) throw new BadRequestException('GitHub API key is invalid or lacks repository access');
    if (response.status === 404) throw new BadRequestException('GitHub repository setup resource was not found or is not accessible to this API key');
    if (response.status === 422) throw new BadRequestException('GitHub could not create the Nodenesia sandbox repository; verify the account permissions and repository name');
    throw new BadRequestException(`GitHub repository setup failed (${response.status})`);
  }

  private githubGostWorkflow() {
    // Ordinary quoted strings deliberately keep shell `${...}` expressions literal.
    return [
      'name: Nodenesia GOST sandbox',
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      task_id: { required: true, type: string }',
      'permissions:',
      '  contents: read',
      '  id-token: write',
      'jobs:',
      '  run-gost:',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 60',
      '    steps:',
      '      - shell: bash',
      '        env:',
      '          TASK_ID: ${{ inputs.task_id }}',
      '          CONTROL_PLANE_URL: ${{ vars.NODENESIA_CONTROL_PLANE_URL }}',
      '          OIDC_AUDIENCE: nodenesia-gost-control-plane',
      '        run: |',
      '          set -euo pipefail',
      '          response="$(curl --fail --silent --show-error -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}")"',
      "          oidc_token=\"$(jq -er '.value' <<<\"$response\")\"",
      "          curl --fail --silent --show-error --retry 3 --retry-all-errors -H \"Authorization: Bearer $oidc_token\" -H 'Content-Type: application/json' --data \"{\\\"runId\\\":${GITHUB_RUN_ID}}\" \"${CONTROL_PLANE_URL}/tasks/${TASK_ID}/config\" > \"$RUNNER_TEMP/nodenesia-gost.json\"",
      '          config="$RUNNER_TEMP/nodenesia-gost.json"',
      '          get() { jq -er "$1" "$config"; }',
      "          enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=\"\"))' \"$1\"; }",
      "          version=\"$(get '.gost.version')\"; local_port=\"$(get '.gost.localPort')\"; bind_port=\"$(get '.gost.bindPort')\"",
      "          master_host=\"$(get '.gost.masterHost')\"; rendezvous_port=\"$(get '.gost.rendezvousPort')\"; transport=\"$(get '.gost.tunnelTransport')\"",
      "          ws_path=\"$(jq -r '.gost.wsPath // \"/ws\"' \"$config\")\"; tls_server_name=\"$(jq -r '.gost.tlsServerName // empty' \"$config\")\"",
      "          socks_user=\"$(enc \"$(get '.gost.socksUsername')\")\"; socks_pass=\"$(enc \"$(get '.gost.socksPassword')\")\"",
      "          tunnel_user=\"$(enc \"$(get '.gost.tunnelUsername')\")\"; tunnel_pass=\"$(enc \"$(get '.gost.tunnelPassword')\")\"",
      '          scheme=socks5; [[ "$transport" == tcp ]] || scheme="socks5+$transport"',
      '          query=""; [[ "$transport" == tcp ]] || query="?path=$(enc "$ws_path")"',
      '          [[ "$transport" != wss ]] || query+="&secure=true&serverName=$(enc "${tls_server_name:-$master_host}")"',
      '          curl -fsSL -o /tmp/gost.tgz "https://github.com/go-gost/gost/releases/download/v$version/gost_${version}_linux_amd64.tar.gz"',
      '          tar -xzf /tmp/gost.tgz -C /tmp gost; chmod +x /tmp/gost',
      "          trap 'jobs -pr | xargs -r kill || true; rm -f \"$config\"' EXIT INT TERM",
      '          /tmp/gost -L="socks5://$socks_user:$socks_pass@127.0.0.1:$local_port" >/tmp/gost-socks.log 2>&1 &',
      '          /tmp/gost -L="rtcp://:$bind_port/127.0.0.1:$local_port" -F="$scheme://$tunnel_user:$tunnel_pass@$master_host:$rendezvous_port$query" >/tmp/gost-tunnel.log 2>&1 &',
      '          sleep 3180',
      '',
    ].join('\n');
  }

  async revokeProviderApiKey(id: number) {
    const result = await this.db.client.from('provider_api_keys').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('id', id).select('id').maybeSingle();
    if (!this.db.unwrap(result, 'Unable to revoke provider API key')) throw new NotFoundException('Provider API key not found');
  }

  async blaxelEgressGateways() {
    const result = await this.db.client.from('blaxel_egress_gateways')
      .select('id,provider_api_key_id,name,region,status,created_at,provider_api_keys(label,key_prefix,key_last4,proxy_providers(code,name)),blaxel_egress_gateway_leases(node_id,status)')
      .order('provider_api_key_id').order('name');
    return this.db.unwrap(result, 'Unable to load Blaxel egress gateways').map((row: any) => {
      const key = Array.isArray(row.provider_api_keys) ? row.provider_api_keys[0] : row.provider_api_keys;
      const provider = Array.isArray(key?.proxy_providers) ? key.proxy_providers[0] : key?.proxy_providers;
      const lease = Array.isArray(row.blaxel_egress_gateway_leases) ? row.blaxel_egress_gateway_leases[0] : row.blaxel_egress_gateway_leases;
      return { id: row.id, providerApiKeyId: row.provider_api_key_id, name: row.name, region: row.region, status: row.status, createdAt: row.created_at, accountLabel: key?.label || 'Unknown', accountMaskedKey: key ? `${key.key_prefix}••••${key.key_last4}` : '', providerName: provider?.name || 'Blaxel', leasedNodeId: lease?.node_id || null, leaseStatus: lease?.status || null };
    });
  }

  async createBlaxelEgressGateway(dto: CreateBlaxelEgressGatewayDto) {
    const keyResult = await this.db.client.from('provider_api_keys').select('id,proxy_providers(code)').eq('id', dto.providerApiKeyId).eq('status', 'active').maybeSingle();
    const key = this.db.unwrap(keyResult, 'Unable to validate Blaxel provider API key') as any;
    const provider = Array.isArray(key?.proxy_providers) ? key.proxy_providers[0] : key?.proxy_providers;
    if (!key || provider?.code !== 'blaxel') throw new BadRequestException('Select an active Blaxel provider API key');
    const result = await this.db.client.from('blaxel_egress_gateways').insert({ provider_api_key_id: dto.providerApiKeyId, name: dto.name, region: dto.region }).select('id,provider_api_key_id,name,region,status,created_at').single();
    if (result.error?.code === '23505') throw new ConflictException('This gateway is already registered for the selected Blaxel account');
    const row = this.db.unwrap(result, 'Unable to add Blaxel egress gateway');
    return { id: row.id, providerApiKeyId: row.provider_api_key_id, name: row.name, region: row.region, status: row.status, createdAt: row.created_at, leasedNodeId: null, leaseStatus: null };
  }

  async updateBlaxelEgressGateway(id: number, dto: UpdateBlaxelEgressGatewayDto) {
    const result = await this.db.client.from('blaxel_egress_gateways').update({ status: dto.status, updated_at: new Date().toISOString() }).eq('id', id).select('id,provider_api_key_id,name,region,status,created_at').maybeSingle();
    const row = this.db.unwrap(result, 'Unable to update Blaxel egress gateway');
    if (!row) throw new NotFoundException('Blaxel egress gateway not found');
    return row;
  }

  async deleteBlaxelEgressGateway(id: number) {
    const result = await this.db.client.from('blaxel_egress_gateways').delete().eq('id', id).select('id').maybeSingle();
    if (result.error?.code === '23503') throw new ConflictException('Release the node using this gateway before deleting it');
    if (!this.db.unwrap(result, 'Unable to delete Blaxel egress gateway')) throw new NotFoundException('Blaxel egress gateway not found');
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
    const result = await this.db.client.from('app_settings').select('key,value').in('key', ['site_name', 'support_email', 'default_currency', 'usd_to_idr_rate', 'credits_per_usd', 'trial_credit_amount']);
    const rows = this.db.unwrap(result, 'Unable to load settings');
    const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
    const usdToIdrRate = Number(values.usd_to_idr_rate);
    return {
      siteName: String(values.site_name || 'Nodenesia'),
      supportEmail: String(values.support_email || ''),
      defaultCurrency: String(values.default_currency || 'USD'),
      usdToIdrRate: Number.isFinite(usdToIdrRate) && usdToIdrRate > 0 ? usdToIdrRate : 16000,
      creditsPerUsd: Number(values.credits_per_usd) > 0 ? Number(values.credits_per_usd) : 100,
      trialCreditAmount: Number(values.trial_credit_amount) >= 0 ? Number(values.trial_credit_amount) : 100,
    };
  }

  async updateGeneralSettings(dto: UpdateGeneralSettingsDto) {
    const rows = [
      { key: 'site_name', value: dto.siteName },
      { key: 'support_email', value: dto.supportEmail || '' },
      { key: 'default_currency', value: dto.defaultCurrency },
      { key: 'usd_to_idr_rate', value: dto.usdToIdrRate },
      { key: 'credits_per_usd', value: dto.creditsPerUsd },
      { key: 'trial_credit_amount', value: dto.trialCreditAmount },
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

  async orders(requestedPage?: number, requestedPageSize?: number) {
    const page = Number.isInteger(requestedPage) ? Math.max(1, Math.min(requestedPage!, 10_000)) : 1;
    const pageSize = Number.isInteger(requestedPageSize) ? Math.max(1, Math.min(requestedPageSize!, 50)) : 5;
    const result = requestedPage === undefined
      ? await this.db.client.from('admin_order_queue').select('*').order('created_at', { ascending: false })
      : await this.db.client.from('admin_order_queue').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
    const items = this.db.unwrap(result, 'Unable to load orders').map((row: any) => {
      const isStaticResidential = row.source === 'static_residential';
      return {
        id: Number(row.source_id), source: row.source, orderKey: `${row.source}:${row.source_id}`,
        customerEmail: row.customer_email || 'Unknown customer', planName: row.plan_name,
        nodeCount: Number(row.node_count), rentalDays: Number(row.rental_days), quotaGb: row.quota_gb === null ? null : Number(row.quota_gb),
        status: row.status, paymentMethod: row.payment_method, amount: Number(row.amount), createdAt: row.created_at,
        activatedAt: row.activated_at, expiresAt: row.expires_at,
        productName: isStaticResidential ? 'Static Residential' : 'SOCKS5 Proxy', productCode: isStaticResidential ? 'static_residential' : 'proxy',
        serviceType: isStaticResidential ? 'static_residential' : 'proxy', nodeName: isStaticResidential ? '5 stable public ports' : `${row.node_count} proxy nodes`, unitPrice: null,
      };
    });
    if (requestedPage === undefined) return items;
    const total = result.count || 0;
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
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
