import { useEffect, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowRight, Check, ChevronRight, CircleAlert, Copy,
  FolderTree, Gauge, Globe2, KeyRound, Layers3, LogOut, Menu, MoreHorizontal, Network, Package, Plus, RefreshCw,
  Server, Settings, ShieldCheck, Signal, Trash2, Users, X, Zap,
} from 'lucide-react';
import {
  useCreateCategory, useCreateOrder, useCreateProduct, useCreateSandboxKey, useCreateUser,
  useCreateProvider, useCreateProviderApiKey, useDeleteCategory, useDeleteProduct, useDeleteProvider, useDeleteSandboxKey, useDeleteUser,
  useCurrentUser, useOrderQuote,
  useGetAdminOverview, useGetClientOverview, useGetOrderConnection, useListAdminOrders,
  useGeneralSettings, useListAdminProducts, useListCategories, useListClientOrders, useListClientProxyNodes, useListNodes, useListPlans, useListProducts, useListProviderApiKeys, useListProviders, useListSandboxKeys, useListUsers,
  useProxySettings, useRevokeProviderApiKey, useUpdateCategory, useUpdateGeneralSettings, useUpdateOrderStatus, useUpdateProduct, useUpdateProvider, useUpdateProxyPrice, useUpdateUser,
  getGetAdminOverviewQueryKey, getGetClientOverviewQueryKey, getGetOrderConnectionQueryKey,
  getListAdminOrdersQueryKey, getListAdminProductsQueryKey, getListCategoriesQueryKey, getListClientOrdersQueryKey, getListClientProxyNodesQueryKey, getListNodesQueryKey,
  getCurrentUserQueryKey, getGeneralSettingsQueryKey, getListPlansQueryKey, getListProviderApiKeysQueryKey, getListProvidersQueryKey, getListSandboxKeysQueryKey, getListUsersQueryKey, getProxySettingsQueryKey, subscribeToProxyNodeEvents,
} from '@/lib/api-client';
import type {
  AdminOrder, AdminProduct, CatalogProduct, Category, GeneralSettings, Plan, ProductInput, ProxyNode, ProxyProvider, RuntimeProxyNode, SandboxKey, User, Order, ConnectionDetails,
} from '@/lib/api-client';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { AuthProvider, useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');
const money = (value = 0) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const time = (value?: string | null) => value ? new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '—';
const orderTone = (status: Order['status']): 'green' | 'orange' | 'red' | 'neutral' => status === 'active' ? 'green' : ['pending', 'provisioning'].includes(status) ? 'orange' : ['rejected', 'provisioning_failed'].includes(status) ? 'red' : 'neutral';

function Logo({ inverse = false }: { inverse?: boolean }) {
  return <Link href="/" className="inline-flex items-center gap-2.5" data-testid="link-logo">
    <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f46c43] text-white shadow-sm">
      <Network size={19} strokeWidth={2.4} />
    </span>
    <span className={cx('text-[17px] font-extrabold tracking-[-.04em]', inverse ? 'text-white' : 'text-[#142037]')}>proxy node</span>
  </Link>;
}

function Button({ children, className, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'outline' | 'quiet' | 'danger' }) {
  return <button className={cx(
    'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition duration-200 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50',
    variant === 'primary' && 'bg-[#f46c43] text-white shadow-[0_5px_16px_rgba(244,108,67,.22)] hover:bg-[#df5934]',
    variant === 'outline' && 'border border-[#ccdbe0] bg-white text-[#142037] hover:border-[#f46c43] hover:text-[#d95432]',
    variant === 'quiet' && 'text-slate-500 hover:bg-slate-100 hover:text-[#142037]',
    variant === 'danger' && 'bg-red-50 text-red-700 hover:bg-red-100',
    className,
  )} {...props}>{children}</button>;
}

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'green' | 'orange' | 'red' | 'neutral' | 'teal' }) {
  return <span className={cx(
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[.08em]',
    tone === 'green' && 'bg-[#e4f6ef] text-[#177653]',
    tone === 'orange' && 'bg-[#fff0e8] text-[#b34b2d]',
    tone === 'red' && 'bg-[#fdeceb] text-[#b63d38]',
    tone === 'teal' && 'bg-[#def5f3] text-[#13716e]',
    tone === 'neutral' && 'bg-slate-100 text-slate-600',
  )}>{children}</span>;
}

function SectionTitle({ eyebrow, title, body, action }: { eyebrow: string; title: string; body?: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
    <div><p className="mono mb-2 text-[10px] font-medium uppercase tracking-[.2em] text-[#e4643d]">{eyebrow}</p><h2 className="text-2xl font-extrabold tracking-[-.04em] text-[#142037] md:text-3xl">{title}</h2>{body && <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">{body}</p>}</div>
    {action}
  </div>;
}

function State({ loading, error, onRetry, children, empty }: { loading?: boolean; error?: boolean; onRetry?: () => void; children: ReactNode; empty?: boolean }) {
  if (loading) return <div className="grid gap-3"><div className="h-16 animate-pulse rounded-2xl bg-slate-100" /><div className="h-16 animate-pulse rounded-2xl bg-slate-100" /><div className="h-16 animate-pulse rounded-2xl bg-slate-100" /></div>;
  if (error) return <div className="rounded-2xl border border-red-100 bg-red-50 p-8 text-center"><CircleAlert className="mx-auto mb-3 text-red-500" size={24} /><p className="font-bold text-red-800">This signal could not be loaded.</p><p className="mt-1 text-sm text-red-700">Try again in a moment.</p>{onRetry && <Button onClick={onRetry} variant="outline" className="mt-4"><RefreshCw size={15} /> Retry</Button>}</div>;
  if (empty) return <div className="rounded-2xl border border-dashed border-[#cbd9df] bg-white p-10 text-center"><Layers3 className="mx-auto mb-3 text-slate-300" size={28} /><p className="font-bold text-[#142037]">Nothing here yet</p><p className="mt-1 text-sm text-slate-500">Your next move will show up in this space.</p></div>;
  return <>{children}</>;
}

function PublicNav() {
  return <header className="absolute inset-x-0 top-0 z-20"><div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6 lg:px-10"><Logo inverse /><nav className="hidden items-center gap-8 text-sm text-slate-300 md:flex"><a href="#how-it-works" data-testid="link-how-it-works">How it works</a><a href="#plans" data-testid="link-plans">Plans</a><a href="#operators" data-testid="link-operators">For operators</a></nav><div className="flex items-center gap-2"><Link href="/sign-in" className="hidden px-3 py-2 text-sm font-bold text-slate-200 hover:text-white sm:inline-flex" data-testid="link-sign-in">Sign in</Link><Link href="/sign-in" className="inline-flex items-center gap-2 rounded-xl bg-[#f46c43] px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-orange-900/20 hover:bg-[#ff7b51]" data-testid="link-get-started">Customer login <ArrowRight size={15} /></Link></div></div></header>;
}

function NetworkOrb() {
  return <div className="relative mx-auto aspect-square w-full max-w-[510px] [perspective:1100px]">
    <div className="absolute inset-[13%] rounded-full border border-[#69d5d0]/30 bg-[#1d3c50]/40 shadow-[0_0_90px_rgba(105,213,208,.16)] signal-ring" />
    <div className="absolute inset-[25%] rounded-full border border-[#f46c43]/50 bg-[#f46c43]/5" />
    <div className="absolute inset-[34%] grid place-items-center rounded-full border border-[#69d5d0]/50 bg-[#203c4b] shadow-[0_0_45px_rgba(105,213,208,.22)]">
      <div className="text-center"><div className="mono text-[10px] uppercase tracking-[.24em] text-[#69d5d0]">route core</div><div className="mt-2 text-2xl font-extrabold text-white">US / 24</div><div className="mt-1 text-xs text-slate-400">nodes online</div></div>
    </div>
    {[
      ['New York', '11ms', 'left-[3%] top-[18%]'], ['Austin', '18ms', 'right-[2%] top-[29%]'], ['Seattle', '14ms', 'left-[9%] bottom-[23%]'], ['Chicago', '9ms', 'right-[7%] bottom-[17%]'],
    ].map(([name, latency, position], index) => <div key={name} className={cx('float-node absolute rounded-2xl border border-white/10 bg-[#203c4b]/90 px-3 py-2 shadow-2xl backdrop-blur', position, index === 1 && 'delay', index === 2 && 'delay-2')}><div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#69d5d0]" /><span className="text-xs font-semibold text-white">{name}</span></div><div className="mono mt-1 text-[10px] text-slate-400">{latency} · SOCKS5</div></div>)}
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 500 500" fill="none" aria-hidden="true"><path d="M90 116L250 250M416 160L250 250M110 390L250 250M400 405L250 250" stroke="#69D5D0" strokeOpacity=".25" strokeDasharray="5 8"/><circle cx="90" cy="116" r="4" fill="#69D5D0"/><circle cx="416" cy="160" r="4" fill="#F46C43"/><circle cx="110" cy="390" r="4" fill="#F46C43"/><circle cx="400" cy="405" r="4" fill="#69D5D0"/></svg>
  </div>;
}

function Landing() {
  const plans = useListPlans();
  return <div className="min-h-[100dvh] overflow-hidden bg-[#142037]">
    <section className="relative min-h-[740px] text-white"><PublicNav /><div className="absolute inset-0 bg-[radial-gradient(circle_at_65%_40%,#245066_0,transparent_35%),linear-gradient(125deg,#142037_15%,#183041_100%)]" /><div className="hero-grid absolute inset-0 opacity-50" /><div className="relative mx-auto grid max-w-7xl items-center gap-10 px-6 pb-20 pt-36 lg:grid-cols-[1.03fr_.97fr] lg:px-10 lg:pb-28 lg:pt-44"><div className="reveal max-w-2xl"><div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#69d5d0]/25 bg-[#69d5d0]/10 px-3 py-1.5 text-xs font-bold text-[#91e4df]"><span className="h-1.5 w-1.5 rounded-full bg-[#69d5d0]" /> US network · hourly rotation</div><h1 className="max-w-xl text-5xl font-extrabold leading-[.98] tracking-[-.065em] sm:text-6xl lg:text-[76px]">Routes you can <span className="text-[#69d5d0]">reason about.</span></h1><p className="mt-7 max-w-lg text-base leading-7 text-slate-300 sm:text-lg">Rent dependable US SOCKS5 nodes for the work that needs a clean signal. One dashboard, automatic IP rotation, no infrastructure theatre.</p><div className="mt-9 flex flex-wrap gap-3"><Link href="/sign-in" className="inline-flex items-center gap-2 rounded-xl bg-[#f46c43] px-5 py-3.5 text-sm font-bold text-white shadow-[0_12px_30px_rgba(244,108,67,.25)] hover:bg-[#ff7b51]" data-testid="link-hero-start">Customer login <ArrowRight size={16} /></Link><a href="#how-it-works" className="inline-flex items-center rounded-xl border border-white/15 px-5 py-3.5 text-sm font-bold text-slate-200 hover:border-white/35" data-testid="link-hero-learn">See how it works</a></div><div className="mt-11 flex flex-wrap gap-x-7 gap-y-3 border-t border-white/10 pt-5 text-xs text-slate-400"><span className="inline-flex items-center gap-2"><ShieldCheck size={15} className="text-[#69d5d0]" /> No long-term lock-in</span><span className="inline-flex items-center gap-2"><Zap size={15} className="text-[#f46c43]" /> Rotate every 60 min</span></div></div><div className="reveal-2 relative"><NetworkOrb /></div></div></section>
    <section id="how-it-works" className="bg-[#f4f8f8] px-6 py-24 text-[#142037] lg:px-10"><div className="mx-auto max-w-7xl"><SectionTitle eyebrow="the control plane" title="Small surface area. Serious signal." body="Proxy Node keeps the operational model visible: pick a plan, get a node, watch the clock. The network takes care of the rest." /><div className="grid gap-4 md:grid-cols-3"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-7"><span className="mono text-xs text-[#f46c43]">01 / select</span><Globe2 className="my-10 text-[#142037]" size={28} /><h3 className="text-xl font-extrabold">Choose your footprint</h3><p className="mt-3 text-sm leading-6 text-slate-500">Start in the US with a node count and duration that fits your run. More countries can slot into the same model.</p></div><div className="rounded-3xl border border-[#dbe7e9] bg-[#142037] p-7 text-white"><span className="mono text-xs text-[#69d5d0]">02 / connect</span><Signal className="my-10 text-[#69d5d0]" size={28} /><h3 className="text-xl font-extrabold">Copy one clean endpoint</h3><p className="mt-3 text-sm leading-6 text-slate-300">Credentials arrive in a focused connection view, ready for scripts, browsers, crawlers, and growth tooling.</p></div><div className="rounded-3xl border border-[#dbe7e9] bg-white p-7"><span className="mono text-xs text-[#f46c43]">03 / rotate</span><RefreshCw className="my-10 text-[#f46c43]" size={28} /><h3 className="text-xl font-extrabold">Let the hour turn over</h3><p className="mt-3 text-sm leading-6 text-slate-500">IP rotation happens automatically, so your team stays focused on the request instead of the maintenance.</p></div></div></div></section>
    <section id="plans" className="bg-[#f4f8f8] px-6 pb-24 lg:px-10"><div className="mx-auto max-w-7xl"><SectionTitle eyebrow="plans" title="Start narrow. Scale cleanly." body="Every plan is built around predictable node access, not a maze of add-ons." action={<Link href="/sign-in" className="text-sm font-bold text-[#e05c37]" data-testid="link-plans-cta">Customer login <ChevronRight size={16} className="inline" /></Link>} /><State loading={plans.isLoading} error={plans.isError} onRetry={() => plans.refetch()} empty={!plans.data?.length}><div className="grid gap-4 md:grid-cols-3">{plans.data?.map((plan: Plan) => <PlanCard key={plan.id} plan={plan} />)}</div></State></div></section>
    <section id="operators" className="border-t border-white/10 bg-[#142037] px-6 py-24 text-white lg:px-10"><div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[.9fr_1.1fr]"><div><p className="mono mb-3 text-[10px] uppercase tracking-[.2em] text-[#69d5d0]">built for the person on call</p><h2 className="max-w-lg text-4xl font-extrabold leading-tight tracking-[-.05em]">You should not need a spreadsheet to trust a proxy.</h2><p className="mt-5 max-w-lg leading-7 text-slate-300">A high-signal surface for developers, growth teams, and operators who need to know what is live, what is rotating, and what happens next.</p><Link href="/sign-in" className="mt-8 inline-flex items-center gap-2 text-sm font-bold text-[#69d5d0]" data-testid="link-operator-cta">Customer login <ArrowRight size={16} /></Link></div><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-white/10 bg-white/5 p-6"><div className="mono text-3xl text-[#69d5d0]">60m</div><p className="mt-4 font-bold">Automatic rotation</p><p className="mt-2 text-sm leading-6 text-slate-400">Fresh egress without a manual reset ritual.</p></div><div className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:translate-y-8"><div className="mono text-3xl text-[#f46c43]">SOCKS5</div><p className="mt-4 font-bold">One dependable protocol</p><p className="mt-2 text-sm leading-6 text-slate-400">Simple connection details for every workflow.</p></div></div></div></section>
    <footer className="bg-[#142037] px-6 pb-10 text-slate-500 lg:px-10"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-4 border-t border-white/10 pt-7 text-xs sm:flex-row"><span>© 2025 Proxy Node</span><span className="mono">signal / rotation / control</span></div></footer>
  </div>;
}

function PlanCard({ plan, onSelect }: { plan: Plan; onSelect?: (plan: Plan) => void }) {
  return <div className={cx('relative rounded-3xl border p-6 transition hover:-translate-y-1', plan.highlighted ? 'border-[#f46c43] bg-[#142037] text-white shadow-xl shadow-slate-900/10' : 'border-[#dbe7e9] bg-white text-[#142037]')}><div className="flex items-start justify-between gap-3"><div><p className={cx('mono text-[10px] uppercase tracking-[.17em]', plan.highlighted ? 'text-[#69d5d0]' : 'text-[#f46c43]')}>{plan.nodeCount} {plan.nodeCount === 1 ? 'node' : 'nodes'}</p><h3 className="mt-3 text-xl font-extrabold">{plan.name}</h3></div>{plan.highlighted && <Badge tone="orange">Popular</Badge>}</div><div className="mt-7 flex items-baseline gap-1"><span className="text-4xl font-extrabold tracking-[-.06em]">{money(plan.price)}</span><span className={cx('text-xs', plan.highlighted ? 'text-slate-400' : 'text-slate-500')}>/ {plan.durationHours}h</span></div><p className={cx('mt-4 min-h-12 text-sm leading-6', plan.highlighted ? 'text-slate-300' : 'text-slate-500')}>{plan.description}</p><div className={cx('mt-6 border-t pt-5 text-sm', plan.highlighted ? 'border-white/10 text-slate-200' : 'border-slate-100 text-slate-600')}><div className="flex items-center gap-2"><Check size={15} className="text-[#69d5d0]" /> {plan.rotation} rotation</div></div>{onSelect && <Button onClick={() => onSelect(plan)} className="mt-6 w-full"><Plus size={15} /> Rent this plan</Button>}</div>;
}

function AppShell({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, signOut } = useAuth();
  const [location, setLocation] = useLocation();
  const displayName = String(user?.user_metadata?.name || user?.email?.split('@')[0] || 'Workspace member');
  const initial = (displayName[0] || 'P').toUpperCase();
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = admin ? [
    { section: 'Dashboard' }, { href: '/admin', label: 'Dashboard', icon: Gauge },
    { section: 'Info' }, { href: '/admin/info/users', label: 'Users', icon: Users },
    { section: 'Proxy' }, { href: '/admin/proxy/api-keys', label: 'Provider API keys', icon: KeyRound }, { href: '/admin/proxy/providers', label: 'Providers', icon: Server }, { href: '/admin/proxy/orders', label: 'Orders', icon: Layers3 }, { href: '/admin/proxy/settings', label: 'Pricing', icon: Settings },
    { section: 'System' }, { href: '/admin/settings', label: 'Settings', icon: Settings },
  ] : [{ section: 'Workspace' }, { href: '/client', label: 'Overview', icon: Gauge }, { href: '/client/nodes', label: 'Nodes', icon: Server }, { href: '/client/orders', label: 'Orders', icon: Layers3 }];
  const currentTarget = location;
  return <div className="min-h-[100dvh] bg-[#f4f8f8]"><aside className={cx('fixed inset-y-0 left-0 z-40 flex w-[250px] flex-col overflow-y-auto bg-[#142037] px-4 py-5 text-white transition-transform duration-300 lg:translate-x-0', mobileOpen ? 'translate-x-0' : '-translate-x-full')}><div className="px-3"><Logo inverse /></div><div className="mt-8 px-3"><nav className="grid gap-1">{nav.map((item, index) => { if ('section' in item) return <p key={`${item.section}-${index}`} className="mono mb-1 mt-5 px-3 text-[9px] font-semibold uppercase tracking-[.2em] text-[#91e4df] first:mt-0">{item.section}</p>; const { href, label, icon: Icon } = item; const active = href === currentTarget; return <Link key={href} href={href} onClick={() => setMobileOpen(false)} aria-current={active ? 'page' : undefined} className={cx('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition', active ? 'bg-white/12 text-white shadow-[inset_3px_0_0_#69d5d0]' : 'text-slate-200 hover:bg-white/8 hover:text-white')} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={16} className={active ? 'text-[#69d5d0]' : 'text-slate-300'} />{label}</Link>; })}</nav></div><div className="mt-auto border-t border-white/20 px-3 pt-4"><div className="mb-3 flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-full bg-[#69d5d0] text-sm font-extrabold text-[#142037]">{initial}</div><div className="min-w-0"><p className="truncate text-xs font-bold text-white">{displayName}</p><p className="truncate text-[11px] text-slate-300">{user?.email || 'signed in'}</p></div></div><button onClick={() => void signOut().then(() => { queryClient.clear(); setLocation('/'); })} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold text-slate-200 hover:bg-white/10 hover:text-white" data-testid="button-sign-out"><LogOut size={15} /> Sign out</button></div></aside><div className="lg:pl-[250px]"><header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-[#dbe7e9] bg-[#f4f8f8]/90 px-5 backdrop-blur lg:px-9"><button className="rounded-lg p-2 text-slate-500 lg:hidden" onClick={() => setMobileOpen(!mobileOpen)} data-testid="button-open-menu"><Menu size={22} /></button><div className="hidden items-center gap-2 text-xs text-slate-400 sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#69d5d0]" /> All systems operational</div><div className="flex items-center gap-3"><span className="mono hidden text-[10px] uppercase tracking-[.12em] text-slate-400 sm:inline">{admin ? 'admin / modules' : 'workspace / us'}</span><div className="h-8 w-px bg-[#dbe7e9]" /><div className="grid h-8 w-8 place-items-center rounded-full bg-[#e0eeed] text-xs font-extrabold text-[#13716e]">{initial}</div></div></header><main>{children}</main></div></div>;
}

function ClientDashboard() {
  const overview = useGetClientOverview();
  const plans = useListPlans({ query: { queryKey: getListPlansQueryKey() } });
  const nodes = useListNodes(undefined, { query: { queryKey: getListNodesQueryKey() } });
  const orders = useListClientOrders();
  const activeId = overview.data?.activeOrder?.id ?? 0;
  const connection = useGetOrderConnection(activeId, undefined, { query: { enabled: !!activeId, queryKey: getGetOrderConnectionQueryKey(activeId) } });
  const createOrder = useCreateOrder();
  const qc = useQueryClient();
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [payment, setPayment] = useState<'bank_transfer' | 'crypto'>('bank_transfer');
  const [showPlans, setShowPlans] = useState(false);
  const activeNode = nodes.data?.find((node: ProxyNode) => node.status === 'online');
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); };
  const submitOrder = () => { if (!selectedPlan || !activeNode) return; createOrder.mutate({ data: { productId: selectedPlan.productId, nodeCount: 1, rentalDays: Math.max(1, Math.ceil(selectedPlan.durationHours / 24)), paymentMethod: payment } }, { onSuccess: () => { setSelectedPlan(null); setShowPlans(false); void qc.invalidateQueries({ queryKey: getListClientOrdersQueryKey() }); void qc.invalidateQueries({ queryKey: getGetClientOverviewQueryKey() }); } }); };
  return <AppShell><div className="shell-grid min-h-[calc(100dvh-72px)] px-5 py-8 lg:px-9"><div className="mx-auto max-w-[1420px]"><div className="mb-9 flex flex-wrap items-end justify-between gap-4"><div className="reveal"><p className="mono mb-2 text-[10px] uppercase tracking-[.2em] text-[#e4643d]">client workspace</p><h1 className="text-3xl font-extrabold tracking-[-.05em] text-[#142037] md:text-4xl">Good to see you, {overview.data?.displayName?.split(' ')[0] || 'operator'}.</h1><p className="mt-2 text-sm text-slate-500">Your routing surface, at a glance.</p></div><Button onClick={() => setShowPlans(true)} data-testid="button-rent-node"><Plus size={16} /> Rent a node</Button></div><State loading={overview.isLoading} error={overview.isError} onRetry={() => overview.refetch()}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Active nodes" value={String(overview.data?.activeNodes ?? 0)} detail={activeNode ? `${activeNode.city}, ${activeNode.country}` : 'No active footprint'} icon={Server} tone="teal" /><Metric label="Requests today" value={(overview.data?.requestsToday ?? 0).toLocaleString()} detail="Across your workspace" icon={Activity} tone="orange" /><Metric label="Success rate" value={`${overview.data?.successRate ?? 0}%`} detail="Last 24 hours" icon={Signal} tone="teal" /><Metric label="Next rotation" value={overview.data?.nextRotationAt ? time(overview.data.nextRotationAt) : '—'} detail={overview.data?.nextRotationAt ? date(overview.data.nextRotationAt) : 'Activate a plan to start'} icon={RefreshCw} tone="orange" /></div><div className="mt-5 grid gap-5 xl:grid-cols-[1.28fr_.72fr]"><div id="nodes" className="rounded-3xl border border-[#dbe7e9] bg-white p-6 shadow-[0_10px_35px_rgba(20,32,55,.04)]"><div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><p className="mono text-[10px] uppercase tracking-[.18em] text-[#e4643d]">live connection</p><h2 className="mt-2 text-xl font-extrabold tracking-[-.04em]">Your active node</h2></div>{overview.data?.activeOrder ? <Badge tone="green"><span className="h-1.5 w-1.5 rounded-full bg-current" /> Active</Badge> : <Badge>Awaiting order</Badge>}</div>{overview.data?.activeOrder && connection.data ? <ConnectionCard connection={connection.data} nodeName={overview.data.activeOrder.nodeName} onCopy={copy} /> : <div className="rounded-2xl border border-dashed border-[#cbd9df] bg-[#f8fbfb] p-8 text-center"><Server className="mx-auto mb-3 text-[#69d5d0]" size={28} /><p className="font-bold text-[#142037]">No active node yet</p><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500">Pick a plan to provision your first US SOCKS5 endpoint. Approval is handled by the Proxy Node team.</p><Button onClick={() => setShowPlans(true)} className="mt-5">View plans <ArrowRight size={15} /></Button></div>}</div><div className="rounded-3xl bg-[#142037] p-6 text-white shadow-xl shadow-slate-900/10"><div className="flex items-start justify-between"><div><p className="mono text-[10px] uppercase tracking-[.18em] text-[#69d5d0]">current plan</p><h2 className="mt-2 text-xl font-extrabold">{overview.data?.activeOrder?.planName || 'No plan selected'}</h2></div><Zap className="text-[#f46c43]" size={20} /></div>{overview.data?.activeOrder ? <><div className="mt-8 space-y-4 text-sm"><div className="flex justify-between border-b border-white/10 pb-3"><span className="text-slate-400">Node</span><span className="font-bold">{overview.data.activeOrder.nodeName}</span></div><div className="flex justify-between border-b border-white/10 pb-3"><span className="text-slate-400">Started</span><span className="font-bold">{date(overview.data.activeOrder.createdAt)}</span></div><div className="flex justify-between"><span className="text-slate-400">Expires</span><span className="font-bold">{date(overview.data.activeOrder.expiresAt)}</span></div></div><div className="mt-8 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full w-[68%] rounded-full bg-[#69d5d0]" /></div><p className="mt-2 text-xs text-slate-400">Rotation window healthy · next at {time(overview.data.nextRotationAt)}</p></> : <p className="mt-8 text-sm leading-6 text-slate-400">Your plan summary will appear here after your first order is approved.</p>}</div></div><div id="orders" className="mt-8"><SectionTitle eyebrow="history" title="Recent orders" action={<span className="mono text-[10px] uppercase tracking-[.15em] text-slate-400">{orders.data?.length || 0} records</span>} /><State loading={orders.isLoading} error={orders.isError} onRetry={() => orders.refetch()} empty={!orders.data?.length}><OrdersTable orders={orders.data || []} /></State></div></State></div></div>{showPlans && <Modal title="Rent a node" onClose={() => { setShowPlans(false); setSelectedPlan(null); }}><div className="grid gap-3">{selectedPlan ? <><div className="rounded-2xl bg-[#f4f8f8] p-4"><p className="mono text-[10px] uppercase tracking-[.16em] text-[#e4643d]">selected plan</p><p className="mt-2 font-extrabold text-[#142037]">{selectedPlan.name} · {money(selectedPlan.price)}</p><p className="mt-1 text-sm text-slate-500">{activeNode ? `Best available node: ${activeNode.name}` : 'No online node is available right now.'}</p></div><label className="text-sm font-bold text-[#142037]">Payment method<select value={payment} onChange={e => setPayment(e.target.value as typeof payment)} className="mt-2 block w-full rounded-xl border border-[#dbe7e9] bg-white px-3 py-3 text-sm"><option value="bank_transfer">Bank transfer</option><option value="crypto">Crypto</option></select></label><div className="flex gap-2 pt-2"><Button variant="outline" className="flex-1" onClick={() => setSelectedPlan(null)}>Back</Button><Button className="flex-1" disabled={createOrder.isPending || !activeNode} onClick={submitOrder}>{createOrder.isPending ? 'Submitting…' : 'Submit order'}</Button></div></> : <><p className="mb-2 text-sm text-slate-500">Choose a plan for your next US node.</p>{plans.data?.map((plan: Plan) => <button key={plan.id} onClick={() => setSelectedPlan(plan)} className="flex items-center justify-between rounded-2xl border border-[#dbe7e9] p-4 text-left transition hover:border-[#f46c43] hover:bg-[#fff9f6]" data-testid={`button-select-plan-${plan.id}`}><span><span className="block font-extrabold text-[#142037]">{plan.name}</span><span className="mt-1 block text-xs text-slate-500">{plan.nodeCount} node · {plan.durationHours} hours · {plan.rotation} rotation</span></span><span className="font-extrabold text-[#142037]">{money(plan.price)}</span></button>)}</>}</div></Modal>}</AppShell>;
}

function Metric({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: typeof Gauge; tone: 'teal' | 'orange' }) {
  return <div className="rounded-3xl border border-[#dbe7e9] bg-white p-5"><div className="flex items-start justify-between"><p className="text-xs font-bold text-slate-500">{label}</p><span className={cx('grid h-8 w-8 place-items-center rounded-xl', tone === 'teal' ? 'bg-[#def5f3] text-[#13716e]' : 'bg-[#fff0e8] text-[#d95432]')}><Icon size={16} /></span></div><p className="mono mt-5 text-2xl font-medium tracking-[-.05em] text-[#142037]">{value}</p><p className="mt-1 truncate text-xs text-slate-500">{detail}</p></div>;
}

function ConnectionCard({ connection, nodeName, onCopy }: { connection: ConnectionDetails; nodeName: string; onCopy: (text: string) => void }) {
  const fields = [['Host', connection.host], ['Port', String(connection.port)], ['Username', connection.username], ['Password', connection.password]];
  return <div><div className="mb-4 flex items-center justify-between rounded-2xl bg-[#f4f8f8] px-4 py-3"><div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#69d5d0]" /><span className="font-bold text-[#142037]">{nodeName}</span></div><span className="mono text-[10px] text-slate-500">{connection.protocol}</span></div><div className="grid gap-2 sm:grid-cols-2">{fields.map(([label, value]) => <div key={label} className="group flex items-center justify-between rounded-xl border border-[#edf2f3] px-3 py-3"><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-slate-400">{label}</p><p className="mono mt-1 text-xs text-[#142037]">{value}</p></div><button onClick={() => onCopy(value)} className="rounded-lg p-2 text-slate-400 opacity-0 transition group-hover:opacity-100 hover:bg-slate-100 hover:text-[#f46c43]" data-testid={`button-copy-${label.toLowerCase()}`}><Copy size={14} /></button></div>)}</div><div className="mt-4 flex items-center justify-between border-t border-[#edf2f3] pt-4 text-xs"><span className="text-slate-500">Next automatic rotation</span><span className="mono font-medium text-[#13716e]">{time(connection.nextRotationAt)} · {date(connection.nextRotationAt)}</span></div></div>;
}

const compactDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [days ? `${days}d` : '', hours || days ? `${hours}h` : '', `${minutes}m`, `${remainingSeconds}s`].filter(Boolean).join(' ');
};

function CompactNodeCard({ order, connection, node }: { order: Order; connection: ConnectionDetails; node?: RuntimeProxyNode }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const activatedAt = new Date(order.activatedAt || order.createdAt).getTime();
  const expiresAt = order.expiresAt ? new Date(order.expiresAt).getTime() : null;
  const total = expiresAt ? Math.max(1, expiresAt - activatedAt) : 1;
  const remaining = expiresAt ? Math.max(0, expiresAt - now) : 0;
  const progress = expiresAt ? Math.min(100, Math.max(0, ((now - activatedAt) / total) * 100)) : 0;
  const endpoint = `${connection.protocol.toLowerCase()}://${connection.host}:${connection.port}`;
  const connectionString = `${connection.protocol.toLowerCase()}://${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password)}@${connection.host}:${connection.port}`;
  const copy = (value: string) => void navigator.clipboard?.writeText(value);
  const status = node?.status || 'online';
  const reachable = ['online', 'rotating', 'degraded'].includes(status);
  const statusLabel = status === 'online' ? 'READY' : status.toUpperCase();
  const statusColor = reachable ? '#43cf65' : status === 'provisioning' || status === 'queued' ? '#f6a94a' : '#ff5156';
  const nextRotationAt = node?.nextRotationAt || connection.nextRotationAt;
  return <article className="relative overflow-hidden rounded-xl border border-[#34404b] bg-[#171d23] px-3.5 py-3 text-slate-200 shadow-[0_8px_22px_rgba(20,32,55,.12)]">
    <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: statusColor }} />
    <div className="flex items-center gap-1.5 pl-1">
      <span className="mono text-[10px] font-bold text-slate-500">#{node?.id || order.id}</span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
      <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-200" title={`Order #${order.id}`}>Node {node?.id || order.id}</span>
      <span className="text-[9px] font-extrabold tracking-[.08em]" style={{ color: statusColor }}>{statusLabel}</span>
      <button onClick={() => copy(connectionString)} title="Copy endpoint with username and password" aria-label="Copy full proxy connection string" className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[#ff5156] text-white transition hover:bg-[#ff696d]" data-testid={`button-copy-endpoint-${node?.id || order.id}`}><Copy size={11} /></button>
    </div>
    <button onClick={() => copy(connectionString)} className="mono mt-2 block w-full break-all pl-1 text-left text-[9px] leading-3 font-medium tracking-[-.01em] text-[#43d6dc] hover:text-[#79edf1]" title="Copy endpoint with username and password">{endpoint}</button>
    <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-white/10 pl-1 pt-2.5 text-[10px] leading-4">
      <p className="min-w-0 text-slate-500">Protocol <strong className="ml-1 text-slate-300">{connection.protocol}</strong></p>
      <p className="text-slate-500">Port <strong className="ml-1 text-slate-300">{connection.port}</strong></p>
      <p className="min-w-0 text-slate-500">Egress <strong className="ml-1 break-all text-slate-300">{node?.egressIp || connection.host}</strong></p>
      <p className="text-slate-500">Reachable <strong className={cx('ml-1', reachable ? 'text-[#43cf65]' : 'text-[#ff696d]')}>{reachable ? 'OK' : 'NO'}</strong></p>
      <p className="text-slate-500">Uptime <strong className="ml-1 text-slate-300">{compactDuration(now - activatedAt)}</strong></p>
      <p className="text-slate-500">Rotation <strong className="ml-1 text-slate-300">{nextRotationAt ? compactDuration(new Date(nextRotationAt).getTime() - now) : '—'}</strong></p>
    </div>
    {expiresAt && <div className="mt-2.5 pl-1"><div className="h-1 overflow-hidden rounded-full bg-[#323a43]"><div className="h-full rounded-full bg-[#35bd58] transition-[width] duration-1000" style={{ width: `${100 - progress}%` }} /></div><div className="mt-1 flex justify-between gap-2 text-[9px] text-slate-500"><span>{date(order.expiresAt)}</span><span>Expires in {compactDuration(remaining)}</span></div></div>}
    <details className="mt-2 border-t border-white/10 pl-1 pt-2 text-[10px]"><summary className="cursor-pointer select-none font-bold text-slate-500 hover:text-white">Credentials</summary><div className="mt-1.5 grid gap-1.5 sm:grid-cols-2"><button onClick={() => copy(connection.username)} title={connection.username} className="flex min-w-0 items-center justify-between rounded-md bg-white/5 px-2 py-1.5 text-left hover:bg-white/10"><span className="mono truncate text-[9px] text-slate-300">{connection.username}</span><Copy className="shrink-0" size={10} /></button><button onClick={() => copy(connection.password)} className="flex items-center justify-between rounded-md bg-white/5 px-2 py-1.5 text-left hover:bg-white/10"><span className="mono text-[9px] text-slate-300">••••••••</span><Copy size={10} /></button></div></details>
  </article>;
}

function ActiveNodeItem({ order, node }: { order: Order; node: RuntimeProxyNode }) {
  const connection = useGetOrderConnection(order.id, node.id, { query: { queryKey: getGetOrderConnectionQueryKey(order.id, node.id) } });
  return <State loading={connection.isLoading} error={connection.isError} onRetry={() => connection.refetch()}>{connection.data && <CompactNodeCard order={order} connection={connection.data} node={node} />}</State>;
}

function OrdersTable({ orders }: { orders: Order[] }) {
  return <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><div className="hidden grid-cols-[1.3fr_1fr_.7fr_.8fr] gap-4 border-b border-[#edf2f3] px-5 py-3 text-[10px] font-bold uppercase tracking-[.15em] text-slate-400 md:grid"><span>Service / order</span><span>Configuration</span><span>Amount</span><span>Status</span></div>{orders.map(order => <div key={order.id} className="grid gap-2 border-b border-[#edf2f3] px-5 py-4 last:border-0 md:grid-cols-[1.3fr_1fr_.7fr_.8fr] md:items-center md:gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#13716e]">{order.productName}</p><p className="mt-1 font-bold text-[#142037]">{order.planName}</p><p className="mono mt-1 text-[10px] text-slate-400">#{String(order.id).padStart(5, '0')} · {date(order.createdAt)}</p></div><p className="text-sm text-slate-600"><strong>{order.nodeCount}</strong> {order.nodeCount === 1 ? 'node' : 'nodes'} · <strong>{order.rentalDays}</strong> {order.rentalDays === 1 ? 'day' : 'days'}</p><p className="text-sm font-bold text-[#142037]">{money(order.amount)}</p><div><Badge tone={orderTone(order.status)}>{order.status}</Badge></div></div>)}</div>;
}

function AdminDashboard() {
  const overview = useGetAdminOverview();
  const users = useListUsers();
  const keys = useListSandboxKeys();
  const adminOrders = useListAdminOrders();
  const qc = useQueryClient();
  const createUser = useCreateUser(); const updateUser = useUpdateUser(); const deleteUser = useDeleteUser();
  const createKey = useCreateSandboxKey(); const deleteKey = useDeleteSandboxKey(); const updateOrder = useUpdateOrderStatus();
  const [userForm, setUserForm] = useState({ name: '', email: '' });
  const [keyLabel, setKeyLabel] = useState('');
  const [latestKey, setLatestKey] = useState('');
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const refreshUsers = () => void qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
  const refreshKeys = () => void qc.invalidateQueries({ queryKey: getListSandboxKeysQueryKey() });
  const refreshOrders = () => { void qc.invalidateQueries({ queryKey: getListAdminOrdersQueryKey() }); void qc.invalidateQueries({ queryKey: getGetAdminOverviewQueryKey() }); };
  const copyText = (value: string) => { void navigator.clipboard?.writeText(value); };
  const submitUser = () => { if (!userForm.name || !userForm.email) return; createUser.mutate({ data: userForm }, { onSuccess: () => { setUserForm({ name: '', email: '' }); refreshUsers(); } }); };
  const submitKey = () => { if (!keyLabel) return; createKey.mutate({ data: { label: keyLabel } }, { onSuccess: (created) => { setKeyLabel(''); setLatestKey(created.secret || ''); refreshKeys(); } }); };
  return <AppShell admin><div className="shell-grid min-h-[calc(100dvh-72px)] px-5 py-8 lg:px-9"><div className="mx-auto max-w-[1420px]"><div className="mb-9"><p className="mono mb-2 text-[10px] uppercase tracking-[.2em] text-[#e4643d]">operator desk</p><h1 className="text-3xl font-extrabold tracking-[-.05em] text-[#142037] md:text-4xl">Keep the network honest.</h1><p className="mt-2 text-sm text-slate-500">Operational view across customers, keys, and manual settlement.</p></div><State loading={overview.isLoading} error={overview.isError} onRetry={() => overview.refetch()}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"><Metric label="MRR" value={money(overview.data?.mrr)} detail={`${overview.data?.mrrChange ?? 0}% vs last month`} icon={Activity} tone="orange" /><Metric label="Active users" value={String(overview.data?.activeUsers ?? 0)} detail="Currently routing" icon={Users} tone="teal" /><Metric label="Active nodes" value={String(overview.data?.activeNodes ?? 0)} detail="Across US footprint" icon={Server} tone="teal" /><Metric label="Pending orders" value={String(overview.data?.pendingOrders ?? 0)} detail="Need review" icon={Layers3} tone="orange" /><Metric label="Success rate" value={`${overview.data?.successRate ?? 0}%`} detail="Network average" icon={Signal} tone="teal" /></div><div className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_.9fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><SectionTitle eyebrow="signal feed" title="Recent activity" /><div className="grid gap-4">{overview.data?.recentActivity?.map(item => <div key={item.id} className="flex gap-3"><span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full', item.tone === 'success' ? 'bg-[#69d5d0]' : item.tone === 'warning' ? 'bg-[#f46c43]' : 'bg-slate-300')} /><div className="min-w-0 flex-1"><div className="flex justify-between gap-3"><p className="text-sm font-bold text-[#142037]">{item.title}</p><span className="mono whitespace-nowrap text-[10px] text-slate-400">{item.time}</span></div><p className="mt-1 text-xs text-slate-500">{item.detail}</p></div></div>)}</div></div><div className="rounded-3xl bg-[#142037] p-6 text-white"><p className="mono text-[10px] uppercase tracking-[.18em] text-[#69d5d0]">operator note</p><h2 className="mt-3 text-2xl font-extrabold leading-tight tracking-[-.04em]">Make the exception visible.</h2><p className="mt-3 text-sm leading-6 text-slate-400">Pending payments stay out of the active network until you approve them. That boundary is the product.</p><div className="mt-8 flex items-center gap-3 text-sm font-bold"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f46c43]"><ShieldCheck size={17} /></span> Manual approval queue is live</div></div></div></State><div id="users" className="mt-10"><SectionTitle eyebrow="directory" title="Users" body="Create and maintain the customer records that power the client workspace." /><div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><h3 className="font-extrabold text-[#142037]">{editingUser ? 'Edit user' : 'Add user'}</h3><div className="mt-5 grid gap-3"><input value={editingUser?.name ?? userForm.name} onChange={e => editingUser ? setEditingUser({ ...editingUser, name: e.target.value }) : setUserForm({ ...userForm, name: e.target.value })} placeholder="Name" className="rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]" data-testid="input-user-name" /><input value={editingUser?.email ?? userForm.email} disabled={!!editingUser} onChange={e => setUserForm({ ...userForm, email: e.target.value })} placeholder="Email" type="email" className="rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43] disabled:opacity-50" data-testid="input-user-email" />{editingUser ? <div className="flex gap-2"><Button className="flex-1" disabled={updateUser.isPending} onClick={() => updateUser.mutate({ id: editingUser.id, data: { name: editingUser.name, status: editingUser.status } }, { onSuccess: () => { setEditingUser(null); refreshUsers(); } })}>Save changes</Button><Button variant="quiet" onClick={() => setEditingUser(null)}>Cancel</Button></div> : <Button onClick={submitUser} disabled={createUser.isPending}><Plus size={15} /> {createUser.isPending ? 'Adding…' : 'Add user'}</Button>}</div></div><UsersTable users={users.data || []} loading={users.isLoading} onEdit={setEditingUser} onDelete={id => { if (window.confirm('Delete this user record?')) deleteUser.mutate({ id }, { onSuccess: refreshUsers }); }} onToggle={(user) => updateUser.mutate({ id: user.id, data: { status: user.status === 'active' ? 'suspended' : 'active' } }, { onSuccess: refreshUsers })} /></div></div><div id="keys" className="mt-10"><SectionTitle eyebrow="developer access" title="Sandbox API keys" body="Issue scoped-looking credentials for testing and integration." /><div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><h3 className="font-extrabold text-[#142037]">Create a key</h3><p className="mt-2 text-sm text-slate-500">The full secret is shown once by the API.</p>{latestKey && <div className="mt-4 rounded-xl border border-[#bfe3df] bg-[#eaf8f6] p-3"><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#13716e]">Copy this key now</p><div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs text-[#142037]">{latestKey}</code><button onClick={() => copyText(latestKey)} className="rounded-lg bg-white p-2 text-[#13716e]" aria-label="Copy API key"><Copy size={14} /></button></div></div>}<input value={keyLabel} onChange={e => setKeyLabel(e.target.value)} placeholder="e.g. QA crawler" className="mt-5 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]" data-testid="input-key-label" /><Button className="mt-3 w-full" disabled={createKey.isPending} onClick={submitKey}><KeyRound size={15} /> Create key</Button></div><KeysTable keys={keys.data || []} loading={keys.isLoading} onDelete={id => { if (window.confirm('Revoke this sandbox key?')) deleteKey.mutate({ id }, { onSuccess: refreshKeys }); }} /></div></div><div id="orders" className="mt-10"><SectionTitle eyebrow="settlement" title="Order approval queue" body="Review manual payments before provisioning access." /><AdminOrdersTable orders={adminOrders.data || []} loading={adminOrders.isLoading} onStatus={(id, status) => updateOrder.mutate({ id, data: { status } }, { onSuccess: refreshOrders })} /></div></div></div></AppShell>;
}

function UsersTable({ users, loading, onEdit, onDelete, onToggle }: { users: User[]; loading: boolean; onEdit: (user: User) => void; onDelete: (id: number) => void; onToggle: (user: User) => void }) {
  return <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><State loading={loading} empty={!users.length}><div className="divide-y divide-[#edf2f3]">{users.map(user => <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" data-testid={`row-user-${user.id}`}><div className="flex min-w-[210px] items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-full bg-[#def5f3] text-xs font-extrabold text-[#13716e]">{user.name.slice(0, 1).toUpperCase()}</div><div><p className="text-sm font-bold text-[#142037]">{user.name}</p><p className="text-xs text-slate-500">{user.email}</p></div></div><div className="flex items-center gap-3"><Badge tone={user.status === 'active' ? 'green' : 'red'}>{user.status}</Badge><span className="hidden text-xs text-slate-500 md:inline">{user.planName}</span><button onClick={() => onEdit(user)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-[#142037]" data-testid={`button-edit-user-${user.id}`}><MoreHorizontal size={17} /></button><button onClick={() => onToggle(user)} className="text-xs font-bold text-[#13716e]" data-testid={`button-toggle-user-${user.id}`}>{user.status === 'active' ? 'Suspend' : 'Activate'}</button><button onClick={() => onDelete(user.id)} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" data-testid={`button-delete-user-${user.id}`}><Trash2 size={15} /></button></div></div>)}</div></State></div>;
}

function KeysTable({ keys, loading, onDelete }: { keys: SandboxKey[]; loading: boolean; onDelete: (id: number) => void }) {
  return <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><State loading={loading} empty={!keys.length}><div className="divide-y divide-[#edf2f3]">{keys.map(key => <div key={key.id} className="flex items-center justify-between gap-3 px-5 py-4" data-testid={`row-key-${key.id}`}><div><div className="flex items-center gap-2"><p className="text-sm font-bold text-[#142037]">{key.label}</p><Badge tone={key.status === 'active' ? 'green' : 'red'}>{key.status}</Badge></div><p className="mono mt-1 text-xs text-slate-500">{key.prefix}•••••• · {key.requests.toLocaleString()} requests</p></div><button onClick={() => onDelete(key.id)} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" data-testid={`button-delete-key-${key.id}`}><Trash2 size={15} /></button></div>)}</div></State></div>;
}

function AdminOrdersTable({ orders, loading, onStatus }: { orders: AdminOrder[]; loading: boolean; onStatus: (id: number, status: 'active' | 'rejected') => void }) {
  return <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><State loading={loading} empty={!orders.length}><div className="divide-y divide-[#edf2f3]">{orders.map(order => <div key={order.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4" data-testid={`row-order-${order.id}`}><div><p className="text-sm font-bold text-[#142037]">{order.customerEmail}</p><p className="mt-1 text-xs text-slate-500">{order.planName} · {order.nodeCount} {order.nodeCount === 1 ? 'node' : 'nodes'} · {order.rentalDays} {order.rentalDays === 1 ? 'day' : 'days'} · {order.paymentMethod}</p></div><div className="flex items-center gap-3"><div className="text-right"><p className="text-sm font-bold text-[#142037]">{money(order.amount)}</p><p className="text-xs text-slate-400">{date(order.createdAt)}</p></div>{order.status === 'pending' ? <><Button className="min-h-9 px-3 text-xs" onClick={() => onStatus(order.id, 'active')} data-testid={`button-approve-order-${order.id}`}><Check size={14} /> Approve</Button><Button variant="danger" className="min-h-9 px-3 text-xs" onClick={() => onStatus(order.id, 'rejected')} data-testid={`button-reject-order-${order.id}`}><X size={14} /> Reject</Button></> : <Badge tone={orderTone(order.status)}>{order.status}</Badge>}</div></div>)}</div></State></div>;
}

function PageLayout({ admin = false, eyebrow, title, body, action, children }: { admin?: boolean; eyebrow: string; title: string; body: string; action?: ReactNode; children: ReactNode }) {
  return <AppShell admin={admin}><div className="shell-grid min-h-[calc(100dvh-72px)] px-5 py-8 lg:px-9"><div className="mx-auto max-w-[1420px]"><div className="mb-9 flex flex-wrap items-end justify-between gap-4"><div><p className="mono mb-2 text-[10px] uppercase tracking-[.2em] text-[#e4643d]">{eyebrow}</p><h1 className="text-3xl font-extrabold tracking-[-.05em] text-[#142037] md:text-4xl">{title}</h1><p className="mt-2 max-w-2xl text-sm text-slate-500">{body}</p></div>{action}</div>{children}</div></div></AppShell>;
}

function ClientOverviewPage() {
  const overview = useGetClientOverview();
  return <PageLayout eyebrow="client workspace" title={`Good to see you, ${overview.data?.displayName?.split(' ')[0] || 'operator'}.`} body="Your routing surface, at a glance." action={<Link href="/client/nodes" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[#f46c43] px-4 text-sm font-bold text-white">Manage nodes <ArrowRight size={15} /></Link>}><State loading={overview.isLoading} error={overview.isError} onRetry={() => overview.refetch()}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Active nodes" value={String(overview.data?.activeNodes ?? 0)} detail="Current provisioned footprint" icon={Server} tone="teal" /><Metric label="Requests today" value={(overview.data?.requestsToday ?? 0).toLocaleString()} detail="Across your workspace" icon={Activity} tone="orange" /><Metric label="Success rate" value={`${overview.data?.successRate ?? 0}%`} detail="Last 24 hours" icon={Signal} tone="teal" /><Metric label="Next rotation" value={overview.data?.nextRotationAt ? time(overview.data.nextRotationAt) : '—'} detail={overview.data?.nextRotationAt ? date(overview.data.nextRotationAt) : 'No active plan'} icon={RefreshCw} tone="orange" /></div><div className="mt-6 rounded-3xl bg-[#142037] p-7 text-white"><p className="mono text-[10px] uppercase tracking-[.18em] text-[#69d5d0]">current plan</p><h2 className="mt-3 text-2xl font-extrabold">{overview.data?.activeOrder?.planName || 'No active plan'}</h2><p className="mt-3 text-sm text-slate-300">{overview.data?.activeOrder ? `${overview.data.activeOrder.nodeName} · expires ${date(overview.data.activeOrder.expiresAt)}` : 'Rent a node to begin routing traffic.'}</p></div></State></PageLayout>;
}

function ClientNodesPage() {
  const overview = useGetClientOverview();
  const nodes = useListNodes(undefined, { query: { queryKey: getListNodesQueryKey() } });
  const activeId = overview.data?.activeOrder?.id ?? 0;
  const connection = useGetOrderConnection(activeId, undefined, { query: { enabled: !!activeId, queryKey: getGetOrderConnectionQueryKey(activeId) } });
  const copy = (value: string) => { void navigator.clipboard?.writeText(value); };
  return <PageLayout eyebrow="network" title="Nodes" body="View your live connection and the proxy resources currently available."><div className="grid gap-6 xl:grid-cols-[1.15fr_.85fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><div className="mb-6 flex items-center justify-between"><h2 className="text-xl font-extrabold text-[#142037]">Active connection</h2>{overview.data?.activeOrder && <Badge tone="green">Active</Badge>}</div><State loading={overview.isLoading || connection.isLoading} error={overview.isError || connection.isError} onRetry={() => { void overview.refetch(); if (activeId) void connection.refetch(); }} empty={!overview.data?.activeOrder}>{overview.data?.activeOrder && connection.data && <ConnectionCard connection={connection.data} nodeName={overview.data.activeOrder.nodeName} onCopy={copy} />}</State></div><div><h2 className="mb-4 text-xl font-extrabold text-[#142037]">Available resources</h2><State loading={nodes.isLoading} error={nodes.isError} onRetry={() => nodes.refetch()} empty={!nodes.data?.length}><div className="grid gap-3">{nodes.data?.map(node => <div key={node.id} className="rounded-2xl border border-[#dbe7e9] bg-white p-4"><div className="flex items-center justify-between"><div><p className="font-bold text-[#142037]">{node.name}</p><p className="mt-1 text-xs text-slate-500">{node.city}, {node.country} · {node.protocol}</p></div><Badge tone={node.status === 'online' ? 'green' : 'neutral'}>{node.status}</Badge></div><p className="mono mt-3 text-[10px] text-slate-400">{node.latencyMs}ms latency</p></div>)}</div></State></div></div></PageLayout>;
}

function ClientOrdersPage() {
  const orders = useListClientOrders();
  return <PageLayout eyebrow="billing" title="Orders" body="Review every proxy rental and its current provisioning status."><State loading={orders.isLoading} error={orders.isError} onRetry={() => orders.refetch()} empty={!orders.data?.length}><OrdersTable orders={orders.data || []} /></State></PageLayout>;
}

function AdminOverviewPage() {
  const overview = useGetAdminOverview();
  return <PageLayout admin eyebrow="operator desk" title="Network overview" body="Operational health across customers, resources, and settlement."><State loading={overview.isLoading} error={overview.isError} onRetry={() => overview.refetch()}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"><Metric label="MRR" value={money(overview.data?.mrr)} detail={`${overview.data?.mrrChange ?? 0}% vs last month`} icon={Activity} tone="orange" /><Metric label="Active users" value={String(overview.data?.activeUsers ?? 0)} detail="Currently routing" icon={Users} tone="teal" /><Metric label="Active nodes" value={String(overview.data?.activeNodes ?? 0)} detail="Online resources" icon={Server} tone="teal" /><Metric label="Pending orders" value={String(overview.data?.pendingOrders ?? 0)} detail="Need review" icon={Layers3} tone="orange" /><Metric label="Success rate" value={`${overview.data?.successRate ?? 0}%`} detail="Network average" icon={Signal} tone="teal" /></div><div className="mt-6 rounded-3xl border border-[#dbe7e9] bg-white p-6"><SectionTitle eyebrow="signal feed" title="Recent activity" /><div className="grid gap-4">{overview.data?.recentActivity?.map(item => <div key={item.id} className="flex gap-3"><span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full', item.tone === 'success' ? 'bg-[#69d5d0]' : item.tone === 'warning' ? 'bg-[#f46c43]' : 'bg-slate-300')} /><div className="flex-1"><div className="flex justify-between gap-3"><p className="text-sm font-bold text-[#142037]">{item.title}</p><span className="mono text-[10px] text-slate-400">{item.time}</span></div><p className="mt-1 text-xs text-slate-500">{item.detail}</p></div></div>)}</div></div></State></PageLayout>;
}

const emptyProductForm = (categoryId = 0): ProductInput => ({
  categoryId,
  code: '',
  name: '',
  sku: '',
  description: '',
  productKind: 'account',
  fulfillmentType: 'manual',
  serviceType: 'digital-account',
  countryCode: '',
  basePrice: 0,
  currency: 'USD',
  imageUrl: '',
  isActive: true,
  isFeatured: false,
});

function AdminCatalogPage() {
  const categories = useListCategories();
  const products = useListAdminProducts();
  const qc = useQueryClient();
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();
  const [categoryForm, setCategoryForm] = useState({ name: '', slug: '', description: '', sortOrder: 0, isActive: true });
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [productForm, setProductForm] = useState<ProductInput>(emptyProductForm());
  const [editingProduct, setEditingProduct] = useState<AdminProduct | null>(null);
  const inputClass = 'rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]';
  const refreshCategories = () => void qc.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
  const refreshProducts = () => { void qc.invalidateQueries({ queryKey: getListAdminProductsQueryKey() }); void qc.invalidateQueries({ queryKey: getListPlansQueryKey() }); };
  const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const saveCategory = () => {
    const data = editingCategory ? { name: editingCategory.name, slug: editingCategory.slug, description: editingCategory.description, sortOrder: editingCategory.sortOrder, isActive: editingCategory.isActive } : categoryForm;
    if (!data.name || !data.slug) return;
    const options = { onSuccess: () => { setEditingCategory(null); setCategoryForm({ name: '', slug: '', description: '', sortOrder: 0, isActive: true }); refreshCategories(); }, onError: (error: Error) => window.alert(error.message) };
    if (editingCategory) updateCategory.mutate({ id: editingCategory.id, data }, options);
    else createCategory.mutate({ data }, options);
  };
  const startProductEdit = (product: AdminProduct) => {
    setEditingProduct(product);
    setProductForm({
      categoryId: product.categoryId,
      code: product.code,
      name: product.name,
      sku: product.sku || '',
      description: product.description,
      productKind: product.productKind,
      fulfillmentType: product.fulfillmentType,
      serviceType: product.serviceType,
      countryCode: product.countryCode || '',
      basePrice: product.basePrice,
      currency: product.currency,
      stockQuantity: product.stockQuantity ?? undefined,
      imageUrl: product.imageUrl || '',
      isActive: product.isActive,
      isFeatured: product.isFeatured,
    });
  };
  const resetProduct = () => { setEditingProduct(null); setProductForm(emptyProductForm(categories.data?.[0]?.id || 0)); };
  const saveProduct = () => {
    if (!productForm.categoryId || !productForm.code || !productForm.name || !productForm.serviceType) return;
    const options = { onSuccess: () => { resetProduct(); refreshProducts(); refreshCategories(); }, onError: (error: Error) => window.alert(error.message) };
    if (editingProduct) updateProduct.mutate({ id: editingProduct.id, data: productForm }, options);
    else createProduct.mutate({ data: productForm }, options);
  };
  const productPending = createProduct.isPending || updateProduct.isPending;

  return <PageLayout admin eyebrow="commerce catalog" title="Categories & products" body="Organize subscriptions, digital accounts, files, keys, and future product types from one catalog.">
    <section className="grid gap-5 xl:grid-cols-[.72fr_1.28fr]">
      <div className="rounded-3xl border border-[#dbe7e9] bg-white p-6">
        <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#def5f3] text-[#13716e]"><FolderTree size={18} /></span><div><h2 className="font-extrabold text-[#142037]">{editingCategory ? 'Edit category' : 'New category'}</h2><p className="text-xs text-slate-500">Group related digital products.</p></div></div>
        <div className="mt-5 grid gap-3">
          <input className={inputClass} placeholder="Category name" value={editingCategory?.name ?? categoryForm.name} onChange={event => editingCategory ? setEditingCategory({ ...editingCategory, name: event.target.value }) : setCategoryForm({ ...categoryForm, name: event.target.value, slug: slugify(event.target.value) })} />
          <input className={inputClass} placeholder="slug-example" value={editingCategory?.slug ?? categoryForm.slug} onChange={event => editingCategory ? setEditingCategory({ ...editingCategory, slug: slugify(event.target.value) }) : setCategoryForm({ ...categoryForm, slug: slugify(event.target.value) })} />
          <textarea className={inputClass} rows={3} placeholder="Description" value={editingCategory?.description ?? categoryForm.description} onChange={event => editingCategory ? setEditingCategory({ ...editingCategory, description: event.target.value }) : setCategoryForm({ ...categoryForm, description: event.target.value })} />
          <label className="flex items-center gap-2 text-xs font-bold text-slate-600"><input type="checkbox" checked={editingCategory?.isActive ?? categoryForm.isActive} onChange={event => editingCategory ? setEditingCategory({ ...editingCategory, isActive: event.target.checked }) : setCategoryForm({ ...categoryForm, isActive: event.target.checked })} /> Active</label>
          <div className="flex gap-2"><Button className="flex-1" onClick={saveCategory} disabled={createCategory.isPending || updateCategory.isPending}>{editingCategory ? 'Save category' : 'Add category'}</Button>{editingCategory && <Button variant="quiet" onClick={() => setEditingCategory(null)}>Cancel</Button>}</div>
        </div>
      </div>
      <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white">
        <State loading={categories.isLoading} error={categories.isError} onRetry={() => categories.refetch()} empty={!categories.data?.length}>
          <div className="divide-y divide-[#edf2f3]">{categories.data?.map(category => <div key={category.id} className="flex items-center justify-between gap-4 px-5 py-4"><div><div className="flex items-center gap-2"><p className="font-bold text-[#142037]">{category.name}</p><Badge tone={category.isActive ? 'green' : 'neutral'}>{category.isActive ? 'active' : 'hidden'}</Badge></div><p className="mt-1 text-xs text-slate-500">/{category.slug} · {category.productCount} products</p></div><div className="flex gap-1"><button className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-[#142037]" onClick={() => setEditingCategory(category)} aria-label="Edit category"><MoreHorizontal size={17} /></button><button className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => { if (window.confirm(`Delete category ${category.name}?`)) deleteCategory.mutate({ id: category.id }, { onSuccess: refreshCategories, onError: error => window.alert(error.message) }); }} aria-label="Delete category"><Trash2 size={15} /></button></div></div>)}</div>
        </State>
      </div>
    </section>

    <section className="mt-10 grid gap-5 xl:grid-cols-[.72fr_1.28fr]">
      <div className="rounded-3xl border border-[#dbe7e9] bg-white p-6">
        <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#fff0e8] text-[#d95432]"><Package size={18} /></span><div><h2 className="font-extrabold text-[#142037]">{editingProduct ? 'Edit product' : 'New product'}</h2><p className="text-xs text-slate-500">Account, download, service, or anything else.</p></div></div>
        <div className="mt-5 grid gap-3">
          <select className={inputClass} value={productForm.categoryId || ''} onChange={event => setProductForm({ ...productForm, categoryId: Number(event.target.value) })}><option value="">Select category</option>{categories.data?.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
          <div className="grid gap-3 sm:grid-cols-2"><input className={inputClass} placeholder="Product name" value={productForm.name} onChange={event => setProductForm({ ...productForm, name: event.target.value, ...(!editingProduct && !productForm.code ? { code: slugify(event.target.value) } : {}) })} /><input className={inputClass} placeholder="product-code" value={productForm.code} onChange={event => setProductForm({ ...productForm, code: slugify(event.target.value) })} /></div>
          <div className="grid gap-3 sm:grid-cols-2"><input className={inputClass} placeholder="SKU (optional)" value={productForm.sku || ''} onChange={event => setProductForm({ ...productForm, sku: event.target.value })} /><label className="text-xs font-bold text-slate-600">Base price {productForm.serviceType === 'proxy' ? '/ node / day' : ''}<input className={`${inputClass} mt-1 block w-full`} type="number" min="0" step="0.01" placeholder="0.00" value={productForm.basePrice} onChange={event => setProductForm({ ...productForm, basePrice: Number(event.target.value) })} /></label></div>
          <div className="grid gap-3 sm:grid-cols-2"><select className={inputClass} value={productForm.productKind} onChange={event => setProductForm({ ...productForm, productKind: event.target.value as ProductInput['productKind'] })}><option value="account">Account</option><option value="digital">Digital file / key</option><option value="service">Service</option><option value="other">Other</option></select><select className={inputClass} value={productForm.fulfillmentType} onChange={event => setProductForm({ ...productForm, fulfillmentType: event.target.value as ProductInput['fulfillmentType'] })}><option value="manual">Manual delivery</option><option value="automatic">Automatic delivery</option><option value="service">Service provisioning</option></select></div>
          <div className="grid gap-3 sm:grid-cols-3"><input className={inputClass} placeholder="Service type" value={productForm.serviceType} onChange={event => setProductForm({ ...productForm, serviceType: event.target.value })} /><input className={inputClass} placeholder="Country (US)" maxLength={2} value={productForm.countryCode || ''} onChange={event => setProductForm({ ...productForm, countryCode: event.target.value.toUpperCase() })} /><input className={inputClass} placeholder="Currency" maxLength={3} value={productForm.currency} onChange={event => setProductForm({ ...productForm, currency: event.target.value.toUpperCase() })} /></div>
          <input className={inputClass} type="number" min="0" placeholder="Stock quantity (blank = unlimited)" value={productForm.stockQuantity ?? ''} onChange={event => setProductForm({ ...productForm, stockQuantity: event.target.value === '' ? undefined : Number(event.target.value) })} />
          <input className={inputClass} placeholder="Image URL (optional)" value={productForm.imageUrl || ''} onChange={event => setProductForm({ ...productForm, imageUrl: event.target.value })} />
          <textarea className={inputClass} rows={3} placeholder="Product description" value={productForm.description || ''} onChange={event => setProductForm({ ...productForm, description: event.target.value })} />
          <div className="flex flex-wrap gap-5"><label className="flex items-center gap-2 text-xs font-bold text-slate-600"><input type="checkbox" checked={productForm.isActive} onChange={event => setProductForm({ ...productForm, isActive: event.target.checked })} /> Active</label><label className="flex items-center gap-2 text-xs font-bold text-slate-600"><input type="checkbox" checked={productForm.isFeatured} onChange={event => setProductForm({ ...productForm, isFeatured: event.target.checked })} /> Featured</label></div>
          <div className="flex gap-2"><Button className="flex-1" disabled={productPending || !productForm.categoryId || !productForm.name || !productForm.code} onClick={saveProduct}>{productPending ? 'Saving…' : editingProduct ? 'Save product' : 'Add product'}</Button>{editingProduct && <Button variant="quiet" onClick={resetProduct}>Cancel</Button>}</div>
        </div>
      </div>
      <div><State loading={products.isLoading} error={products.isError} onRetry={() => products.refetch()} empty={!products.data?.length}><div className="grid gap-3">{products.data?.map(product => <article key={product.id} className="rounded-2xl border border-[#dbe7e9] bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex min-w-0 gap-3">{product.imageUrl ? <img src={product.imageUrl} alt="" className="h-12 w-12 rounded-xl object-cover" /> : <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[#def5f3] text-[#13716e]"><Package size={19} /></span>}<div><div className="flex flex-wrap items-center gap-2"><h3 className="font-extrabold text-[#142037]">{product.name}</h3><Badge tone={product.isActive ? 'green' : 'neutral'}>{product.isActive ? 'active' : 'draft'}</Badge>{product.isFeatured && <Badge tone="orange">featured</Badge>}</div><p className="mt-1 text-xs text-slate-500">{product.categoryName} · {product.productKind} · {product.fulfillmentType}</p><p className="mono mt-2 text-[10px] text-slate-400">{product.sku || product.code} · stock {product.stockQuantity ?? 'unlimited'}</p></div></div><div className="flex items-center gap-2"><span className="mr-2 font-extrabold text-[#142037]">{product.currency} {product.basePrice.toFixed(2)}</span><button className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-[#142037]" onClick={() => startProductEdit(product)} aria-label="Edit product"><MoreHorizontal size={17} /></button><button className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => { if (window.confirm(`Delete product ${product.name}?`)) deleteProduct.mutate({ id: product.id }, { onSuccess: () => { refreshProducts(); refreshCategories(); }, onError: error => window.alert(error.message) }); }} aria-label="Delete product"><Trash2 size={15} /></button></div></div>{product.description && <p className="mt-4 border-t border-[#edf2f3] pt-3 text-sm leading-6 text-slate-500">{product.description}</p>}</article>)}</div></State></div>
    </section>
  </PageLayout>;
}

function AdminUsersPage() {
  const users = useListUsers();
  const qc = useQueryClient();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [editing, setEditing] = useState<User | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
  const create = () => {
    if (!form.name || !form.email || form.password.length < 12) return;
    createUser.mutate(
      { data: form },
      {
        onSuccess: () => {
          setForm({ name: '', email: '', password: '' });
          refresh();
        },
        onError: error => window.alert(error.message),
      },
    );
  };

  return <PageLayout admin eyebrow="directory" title="Users" body="Create customer login accounts and maintain their access.">
    <div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]">
      <div className="rounded-3xl border border-[#dbe7e9] bg-white p-6">
        <h2 className="font-extrabold text-[#142037]">{editing ? 'Edit user' : 'Add user'}</h2>
        <div className="mt-5 grid gap-3">
          <input value={editing?.name ?? form.name} onChange={event => editing ? setEditing({ ...editing, name: event.target.value }) : setForm({ ...form, name: event.target.value })} placeholder="Name" className="rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" />
          <input value={editing?.email ?? form.email} disabled={!!editing} onChange={event => setForm({ ...form, email: event.target.value })} placeholder="Email" type="email" className="rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm disabled:opacity-50" />
          {!editing && <>
            <input value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} placeholder="Temporary password" type="password" minLength={12} autoComplete="new-password" className="rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" />
            <p className="text-xs leading-5 text-slate-500">At least 12 characters. Send this temporary password to the customer securely.</p>
          </>}
          {editing ? <div className="flex gap-2"><Button className="flex-1" onClick={() => updateUser.mutate({ id: editing.id, data: { name: editing.name, status: editing.status } }, { onSuccess: () => { setEditing(null); refresh(); } })}>Save</Button><Button variant="quiet" onClick={() => setEditing(null)}>Cancel</Button></div> : <Button disabled={createUser.isPending || !form.name || !form.email || form.password.length < 12} onClick={create}><Plus size={15} /> {createUser.isPending ? 'Creating...' : 'Add user'}</Button>}
        </div>
      </div>
      <UsersTable users={users.data || []} loading={users.isLoading} onEdit={setEditing} onDelete={id => { if (window.confirm('Delete this user record?')) deleteUser.mutate({ id }, { onSuccess: refresh }); }} onToggle={user => updateUser.mutate({ id: user.id, data: { status: user.status === 'active' ? 'suspended' : 'active' } }, { onSuccess: refresh })} />
    </div>
  </PageLayout>;
}

function AdminKeysPage() {
  const keys = useListSandboxKeys();
  const qc = useQueryClient();
  const createKey = useCreateSandboxKey(); const deleteKey = useDeleteSandboxKey();
  const [label, setLabel] = useState(''); const [secret, setSecret] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: getListSandboxKeysQueryKey() });
  const create = () => { if (!label) return; createKey.mutate({ data: { label } }, { onSuccess: result => { setLabel(''); setSecret(result.secret || ''); refresh(); } }); };
  return <PageLayout admin eyebrow="developer access" title="Sandbox API keys" body="Issue and revoke credentials used by integrations."><div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><h2 className="font-extrabold text-[#142037]">Create a key</h2>{secret && <div className="mt-4 rounded-xl border border-[#bfe3df] bg-[#eaf8f6] p-3"><p className="text-[10px] font-bold uppercase text-[#13716e]">Copy this key now</p><div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 break-all text-xs">{secret}</code><button onClick={() => void navigator.clipboard?.writeText(secret)}><Copy size={14} /></button></div></div>}<input value={label} onChange={event => setLabel(event.target.value)} placeholder="e.g. QA crawler" className="mt-5 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" /><Button className="mt-3 w-full" onClick={create}><KeyRound size={15} /> Create key</Button></div><KeysTable keys={keys.data || []} loading={keys.isLoading} onDelete={id => { if (window.confirm('Revoke this sandbox key?')) deleteKey.mutate({ id }, { onSuccess: refresh }); }} /></div></PageLayout>;
}

function AdminOrdersPage() {
  const orders = useListAdminOrders();
  const updateOrder = useUpdateOrderStatus();
  const qc = useQueryClient();
  const refresh = () => { void qc.invalidateQueries({ queryKey: getListAdminOrdersQueryKey() }); void qc.invalidateQueries({ queryKey: getGetAdminOverviewQueryKey() }); };
  return <PageLayout admin eyebrow="settlement" title="Order approval queue" body="Review manual payments before provisioning customer access."><AdminOrdersTable orders={orders.data || []} loading={orders.isLoading} onStatus={(id, status) => updateOrder.mutate({ id, data: { status } }, { onSuccess: refresh })} /></PageLayout>;
}

function AdminProvidersPage() {
  const providers = useListProviders();
  const createProvider = useCreateProvider();
  const updateProvider = useUpdateProvider();
  const deleteProvider = useDeleteProvider();
  const qc = useQueryClient();
  const emptyForm = { name: '', code: '', apiBaseUrl: '', maxSandboxes: 20, reservedReplacementSlots: 1, maxConcurrentProvisions: 2 };
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<ProxyProvider | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: getListProvidersQueryKey() });
  const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const save = () => {
    const data = editing ? {
      name: editing.name,
      code: editing.code,
      apiBaseUrl: editing.apiBaseUrl || '',
      status: editing.status,
      maxSandboxes: editing.maxSandboxes ?? 20,
      reservedReplacementSlots: editing.reservedReplacementSlots,
      maxConcurrentProvisions: editing.maxConcurrentProvisions,
    } : form;
    if (!data.name || !data.code) return;
    if ((data.maxSandboxes || 0) <= data.reservedReplacementSlots) {
      window.alert('Max sandboxes must be greater than reserved replacement slots.');
      return;
    }
    const options = { onSuccess: () => { setEditing(null); setForm(emptyForm); refresh(); }, onError: (error: Error) => window.alert(error.message) };
    if (editing) updateProvider.mutate({ id: editing.id, data }, options); else createProvider.mutate({ data }, options);
  };
  const inputClass = 'rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]';
  const setCapacity = (field: 'maxSandboxes' | 'reservedReplacementSlots' | 'maxConcurrentProvisions', value: number) => {
    if (editing) setEditing({ ...editing, [field]: value });
    else setForm({ ...form, [field]: value });
  };
  return <PageLayout admin eyebrow="proxy module" title="Providers" body="Manage upstream compute providers and enforce their sandbox capacity.">
    <div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]">
      <div className="rounded-3xl border border-[#dbe7e9] bg-white p-6">
        <h2 className="font-extrabold">{editing ? 'Edit provider' : 'Add provider'}</h2>
        <div className="mt-5 grid gap-3">
          <input className={inputClass} placeholder="Provider name" value={editing?.name ?? form.name} onChange={event => editing ? setEditing({ ...editing, name: event.target.value }) : setForm({ ...form, name: event.target.value, code: slugify(event.target.value) })} />
          <input className={inputClass} placeholder="provider-code" value={editing?.code ?? form.code} onChange={event => editing ? setEditing({ ...editing, code: slugify(event.target.value) }) : setForm({ ...form, code: slugify(event.target.value) })} />
          <input className={inputClass} placeholder="API base URL" value={editing?.apiBaseUrl ?? form.apiBaseUrl} onChange={event => editing ? setEditing({ ...editing, apiBaseUrl: event.target.value }) : setForm({ ...form, apiBaseUrl: event.target.value })} />
          <div className="grid grid-cols-3 gap-2">
            <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Max sandbox<input className={`${inputClass} mt-1 w-full`} type="number" min={1} value={editing?.maxSandboxes ?? form.maxSandboxes} onChange={event => setCapacity('maxSandboxes', Math.max(1, Number(event.target.value) || 1))} /></label>
            <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Reserve<input className={`${inputClass} mt-1 w-full`} type="number" min={0} value={editing?.reservedReplacementSlots ?? form.reservedReplacementSlots} onChange={event => setCapacity('reservedReplacementSlots', Math.max(0, Number(event.target.value) || 0))} /></label>
            <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Concurrency<input className={`${inputClass} mt-1 w-full`} type="number" min={1} value={editing?.maxConcurrentProvisions ?? form.maxConcurrentProvisions} onChange={event => setCapacity('maxConcurrentProvisions', Math.max(1, Number(event.target.value) || 1))} /></label>
          </div>
          {editing && <select className={inputClass} value={editing.status} onChange={event => setEditing({ ...editing, status: event.target.value as ProxyProvider['status'] })}><option value="active">Active</option><option value="disabled">Disabled</option></select>}
          <div className="flex gap-2"><Button className="flex-1" onClick={save}>{editing ? 'Save provider' : 'Add provider'}</Button>{editing && <Button variant="quiet" onClick={() => setEditing(null)}>Cancel</Button>}</div>
        </div>
      </div>
      <State loading={providers.isLoading} error={providers.isError} onRetry={() => providers.refetch()} empty={!providers.data?.length}>
        <div className="grid content-start gap-3">{providers.data?.map(provider => {
          const customerCapacity = provider.maxSandboxes === null ? null : Math.max(0, provider.maxSandboxes - provider.reservedReplacementSlots);
          return <div key={provider.id} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#dbe7e9] bg-white p-5">
            <div><div className="flex items-center gap-2"><p className="font-extrabold">{provider.name}</p><Badge tone={provider.status === 'active' ? 'green' : 'neutral'}>{provider.status}</Badge></div><p className="mono mt-1 text-[10px] text-slate-400">{provider.code} · {provider.apiBaseUrl || 'No API URL'}</p><p className="mt-2 text-xs text-slate-500">{provider.activeSandboxes}/{provider.maxSandboxes ?? '∞'} running · {provider.reservedReplacementSlots} reserved · {customerCapacity ?? '∞'} customer capacity · concurrency {provider.maxConcurrentProvisions}</p><p className="mt-1 text-xs text-slate-400">{provider.keyCount} keys · {provider.resourceCount} legacy resources</p></div>
            <div className="flex gap-1"><button className="rounded-lg p-2 text-slate-400 hover:bg-slate-100" onClick={() => setEditing({ ...provider, maxSandboxes: provider.maxSandboxes ?? 20 })}><MoreHorizontal size={17} /></button><button className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => { if (window.confirm(`Delete ${provider.name}?`)) deleteProvider.mutate({ id: provider.id }, { onSuccess: refresh, onError: error => window.alert(error.message) }); }}><Trash2 size={15} /></button></div>
          </div>;
        })}</div>
      </State>
    </div>
  </PageLayout>;
}

function AdminProviderApiKeysPage() {
  const providers = useListProviders();
  const keys = useListProviderApiKeys();
  const createKey = useCreateProviderApiKey();
  const revokeKey = useRevokeProviderApiKey();
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState(0);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: getListProviderApiKeysQueryKey() }); void qc.invalidateQueries({ queryKey: getListProvidersQueryKey() }); };
  const submit = () => { if (!providerId || !label || secret.length < 8) return; createKey.mutate({ providerId, data: { label, secret } }, { onSuccess: () => { setLabel(''); setSecret(''); refresh(); }, onError: error => window.alert(error.message) }); };
  const inputClass = 'rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]';
  return <PageLayout admin eyebrow="proxy module" title="Provider API keys" body="Store upstream credentials per provider. Secrets are encrypted at rest and never returned by the API."><div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><h2 className="font-extrabold">Add provider key</h2><div className="mt-5 grid gap-3"><select className={inputClass} value={providerId || ''} onChange={event => setProviderId(Number(event.target.value))}><option value="">Select provider</option>{providers.data?.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><input className={inputClass} placeholder="Label" value={label} onChange={event => setLabel(event.target.value)} /><input className={inputClass} type="password" autoComplete="new-password" placeholder="Provider API secret" value={secret} onChange={event => setSecret(event.target.value)} /><p className="text-xs leading-5 text-slate-500">Requires `PROVIDER_SECRET_ENCRYPTION_KEY` on the Nest server.</p><Button disabled={!providerId || !label || secret.length < 8 || createKey.isPending} onClick={submit}>{createKey.isPending ? 'Encrypting…' : 'Save encrypted key'}</Button></div></div><State loading={keys.isLoading} error={keys.isError} onRetry={() => keys.refetch()} empty={!keys.data?.length}><div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><div className="divide-y divide-[#edf2f3]">{keys.data?.map(key => <div key={key.id} className="flex items-center justify-between gap-4 px-5 py-4"><div><div className="flex items-center gap-2"><p className="text-sm font-bold">{key.label}</p><Badge tone={key.status === 'active' ? 'green' : 'red'}>{key.status}</Badge></div><p className="mt-1 text-xs text-slate-500">{key.providerName}</p><p className="mono mt-1 text-[10px] text-slate-400">{key.maskedKey}</p></div>{key.status === 'active' && <Button variant="danger" className="min-h-8 px-3 text-xs" onClick={() => revokeKey.mutate({ id: key.id }, { onSuccess: refresh })}>Revoke</Button>}</div>)}</div></div></State></div></PageLayout>;
}

function ProxyPriceRow({ setting }: { setting: { id: number; name: string; countryCode: string | null; basePrice: number; currency: string; isActive: boolean } }) {
  const [price, setPrice] = useState(setting.basePrice);
  const [currency, setCurrency] = useState(setting.currency);
  const update = useUpdateProxyPrice();
  const qc = useQueryClient();
  return <div className="grid gap-3 border-b border-[#edf2f3] px-5 py-4 last:border-0 sm:grid-cols-[1fr_130px_90px_auto] sm:items-center"><div><p className="font-bold">{setting.name}</p><p className="text-xs text-slate-500">{setting.countryCode || 'Global'} · {setting.isActive ? 'Active' : 'Inactive'}</p></div><input className="rounded-xl border border-[#dbe7e9] px-3 py-2 text-sm" type="number" min="0" step="0.01" value={price} onChange={event => setPrice(Number(event.target.value))} /><input className="rounded-xl border border-[#dbe7e9] px-3 py-2 text-sm" maxLength={3} value={currency} onChange={event => setCurrency(event.target.value.toUpperCase())} /><Button className="min-h-9 px-3 text-xs" disabled={update.isPending} onClick={() => update.mutate({ id: setting.id, data: { basePrice: price, currency } }, { onSuccess: () => void qc.invalidateQueries({ queryKey: getProxySettingsQueryKey() }), onError: error => window.alert(error.message) })}>Save</Button></div>;
}

function AdminProxySettingsPage() {
  const settings = useProxySettings();
  return <PageLayout admin eyebrow="proxy module" title="Proxy pricing" body="Set the authoritative price for one node per day. Quote and order totals are always calculated on the server."><State loading={settings.isLoading} error={settings.isError} onRetry={() => settings.refetch()} empty={!settings.data?.length}><div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white">{settings.data?.map(setting => <ProxyPriceRow key={setting.id} setting={setting} />)}</div></State></PageLayout>;
}

function AdminGeneralSettingsPage() {
  const settings = useGeneralSettings();
  const update = useUpdateGeneralSettings();
  const qc = useQueryClient();
  const [form, setForm] = useState<GeneralSettings>({ siteName: 'Proxy Node', supportEmail: '', defaultCurrency: 'USD' });
  useEffect(() => { if (settings.data) setForm(settings.data); }, [settings.data]);
  const inputClass = 'mt-2 block w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]';
  return <PageLayout admin eyebrow="system" title="Settings" body="General application defaults shared across modules."><State loading={settings.isLoading} error={settings.isError} onRetry={() => settings.refetch()}><div className="max-w-2xl rounded-3xl border border-[#dbe7e9] bg-white p-6"><div className="grid gap-4"><label className="text-sm font-bold">Site name<input className={inputClass} value={form.siteName} onChange={event => setForm({ ...form, siteName: event.target.value })} /></label><label className="text-sm font-bold">Support email<input className={inputClass} type="email" value={form.supportEmail} onChange={event => setForm({ ...form, supportEmail: event.target.value })} /></label><label className="text-sm font-bold">Default currency<input className={inputClass} maxLength={3} value={form.defaultCurrency} onChange={event => setForm({ ...form, defaultCurrency: event.target.value.toUpperCase() })} /></label><Button className="mt-2 w-fit" disabled={update.isPending} onClick={() => update.mutate({ data: { ...form, supportEmail: form.supportEmail || undefined } }, { onSuccess: () => void qc.invalidateQueries({ queryKey: getGeneralSettingsQueryKey() }), onError: error => window.alert(error.message) })}>{update.isPending ? 'Saving…' : 'Save settings'}</Button></div></div></State></PageLayout>;
}

function ClientHeader({ active = 'services' }: { active?: 'services' | 'proxy' | 'security' }) {
  const { user, signOut } = useAuth();
  const [, setLocation] = useLocation();
  const identity = useCurrentUser();
  const displayName = String(user?.user_metadata?.name || user?.email?.split('@')[0] || 'Customer');
  const logout = () => void signOut().then(() => { queryClient.clear(); setLocation('/'); });
  const linkClass = (selected: boolean) => cx('rounded-lg px-3 py-2 text-sm font-semibold transition', selected ? 'bg-[#def5f3] text-[#13716e]' : 'text-slate-500 hover:text-[#e05c37]');
  return <header className="sticky top-0 z-40 border-b border-[#dbe7e9] bg-white/90 backdrop-blur-xl"><div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between gap-4 px-5 lg:px-8"><Logo /><nav className="hidden items-center gap-1 md:flex"><Link href="/client" className={linkClass(active === 'services')}>Services</Link><Link href="/client/proxy" className={linkClass(active === 'proxy')}>SOCKS5 Proxy</Link><Link href="/client/security" className={linkClass(active === 'security')}>Security</Link></nav><div className="flex items-center gap-2">{identity.data?.role === 'admin' && <Link href="/admin" className="hidden rounded-xl px-3 py-2 text-xs font-bold text-[#13716e] hover:bg-[#def5f3] sm:inline-flex">Admin</Link>}<div className="hidden text-right sm:block"><p className="text-xs font-bold">{displayName}</p><p className="text-[10px] text-slate-500">{user?.email}</p></div><button onClick={logout} className="grid h-10 w-10 place-items-center rounded-xl border border-[#dbe7e9] bg-white text-slate-600 hover:border-[#f46c43] hover:text-[#e05c37]" aria-label="Sign out"><LogOut size={16} /></button></div></div></header>;
}

function SecurityPage() {
  const identity = useCurrentUser();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const [factorId, setFactorId] = useState('');
  const [sessionVerified, setSessionVerified] = useState(false);
  const [qrCode, setQrCode] = useState('');
  const [manualSecret, setManualSecret] = useState('');
  const [secretCopied, setSecretCopied] = useState(false);
  const [code, setCode] = useState('');
  const [verificationError, setVerificationError] = useState('');
  const [message, setMessage] = useState('Loading MFA status…');
  const [pending, setPending] = useState(false);

  const refresh = async () => {
    const [{ data: factors, error }, { data: assurance }] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    if (error) throw error;
    const verified = factors.totp.find(factor => factor.status === 'verified');
    const isSessionVerified = assurance?.currentLevel === 'aal2';
    setFactorId(verified?.id || '');
    setSessionVerified(isSessionVerified);
    setMessage(verified
      ? isSessionVerified
        ? 'MFA is enabled and verified for this session.'
        : 'MFA is enabled. Enter a current authenticator code to unlock admin access.'
      : 'MFA is not enabled. Administrators should enroll before ADMIN_REQUIRE_MFA is enabled.');
  };

  useEffect(() => {
    void refresh().catch(error => setMessage(error instanceof Error ? error.message : 'Unable to load MFA status'));
  }, []);

  const enroll = async () => {
    setPending(true);
    setVerificationError('');
    try {
      const existing = await supabase.auth.mfa.listFactors();
      if (existing.error) throw existing.error;
      const staleFactors = existing.data.all.filter(factor =>
        factor.factor_type === 'totp' &&
        factor.status === 'unverified' &&
        factor.friendly_name === 'Proxy Node Admin'
      );
      for (const factor of staleFactors) {
        const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id });
        if (removed.error) throw removed.error;
      }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Proxy Node Admin' });
      if (error) throw error;
      setFactorId(data.id);
      setQrCode(data.totp.qr_code);
      setManualSecret(data.totp.secret);
      setSecretCopied(false);
      setMessage('Scan this QR code, or enter the setup key manually, then provide the six-digit code.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to enroll MFA');
    } finally {
      setPending(false);
    }
  };

  const verify = async () => {
    if (!factorId) return;
    if (!/^\d{6}$/.test(code)) {
      setVerificationError('Enter the complete six-digit code from your authenticator app.');
      return;
    }
    setPending(true);
    setVerificationError('');
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      if (error) throw error;
    } catch {
      setVerificationError('The 2FA code is invalid or has expired. Wait for a new code and try again.');
      setPending(false);
      return;
    }

    setCode('');
    setQrCode('');
    setManualSecret('');
    setSecretCopied(false);
    try {
      await refresh();
      await qc.invalidateQueries({ queryKey: getCurrentUserQueryKey() });
      const updatedIdentity = await identity.refetch();
      setLocation(updatedIdentity.data?.role === 'admin' ? '/admin' : '/client');
    } catch {
      setSessionVerified(true);
      setMessage('MFA was verified, but the account could not be refreshed. Use Continue to admin or reload this page.');
    }
    setPending(false);
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(manualSecret);
      setSecretCopied(true);
    } catch {
      setMessage('Clipboard access was blocked. Select and copy the setup key manually.');
    }
  };

  return <div className="min-h-[100dvh] bg-[#f4f8f8] text-[#142037]">
    <ClientHeader active="security" />
    <main className="mx-auto max-w-3xl px-5 py-10 lg:px-8">
      <p className="mono text-[10px] uppercase tracking-[.2em] text-[#e4643d]">account security</p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-[-.05em]">Multi-factor authentication</h1>
      <div className="mt-7 rounded-3xl border border-[#dbe7e9] bg-white p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#def5f3] text-[#13716e]"><ShieldCheck size={20} /></span>
          <p className="text-sm leading-6 text-slate-600">{message}</p>
        </div>

        {qrCode && <img src={qrCode} alt="Authenticator enrollment QR code" className="mx-auto mt-6 h-52 w-52" />}

        {manualSecret && <div className="mt-5 rounded-2xl border border-[#dbe7e9] bg-[#f8fbfb] p-4">
          <p className="text-xs font-bold text-[#142037]">Can’t scan the QR code?</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">Choose “Enter setup key” in your authenticator app. Account: <span className="font-semibold">Proxy Node Admin</span>, type: <span className="font-semibold">Time based</span>.</p>
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-[#dbe7e9] bg-white px-3 py-2">
            <code className="min-w-0 flex-1 break-all text-xs font-bold tracking-[.12em] text-[#142037]">{manualSecret}</code>
            <button type="button" onClick={() => void copySecret()} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#def5f3] px-3 py-2 text-xs font-bold text-[#13716e]" aria-label="Copy authenticator setup key">
              <Copy size={13} />{secretCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-amber-700">Keep this setup key private. Anyone with it can generate your 2FA codes.</p>
        </div>}

        {!factorId && <Button className="mt-6" disabled={pending} onClick={enroll}>Enroll authenticator</Button>}

        {factorId && !sessionVerified && <div className="mt-6 max-w-sm">
          <div className="flex gap-3">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={event => { setCode(event.target.value.replace(/\D/g, '')); setVerificationError(''); }}
              placeholder="6-digit code"
              aria-invalid={Boolean(verificationError)}
              aria-describedby={verificationError ? 'mfa-code-error' : undefined}
              className={cx('min-w-0 flex-1 rounded-xl border px-4 py-3 text-sm outline-none', verificationError ? 'border-red-400 bg-red-50 focus:border-red-500' : 'border-[#dbe7e9] focus:border-[#f46c43]')}
            />
            <Button disabled={pending || code.length !== 6} onClick={verify}>{pending ? 'Verifying…' : 'Verify'}</Button>
          </div>
          {verificationError && <p id="mfa-code-error" role="alert" aria-live="polite" className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold leading-5 text-red-700">{verificationError}</p>}
        </div>}

        {factorId && sessionVerified && <div className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <Check size={17} className="text-emerald-700" />
          <p className="flex-1 text-sm font-semibold text-emerald-800">This session has passed multi-factor authentication.</p>
          {identity.data?.role === 'admin' && <Button onClick={() => setLocation('/admin')}>Continue to admin</Button>}
        </div>}
      </div>
    </main>
  </div>;
}

function ClientDashboardPage() {
  const services = [
    { name: 'US SOCKS5 Proxy', description: 'Rent rotating SOCKS5 nodes by quantity and number of live days.', status: 'available', href: '/client/proxy', route: '/client/proxy', icon: Network, tone: 'teal' },
    { name: 'Digital Accounts', description: 'Purchase and manage account-based digital products.', status: 'coming soon', route: '/client/accounts', icon: Users, tone: 'orange' },
    { name: 'API & Automation', description: 'Managed APIs, keys, and automated workflows.', status: 'coming soon', route: '/client/automation', icon: Zap, tone: 'teal' },
    { name: 'Cloud Servers', description: 'Short-lived servers and hosted workloads.', status: 'coming soon', route: '/client/servers', icon: Server, tone: 'orange' },
  ] as const;
  return <div className="min-h-[100dvh] bg-[#f4f8f8] text-[#142037]"><ClientHeader /><main className="mx-auto max-w-7xl px-5 py-9 lg:px-8 lg:py-12"><div className="mb-8"><p className="mono text-[10px] uppercase tracking-[.2em] text-[#e4643d]">service workspace</p><h1 className="mt-2 text-3xl font-extrabold tracking-[-.05em] md:text-4xl">Choose a service</h1><p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">Each service has its own focused workspace for ordering and management.</p></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{services.map(service => { const Icon = service.icon; const available = service.status === 'available'; const content = <><div className="flex items-start justify-between gap-3"><span className={cx('grid h-11 w-11 place-items-center rounded-2xl', service.tone === 'teal' ? 'bg-[#def5f3] text-[#13716e]' : 'bg-[#fff0e8] text-[#d95432]')}><Icon size={20} /></span><Badge tone={available ? 'green' : 'neutral'}>{service.status}</Badge></div><h2 className="mt-6 text-lg font-extrabold">{service.name}</h2><p className="mt-2 min-h-12 text-sm leading-6 text-slate-500">{service.description}</p><div className="mt-5 flex items-center justify-between border-t border-[#edf2f3] pt-4"><span className="mono text-[9px] text-slate-400">{service.route}</span>{available && <span className="inline-flex items-center gap-1 text-xs font-bold text-[#e05c37]">Open <ArrowRight size={13} /></span>}</div></>; return available ? <Link key={service.name} href={service.href} className="rounded-3xl border border-[#dbe7e9] bg-white p-5 transition hover:-translate-y-1 hover:border-[#f46c43] hover:shadow-[0_14px_35px_rgba(20,32,55,.07)]">{content}</Link> : <article key={service.name} aria-disabled="true" className="rounded-3xl border border-[#dbe7e9] bg-white/65 p-5 opacity-75">{content}</article>; })}</div></main></div>;
}

function ProxyOrderForm({ product }: { product: CatalogProduct }) {
  const [nodeCount, setNodeCount] = useState(1);
  const [rentalDays, setRentalDays] = useState(1);
  const [payment, setPayment] = useState<'bank_transfer' | 'crypto'>('bank_transfer');
  const quote = useOrderQuote(product.id, nodeCount, rentalDays, { query: { retry: false } });
  const createOrder = useCreateOrder();
  const qc = useQueryClient();
  const submit = () => {
    if (!quote.data) return;
    createOrder.mutate({ data: { productId: product.id, nodeCount, rentalDays, paymentMethod: payment } }, {
      onSuccess: () => {
        setNodeCount(1);
        setRentalDays(1);
        void qc.invalidateQueries({ queryKey: getListClientOrdersQueryKey() });
        void qc.invalidateQueries({ queryKey: getGetClientOverviewQueryKey() });
      },
      onError: error => window.alert(error.message),
    });
  };
  const fieldClass = 'w-full rounded-lg border border-[#dbe7e9] bg-white px-2.5 py-2 text-xs text-[#142037] outline-none focus:border-[#f46c43]';
  const code = product.countryCode || '—';
  const flag = product.countryCode ? String.fromCodePoint(...product.countryCode.split('').map(char => 127397 + char.charCodeAt(0))) : '🌐';
  let country = code;
  try { country = product.countryCode ? new Intl.DisplayNames(['en'], { type: 'region' }).of(product.countryCode) || code : 'Global'; } catch { country = code; }
  return <>
    <tr className="border-b border-[#edf2f3] last:border-0">
      <td className="px-4 py-4"><div className="flex items-center gap-2"><span className="text-xl">{flag}</span><div><p className="text-xs font-bold text-[#142037]">{country}</p><p className="mono text-[9px] text-slate-400">{code}</p></div></div></td>
      <td className="px-4 py-4"><p className="text-xs font-bold text-[#142037]">{product.name}</p><p className="mt-1 max-w-[230px] truncate text-[10px] text-slate-500" title={product.description}>{product.description}</p></td>
      <td className="whitespace-nowrap px-4 py-4 text-xs font-extrabold text-[#13716e]">{money(product.unitPrice)}<span className="ml-1 font-normal text-slate-400">/ day</span></td>
      <td className="w-24 px-3 py-4"><input aria-label={`Nodes for ${country}`} className={fieldClass} type="number" min={1} max={100} step={1} value={nodeCount} onChange={event => setNodeCount(Math.min(100, Math.max(1, Math.trunc(Number(event.target.value) || 1))))} /></td>
      <td className="w-24 px-3 py-4"><input aria-label={`Days for ${country}`} className={fieldClass} type="number" min={1} max={365} step={1} value={rentalDays} onChange={event => setRentalDays(Math.min(365, Math.max(1, Math.trunc(Number(event.target.value) || 1))))} /></td>
      <td className="w-36 px-3 py-4"><select aria-label={`Payment for ${country}`} className={fieldClass} value={payment} onChange={event => setPayment(event.target.value as typeof payment)}><option value="bank_transfer">Bank transfer</option><option value="crypto">Crypto</option></select></td>
      <td className="whitespace-nowrap px-4 py-4 text-sm font-extrabold text-[#142037]">{quote.isLoading ? '…' : money(quote.data?.total || 0)}</td>
      <td className="px-4 py-4"><Button className="min-h-9 whitespace-nowrap px-3 text-xs" disabled={createOrder.isPending || quote.isLoading || !quote.data} onClick={submit}>{createOrder.isPending ? 'Creating…' : 'Order now'}</Button></td>
    </tr>
    {quote.isError && <tr className="border-b border-[#edf2f3]"><td colSpan={8} className="bg-red-50 px-4 py-2 text-xs text-red-700">{country}: {quote.error.message}</td></tr>}
  </>;
}

function ClientPortalPage() {
  const overview = useGetClientOverview();
  const products = useListProducts();
  const orders = useListClientOrders();
  const runtimeNodes = useListClientProxyNodes();
  const qc = useQueryClient();
  const activeOrders = (orders.data || []).filter(order => order.status === 'active' && (!order.expiresAt || new Date(order.expiresAt) > new Date()));
  const activeOrderById = new Map(activeOrders.map(order => [order.id, order]));
  const activeNodes = (runtimeNodes.data || []).filter(node => activeOrderById.has(node.orderId) && node.status !== 'terminated');
  const services = (products.data || []).filter(product => product.serviceType === 'proxy');

  useEffect(() => subscribeToProxyNodeEvents(event => {
    if (event.type !== 'proxy.connected' && !event.type.startsWith('proxy.node.')) return;
    void qc.invalidateQueries({ queryKey: getListClientProxyNodesQueryKey() });
    if (event.type.startsWith('proxy.node.')) {
      void qc.invalidateQueries({ queryKey: getGetClientOverviewQueryKey() });
      void qc.invalidateQueries({ queryKey: getListClientOrdersQueryKey() });
    }
  }), [qc]);

  const liveNodeCount = runtimeNodes.data?.filter(node => ['online', 'rotating', 'degraded'].includes(node.status)).length ?? activeOrders.length;

  return <div className="min-h-[100dvh] bg-[#f4f8f8] text-[#142037]">
    <ClientHeader active="proxy" />

    <main className="mx-auto max-w-7xl px-5 py-9 lg:px-8 lg:py-12">
      <section className="relative overflow-hidden rounded-[2rem] bg-[#142037] px-6 py-8 text-white md:px-9"><div className="hero-grid absolute inset-0 opacity-20" /><div className="relative flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><Link href="/client" className="mono text-[10px] uppercase tracking-[.18em] text-[#69d5d0] hover:text-white">Services / SOCKS5 Proxy</Link><h1 className="mt-3 text-3xl font-extrabold tracking-[-.05em] md:text-4xl">US SOCKS5 Proxy</h1><p className="mt-3 max-w-xl text-sm leading-6 text-slate-300">Order nodes by country, manage credentials, and track live time in one focused workspace.</p></div><a href="#catalog" className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-xl bg-[#f46c43] px-4 text-sm font-bold text-white hover:bg-[#df5934]">Order proxy <ArrowRight size={15} /></a></div></section>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Active nodes" value={String(liveNodeCount)} detail="Synced by live status stream" icon={Network} tone="teal" /><Metric label="Requests today" value={(overview.data?.requestsToday || 0).toLocaleString()} detail="Proxy traffic" icon={Activity} tone="orange" /><Metric label="Success rate" value={`${overview.data?.successRate ?? 100}%`} detail="Last 24 hours" icon={Signal} tone="teal" /><Metric label="Proxy orders" value={String(orders.data?.length || 0)} detail="Account history" icon={Gauge} tone="orange" /></section>

      <section id="my-services" className="scroll-mt-24 pt-16"><SectionTitle eyebrow="portfolio" title="My proxy nodes" body="Every order can contain multiple nodes, all using the same account username and password." />
        <State loading={orders.isLoading || runtimeNodes.isLoading} error={orders.isError || runtimeNodes.isError} onRetry={() => { void orders.refetch(); void runtimeNodes.refetch(); }} empty={!activeNodes.length}><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{activeNodes.map(node => { const order = activeOrderById.get(node.orderId)!; return <div key={node.id} className="min-w-0"><div className="mb-2 flex items-center justify-between px-1"><p className="truncate text-xs font-bold text-[#142037]">{order.productName}</p><span className="mono ml-2 shrink-0 text-[9px] uppercase text-slate-400">Order #{order.id} · node {node.id}</span></div><ActiveNodeItem order={order} node={node} /></div>; })}</div></State>
      </section>

      <section id="catalog" className="scroll-mt-24 pt-16"><SectionTitle eyebrow="proxy catalog" title="SOCKS5 by country" body="Compare countries and create an order directly from the table." /><State loading={products.isLoading} error={products.isError} onRetry={() => products.refetch()} empty={!services.length}><div className="overflow-x-auto rounded-3xl border border-[#dbe7e9] bg-white"><table className="min-w-[980px] w-full text-left"><thead className="bg-[#f8fbfb] text-[9px] font-bold uppercase tracking-[.13em] text-slate-400"><tr><th className="px-4 py-3">Country</th><th className="px-4 py-3">Proxy service</th><th className="px-4 py-3">Price / node</th><th className="px-3 py-3">Nodes</th><th className="px-3 py-3">Days</th><th className="px-3 py-3">Payment</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Action</th></tr></thead><tbody>{services.map(service => <ProxyOrderForm key={service.id} product={service} />)}</tbody></table></div></State></section>

      <section id="orders" className="scroll-mt-24 pt-16 pb-12"><SectionTitle eyebrow="account history" title="Recent orders" body="Track pending approvals, active subscriptions, and past purchases." /><State loading={orders.isLoading} error={orders.isError} onRetry={() => orders.refetch()} empty={!orders.data?.length}><OrdersTable orders={(orders.data || []).slice(0, 8)} /></State></section>
    </main>

  </div>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-[#142037]/60 px-4 py-6 backdrop-blur-sm" role="dialog" aria-modal="true"><div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl"><div className="mb-6 flex items-center justify-between"><h2 className="text-xl font-extrabold tracking-[-.04em] text-[#142037]">{title}</h2><button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-[#142037]" data-testid="button-close-modal"><X size={18} /></button></div>{children}</div></div>;
}

function PostAuthRedirect() {
  const identity = useCurrentUser();
  const { signOut } = useAuth();

  if (identity.isLoading) return <div className="grid min-h-[100dvh] place-items-center bg-[#f4f8f8]"><RefreshCw className="animate-spin text-[#f46c43]" /></div>;
  if (identity.isError) return <div className="grid min-h-[100dvh] place-items-center bg-[#eaf3f3] px-4"><div className="w-full max-w-md rounded-3xl bg-white p-7 text-center shadow-xl"><CircleAlert className="mx-auto text-red-500" /><h1 className="mt-4 text-xl font-extrabold text-[#142037]">Unable to load your account</h1><p className="mt-2 text-sm text-slate-500">Check that the API server is running, then try again.</p><div className="mt-6 flex justify-center gap-3"><Button onClick={() => void identity.refetch()}>Try again</Button><Button variant="outline" onClick={() => void signOut()}>Sign out</Button></div></div></div>;
  if (identity.data?.role === 'admin') return <Redirect to={identity.data.aal === 'aal2' ? '/admin' : '/client/security'} />;
  return <Redirect to="/client" />;
}

function AuthPage() {
  const { user, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  if (!loading && user) return <PostAuthRedirect />;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true); setError('');
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) throw authError;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Authentication failed');
    } finally {
      setPending(false);
    }
  };

  return <div className="grid min-h-[100dvh] place-items-center bg-[#eaf3f3] px-4 py-10"><div className="absolute left-6 top-6"><Logo /></div><div className="w-full max-w-[440px] rounded-3xl bg-white p-7 shadow-xl sm:p-9"><p className="mono text-[10px] uppercase tracking-[.18em] text-[#e4643d]">secure workspace</p><h1 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-[#142037]">Welcome back</h1><p className="mt-2 text-sm text-slate-500">Sign in with the account provided by your administrator.</p><form onSubmit={submit} className="mt-7 grid gap-4"><label className="text-sm font-bold text-[#142037]">Email<input required type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-2 block w-full rounded-xl border border-[#d9e2e6] bg-[#f3f7f8] px-4 py-3 font-normal outline-none focus:border-[#f46c43]" /></label><label className="text-sm font-bold text-[#142037]">Password<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-2 block w-full rounded-xl border border-[#d9e2e6] bg-[#f3f7f8] px-4 py-3 font-normal outline-none focus:border-[#f46c43]" /></label>{error && <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}<Button type="submit" disabled={pending} className="mt-1 w-full">{pending ? 'Please wait…' : 'Sign in'}</Button></form><p className="mt-6 text-center text-xs leading-5 text-slate-500">Need an account? Contact your administrator.</p></div></div>;
}

function AuthCacheInvalidator() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => { const id = user?.id ?? null; if (previous.current !== undefined && previous.current !== id) qc.clear(); previous.current = id; }, [user?.id, qc]);
  return null;
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-[100dvh] bg-[#142037]" />;
  return user ? <PostAuthRedirect /> : <Landing />;
}

type ProtectedPage = 'client-dashboard' | 'client-proxy' | 'client-security' | 'admin-overview' | 'admin-catalog' | 'admin-info-users' | 'admin-proxy-api-keys' | 'admin-proxy-providers' | 'admin-proxy-orders' | 'admin-proxy-settings' | 'admin-settings';

function Protected({ page }: { page: ProtectedPage }) {
  const { user, loading } = useAuth();
  const admin = page.startsWith('admin-');
  const identity = useCurrentUser({ query: { enabled: Boolean(user && admin) } });
  if (loading || (admin && user && identity.isLoading)) return <div className="grid min-h-[100dvh] place-items-center bg-[#f4f8f8]"><RefreshCw className="animate-spin text-[#f46c43]" /></div>;
  if (!user) return <Redirect to="/sign-in" />;
  if (admin && (identity.isError || identity.data?.role !== 'admin')) return <Redirect to="/client" />;
  if (admin && identity.data?.aal !== 'aal2') return <Redirect to="/client/security" />;
  switch (page) {
    case 'client-dashboard': return <ClientDashboardPage />;
    case 'client-proxy': return <ClientPortalPage />;
    case 'client-security': return <SecurityPage />;
    case 'admin-overview': return <AdminOverviewPage />;
    case 'admin-catalog': return <AdminCatalogPage />;
    case 'admin-info-users': return <AdminUsersPage />;
    case 'admin-proxy-api-keys': return <AdminProviderApiKeysPage />;
    case 'admin-proxy-providers': return <AdminProvidersPage />;
    case 'admin-proxy-orders': return <AdminOrdersPage />;
    case 'admin-proxy-settings': return <AdminProxySettingsPage />;
    case 'admin-settings': return <AdminGeneralSettingsPage />;
    default: return <ClientDashboardPage />;
  }
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function RouterViews() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={AuthPage} /><Route path="/sign-up/*?" component={() => <Redirect to="/sign-in" />} /><Route path="/client/nodes" component={() => <Redirect to="/client/proxy#my-services" />} /><Route path="/client/orders" component={() => <Redirect to="/client/proxy#orders" />} /><Route path="/client/security" component={() => <Protected page="client-security" />} /><Route path="/client/proxy" component={() => <Protected page="client-proxy" />} /><Route path="/client" component={() => <Protected page="client-dashboard" />} /><Route path="/admin/users" component={() => <Redirect to="/admin/info/users" />} /><Route path="/admin/keys" component={() => <Redirect to="/admin/proxy/api-keys" />} /><Route path="/admin/orders" component={() => <Redirect to="/admin/proxy/orders" />} /><Route path="/admin/info/users" component={() => <Protected page="admin-info-users" />} /><Route path="/admin/proxy/api-keys" component={() => <Protected page="admin-proxy-api-keys" />} /><Route path="/admin/proxy/providers" component={() => <Protected page="admin-proxy-providers" />} /><Route path="/admin/proxy/orders" component={() => <Protected page="admin-proxy-orders" />} /><Route path="/admin/proxy/settings" component={() => <Protected page="admin-proxy-settings" />} /><Route path="/admin/settings" component={() => <Protected page="admin-settings" />} /><Route path="/admin/catalog" component={() => <Protected page="admin-catalog" />} /><Route path="/admin" component={() => <Protected page="admin-overview" />} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function App() {
  return <WouterRouter base={basePath}><QueryClientProvider client={queryClient}><AuthProvider><TooltipProvider><AuthCacheInvalidator /><RouterViews /><Toaster /></TooltipProvider></AuthProvider></QueryClientProvider></WouterRouter>;
}

export default App;
