import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { supabase } from './supabase';

export type OrderStatus = 'pending' | 'provisioning' | 'active' | 'provisioning_failed' | 'expired' | 'rejected' | 'cancelled';

export interface Plan {
  id: number;
  name: string;
  description: string;
  price: number;
  durationHours: number;
  nodeCount: number;
  rotation: string;
  highlighted: boolean;
  unitPrice: number;
  currency: string;
  productId: number;
  productCode: string;
  productName: string;
  productDescription: string;
  serviceType: string;
}

export interface ProxyNode {
  id: number;
  orderGroupId: string | null;
  name: string;
  city: string;
  country: string;
  status: 'online' | 'offline' | 'maintenance';
  protocol: string;
  latencyMs: number;
  productId: number;
}
export type RuntimeProxyNodeStatus = 'queued' | 'provisioning' | 'online' | 'rotating' | 'degraded' | 'offline' | 'error' | 'expired' | 'terminating' | 'terminated';
export interface RuntimeProxyNode {
  id: number;
  orderId: number;
  status: RuntimeProxyNodeStatus;
  host: string | null;
  port: number | null;
  egressIp: string | null;
  egressCountryCode: string | null;
  lastHealthAt: string | null;
  lastStatusChangeAt: string;
  nextRotationAt: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  rotationUrl: string | null;
  connection: Pick<ConnectionDetails, 'username' | 'password' | 'protocol'> | null;
}
export interface ProxyNodeStreamEvent {
  id?: string;
  type: string;
  data: Record<string, unknown>;
}
export interface CatalogProduct {
  id: number;
  code: string;
  name: string;
  serviceType: string;
  countryCode: string | null;
  description: string;
  unitPrice: number;
  currency: string;
  imageUrl: string | null;
  isFeatured: boolean;
}

export interface Order {
  id: number;
  planName: string;
  nodeName: string;
  amount: number;
  unitPrice: number | null;
  nodeCount: number;
  rentalDays: number;
  status: OrderStatus;
  paymentMethod: 'bank_transfer' | 'crypto' | 'credit';
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string | null;
  productName: string;
  productCode: string;
  serviceType: string;
  countryCode?: string;
}

export interface StaticResidentialConnection { host: string; port: number; username: string; password: string; protocol: 'SOCKS5'; }
export interface StaticResidentialNode { id: number; port: number; status: 'active' | 'suspended' | 'expired' | 'quota_exceeded'; nextRotationAt: string; connection: StaticResidentialConnection | null; }
export interface StaticResidentialOrder {
  id: number; status: 'active' | 'quota_exceeded' | 'expired' | 'suspended' | 'cancelled'; nodeCount: 5; quotaBytes: number; usedBytes: number; quotaGb: 1 | 3 | 5;
  pricePerGbDay: number; amount: number; creditCost: number; activatedAt: string; expiresAt: string; createdAt: string; nodes: StaticResidentialNode[];
}
export interface StaticResidentialQuote { nodeCount: 5; quotaBytes: number; quotaGb: 1 | 3 | 5; rentalDays: number; pricePerGbDay: number; amount: number; creditCost: number; availableNodes: number; canFulfill: boolean; }
export interface StaticResidentialInventoryItem { id: number; label: string | null; host: string; port: number; username: string; status: 'available' | 'assigned' | 'disabled'; assigned_order_id: number | null; health_failure_count: number; last_health_checked_at: string | null; last_health_error: string | null; created_at: string; updated_at: string; }
export interface PaginatedStaticResidentialInventory { items: StaticResidentialInventoryItem[]; total: number; available: number; page: number; pageSize: number; totalPages: number; }
export interface StaticResidentialPricing { pricePerGbDay: number; fixedNodeCount: 5; quotaOptionsGb: Array<1 | 3 | 5>; }

export interface AdminOrder extends Order {
  customerEmail: string;
  source?: 'proxy' | 'static_residential';
  orderKey?: string;
  quotaGb?: number | null;
}
export interface PaginatedAdminOrders { items: AdminOrder[]; total: number; page: number; pageSize: number; totalPages: number; }
export interface ProvisioningJobLog {
  id: number; nodeId: number; orderId: number | null; eventType: string; status: string; error: string;
  nodeStatus: RuntimeProxyNodeStatus | null; providerName: string | null; providerCode: string | null; createdAt: string;
}
export interface PaginatedProvisioningJobs { items: ProvisioningJobLog[]; total: number; page: number; pageSize: 20; totalPages: number; }
export interface User {
  id: number;
  name: string;
  email: string;
  status: 'active' | 'suspended';
  isTrial?: boolean;
  planName: string;
  usage?: { requests: number; successful: number; today: number };
  temporaryPassword?: string;
}
export interface SandboxKey {
  id: number;
  label: string;
  prefix: string;
  secret?: string;
  requests: number;
  status: 'active' | 'revoked';
}
export interface ConnectionDetails {
  host: string;
  port: number;
  username: string;
  password: string;
  protocol: string;
  nextRotationAt: string;
}
export interface ClientOverview {
  displayName: string;
  activeNodes: number;
  requestsToday: number;
  totalRequests: number;
  totalBandwidthBytes: number;
  successRate: number;
  nextRotationAt: string | null;
  activeOrder: Order | null;
}
export interface AdminOverview {
  mrr: number;
  mrrChange: number;
  activeUsers: number;
  activeNodes: number;
  pendingOrders: number;
  successRate: number;
  recentActivity: Array<{
    id: number;
    title: string;
    detail: string;
    time: string;
    tone: 'success' | 'warning' | 'neutral';
  }>;
}
export interface CurrentUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'client';
  isTrial: boolean;
  aal: 'aal1' | 'aal2';
}
export interface OrderQuote {
  unitPrice: number;
  nodeCount: number;
  rentalDays: number;
  total: number;
  currency: string;
  creditCost: number | null;
  availableNodes: number;
  canFulfill: boolean;
}
export interface CreditBalance { balance: number; }
export interface ProxyConnectionExport { filename: string; content: string; count: number; }
export interface Category {
  id: number;
  slug: string;
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
}
export type ProductKind = 'account' | 'digital' | 'service' | 'other';
export type FulfillmentType = 'automatic' | 'manual' | 'service';
export interface AdminProduct {
  id: number;
  categoryId: number;
  categoryName: string;
  code: string;
  sku: string | null;
  name: string;
  description: string;
  serviceType: string;
  countryCode: string | null;
  productKind: ProductKind;
  fulfillmentType: FulfillmentType;
  basePrice: number;
  currency: string;
  stockQuantity: number | null;
  imageUrl: string | null;
  isActive: boolean;
  isFeatured: boolean;
}
export type CategoryInput = { name: string; slug: string; description?: string; isActive?: boolean; sortOrder?: number };
export type ProductInput = {
  categoryId: number;
  code: string;
  name: string;
  sku?: string;
  description?: string;
  productKind: ProductKind;
  fulfillmentType: FulfillmentType;
  serviceType: string;
  countryCode?: string;
  basePrice: number;
  currency: string;
  stockQuantity?: number;
  imageUrl?: string;
  isActive?: boolean;
  isFeatured?: boolean;
};
export interface ProxyProvider {
  id: number;
  code: string;
  name: string;
  apiBaseUrl: string | null;
  status: 'active' | 'disabled';
  keyCount: number;
  resourceCount: number;
  maxSandboxes: number | null;
  reservedReplacementSlots: number;
  maxConcurrentProvisions: number;
  activeSandboxes: number;
}

export type ProxyProviderInput = {
  name?: string;
  code?: string;
  apiBaseUrl?: string;
  status?: string;
  maxSandboxes?: number | null;
  reservedReplacementSlots?: number;
  maxConcurrentProvisions?: number;
};
export interface ProviderApiKey {
  id: number;
  providerId: number;
  providerName?: string;
  label: string;
  maskedKey: string;
  status: 'active' | 'revoked';
  maxSandboxes: number | null;
  createdAt: string;
  revokedReason?: string | null;
}
export interface ProxyPriceSetting {
  id: number;
  code: string;
  name: string;
  countryCode: string | null;
  basePrice: number;
  currency: string;
  isActive: boolean;
}
export interface GeneralSettings {
  siteName: string;
  supportEmail: string;
  defaultCurrency: string;
  usdToIdrRate: number;
  creditsPerUsd: number;
  trialCreditAmount: number;
}
export interface CreditWallet { id: number; name: string; email: string; isTrial: boolean; balance: number; updatedAt: string | null; }
export interface PaginatedCreditWallets { items: CreditWallet[]; total: number; page: number; pageSize: number; totalPages: number; }
export interface CatalogSettings {
  brandName: string;
  usdToIdrRate: number;
  creditsPerUsd: number;
}

type QueryConfig<T> = { query?: Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'> & { queryKey?: readonly unknown[] } };
type MutationConfig<T, V> = Omit<UseMutationOptions<T, Error, V>, 'mutationFn'>;
type TokenGetter = () => Promise<string | null>;
class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}
const getAccessToken: TokenGetter = async () => {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
};

async function request<T>(path: string, getToken?: TokenGetter, init?: RequestInit): Promise<T> {
  const token = getToken ? await getToken() : null;
  const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    // A suspended profile is rejected by the API with 401. Broadcasting this
    // lets AuthProvider clear the persisted Supabase session in every view.
    if (response.status === 401 && getToken && typeof window !== 'undefined') window.dispatchEvent(new Event('nodenesia:session-invalid'));
    const body = await response.json().catch(() => null) as { message?: string | string[] } | null;
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    throw new ApiRequestError(message || `Request failed (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const query = <T>(key: readonly unknown[], path: string, getToken: TokenGetter | undefined, config?: QueryConfig<T>) =>
  useQuery<T, Error>({ queryKey: config?.query?.queryKey || key, queryFn: () => request<T>(path, getToken), ...config?.query });

export const getListPlansQueryKey = () => ['plans'] as const;
export const getListProductsQueryKey = () => ['catalog-products'] as const;
export const getCatalogSettingsQueryKey = () => ['catalog-settings'] as const;
export const getListNodesQueryKey = () => ['nodes'] as const;
export const getListClientProxyNodesQueryKey = () => ['client-proxy-nodes'] as const;
export const getGetClientOverviewQueryKey = () => ['client-overview'] as const;
export const getListClientOrdersQueryKey = () => ['client-orders'] as const;
export const getGetOrderConnectionQueryKey = (id: number, nodeId?: number) => ['order-connection', id, nodeId ?? 'default'] as const;
export const getOrderQuoteQueryKey = (productId: number, nodeCount: number, rentalDays: number) => ['order-quote', productId, nodeCount, rentalDays] as const;
export const getCreditBalanceQueryKey = () => ['credit-balance'] as const;
export const getStaticResidentialOrdersQueryKey = () => ['static-residential-orders'] as const;
export const getStaticResidentialQuoteQueryKey = (days: number, quotaGb: number) => ['static-residential-quote', days, quotaGb] as const;
export const getStaticResidentialInventoryQueryKey = (page?: number, pageSize?: number) => page === undefined
  ? ['static-residential-inventory'] as const
  : ['static-residential-inventory', page, pageSize] as const;
export const getStaticResidentialPricingQueryKey = () => ['static-residential-pricing'] as const;
export const getGetAdminOverviewQueryKey = () => ['admin-overview'] as const;
export const getListUsersQueryKey = () => ['users'] as const;
export const getListSandboxKeysQueryKey = () => ['sandbox-keys'] as const;
export const getListAdminOrdersQueryKey = () => ['admin-orders'] as const;
export const getPaginatedAdminOrdersQueryKey = (page: number, pageSize: number) => ['admin-orders', page, pageSize] as const;
export const getListCategoriesQueryKey = () => ['admin-categories'] as const;
export const getListAdminProductsQueryKey = () => ['admin-products'] as const;
export const getListProvidersQueryKey = () => ['proxy-providers'] as const;
export const getListProviderApiKeysQueryKey = () => ['provider-api-keys'] as const;
export const getProvisioningJobsQueryKey = (page: number) => ['provisioning-jobs', page] as const;
export const getProxySettingsQueryKey = () => ['proxy-settings'] as const;
export const getGeneralSettingsQueryKey = () => ['general-settings'] as const;
export const getCreditWalletsQueryKey = (page?: number, pageSize?: number) => page === undefined
  ? ['credit-wallets'] as const
  : ['credit-wallets', page, pageSize] as const;
export const getCurrentUserQueryKey = () => ['current-user'] as const;

export function useListPlans(config?: QueryConfig<Plan[]>) {
  return query(getListPlansQueryKey(), '/catalog/plans', undefined, config);
}
export function useListProducts(config?: QueryConfig<CatalogProduct[]>) {
  return query(getListProductsQueryKey(), '/catalog/products', undefined, config);
}
export function useCatalogSettings(config?: QueryConfig<CatalogSettings>) {
  return query(getCatalogSettingsQueryKey(), '/catalog/settings', undefined, config);
}
export function useListNodes(_params?: unknown, config?: QueryConfig<ProxyNode[]>) {
  return query(getListNodesQueryKey(), '/catalog/resources', undefined, config);
}
export function useListClientProxyNodes(config?: QueryConfig<RuntimeProxyNode[]>) {
  return query(getListClientProxyNodesQueryKey(), '/client/proxy/nodes', getAccessToken, config);
}

export function subscribeToProxyNodeEvents(onEvent: (event: ProxyNodeStreamEvent) => void) {
  const controller = new AbortController();
  let lastEventId = '';

  const waitToReconnect = () => new Promise(resolve => window.setTimeout(resolve, 2000));
  const connect = async () => {
    while (!controller.signal.aborted) {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Missing session');
        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/client/proxy/nodes/events`, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
            ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
          },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Proxy event stream failed (${response.status})`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let id = '';
            let type = 'message';
            const dataLines: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('id:')) id = line.slice(3).trim();
              else if (line.startsWith('event:')) type = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            }
            if (id) lastEventId = id;
            if (dataLines.length) {
              const raw = dataLines.join('\n');
              let data: Record<string, unknown> = { value: raw };
              try { data = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep raw payload */ }
              onEvent({ id: id || undefined, type, data });
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        console.warn('Proxy SSE disconnected; reconnecting', error);
      }
      if (!controller.signal.aborted) await waitToReconnect();
    }
  };

  void connect();
  return () => controller.abort();
}
export function useCurrentUser(config?: QueryConfig<CurrentUser>) {
  return query(getCurrentUserQueryKey(), '/auth/me', getAccessToken, {
    ...config,
    query: {
      retry: (failureCount, error) => failureCount < 5 && (!(error instanceof ApiRequestError) || error.status >= 500),
      retryDelay: attempt => Math.min(500 * 2 ** attempt, 3000),
      ...config?.query,
    },
  });
}
export function useGetClientOverview(config?: QueryConfig<ClientOverview>) {
  return query(getGetClientOverviewQueryKey(), '/client/overview', getAccessToken, config);
}
export function useListClientOrders(config?: QueryConfig<Order[]>) {
  return query(getListClientOrdersQueryKey(), '/orders', getAccessToken, config);
}
export function useListStaticResidentialOrders(config?: QueryConfig<StaticResidentialOrder[]>) {
  return query(getStaticResidentialOrdersQueryKey(), '/static-residential/orders', getAccessToken, config);
}
export function useStaticResidentialQuote(rentalDays: number, quotaGb: number, config?: QueryConfig<StaticResidentialQuote>) {
  return useQuery<StaticResidentialQuote, Error>({ queryKey: config?.query?.queryKey || getStaticResidentialQuoteQueryKey(rentalDays, quotaGb), queryFn: () => request('/static-residential/quote', getAccessToken, { method: 'POST', body: JSON.stringify({ rentalDays, quotaGb }) }), ...config?.query });
}
export function useStaticResidentialInventory(page = 1, pageSize = 10, config?: QueryConfig<PaginatedStaticResidentialInventory>) {
  return query(getStaticResidentialInventoryQueryKey(page, pageSize), `/admin/static-residential/inventory?page=${page}&pageSize=${pageSize}`, getAccessToken, config);
}
export function useStaticResidentialPricing(config?: QueryConfig<StaticResidentialPricing>) { return query(getStaticResidentialPricingQueryKey(), '/admin/static-residential/pricing', getAccessToken, config); }
export function useGetOrderConnection(id: number, nodeId?: number, config?: QueryConfig<ConnectionDetails>) {
  const path = nodeId ? `/orders/${id}/nodes/${nodeId}/connection` : `/orders/${id}/connection`;
  return query(getGetOrderConnectionQueryKey(id, nodeId), path, getAccessToken, config);
}
export function useOrderQuote(productId: number, nodeCount: number, rentalDays: number, config?: QueryConfig<OrderQuote>) {
  return useQuery<OrderQuote, Error>({
    queryKey: config?.query?.queryKey || getOrderQuoteQueryKey(productId, nodeCount, rentalDays),
    queryFn: () => request<OrderQuote>('/orders/quote', getAccessToken, { method: 'POST', body: JSON.stringify({ productId, nodeCount, rentalDays }) }),
    ...config?.query,
  });
}
export function useCreditBalance(config?: QueryConfig<CreditBalance>) {
  return query(getCreditBalanceQueryKey(), '/orders/credits/balance', getAccessToken, config);
}
export function useGetAdminOverview(config?: QueryConfig<AdminOverview>) {
  return query(getGetAdminOverviewQueryKey(), '/admin/overview', getAccessToken, config);
}
export function useListUsers(config?: QueryConfig<User[]>) {
  return query(getListUsersQueryKey(), '/admin/users', getAccessToken, config);
}
export function useListSandboxKeys(config?: QueryConfig<SandboxKey[]>) {
  return query(getListSandboxKeysQueryKey(), '/admin/api-keys', getAccessToken, config);
}
export function useListAdminOrders(config?: QueryConfig<AdminOrder[]>) {
  return query(getListAdminOrdersQueryKey(), '/admin/orders', getAccessToken, config);
}
export function usePaginatedAdminOrders(page = 1, pageSize = 5, config?: QueryConfig<PaginatedAdminOrders>) {
  return query(getPaginatedAdminOrdersQueryKey(page, pageSize), `/admin/orders?page=${page}&pageSize=${pageSize}`, getAccessToken, config);
}
export function useListCategories(config?: QueryConfig<Category[]>) {
  return query(getListCategoriesQueryKey(), '/admin/categories', getAccessToken, config);
}
export function useListAdminProducts(config?: QueryConfig<AdminProduct[]>) {
  return query(getListAdminProductsQueryKey(), '/admin/products', getAccessToken, config);
}
export function useListProviders(config?: QueryConfig<ProxyProvider[]>) {
  return query(getListProvidersQueryKey(), '/admin/proxy/providers', getAccessToken, config);
}
export function useListProviderApiKeys(config?: QueryConfig<ProviderApiKey[]>) {
  return query(getListProviderApiKeysQueryKey(), '/admin/proxy/provider-api-keys', getAccessToken, config);
}
export function useProvisioningJobs(page = 1, config?: QueryConfig<PaginatedProvisioningJobs>) {
  return query(getProvisioningJobsQueryKey(page), `/admin/proxy/provisioning-jobs?page=${page}`, getAccessToken, config);
}
export function useProxySettings(config?: QueryConfig<ProxyPriceSetting[]>) {
  return query(getProxySettingsQueryKey(), '/admin/proxy/settings', getAccessToken, config);
}
export function useGeneralSettings(config?: QueryConfig<GeneralSettings>) {
  return query(getGeneralSettingsQueryKey(), '/admin/settings', getAccessToken, config);
}
export function useCreditWallets(page = 1, pageSize = 5, config?: QueryConfig<PaginatedCreditWallets>) {
  return query(getCreditWalletsQueryKey(page, pageSize), `/admin/credits?page=${page}&pageSize=${pageSize}`, getAccessToken, config);
}

export function useCreateOrder(options?: MutationConfig<Order, { data: { productId: number; nodeCount: number; rentalDays: number; paymentMethod: 'credit' } }>) {
  return useMutation({ mutationFn: ({ data }) => request<Order>('/orders', getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useCreateStaticResidentialOrder(options?: MutationConfig<StaticResidentialOrder, { data: { rentalDays: number; quotaGb: 1 | 3 | 5 } }>) {
  return useMutation({ mutationFn: ({ data }) => request<StaticResidentialOrder>('/static-residential/orders', getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useExtendStaticResidentialOrder(options?: MutationConfig<StaticResidentialOrder, { id: number; data: { rentalDays: number } }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<StaticResidentialOrder>(`/static-residential/orders/${id}/extend`, getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useExportStaticResidentialConnections(options?: MutationConfig<ProxyConnectionExport, void>) {
  return useMutation({ mutationFn: () => request<ProxyConnectionExport>('/static-residential/connections/export', getAccessToken), ...options });
}
export function useImportStaticResidentialInventory(options?: MutationConfig<{ createdOrUpdated: number; duplicatesInFile: number; reconfiguredOrders: number }, { data: { content: string; label?: string } }>) { return useMutation({ mutationFn: ({ data }) => request('/admin/static-residential/inventory/import', getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options }); }
export function useCheckStaticResidentialInventoryStatus(options?: MutationConfig<{ checked: number; healthy: number; failed: number; disabled: number; rotationsTriggered: number; failureThreshold: number }, void>) { return useMutation({ mutationFn: () => request<{ checked: number; healthy: number; failed: number; disabled: number; rotationsTriggered: number; failureThreshold: number }>('/admin/static-residential/inventory/check-status', getAccessToken, { method: 'POST' }), ...options }); }
export function useEnableStaticResidentialInventoryProxy(options?: MutationConfig<{ id: number; status: 'available' }, { id: number }>) { return useMutation({ mutationFn: ({ id }) => request(`/admin/static-residential/inventory/${id}/enable`, getAccessToken, { method: 'POST' }), ...options }); }
export function useUpdateStaticResidentialPricing(options?: MutationConfig<StaticResidentialPricing, { data: { pricePerGbDay: number } }>) { return useMutation({ mutationFn: ({ data }) => request('/admin/static-residential/pricing', getAccessToken, { method: 'PATCH', body: JSON.stringify(data) }), ...options }); }
export function useExtendOrder(options?: MutationConfig<Order, { id: number; data: { rentalDays: number } }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<Order>(`/orders/${id}/extend`, getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useExportProxyConnections(options?: MutationConfig<ProxyConnectionExport, void>) {
  return useMutation({ mutationFn: () => request<ProxyConnectionExport>('/orders/connections/export', getAccessToken), ...options });
}
export function useRestartProxyNode(options?: MutationConfig<{ jobId: number; nodeId: number; status: 'rotating' }, { id: number }>) {
  return useMutation({ mutationFn: ({ id }) => request(`/client/proxy/nodes/${id}/restart`, getAccessToken, { method: 'POST' }), ...options });
}
export function useRecreateAllProxyNodes(options?: MutationConfig<{ nodeIds: number[]; status: 'rotating' }, void>) {
  return useMutation({ mutationFn: () => request<{ nodeIds: number[]; status: 'rotating' }>('/client/proxy/nodes/recreate-all', getAccessToken, { method: 'POST' }), ...options });
}
export function useCreateUser(options?: MutationConfig<User, { data: { name: string; email: string } }>) {
  return useMutation({ mutationFn: ({ data }) => request<User>('/admin/users', getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useUpdateUser(options?: MutationConfig<User, { id: number; data: { name?: string; status?: string; isTrial?: boolean } }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<User>(`/admin/users/${id}`, getAccessToken, { method: 'PATCH', body: JSON.stringify(data) }), ...options });
}
export function useResetUserPassword(options?: MutationConfig<{ id: number; temporaryPassword: string }, { id: number }>) {
  return useMutation({ mutationFn: ({ id }) => request<{ id: number; temporaryPassword: string }>(`/admin/users/${id}/reset-password`, getAccessToken, { method: 'POST' }), ...options });
}
export function useDeleteUser(options?: MutationConfig<void, { id: number }>) {
  return useMutation({ mutationFn: ({ id }) => request<void>(`/admin/users/${id}`, getAccessToken, { method: 'DELETE' }), ...options });
}
export function useCreateSandboxKey(options?: MutationConfig<SandboxKey, { data: { label: string } }>) {
  return useMutation({ mutationFn: ({ data }) => request<SandboxKey>('/admin/api-keys', getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useDeleteSandboxKey(options?: MutationConfig<void, { id: number }>) {
  return useMutation({ mutationFn: ({ id }) => request<void>(`/admin/api-keys/${id}`, getAccessToken, { method: 'DELETE' }), ...options });
}
export function useUpdateOrderStatus(options?: MutationConfig<AdminOrder, { id: number; data: { status: 'active' | 'rejected' } }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<AdminOrder>(`/admin/orders/${id}/status`, getAccessToken, { method: 'PATCH', body: JSON.stringify(data) }), ...options });
}
export function useCreateCategory(options?: MutationConfig<Category, { data: CategoryInput }>) {
  return useMutation({ mutationFn: ({ data }) => request<Category>('/admin/categories', getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useUpdateCategory(options?: MutationConfig<Category, { id: number; data: Partial<CategoryInput> }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<Category>(`/admin/categories/${id}`, getAccessToken, { method: 'PATCH', body: JSON.stringify(data) }), ...options });
}
export function useDeleteCategory(options?: MutationConfig<void, { id: number }>) {
  return useMutation({ mutationFn: ({ id }) => request<void>(`/admin/categories/${id}`, getAccessToken, { method: 'DELETE' }), ...options });
}
export function useCreateProduct(options?: MutationConfig<AdminProduct, { data: ProductInput }>) {
  return useMutation({ mutationFn: ({ data }) => request<AdminProduct>('/admin/products', getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useUpdateProduct(options?: MutationConfig<AdminProduct, { id: number; data: Partial<ProductInput> }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<AdminProduct>(`/admin/products/${id}`, getAccessToken, { method: 'PATCH', body: JSON.stringify(data) }), ...options });
}
export function useDeleteProduct(options?: MutationConfig<void, { id: number }>) {
  return useMutation({ mutationFn: ({ id }) => request<void>(`/admin/products/${id}`, getAccessToken, { method: 'DELETE' }), ...options });
}
export function useCreateProvider(options?: MutationConfig<ProxyProvider, { data: ProxyProviderInput }>) {
  return useMutation({ mutationFn: ({ data }) => request<ProxyProvider>('/admin/proxy/providers', getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useUpdateProvider(options?: MutationConfig<ProxyProvider, { id: number; data: ProxyProviderInput }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<ProxyProvider>(`/admin/proxy/providers/${id}`, getAccessToken, { method: 'PATCH', body: JSON.stringify(data) }), ...options });
}
export function useDeleteProvider(options?: MutationConfig<void, { id: number }>) {
  return useMutation({ mutationFn: ({ id }) => request<void>(`/admin/proxy/providers/${id}`, getAccessToken, { method: 'DELETE' }), ...options });
}
export function useCreateProviderApiKey(options?: MutationConfig<ProviderApiKey, { providerId: number; data: { label: string; secret: string; maxSandboxes?: number } }>) {
  return useMutation({ mutationFn: ({ providerId, data }) => request<ProviderApiKey>(`/admin/proxy/providers/${providerId}/api-keys`, getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useUpdateProviderApiKey(options?: MutationConfig<ProviderApiKey, { id: number; data: { maxSandboxes: number } }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<ProviderApiKey>(`/admin/proxy/provider-api-keys/${id}`, getAccessToken, { method: 'PATCH', body: JSON.stringify(data) }), ...options });
}
export function useRevokeProviderApiKey(options?: MutationConfig<void, { id: number }>) {
  return useMutation({ mutationFn: ({ id }) => request<void>(`/admin/proxy/provider-api-keys/${id}`, getAccessToken, { method: 'DELETE' }), ...options });
}
export function useUpdateProxyPrice(options?: MutationConfig<ProxyPriceSetting, { id: number; data: { basePrice: number; currency: string } }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<ProxyPriceSetting>(`/admin/proxy/settings/${id}`, getAccessToken, { method: 'PATCH', body: JSON.stringify(data) }), ...options });
}
export function useUpdateGeneralSettings(options?: MutationConfig<GeneralSettings, { data: { siteName: string; supportEmail?: string; defaultCurrency: string; usdToIdrRate: number; creditsPerUsd: number; trialCreditAmount: number } }>) {
  return useMutation({ mutationFn: ({ data }) => request<GeneralSettings>('/admin/settings', getAccessToken, { method: 'PATCH', body: JSON.stringify(data) }), ...options });
}
export function useAdjustCredit(options?: MutationConfig<{ profileId: number; balance: number }, { id: number; data: { amount: number; note?: string } }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<{ profileId: number; balance: number }>(`/admin/credits/${id}/adjust`, getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useAddCreditTopUp(options?: MutationConfig<{ profileId: number; balance: number }, { id: number; data: { amount: number; currency: 'USD' | 'IDR'; note?: string } }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<{ profileId: number; balance: number }>(`/admin/credits/${id}/top-up`, getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
export function useDeductCredit(options?: MutationConfig<{ profileId: number; balance: number }, { id: number; data: { amount: number; note: string } }>) {
  return useMutation({ mutationFn: ({ id, data }) => request<{ profileId: number; balance: number }>(`/admin/credits/${id}/deduct`, getAccessToken, { method: 'POST', body: JSON.stringify(data) }), ...options });
}
