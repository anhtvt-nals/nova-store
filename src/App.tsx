import { useEffect, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowRight, Ban, Check, ChevronRight, CircleAlert, Copy, Download,
  FolderTree, Gauge, Globe2, History, KeyRound, Layers3, Link2, LogIn, LogOut, Menu, MoreHorizontal, Network, Package, Pencil, Plus, RefreshCw, Search, UserCheck,
  MessageCircle, Send, Server, Settings, ShieldCheck, Signal, Trash2, Users, X, Zap,
} from 'lucide-react';
import {
  useCreateCategory, useCreateOrder, useCreateProduct, useCreateSandboxKey, useCreateUser,
  useCreateProvider, useCreateProviderApiKey, useDeleteCategory, useDeleteProduct, useDeleteProvider, useDeleteSandboxKey, useDeleteUser,
  useCreditBalance, useCurrentUser, useExtendOrder, useExportProxyConnections, useOrderQuote, useRecreateAllProxyNodes, useRestartProxyNode, useCreateStaticResidentialOrder, useExtendStaticResidentialOrder, useExportStaticResidentialConnections, useListStaticResidentialOrders, useStaticResidentialQuote, useImportStaticResidentialInventory, useCheckStaticResidentialInventoryStatus, useEnableStaticResidentialInventoryProxy, useStaticResidentialInventory, useStaticResidentialPricing, useUpdateStaticResidentialPricing,
  useGetAdminOverview, useGetClientOverview, useGetOrderConnection, usePaginatedAdminOrders,
  useGeneralSettings, useListAdminProducts, useListCategories, useListClientOrders, useListClientProxyNodes, useListNodes, useListPlans, useListProducts, useListProviderApiKeys, useListProviders, useListSandboxKeys, useListUsers, usePaginatedUsers,
  useAddCreditTopUp, useCatalogSettings, useCreditHistory, useCreditWallets, useDeductCredit, useProvisioningJobs, useProxySettings, useResetUserPassword, useRevokeProviderApiKey, useUpdateCategory, useUpdateGeneralSettings, useUpdateOrderStatus, useUpdateProduct, useUpdateProvider, useUpdateProviderApiKey, useUpdateProxyPrice, useUpdateUser,
  getGetAdminOverviewQueryKey, getGetClientOverviewQueryKey, getGetOrderConnectionQueryKey,
  getListAdminOrdersQueryKey, getListAdminProductsQueryKey, getListCategoriesQueryKey, getListClientOrdersQueryKey, getListClientProxyNodesQueryKey, getListNodesQueryKey,
  getCreditWalletsQueryKey, getCurrentUserQueryKey, getGeneralSettingsQueryKey, getListPlansQueryKey, getListProviderApiKeysQueryKey, getListProvidersQueryKey, getListSandboxKeysQueryKey, getListUsersQueryKey, getProxySettingsQueryKey, getStaticResidentialInventoryQueryKey, getStaticResidentialOrdersQueryKey, getStaticResidentialPricingQueryKey, subscribeToProxyNodeEvents,
  getTelegramVerificationStatusQueryKey, useStartTelegramVerification, useTelegramVerificationStatus,
} from '@/lib/api-client';
import type {
  AdminOrder, AdminProduct, CatalogProduct, Category, CreditWallet, CurrentUser, GeneralSettings, PaginatedAdminOrders, Plan, ProductInput, ProxyNode, ProxyProvider, ProviderApiKey, RuntimeProxyNode, SandboxKey, User, Order, ConnectionDetails, StaticResidentialOrder,
} from '@/lib/api-client';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { AuthProvider, useAuth } from '@/lib/auth';
import { translations, type SiteLocale, type TranslationKey } from '@/lib/i18n';
import { supabase } from '@/lib/supabase';

const queryClient = new QueryClient();
const Power = UserCheck;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const communityLinks = {
  telegram: 'https://t.me/+WH5hnlakrEs3ZjFl',
  whatsapp: 'https://chat.whatsapp.com/Bp30pcOwelIEI7MFXSBj2d',
} as const;

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');
const money = (value = 0) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const time = (value?: string | null) => value ? new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '—';
const bytes = (value = 0) => {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: index ? 2 : 0 })} ${units[index]}`;
};
const orderTone = (status: Order['status']): 'green' | 'orange' | 'red' | 'neutral' => status === 'active' ? 'green' : ['pending', 'provisioning'].includes(status) ? 'orange' : ['rejected', 'provisioning_failed'].includes(status) ? 'red' : 'neutral';

function useLocalePreferences() {
  const settings = useCatalogSettings();
  const [locale, setLocaleState] = useState<SiteLocale>(() => {
    const stored = typeof window === 'undefined' ? null : window.localStorage.getItem('nodenesia-locale');
    return stored === 'id' || stored === 'en' ? stored : (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('id') ? 'id' : 'en');
  });
  useEffect(() => {
    const sync = () => {
      const stored = window.localStorage.getItem('nodenesia-locale');
      if (stored === 'id' || stored === 'en') setLocaleState(stored);
    };
    window.addEventListener('nodenesia-locale-change', sync);
    return () => window.removeEventListener('nodenesia-locale-change', sync);
  }, []);
  const setLocale = (next: SiteLocale) => {
    window.localStorage.setItem('nodenesia-locale', next);
    setLocaleState(next);
    window.dispatchEvent(new Event('nodenesia-locale-change'));
  };
  const usdToIdrRate = settings.data?.usdToIdrRate || 16000;
  const formatMoney = (value = 0, currency = 'USD') => {
    const targetCurrency = locale === 'id' && currency === 'USD' ? 'IDR' : currency;
    const targetValue = targetCurrency === 'IDR' && currency === 'USD' ? value * usdToIdrRate : value;
    return new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-US', {
      style: 'currency', currency: targetCurrency, minimumFractionDigits: targetCurrency === 'IDR' ? 0 : 2, maximumFractionDigits: targetCurrency === 'IDR' ? 0 : 2,
    }).format(targetValue);
  };
  return { locale, setLocale, t: (key: TranslationKey) => translations[locale][key], formatMoney, brandName: settings.data?.brandName || 'Nodenesia', usdToIdrRate, creditsPerUsd: settings.data?.creditsPerUsd || 100 };
}

function LocaleSwitcher({ inverse = false }: { inverse?: boolean }) {
  const { locale, setLocale } = useLocalePreferences();
  return <div className={cx('flex rounded-lg border p-0.5 text-[10px] font-extrabold tracking-[.08em]', inverse ? 'border-white/20 bg-white/5 text-slate-300' : 'border-[#dbe7e9] bg-[#f8fbfb] text-slate-500')} aria-label="Language selector">
    {(['en', 'id'] as const).map(code => <button key={code} type="button" onClick={() => setLocale(code)} className={cx('rounded-md px-2 py-1 uppercase transition', locale === code && (inverse ? 'bg-white text-[#142037]' : 'bg-[#142037] text-white'))}>{code}</button>)}
  </div>;
}

function CommunityLinks({ inverse = false, className }: { inverse?: boolean; className?: string }) {
  const linkClass = inverse ? 'text-slate-300 hover:text-white' : 'text-slate-500 hover:text-[#142037]';
  return <div className={cx('flex flex-wrap items-center justify-center gap-x-4 gap-y-2', className)}>
    <a href={communityLinks.telegram} target="_blank" rel="noreferrer" className={cx('inline-flex items-center gap-1.5 text-xs font-bold transition', linkClass)} aria-label="Join Nodenesia on Telegram"><Send size={14} />Telegram</a>
    <a href={communityLinks.whatsapp} target="_blank" rel="noreferrer" className={cx('inline-flex items-center gap-1.5 text-xs font-bold transition', linkClass)} aria-label="Join Nodenesia on WhatsApp"><MessageCircle size={14} />WhatsApp</a>
  </div>;
}

function Logo({ inverse = false }: { inverse?: boolean }) {
  return <Link href="/" aria-label="Nodenesia home" className="inline-flex items-center" data-testid="link-logo">
    <img src="/logo.png" alt="" className="h-9 w-auto object-contain" />
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
  const { t } = useLocalePreferences();
  return <header className="absolute inset-x-0 top-0 z-20"><div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6 lg:px-10"><Logo inverse /><nav className="hidden items-center gap-8 text-sm text-slate-300 md:flex"><a href="#how-it-works" data-testid="link-how-it-works">{t('howItWorks')}</a><a href="#plans" data-testid="link-plans">{t('plans')}</a><a href="#operators" data-testid="link-operators">{t('forOperators')}</a></nav><div className="flex items-center gap-2"><LocaleSwitcher inverse /><Link href="/sign-up" className="hidden px-3 py-2 text-sm font-bold text-slate-200 hover:text-white sm:inline-flex" data-testid="link-sign-up">{t('createAccount')}</Link><Link href="/sign-in" aria-label={t('customerLogin')} title={t('customerLogin')} className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#f46c43] text-white shadow-lg shadow-orange-900/20 hover:bg-[#ff7b51] sm:h-auto sm:w-auto sm:gap-2 sm:px-4 sm:py-2.5 sm:text-sm sm:font-bold" data-testid="link-get-started"><LogIn size={17} className="sm:hidden" /><span className="hidden sm:inline">{t('customerLogin')}</span><ArrowRight size={15} className="hidden sm:block" /></Link></div></div></header>;
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
  const { t } = useLocalePreferences();
  return <div className="min-h-[100dvh] overflow-hidden bg-[#142037]"><section className="relative min-h-[740px] text-white"><PublicNav /><div className="absolute inset-0 bg-[radial-gradient(circle_at_65%_40%,#245066_0,transparent_35%),linear-gradient(125deg,#142037_15%,#183041_100%)]" /><div className="hero-grid absolute inset-0 opacity-50" /><div className="relative mx-auto grid max-w-7xl items-center gap-10 px-6 pb-20 pt-36 lg:grid-cols-[1.03fr_.97fr] lg:px-10 lg:pb-28 lg:pt-44"><div className="reveal max-w-2xl"><div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#69d5d0]/25 bg-[#69d5d0]/10 px-3 py-1.5 text-xs font-bold text-[#91e4df]"><span className="h-1.5 w-1.5 rounded-full bg-[#69d5d0]" /> {t('heroBadge')}</div><h1 className="max-w-xl text-5xl font-extrabold leading-[.98] tracking-[-.065em] sm:text-6xl lg:text-[76px]">{t('heroTitle')} <span className="text-[#69d5d0]">{t('heroAccent')}</span></h1><p className="mt-7 max-w-lg text-base leading-7 text-slate-300 sm:text-lg">{t('heroBody')}</p><div className="mt-9 flex flex-wrap gap-3"><Link href="/sign-in" className="inline-flex items-center gap-2 rounded-xl bg-[#f46c43] px-5 py-3.5 text-sm font-bold text-white shadow-[0_12px_30px_rgba(244,108,67,.25)] hover:bg-[#ff7b51]">{t('customerLogin')} <ArrowRight size={16} /></Link><a href="#how-it-works" className="inline-flex items-center rounded-xl border border-white/15 px-5 py-3.5 text-sm font-bold text-slate-200 hover:border-white/35">{t('seeHow')}</a></div><div className="mt-11 flex flex-wrap gap-x-7 gap-y-3 border-t border-white/10 pt-5 text-xs text-slate-400"><span className="inline-flex items-center gap-2"><ShieldCheck size={15} className="text-[#69d5d0]" /> {t('noLockIn')}</span><span className="inline-flex items-center gap-2"><Zap size={15} className="text-[#f46c43]" /> {t('rotateEvery')}</span></div></div><div className="reveal-2 relative"><NetworkOrb /></div></div></section><section id="how-it-works" className="bg-[#f4f8f8] px-6 py-24 text-[#142037] lg:px-10"><div className="mx-auto max-w-7xl"><SectionTitle eyebrow={t('controlPlane')} title={t('controlTitle')} body={t('controlBody')} /><div className="grid gap-4 md:grid-cols-3"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-7"><span className="mono text-xs text-[#f46c43]">01 / select</span><Globe2 className="my-10 text-[#142037]" size={28} /><h3 className="text-xl font-extrabold">{t('selectTitle')}</h3><p className="mt-3 text-sm leading-6 text-slate-500">{t('selectBody')}</p></div><div className="rounded-3xl border border-[#dbe7e9] bg-[#142037] p-7 text-white"><span className="mono text-xs text-[#69d5d0]">02 / connect</span><Signal className="my-10 text-[#69d5d0]" size={28} /><h3 className="text-xl font-extrabold">{t('connectTitle')}</h3><p className="mt-3 text-sm leading-6 text-slate-300">{t('connectBody')}</p></div><div className="rounded-3xl border border-[#dbe7e9] bg-white p-7"><span className="mono text-xs text-[#f46c43]">03 / rotate</span><RefreshCw className="my-10 text-[#f46c43]" size={28} /><h3 className="text-xl font-extrabold">{t('rotateTitle')}</h3><p className="mt-3 text-sm leading-6 text-slate-500">{t('rotateBody')}</p></div></div></div></section><section id="plans" className="bg-[#f4f8f8] px-6 pb-24 lg:px-10"><div className="mx-auto max-w-7xl"><SectionTitle eyebrow={t('plans')} title={t('plansTitle')} body={t('plansBody')} action={<Link href="/sign-in" className="text-sm font-bold text-[#e05c37]">{t('customerLogin')} <ChevronRight size={16} className="inline" /></Link>} /><div className="grid w-full grid-cols-1 gap-5 md:grid-cols-2"><LandingPlanCard name={t('trialPlanName')} price={t('trialPlanPrice')} description={t('trialPlanDescription')} details={[t('trialPlanNodes'), t('trialPlanDuration'), t('trialPlanRotation'), t('trialPlanAccess')]} cta={t('goToClient')} /><LandingPlanCard name={t('proPlanName')} price={t('proPlanPrice')} description={t('proPlanDescription')} details={[t('proPlanNodes'), t('proPlanDuration'), t('proPlanRotation'), t('proPlanAccess')]} cta={t('goToClient')} highlighted /></div></div></section><footer className="bg-[#142037] px-6 pb-10 text-slate-500 lg:px-10"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-4 border-t border-white/10 pt-7 text-xs sm:flex-row sm:items-center"><span>© 2026 Nodenesia</span><CommunityLinks inverse /><span className="mono">signal / rotation / control</span></div></footer></div>;
}

function LandingPlanCard({ name, price, description, details, cta, highlighted = false }: { name: string; price: string; description: string; details: string[]; cta: string; highlighted?: boolean }) {
  return <article className={cx('relative flex min-h-[390px] w-full flex-col rounded-3xl border p-6 md:p-7', highlighted ? 'border-[#f46c43] bg-[#142037] text-white shadow-xl shadow-slate-900/10' : 'border-[#dbe7e9] bg-white text-[#142037]')}>
    <div className="flex items-start justify-between gap-3"><div><p className={cx('mono text-[10px] uppercase tracking-[.17em]', highlighted ? 'text-[#69d5d0]' : 'text-[#f46c43]')}>SOCKS5 proxy</p><h3 className="mt-3 text-xl font-extrabold">{name}</h3></div>{highlighted && <Badge tone="orange">Popular</Badge>}</div>
    <p className="mt-7 text-3xl font-extrabold tracking-[-.06em]">{price}</p><p className={cx('mt-4 min-h-12 text-sm leading-6', highlighted ? 'text-slate-300' : 'text-slate-500')}>{description}</p>
    <ul className={cx('mt-6 grid gap-3 border-t pt-5 text-sm', highlighted ? 'border-white/10 text-slate-200' : 'border-slate-100 text-slate-600')}>{details.map(detail => <li key={detail} className="flex items-center gap-2"><Check size={15} className="shrink-0 text-[#69d5d0]" />{detail}</li>)}</ul>
    <div className="mt-auto pt-6"><Link href="/client/proxy" className={cx('inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition', highlighted ? 'bg-[#f46c43] text-white hover:bg-[#ff7b51]' : 'bg-[#142037] !text-white hover:bg-[#203c4b]')}>{cta} <ArrowRight size={15} /></Link></div>
  </article>;
}

function PlanCard({ plan, onSelect }: { plan: Plan; onSelect?: (plan: Plan) => void }) {
  const { formatMoney } = useLocalePreferences();
  return <div className={cx('relative rounded-3xl border p-6 transition hover:-translate-y-1', plan.highlighted ? 'border-[#f46c43] bg-[#142037] text-white shadow-xl shadow-slate-900/10' : 'border-[#dbe7e9] bg-white text-[#142037]')}><div className="flex items-start justify-between gap-3"><div><p className={cx('mono text-[10px] uppercase tracking-[.17em]', plan.highlighted ? 'text-[#69d5d0]' : 'text-[#f46c43]')}>{plan.nodeCount} {plan.nodeCount === 1 ? 'node' : 'nodes'}</p><h3 className="mt-3 text-xl font-extrabold">{plan.name}</h3></div>{plan.highlighted && <Badge tone="orange">Popular</Badge>}</div><div className="mt-7 flex items-baseline gap-1"><span className="text-4xl font-extrabold tracking-[-.06em]">{formatMoney(plan.price, plan.currency)}</span><span className={cx('text-xs', plan.highlighted ? 'text-slate-400' : 'text-slate-500')}>/ {plan.durationHours}h</span></div><p className={cx('mt-4 min-h-12 text-sm leading-6', plan.highlighted ? 'text-slate-300' : 'text-slate-500')}>{plan.description}</p><div className={cx('mt-6 border-t pt-5 text-sm', plan.highlighted ? 'border-white/10 text-slate-200' : 'border-slate-100 text-slate-600')}><div className="flex items-center gap-2"><Check size={15} className="text-[#69d5d0]" /> {plan.rotation} rotation</div></div>{onSelect && <Button onClick={() => onSelect(plan)} className="mt-6 w-full"><Plus size={15} /> Rent this plan</Button>}</div>;
}

function AppShell({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, signOut } = useAuth();
  const [location, setLocation] = useLocation();
  const displayName = String(user?.user_metadata?.name || user?.email?.split('@')[0] || 'Workspace member');
  const initial = (displayName[0] || 'P').toUpperCase();
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = admin ? [
    { section: 'Dashboard' }, { href: '/admin', label: 'Dashboard', icon: Gauge },
    { section: 'Info' }, { href: '/admin/info/users', label: 'Users', icon: Users }, { href: '/admin/credits', label: 'Credits', icon: Zap },
    { section: 'Proxy' }, { href: '/admin/proxy/api-keys', label: 'Provider API keys', icon: KeyRound }, { href: '/admin/proxy/providers', label: 'Providers', icon: Server }, { href: '/admin/proxy/orders', label: 'Orders', icon: Layers3 }, { href: '/admin/proxy/provisioning-logs', label: 'Provisioning logs', icon: Activity }, { href: '/admin/proxy/settings', label: 'Pricing', icon: Settings }, { href: '/admin/static-residential', label: 'Static residential', icon: Globe2 },
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
  const payment = 'credit' as const;
  const [showPlans, setShowPlans] = useState(false);
  const activeNode = nodes.data?.find((node: ProxyNode) => node.status === 'online');
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); };
  const submitOrder = () => { if (!selectedPlan || !activeNode) return; createOrder.mutate({ data: { productId: selectedPlan.productId, nodeCount: 1, rentalDays: Math.max(1, Math.ceil(selectedPlan.durationHours / 24)), paymentMethod: payment } }, { onSuccess: () => { setSelectedPlan(null); setShowPlans(false); void qc.invalidateQueries({ queryKey: getListClientOrdersQueryKey() }); void qc.invalidateQueries({ queryKey: getGetClientOverviewQueryKey() }); } }); };
  return <AppShell><div className="shell-grid min-h-[calc(100dvh-72px)] px-5 py-8 lg:px-9"><div className="mx-auto max-w-[1420px]"><div className="mb-9 flex flex-wrap items-end justify-between gap-4"><div className="reveal"><p className="mono mb-2 text-[10px] uppercase tracking-[.2em] text-[#e4643d]">client workspace</p><h1 className="text-3xl font-extrabold tracking-[-.05em] text-[#142037] md:text-4xl">Good to see you, {overview.data?.displayName?.split(' ')[0] || 'operator'}.</h1><p className="mt-2 text-sm text-slate-500">Your routing surface, at a glance.</p></div><Button onClick={() => setShowPlans(true)} data-testid="button-rent-node"><Plus size={16} /> Rent a node</Button></div><State loading={overview.isLoading} error={overview.isError} onRetry={() => overview.refetch()}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Active nodes" value={String(overview.data?.activeNodes ?? 0)} detail={activeNode ? `${activeNode.city}, ${activeNode.country}` : 'No active footprint'} icon={Server} tone="teal" /><Metric label="Requests today" value={(overview.data?.requestsToday ?? 0).toLocaleString()} detail="Across your workspace" icon={Activity} tone="orange" /><Metric label="Success rate" value={`${overview.data?.successRate ?? 0}%`} detail="Last 24 hours" icon={Signal} tone="teal" /><Metric label="Next rotation" value={overview.data?.nextRotationAt ? time(overview.data.nextRotationAt) : '—'} detail={overview.data?.nextRotationAt ? date(overview.data.nextRotationAt) : 'Activate a plan to start'} icon={RefreshCw} tone="orange" /></div><div className="mt-5 grid gap-5 xl:grid-cols-[1.28fr_.72fr]"><div id="nodes" className="rounded-3xl border border-[#dbe7e9] bg-white p-6 shadow-[0_10px_35px_rgba(20,32,55,.04)]"><div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><p className="mono text-[10px] uppercase tracking-[.18em] text-[#e4643d]">live connection</p><h2 className="mt-2 text-xl font-extrabold tracking-[-.04em]">Your active node</h2></div>{overview.data?.activeOrder ? <Badge tone="green"><span className="h-1.5 w-1.5 rounded-full bg-current" /> Active</Badge> : <Badge>Awaiting order</Badge>}</div>{overview.data?.activeOrder && connection.data ? <ConnectionCard connection={connection.data} nodeName={overview.data.activeOrder.nodeName} onCopy={copy} /> : <div className="rounded-2xl border border-dashed border-[#cbd9df] bg-[#f8fbfb] p-8 text-center"><Server className="mx-auto mb-3 text-[#69d5d0]" size={28} /><p className="font-bold text-[#142037]">No active node yet</p><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500">Pick a plan to provision your first US SOCKS5 endpoint. Approval is handled by the Proxy Node team.</p><Button onClick={() => setShowPlans(true)} className="mt-5">View plans <ArrowRight size={15} /></Button></div>}</div><div className="rounded-3xl bg-[#142037] p-6 text-white shadow-xl shadow-slate-900/10"><div className="flex items-start justify-between"><div><p className="mono text-[10px] uppercase tracking-[.18em] text-[#69d5d0]">current plan</p><h2 className="mt-2 text-xl font-extrabold">{overview.data?.activeOrder?.planName || 'No plan selected'}</h2></div><Zap className="text-[#f46c43]" size={20} /></div>{overview.data?.activeOrder ? <><div className="mt-8 space-y-4 text-sm"><div className="flex justify-between border-b border-white/10 pb-3"><span className="text-slate-400">Node</span><span className="font-bold">{overview.data.activeOrder.nodeName}</span></div><div className="flex justify-between border-b border-white/10 pb-3"><span className="text-slate-400">Started</span><span className="font-bold">{date(overview.data.activeOrder.createdAt)}</span></div><div className="flex justify-between"><span className="text-slate-400">Expires</span><span className="font-bold">{date(overview.data.activeOrder.expiresAt)}</span></div></div><div className="mt-8 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full w-[68%] rounded-full bg-[#69d5d0]" /></div><p className="mt-2 text-xs text-slate-400">Rotation window healthy · next at {time(overview.data.nextRotationAt)}</p></> : <p className="mt-8 text-sm leading-6 text-slate-400">Your plan summary will appear here after your first order is approved.</p>}</div></div><div id="orders" className="mt-8"><SectionTitle eyebrow="history" title="Recent orders" action={<span className="mono text-[10px] uppercase tracking-[.15em] text-slate-400">{orders.data?.length || 0} records</span>} /><State loading={orders.isLoading} error={orders.isError} onRetry={() => orders.refetch()} empty={!orders.data?.length}><OrdersTable orders={orders.data || []} /></State></div></State></div></div>{showPlans && <Modal title="Rent a node" onClose={() => { setShowPlans(false); setSelectedPlan(null); }}><div className="grid gap-3">{selectedPlan ? <><div className="rounded-2xl bg-[#f4f8f8] p-4"><p className="mono text-[10px] uppercase tracking-[.16em] text-[#e4643d]">selected plan</p><p className="mt-2 font-extrabold text-[#142037]">{selectedPlan.name} · {money(selectedPlan.price)}</p><p className="mt-1 text-sm text-slate-500">{activeNode ? `Best available node: ${activeNode.name}` : 'No online node is available right now.'}</p></div><p className="rounded-xl border border-[#bfe3df] bg-[#eaf8f6] px-3 py-3 text-sm font-bold text-[#13716e]">Payment method: Credit</p><div className="flex gap-2 pt-2"><Button variant="outline" className="flex-1" onClick={() => setSelectedPlan(null)}>Back</Button><Button className="flex-1" disabled={createOrder.isPending || !activeNode} onClick={submitOrder}>{createOrder.isPending ? 'Submitting…' : 'Submit order'}</Button></div></> : <><p className="mb-2 text-sm text-slate-500">Choose a plan for your next US node.</p>{plans.data?.map((plan: Plan) => <button key={plan.id} onClick={() => setSelectedPlan(plan)} className="flex items-center justify-between rounded-2xl border border-[#dbe7e9] p-4 text-left transition hover:border-[#f46c43] hover:bg-[#fff9f6]" data-testid={`button-select-plan-${plan.id}`}><span><span className="block font-extrabold text-[#142037]">{plan.name}</span><span className="mt-1 block text-xs text-slate-500">{plan.nodeCount} node · {plan.durationHours} hours · {plan.rotation} rotation</span></span><span className="font-extrabold text-[#142037]">{money(plan.price)}</span></button>)}</>}</div></Modal>}</AppShell>;
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

function CompactNodeCard({ order, connection, node, onRestart, restarting }: { order: Order; connection: ConnectionDetails; node?: RuntimeProxyNode; onRestart?: () => void; restarting?: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const activatedAt = new Date(order.activatedAt || order.createdAt).getTime();
  const expiresAt = order.expiresAt ? new Date(order.expiresAt).getTime() : null;
  const total = expiresAt ? Math.max(1, expiresAt - activatedAt) : 1;
  const remaining = expiresAt ? Math.max(0, expiresAt - now) : 0;
  const progress = expiresAt ? Math.min(100, Math.max(0, ((now - activatedAt) / total) * 100)) : 0;
  const connectionString = `${connection.protocol.toLowerCase()}://${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password)}@${connection.host}:${connection.port}`;
  const rotationUrl = node?.rotationUrl ? new URL(node.rotationUrl, window.location.origin).toString() : null;
  const copy = async (value: string) => {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copiedSuccessfully = document.execCommand('copy');
      textarea.remove();
      if (!copiedSuccessfully) throw new Error('Clipboard is unavailable');
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const status = node?.status || 'online';
  const reachable = ['online', 'degraded'].includes(status);
  const statusLabel = status === 'online' ? 'READY' : status.toUpperCase();
  const statusColor = reachable ? '#43cf65' : status === 'provisioning' || status === 'queued' ? '#f6a94a' : '#ff5156';
  const nextRotationAt = node?.nextRotationAt || connection.nextRotationAt;
  return <article className="relative overflow-hidden rounded-xl border border-[#34404b] bg-[#171d23] px-3 py-2.5 text-slate-200 shadow-[0_8px_22px_rgba(20,32,55,.12)]">
    <span className="absolute inset-y-0 left-0 w-0.5" style={{ backgroundColor: statusColor }} />
    <div className="flex items-center gap-1.5 pl-0.5">
      <span className="mono text-[9px] font-bold text-slate-500">#{node?.id || order.id}</span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
      <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-slate-200" title={`Order #${order.id}`}>Node {node?.id || order.id}</span>
      <span className="text-[8px] font-extrabold tracking-[.08em]" style={{ color: statusColor }}>{statusLabel}</span>
      <button onClick={() => void copy(connectionString)} className="grid h-6 w-6 shrink-0 place-items-center rounded border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10" data-testid={`button-copy-proxy-${node?.id || order.id}`} aria-label="Copy SOCKS5 proxy" title="Copy SOCKS5 proxy">{copied ? <Check size={11} className="text-[#43cf65]" /> : <Copy size={10} />}</button>
      {rotationUrl && <button onClick={() => void copy(rotationUrl)} className="grid h-6 w-6 shrink-0 place-items-center rounded border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10" data-testid={`button-copy-rotation-url-${node?.id || order.id}`} aria-label="Copy rotation URL" title="Copy rotation URL"><Link2 size={10} /></button>}
      {onRestart && <button onClick={onRestart} disabled={restarting} className="grid h-6 w-6 shrink-0 place-items-center rounded border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50" data-testid={`button-restart-node-${node?.id || order.id}`} aria-label="Restart node" title="Restart node"><RefreshCw className={restarting ? 'animate-spin' : ''} size={10} /></button>}
    </div>
    <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-2">
      <div className="flex items-center justify-between gap-2"><p className="text-[8px] font-bold uppercase tracking-[.1em] text-slate-500">SOCKS5 proxy</p></div>
      <code className="mono mt-1.5 block break-all text-[9px] leading-3.5 text-[#43d6dc]">{connectionString}</code>
    </div>
    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-white/10 pl-0.5 pt-2 text-[9px] leading-3.5">
      <p className="min-w-0 text-slate-500">Protocol <strong className="ml-1 text-slate-300">{connection.protocol}</strong></p>
      <p className="text-slate-500">Port <strong className="ml-1 text-slate-300">{connection.port}</strong></p>
      <p className="min-w-0 text-slate-500">Egress <strong className="ml-1 break-all text-slate-300">{node?.egressIp || connection.host}{node?.egressCountryCode && <span className="ml-1 whitespace-nowrap" title={node.egressCountryCode}>{String.fromCodePoint(...node.egressCountryCode.split('').map(char => 127397 + char.charCodeAt(0)))}</span>}</strong></p>
      <p className="text-slate-500">Reachable <strong className={cx('ml-1', reachable ? 'text-[#43cf65]' : 'text-[#ff696d]')}>{reachable ? 'OK' : 'NO'}</strong></p>
      <p className="text-slate-500">Uptime <strong className="ml-1 text-slate-300">{compactDuration(now - activatedAt)}</strong></p>
      <p className="text-slate-500">Rotation <strong className="ml-1 text-slate-300">{nextRotationAt ? compactDuration(new Date(nextRotationAt).getTime() - now) : '—'}</strong></p>
    </div>
    {expiresAt && <div className="mt-2 pl-0.5"><div className="h-0.5 overflow-hidden rounded-full bg-[#323a43]"><div className="h-full rounded-full bg-[#35bd58] transition-[width] duration-1000" style={{ width: `${100 - progress}%` }} /></div><div className="mt-1 flex justify-between gap-2 text-[8px] text-slate-500"><span>{date(order.expiresAt)}</span><span>Expires in {compactDuration(remaining)}</span></div></div>}
  </article>;
}

function ActiveNodeItem({ order, node }: { order: Order; node: RuntimeProxyNode }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const restart = useRestartProxyNode();
  const orderIsActive = order.status === 'active' && (!order.expiresAt || new Date(order.expiresAt) > new Date());
  const canRestart = orderIsActive && ['online', 'degraded', 'offline', 'error'].includes(node.status);
  const canShowConnection = order.status === 'active'
    && (!order.expiresAt || new Date(order.expiresAt) > new Date())
    && ['online', 'rotating', 'degraded'].includes(node.status)
    && !!node.host && !!node.port && !!node.connection;
  const requestRestart = () => {
    if (!canRestart) return;
    restart.mutate({ id: node.id }, {
      onSuccess: () => {
        toast({ title: 'Node rotation started', description: `Node ${node.id} is being replaced. The proxy may be briefly unavailable.` });
        void qc.invalidateQueries({ queryKey: getListClientProxyNodesQueryKey() });
      },
      onError: error => toast({ variant: 'destructive', title: 'Unable to start rotation', description: error.message }),
    });
  };
  if (!canShowConnection || !node.connection || !node.host || !node.port) return <ProxyNodeStatusCard node={node} onRestart={canRestart ? requestRestart : undefined} restarting={restart.isPending} />;
  return <CompactNodeCard order={order} connection={{
    host: node.host,
    port: node.port,
    username: node.connection.username,
    password: node.connection.password,
    protocol: node.connection.protocol,
    nextRotationAt: node.nextRotationAt || '',
  }} node={node} onRestart={canRestart ? requestRestart : undefined} restarting={restart.isPending} />;
}

function ProxyNodeStatusCard({ node, onRestart, restarting }: { node: RuntimeProxyNode; onRestart?: () => void; restarting?: boolean }) {
  const pending = node.status === 'queued' || node.status === 'provisioning' || node.status === 'rotating';
  const healthy = node.status === 'online' || node.status === 'degraded';
  const statusColor = healthy ? '#43cf65' : pending ? '#f6a94a' : '#ff5156';
  const endpoint = node.host && node.port ? `${node.host}:${node.port}` : 'Waiting for endpoint allocation';
  return <article className="relative overflow-hidden rounded-xl border border-[#34404b] bg-[#171d23] px-3 py-2.5 text-slate-200 shadow-[0_8px_22px_rgba(20,32,55,.12)]">
    <span className="absolute inset-y-0 left-0 w-0.5" style={{ backgroundColor: statusColor }} />
    <div className="flex items-center gap-1.5 pl-0.5">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
      <p className="min-w-0 flex-1 truncate text-[10px] font-bold">Node {node.id}</p>
      <span className="text-[8px] font-extrabold tracking-[.08em]" style={{ color: statusColor }}>{node.status.toUpperCase()}</span>
      {onRestart && <button onClick={onRestart} disabled={restarting} className="grid h-6 w-6 shrink-0 place-items-center rounded border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50" data-testid={`button-restart-node-${node.id}`} aria-label="Restart node" title="Restart node"><RefreshCw className={restarting ? 'animate-spin' : ''} size={10} /></button>}
    </div>
    <p className="mono mt-2 break-all pl-0.5 text-[9px] text-[#43d6dc]">{endpoint}</p>
    <p className="mt-2 border-t border-white/10 pl-0.5 pt-2 text-[9px] text-slate-500">Last update <strong className="ml-1 text-slate-300">{date(node.lastStatusChangeAt)} {time(node.lastStatusChangeAt)}</strong></p>
    {node.errorMessage && <p className="mt-2 rounded-md bg-red-500/10 px-2 py-1.5 text-[9px] leading-3.5 text-red-300">{node.errorMessage}</p>}
    {!healthy && !node.errorMessage && <p className="mt-2 text-[9px] leading-3.5 text-slate-500">Connection credentials will appear when this node and its order are active.</p>}
  </article>;
}

function OrdersTable({ orders }: { orders: Order[] }) {
  const { formatMoney } = useLocalePreferences();
  return <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><div className="hidden grid-cols-[1.3fr_1fr_.7fr_.8fr] gap-4 border-b border-[#edf2f3] px-5 py-3 text-[10px] font-bold uppercase tracking-[.15em] text-slate-400 md:grid"><span>Service / order</span><span>Configuration</span><span>Amount</span><span>Status</span></div>{orders.map(order => <div key={order.id} className="grid gap-2 border-b border-[#edf2f3] px-5 py-4 last:border-0 md:grid-cols-[1.3fr_1fr_.7fr_.8fr] md:items-center md:gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#13716e]">{order.productName}</p><p className="mt-1 font-bold text-[#142037]">{order.planName}</p><p className="mono mt-1 text-[10px] text-slate-400">#{String(order.id).padStart(5, '0')} · {date(order.createdAt)}</p></div><p className="text-sm text-slate-600"><strong>{order.nodeCount}</strong> {order.nodeCount === 1 ? 'node' : 'nodes'} · <strong>{order.rentalDays}</strong> {order.rentalDays === 1 ? 'day' : 'days'}</p><p className="text-sm font-bold text-[#142037]">{formatMoney(order.amount)}</p><div><Badge tone={orderTone(order.status)}>{order.status}</Badge></div></div>)}</div>;
}

function AdminDashboard() {
  const overview = useGetAdminOverview();
  const users = useListUsers();
  const keys = useListSandboxKeys();
  const adminOrders = usePaginatedAdminOrders(1, 5);
  const qc = useQueryClient();
  const createUser = useCreateUser(); const updateUser = useUpdateUser(); const deleteUser = useDeleteUser(); const resetPassword = useResetUserPassword();
  const createKey = useCreateSandboxKey(); const deleteKey = useDeleteSandboxKey(); const updateOrder = useUpdateOrderStatus();
  const [userForm, setUserForm] = useState({ name: '', email: '' });
  const [keyLabel, setKeyLabel] = useState('');
  const [latestKey, setLatestKey] = useState('');
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [generatedPassword, setGeneratedPassword] = useState<{ email: string; password: string } | null>(null);
  const [resettingUserId, setResettingUserId] = useState<number>();
  const refreshUsers = () => void qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
  const refreshKeys = () => void qc.invalidateQueries({ queryKey: getListSandboxKeysQueryKey() });
  const refreshOrders = () => { void qc.invalidateQueries({ queryKey: getListAdminOrdersQueryKey() }); void qc.invalidateQueries({ queryKey: getGetAdminOverviewQueryKey() }); };
  const copyText = (value: string) => { void navigator.clipboard?.writeText(value); };
  const submitUser = () => { if (!userForm.name || !userForm.email) return; createUser.mutate({ data: userForm }, { onSuccess: user => { setUserForm({ name: '', email: '' }); setGeneratedPassword(user.temporaryPassword ? { email: user.email, password: user.temporaryPassword } : null); refreshUsers(); } }); };
  const resetUserPassword = (user: User) => {
    if (!window.confirm(`Generate a new password for ${user.email}? Their current password will stop working immediately.`)) return;
    setResettingUserId(user.id);
    resetPassword.mutate({ id: user.id }, {
      onSuccess: result => setGeneratedPassword({ email: user.email, password: result.temporaryPassword }),
      onError: error => window.alert(error.message),
      onSettled: () => setResettingUserId(undefined),
    });
  };
  const submitKey = () => { if (!keyLabel) return; createKey.mutate({ data: { label: keyLabel } }, { onSuccess: (created) => { setKeyLabel(''); setLatestKey(created.secret || ''); refreshKeys(); } }); };
  return <AppShell admin><div className="shell-grid min-h-[calc(100dvh-72px)] px-5 py-8 lg:px-9"><div className="mx-auto max-w-[1420px]"><div className="mb-9"><p className="mono mb-2 text-[10px] uppercase tracking-[.2em] text-[#e4643d]">operator desk</p><h1 className="text-3xl font-extrabold tracking-[-.05em] text-[#142037] md:text-4xl">Keep the network honest.</h1><p className="mt-2 text-sm text-slate-500">Operational view across customers, keys, and manual settlement.</p></div><State loading={overview.isLoading} error={overview.isError} onRetry={() => overview.refetch()}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"><Metric label="MRR" value={money(overview.data?.mrr)} detail={`${overview.data?.mrrChange ?? 0}% vs last month`} icon={Activity} tone="orange" /><Metric label="Active users" value={String(overview.data?.activeUsers ?? 0)} detail="Currently routing" icon={Users} tone="teal" /><Metric label="Active nodes" value={String(overview.data?.activeNodes ?? 0)} detail="Across US footprint" icon={Server} tone="teal" /><Metric label="Pending orders" value={String(overview.data?.pendingOrders ?? 0)} detail="Need review" icon={Layers3} tone="orange" /><Metric label="Success rate" value={`${overview.data?.successRate ?? 0}%`} detail="Network average" icon={Signal} tone="teal" /></div><div className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_.9fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><SectionTitle eyebrow="signal feed" title="Recent activity" /><div className="grid gap-4">{overview.data?.recentActivity?.map(item => <div key={item.id} className="flex gap-3"><span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full', item.tone === 'success' ? 'bg-[#69d5d0]' : item.tone === 'warning' ? 'bg-[#f46c43]' : 'bg-slate-300')} /><div className="min-w-0 flex-1"><div className="flex justify-between gap-3"><p className="text-sm font-bold text-[#142037]">{item.title}</p><span className="mono whitespace-nowrap text-[10px] text-slate-400">{item.time}</span></div><p className="mt-1 text-xs text-slate-500">{item.detail}</p></div></div>)}</div></div><div className="rounded-3xl bg-[#142037] p-6 text-white"><p className="mono text-[10px] uppercase tracking-[.18em] text-[#69d5d0]">operator note</p><h2 className="mt-3 text-2xl font-extrabold leading-tight tracking-[-.04em]">Make the exception visible.</h2><p className="mt-3 text-sm leading-6 text-slate-400">Pending payments stay out of the active network until you approve them. That boundary is the product.</p><div className="mt-8 flex items-center gap-3 text-sm font-bold"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f46c43]"><ShieldCheck size={17} /></span> Manual approval queue is live</div></div></div></State><div id="users" className="mt-10"><SectionTitle eyebrow="directory" title="Users" body="Create and maintain the customer records that power the client workspace." /><div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]"><div className="grid gap-5">{generatedPassword && <GeneratedPasswordCard email={generatedPassword.email} password={generatedPassword.password} onDismiss={() => setGeneratedPassword(null)} />}<div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><h3 className="font-extrabold text-[#142037]">{editingUser ? 'Edit user' : 'Add user'}</h3><div className="mt-5 grid gap-3"><input value={editingUser?.name ?? userForm.name} onChange={e => editingUser ? setEditingUser({ ...editingUser, name: e.target.value }) : setUserForm({ ...userForm, name: e.target.value })} placeholder="Name" className="rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]" data-testid="input-user-name" /><input value={editingUser?.email ?? userForm.email} disabled={!!editingUser} onChange={e => setUserForm({ ...userForm, email: e.target.value })} placeholder="Email" type="email" className="rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43] disabled:opacity-50" data-testid="input-user-email" />{editingUser ? <div className="flex gap-2"><Button className="flex-1" disabled={updateUser.isPending} onClick={() => updateUser.mutate({ id: editingUser.id, data: { name: editingUser.name, status: editingUser.status } }, { onSuccess: () => { setEditingUser(null); refreshUsers(); } })}>Save changes</Button><Button variant="quiet" onClick={() => setEditingUser(null)}>Cancel</Button></div> : <Button onClick={submitUser} disabled={createUser.isPending}><Plus size={15} /> {createUser.isPending ? 'Adding…' : 'Add user'}</Button>}</div></div></div><UsersTable users={users.data || []} loading={users.isLoading} onEdit={setEditingUser} onDelete={id => { if (window.confirm('Delete this user record?')) deleteUser.mutate({ id }, { onSuccess: refreshUsers }); }} onToggle={(user) => updateUser.mutate({ id: user.id, data: { status: user.status === 'active' ? 'suspended' : 'active' } }, { onSuccess: refreshUsers })} onResetPassword={resetUserPassword} resettingId={resettingUserId} /></div></div><div id="keys" className="mt-10">
<SectionTitle eyebrow="developer access" title="Sandbox API keys" body="Issue scoped-looking credentials for testing and integration." /><div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><h3 className="font-extrabold text-[#142037]">Create a key</h3><p className="mt-2 text-sm text-slate-500">The full secret is shown once by the API.</p>{latestKey && <div className="mt-4 rounded-xl border border-[#bfe3df] bg-[#eaf8f6] p-3"><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#13716e]">Copy this key now</p><div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs text-[#142037]">{latestKey}</code><button onClick={() => copyText(latestKey)} className="rounded-lg bg-white p-2 text-[#13716e]" aria-label="Copy API key"><Copy size={14} /></button></div></div>}<input value={keyLabel} onChange={e => setKeyLabel(e.target.value)} placeholder="e.g. QA crawler" className="mt-5 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]" data-testid="input-key-label" /><Button className="mt-3 w-full" disabled={createKey.isPending} onClick={submitKey}><KeyRound size={15} /> Create key</Button></div><KeysTable keys={keys.data || []} loading={keys.isLoading} onDelete={id => { if (window.confirm('Revoke this sandbox key?')) deleteKey.mutate({ id }, { onSuccess: refreshKeys }); }} /></div></div><div id="orders" className="mt-10"><SectionTitle eyebrow="settlement" title="Order approval queue" body="Review manual payments before provisioning access." /><AdminOrdersTable orders={adminOrders.data || []} loading={adminOrders.isLoading} onStatus={(id, status) => updateOrder.mutate({ id, data: { status } }, { onSuccess: refreshOrders })} /></div></div></div></AppShell>;
}

function IconActionButton({ label, onClick, disabled, tone = 'default', testId, compact = false, children }: { label: string; onClick: () => void; disabled?: boolean; tone?: 'default' | 'danger'; testId?: string; compact?: boolean; children: ReactNode }) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
        className={cx(
          'grid shrink-0 place-items-center rounded-lg border border-[#dbe7e9] text-slate-500 transition hover:bg-slate-100 hover:text-[#142037] disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'h-8 w-8' : 'h-9 w-9',
          tone === 'danger' && 'hover:border-red-200 hover:bg-red-50 hover:text-red-600',
        )}
      >
        {children}
      </button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>;
}

function Pagination({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  if (total <= 1) return null;
  return <div className="flex items-center justify-between border-t border-[#edf2f3] px-5 py-3 text-xs text-slate-500"><span>Page {page} of {total}</span><div className="flex gap-2"><button className="rounded-lg border border-[#dbe7e9] px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</button><button className="rounded-lg border border-[#dbe7e9] px-2 py-1 disabled:opacity-40" disabled={page >= total} onClick={() => onChange(page + 1)}>Next</button></div></div>;
}

function UsersTable({ users, loading, onEdit, onDelete, onToggle, onResetPassword, resettingId, pagination }: { users: User[]; loading: boolean; onEdit: (user: User) => void; onDelete: (id: number) => void; onToggle: (user: User) => void; onResetPassword: (user: User) => void; resettingId?: number; pagination?: { page: number; total: number; onChange: (page: number) => void } }) {
  const [page, setPage] = useState(1); const total = Math.max(1, Math.ceil(users.length / 5)); const visible = users.slice((page - 1) * 5, page * 5);
  useEffect(() => { if (page > total) setPage(total); }, [page, total]);
  const displayedUsers = pagination ? users : visible;
  const activePage = pagination?.page ?? page;
  const pageTotal = pagination?.total ?? total;
  const changePage = pagination?.onChange ?? setPage;
  return <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><State loading={loading} empty={!users.length}><div className="divide-y divide-[#edf2f3]">{displayedUsers.map(user => <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" data-testid={`row-user-${user.id}`}><div className="flex min-w-[210px] items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-full bg-[#def5f3] text-xs font-extrabold text-[#13716e]">{user.name.slice(0, 1).toUpperCase()}</div><div><p className="text-sm font-bold text-[#142037]">{user.name}</p><p className="text-xs text-slate-500">{user.email}</p><p className="mt-1 text-[10px] text-slate-400">Usage: {(user.usage?.today || 0).toLocaleString()} today · {(user.usage?.requests || 0).toLocaleString()} total · {user.usage?.requests ? `${Math.round(((user.usage.successful || 0) / user.usage.requests) * 100)}% success` : '—'}</p></div></div><div className="flex items-center gap-2"><Badge tone={user.status === 'active' ? 'green' : 'red'}>{user.status}</Badge><span className="hidden text-xs text-slate-500 md:inline">{user.planName}</span><IconActionButton label="Edit user" onClick={() => onEdit(user)} testId={`button-edit-user-${user.id}`}><Pencil size={15} /></IconActionButton><IconActionButton label="Reset password" onClick={() => onResetPassword(user)} disabled={resettingId === user.id} testId={`button-reset-password-${user.id}`}><KeyRound size={15} /></IconActionButton><IconActionButton label={user.status === 'active' ? 'Suspend user' : 'Activate user'} onClick={() => onToggle(user)} testId={`button-toggle-user-${user.id}`}>{user.status === 'active' ? <Ban size={15} /> : <Power size={15} />}</IconActionButton><IconActionButton label="Delete user" tone="danger" onClick={() => onDelete(user.id)} testId={`button-delete-user-${user.id}`}><Trash2 size={15} /></IconActionButton></div></div>)}</div><Pagination page={activePage} total={pageTotal} onChange={changePage} /></State></div>;
}

function GeneratedPasswordCard({ email, password, onDismiss }: { email: string; password: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(password);
    else {
      const textarea = document.createElement('textarea');
      textarea.value = password;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return <div className="rounded-2xl border border-[#f4c8a8] bg-[#fff6ef] p-4" data-testid="card-generated-password">
    <p className="text-xs font-bold text-[#a15b2a]">Temporary password for {email}</p>
    <p className="mt-1 text-[11px] leading-5 text-[#a15b2a]">Copy and send this password to the customer securely now — it will not be shown again.</p>
    <div className="mt-3 flex items-center gap-2 rounded-xl border border-[#f4c8a8] bg-white px-3 py-2">
      <code className="mono flex-1 truncate text-sm text-[#142037]" data-testid="text-generated-password">{password}</code>
      <button onClick={() => void copy()} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[#dbe7e9] text-[#13716e] hover:bg-slate-50" data-testid="button-copy-generated-password" aria-label="Copy password">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    </div>
    <button onClick={onDismiss} className="mt-3 text-xs font-bold text-[#13716e]" data-testid="button-dismiss-generated-password">Done, I've copied it</button>
  </div>;
}

function KeysTable({ keys, loading, onDelete }: { keys: SandboxKey[]; loading: boolean; onDelete: (id: number) => void }) {
  const [page, setPage] = useState(1); const total = Math.max(1, Math.ceil(keys.length / 5)); const visible = keys.slice((page - 1) * 5, page * 5);
  useEffect(() => { if (page > total) setPage(total); }, [page, total]);
  return <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><State loading={loading} empty={!keys.length}><div className="divide-y divide-[#edf2f3]">{visible.map(key => <div key={key.id} className="flex items-center justify-between gap-3 px-5 py-4" data-testid={`row-key-${key.id}`}><div><div className="flex items-center gap-2"><p className="text-sm font-bold text-[#142037]">{key.label}</p><Badge tone={key.status === 'active' ? 'green' : 'red'}>{key.status}</Badge></div><p className="mono mt-1 text-xs text-slate-500">{key.prefix}•••••• · {key.requests.toLocaleString()} requests</p></div><button onClick={() => onDelete(key.id)} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" data-testid={`button-delete-key-${key.id}`}><Trash2 size={15} /></button></div>)}</div><Pagination page={page} total={total} onChange={setPage} /></State></div>;
}

function AdminOrdersTable({ orders: source, loading, onStatus }: { orders: AdminOrder[] | PaginatedAdminOrders; loading: boolean; onStatus: (id: number, status: 'active' | 'rejected') => void }) {
  const orders = Array.isArray(source) ? source : source.items;
  return <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><State loading={loading} empty={!orders.length}><div className="divide-y divide-[#edf2f3]">{orders.map(order => {
    const isStaticResidential = order.source === 'static_residential';
    const status = String(order.status);
    const tone = isStaticResidential ? (status === 'active' ? 'green' : status === 'quota_exceeded' ? 'red' : status === 'expired' ? 'orange' : 'neutral') : orderTone(order.status);
    return <div key={order.orderKey || order.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4" data-testid={`row-order-${order.orderKey || order.id}`}><div><p className="text-sm font-bold text-[#142037]">{order.customerEmail}</p><p className="mt-1 text-xs text-slate-500">{isStaticResidential ? `US Static Residential · ${order.nodeCount} ports · ${order.quotaGb} GB shared · ${order.rentalDays} ${order.rentalDays === 1 ? 'day' : 'days'} · credit` : `${order.planName} · ${order.nodeCount} ${order.nodeCount === 1 ? 'node' : 'nodes'} · ${order.rentalDays} ${order.rentalDays === 1 ? 'day' : 'days'} · ${order.paymentMethod}`}</p></div><div className="flex items-center gap-3"><div className="text-right"><p className="text-sm font-bold text-[#142037]">{money(order.amount)}</p><p className="text-xs text-slate-400">{date(order.createdAt)}</p></div>{!isStaticResidential && order.status === 'pending' ? <><Button className="min-h-9 px-3 text-xs" onClick={() => onStatus(order.id, 'active')} data-testid={`button-approve-order-${order.id}`}><Check size={14} /> Approve</Button><Button variant="danger" className="min-h-9 px-3 text-xs" onClick={() => onStatus(order.id, 'rejected')} data-testid={`button-reject-order-${order.id}`}><X size={14} /> Reject</Button></> : <Badge tone={tone}>{status.replace('_', ' ')}</Badge>}</div></div>;
  })}</div></State></div>;
}

function PageLayout({ admin = false, eyebrow, title, body, action, children }: { admin?: boolean; eyebrow: string; title: string; body: string; action?: ReactNode; children: ReactNode }) {
  return <AppShell admin={admin}><div className="shell-grid min-h-[calc(100dvh-72px)] px-5 py-8 lg:px-9"><div className="mx-auto max-w-[1420px]"><div className="mb-9 flex flex-wrap items-end justify-between gap-4"><div><p className="mono mb-2 text-[10px] uppercase tracking-[.2em] text-[#e4643d]">{eyebrow}</p><h1 className="text-3xl font-extrabold tracking-[-.05em] text-[#142037] md:text-4xl">{title}</h1><p className="mt-2 max-w-2xl text-sm text-slate-500">{body}</p></div>{action}</div>{children}</div></div></AppShell>;
}

function ClientOverviewPage() {
  const overview = useGetClientOverview();
  return <PageLayout eyebrow="client workspace" title={`Good to see you, ${overview.data?.displayName?.split(' ')[0] || 'operator'}.`} body="Your routing surface, at a glance." action={<Link href="/client/nodes" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[#f46c43] px-4 text-sm font-bold text-white">Manage nodes <ArrowRight size={15} /></Link>}><State loading={overview.isLoading} error={overview.isError} onRetry={() => overview.refetch()}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"><Metric label="Active nodes" value={String(overview.data?.activeNodes ?? 0)} detail="Current provisioned footprint" icon={Server} tone="teal" /><Metric label="Requests today" value={(overview.data?.requestsToday ?? 0).toLocaleString()} detail="Across your workspace" icon={Activity} tone="orange" /><Metric label="Total requests" value={(overview.data?.totalRequests ?? 0).toLocaleString()} detail="All recorded proxy connections" icon={Gauge} tone="teal" /><Metric label="Total bandwidth" value={bytes(overview.data?.totalBandwidthBytes ?? 0)} detail="Upload + download" icon={Activity} tone="orange" /><Metric label="Next rotation" value={overview.data?.nextRotationAt ? time(overview.data.nextRotationAt) : '—'} detail={overview.data?.nextRotationAt ? date(overview.data.nextRotationAt) : 'No active plan'} icon={RefreshCw} tone="orange" /></div><div className="mt-6 rounded-3xl bg-[#142037] p-7 text-white"><p className="mono text-[10px] uppercase tracking-[.18em] text-[#69d5d0]">current plan</p><h2 className="mt-3 text-2xl font-extrabold">{overview.data?.activeOrder?.planName || 'No active plan'}</h2><p className="mt-3 text-sm text-slate-300">{overview.data?.activeOrder ? `${overview.data.activeOrder.nodeName} · expires ${date(overview.data.activeOrder.expiresAt)}` : 'Rent a node to begin routing traffic.'}</p></div></State></PageLayout>;
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
          <div className="grid gap-3 sm:grid-cols-2"><input className={inputClass} placeholder="SKU (optional)" value={productForm.sku || ''} onChange={event => setProductForm({ ...productForm, sku: event.target.value })} /><label className="text-xs font-bold text-slate-600">Base price {productForm.serviceType === 'proxy' ? '/ node / day' : ''}<input className={`${inputClass} mt-1 block w-full`} type="number" min="0" step="0.0001" placeholder="0.0000" value={productForm.basePrice} onChange={event => setProductForm({ ...productForm, basePrice: Number(event.target.value) })} /></label></div>
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
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const users = usePaginatedUsers(page, 5, search);
  const qc = useQueryClient();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const resetPassword = useResetUserPassword();
  const [form, setForm] = useState({ name: '', email: '' });
  const [editing, setEditing] = useState<User | null>(null);
  const [generated, setGenerated] = useState<{ email: string; password: string } | null>(null);
  const [resettingId, setResettingId] = useState<number>();
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);
  useEffect(() => { if (users.data && page > users.data.totalPages) setPage(users.data.totalPages); }, [users.data?.totalPages, page]);
  const refresh = () => void qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
  const create = () => {
    if (!form.name || !form.email) return;
    createUser.mutate(
      { data: form },
      {
        onSuccess: user => {
          setForm({ name: '', email: '' });
          setGenerated(user.temporaryPassword ? { email: user.email, password: user.temporaryPassword } : null);
          refresh();
        },
        onError: error => window.alert(error.message),
      },
    );
  };
  const resetUserPassword = (user: User) => {
    if (!window.confirm(`Generate a new password for ${user.email}? Their current password will stop working immediately.`)) return;
    setResettingId(user.id);
    resetPassword.mutate(
      { id: user.id },
      {
        onSuccess: result => setGenerated({ email: user.email, password: result.temporaryPassword }),
        onError: error => window.alert(error.message),
        onSettled: () => setResettingId(undefined),
      },
    );
  };

  return <PageLayout admin eyebrow="directory" title="Users" body="Create customer login accounts and maintain their access.">
    <div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]">
      <div className="grid gap-5">
        {generated && <GeneratedPasswordCard email={generated.email} password={generated.password} onDismiss={() => setGenerated(null)} />}
        <div className="rounded-3xl border border-[#dbe7e9] bg-white p-6">
          <h2 className="font-extrabold text-[#142037]">{editing ? 'Edit user' : 'Add user'}</h2>
          <div className="mt-5 grid gap-3">
            <input value={editing?.name ?? form.name} onChange={event => editing ? setEditing({ ...editing, name: event.target.value }) : setForm({ ...form, name: event.target.value })} placeholder="Name" className="rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" />
            <input value={editing?.email ?? form.email} disabled={!!editing} onChange={event => setForm({ ...form, email: event.target.value })} placeholder="Email" type="email" className="rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm disabled:opacity-50" />
            {!editing && <p className="text-xs leading-5 text-slate-500">A strong temporary password is generated automatically and shown once after creation.</p>}
            {editing ? <div className="flex gap-2"><Button className="flex-1" onClick={() => updateUser.mutate({ id: editing.id, data: { name: editing.name, status: editing.status } }, { onSuccess: () => { setEditing(null); refresh(); } })}>Save</Button><Button variant="quiet" onClick={() => setEditing(null)}>Cancel</Button></div> : <Button disabled={createUser.isPending || !form.name || !form.email} onClick={create}><Plus size={15} /> {createUser.isPending ? 'Creating...' : 'Add user'}</Button>}
          </div>
        </div>
      </div>
      <div className="min-w-0">
        <label className="relative mb-3 block">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Search by name or email" aria-label="Search users by name or email" className="w-full rounded-xl border border-[#dbe7e9] bg-white py-3 pl-10 pr-10 text-sm outline-none focus:border-[#f46c43]" />
          {searchInput && <button type="button" onClick={() => setSearchInput('')} aria-label="Clear user search" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-[#142037]"><X size={15} /></button>}
        </label>
        <UsersTable users={users.data?.items || []} loading={users.isLoading} onEdit={setEditing} onDelete={id => { if (window.confirm('Delete this user record?')) deleteUser.mutate({ id }, { onSuccess: refresh }); }} onToggle={user => updateUser.mutate({ id: user.id, data: { status: user.status === 'active' ? 'suspended' : 'active' } }, { onSuccess: refresh })} onResetPassword={resetUserPassword} resettingId={resettingId} pagination={{ page, total: users.data?.totalPages || 1, onChange: setPage }} />
      </div>
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
  const [page, setPage] = useState(1);
  const orders = usePaginatedAdminOrders(page, 5);
  const updateOrder = useUpdateOrderStatus();
  const qc = useQueryClient();
  useEffect(() => { if (orders.data && page > orders.data.totalPages) setPage(orders.data.totalPages); }, [orders.data?.totalPages, page]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: getListAdminOrdersQueryKey() }); void qc.invalidateQueries({ queryKey: getGetAdminOverviewQueryKey() }); };
  return <PageLayout admin eyebrow="settlement" title="Order approval queue" body="Review manual payments before provisioning customer access."><AdminOrdersTable orders={orders.data?.items || []} loading={orders.isLoading} onStatus={(id, status) => updateOrder.mutate({ id, data: { status } }, { onSuccess: refresh })} /><Pagination page={page} total={orders.data?.totalPages || 1} onChange={setPage} /></PageLayout>;
}

function AdminProvidersPage() {
  const providers = useListProviders();
  const providerKeys = useListProviderApiKeys();
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
  return <PageLayout admin eyebrow="proxy module" title="Providers" body="API-key limits determine capacity. Provider Max sandbox is an optional aggregate safety cap.">
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
          const activeKeys = (providerKeys.data || []).filter(key => key.providerId === provider.id && key.status === 'active');
          const keyLimit = activeKeys.some(key => key.maxSandboxes === null) ? null : activeKeys.reduce((total, key) => total + (key.maxSandboxes || 0), 0);
          const effectiveLimit = provider.maxSandboxes === null ? keyLimit : keyLimit === null ? provider.maxSandboxes : Math.min(provider.maxSandboxes, keyLimit);
          const customerCapacity = effectiveLimit === null ? null : Math.max(0, effectiveLimit - provider.reservedReplacementSlots);
          return <div key={provider.id} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#dbe7e9] bg-white p-5">
            <div><div className="flex items-center gap-2"><p className="font-extrabold">{provider.name}</p><Badge tone={provider.status === 'active' ? 'green' : 'neutral'}>{provider.status}</Badge></div><p className="mono mt-1 text-[10px] text-slate-400">{provider.code} · {provider.apiBaseUrl || 'No API URL'}</p><p className="mt-2 text-xs text-slate-500">{provider.activeSandboxes}/{effectiveLimit ?? '∞'} running · {provider.reservedReplacementSlots} reserved · {customerCapacity ?? '∞'} customer capacity · concurrency {provider.maxConcurrentProvisions}</p><p className="mt-1 text-xs text-slate-400">{activeKeys.length} active keys · key cap {keyLimit ?? '∞'} · provider cap {provider.maxSandboxes ?? 'none'}</p></div>
            <div className="flex gap-1">{provider.maxSandboxes !== null && <button title="Remove provider cap and use API-key capacity" className="rounded-lg p-2 text-slate-400 hover:bg-[#eaf8f6] hover:text-[#13716e]" onClick={() => { if (window.confirm(`Remove the aggregate max for ${provider.name}? Active API-key limits will control capacity.`)) updateProvider.mutate({ id: provider.id, data: { maxSandboxes: null } }, { onSuccess: refresh, onError: error => window.alert(error.message) }); }}>∞</button>}<button className="rounded-lg p-2 text-slate-400 hover:bg-slate-100" onClick={() => setEditing({ ...provider, maxSandboxes: provider.maxSandboxes ?? 20 })}><MoreHorizontal size={17} /></button><button className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => { if (window.confirm(`Delete ${provider.name}?`)) deleteProvider.mutate({ id: provider.id }, { onSuccess: refresh, onError: error => window.alert(error.message) }); }}><Trash2 size={15} /></button></div>
          </div>;
        })}</div>
      </State>
    </div>
  </PageLayout>;
}

function ProviderApiKeyRow({ apiKey, onRefresh }: { apiKey: ProviderApiKey; onRefresh: () => void }) {
  const update = useUpdateProviderApiKey();
  const revoke = useRevokeProviderApiKey();
  const [limit, setLimit] = useState(String(apiKey.maxSandboxes ?? 10));
  useEffect(() => setLimit(String(apiKey.maxSandboxes ?? 10)), [apiKey.id, apiKey.maxSandboxes]);
  const parsedLimit = Number(limit);
  const validLimit = Number.isInteger(parsedLimit) && parsedLimit > 0;
  return <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"><div className="min-w-0"><div className="flex items-center gap-2"><p className="text-sm font-bold">{apiKey.label}</p><Badge tone={apiKey.status === 'active' ? 'green' : 'red'}>{apiKey.status}</Badge></div><p className="mt-1 text-xs text-slate-500">{apiKey.providerName}</p><p className="mono mt-1 text-[10px] text-slate-400">{apiKey.maskedKey}</p>{apiKey.status === 'revoked' && apiKey.revokedReason && <p className="mt-1 text-[11px] text-red-500">Auto-disabled: {apiKey.revokedReason}</p>}</div><div className="flex items-end gap-2"><label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Key max sandbox<input className="mt-1 block h-8 w-24 rounded-lg border border-[#dbe7e9] bg-[#f8fbfb] px-2 text-xs" type="number" min={1} step={1} value={limit} onChange={event => setLimit(event.target.value)} /></label><IconActionButton compact label={update.isPending ? 'Saving key limit' : 'Save key limit'} onClick={() => update.mutate({ id: apiKey.id, data: { maxSandboxes: parsedLimit } }, { onSuccess: onRefresh, onError: error => window.alert(error.message) })} disabled={!validLimit || update.isPending || parsedLimit === apiKey.maxSandboxes}><Check size={14} /></IconActionButton>{apiKey.status === 'active' && <IconActionButton compact tone="danger" label="Revoke API key" onClick={() => revoke.mutate({ id: apiKey.id }, { onSuccess: onRefresh, onError: error => window.alert(error.message) })} disabled={revoke.isPending}><Ban size={14} /></IconActionButton>}</div></div>;
}

function AdminProviderApiKeysPage() {
  const providers = useListProviders();
  const keys = useListProviderApiKeys();
  const createKey = useCreateProviderApiKey();
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState(0);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [maxSandboxes, setMaxSandboxes] = useState('10');
  const [page, setPage] = useState(1);
  const selectedProvider = providers.data?.find(provider => provider.id === providerId);
  const isGithub = selectedProvider?.code === 'github';
  const totalPages = Math.max(1, Math.ceil((keys.data?.length || 0) / 5));
  const visibleKeys = (keys.data || []).slice((page - 1) * 5, page * 5);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: getListProviderApiKeysQueryKey() }); void qc.invalidateQueries({ queryKey: getListProvidersQueryKey() }); };
  const parsedMaxSandboxes = Number(maxSandboxes);
  const validMaxSandboxes = Number.isInteger(parsedMaxSandboxes) && parsedMaxSandboxes > 0;
  const submit = () => { if (!providerId || !label || secret.length < 8 || !validMaxSandboxes) return; createKey.mutate({ providerId, data: { label, secret, maxSandboxes: parsedMaxSandboxes } }, { onSuccess: () => { setLabel(''); setSecret(''); setMaxSandboxes('10'); refresh(); }, onError: error => window.alert(error.message) }); };
  const inputClass = 'rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]';
  return <PageLayout admin eyebrow="proxy module" title="Provider API keys" body="Set a safety limit per API key. Provider Max sandbox remains the aggregate hard cap for the provider."><div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><h2 className="font-extrabold">Add provider key</h2><div className="mt-5 grid gap-3"><select className={inputClass} value={providerId || ''} onChange={event => setProviderId(Number(event.target.value))}><option value="">Select provider</option>{providers.data?.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><input className={inputClass} placeholder="Label" value={label} onChange={event => setLabel(event.target.value)} /><input className={inputClass} type="password" autoComplete="new-password" placeholder={isGithub ? 'GITHUB_OWNER|GITHUB_API_KEY' : 'Provider API secret'} value={secret} onChange={event => setSecret(event.target.value)} /><label className="text-xs font-bold text-slate-600">Max sandboxes for this key<input className={`${inputClass} mt-2 w-full`} type="number" min={1} step={1} value={maxSandboxes} onChange={event => setMaxSandboxes(event.target.value)} /></label>{isGithub && <p className="text-xs leading-5 text-slate-500">Format: <code>GITHUB_OWNER|GITHUB_API_KEY</code>. The owner is retained only as a masked prefix; the complete value is encrypted at rest.</p>}<p className="text-xs leading-5 text-slate-500">Requires `PROVIDER_SECRET_ENCRYPTION_KEY` on the Nest server.</p><Button disabled={!providerId || !label || secret.length < 8 || !validMaxSandboxes || createKey.isPending} onClick={submit}>{createKey.isPending ? 'Encrypting…' : 'Save encrypted key'}</Button></div></div><State loading={keys.isLoading} error={keys.isError} onRetry={() => keys.refetch()} empty={!keys.data?.length}><div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><div className="divide-y divide-[#edf2f3]">{visibleKeys.map(key => <ProviderApiKeyRow key={key.id} apiKey={key} onRefresh={refresh} />)}</div><Pagination page={page} total={totalPages} onChange={setPage} /></div></State></div></PageLayout>;
}

function AdminProvisioningLogsPage() {
  const [page, setPage] = useState(1);
  const jobs = useProvisioningJobs(page);
  useEffect(() => { if (jobs.data && page > jobs.data.totalPages) setPage(jobs.data.totalPages); }, [jobs.data?.totalPages, page]);
  return <PageLayout admin eyebrow="proxy operations" title="Provisioning error logs" body="Append-only provisioning and rotation failures. Entries are retained after a retry or recovery and sorted by event creation time, newest first."><State loading={jobs.isLoading} error={jobs.isError} onRetry={() => jobs.refetch()} empty={!jobs.data?.items.length}><div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><div className="divide-y divide-[#edf2f3]">{jobs.data?.items.map(job => <div key={job.id} className="grid gap-3 px-5 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><p className="font-extrabold">Error event #{job.id}</p><Badge tone="red">{job.status}</Badge><span className="mono text-[10px] uppercase tracking-wide text-slate-400">{job.eventType}</span></div><p className="mt-1 text-xs text-slate-500">Node #{job.nodeId}{job.orderId ? ` · Order #${job.orderId}` : ''}{job.providerName ? ` · ${job.providerName}` : ''}</p></div><p className="text-left text-xs text-slate-400 sm:text-right">{new Date(job.createdAt).toLocaleString()}</p></div><div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2"><p className="mono break-words text-xs leading-5 text-red-700">{job.error}</p></div></div>)}</div><Pagination page={page} total={jobs.data?.totalPages || 1} onChange={setPage} /></div></State></PageLayout>;
}

function ProxyPriceRow({ setting }: { setting: { id: number; name: string; countryCode: string | null; basePrice: number; currency: string; isActive: boolean } }) {
  // Keep the edit buffer as text so typing `0.` or trailing fractional zeros
  // is not immediately normalized by React before the user finishes.
  const [price, setPrice] = useState(String(setting.basePrice));
  const [currency, setCurrency] = useState(setting.currency);
  const update = useUpdateProxyPrice();
  const qc = useQueryClient();
  const parsedPrice = Number(price);
  const validPrice = /^\d+(?:\.\d{1,4})?$/.test(price) && Number.isFinite(parsedPrice) && parsedPrice >= 0;
  return <div className="grid gap-3 border-b border-[#edf2f3] px-5 py-4 last:border-0 sm:grid-cols-[1fr_130px_90px_auto] sm:items-center"><div><p className="font-bold">{setting.name}</p><p className="text-xs text-slate-500">{setting.countryCode || 'Global'} · {setting.isActive ? 'Active' : 'Inactive'}</p></div><input className="rounded-xl border border-[#dbe7e9] px-3 py-2 text-sm" inputMode="decimal" pattern="^\d*(\.\d{0,4})?$" placeholder="0.0000" value={price} onChange={event => { const next = event.target.value; if (/^\d*(?:\.\d{0,4})?$/.test(next)) setPrice(next); }} /><input className="rounded-xl border border-[#dbe7e9] px-3 py-2 text-sm" maxLength={3} value={currency} onChange={event => setCurrency(event.target.value.toUpperCase())} /><Button className="min-h-9 px-3 text-xs" disabled={update.isPending || !validPrice} onClick={() => update.mutate({ id: setting.id, data: { basePrice: parsedPrice, currency } }, { onSuccess: () => void qc.invalidateQueries({ queryKey: getProxySettingsQueryKey() }), onError: error => window.alert(error.message) })}>Save</Button></div>;
}

function AdminProxySettingsPage() {
  const settings = useProxySettings();
  return <PageLayout admin eyebrow="proxy module" title="Proxy pricing" body="Set the authoritative price for one node per day. Quote and order totals are always calculated on the server."><State loading={settings.isLoading} error={settings.isError} onRetry={() => settings.refetch()} empty={!settings.data?.length}><div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white">{settings.data?.map(setting => <ProxyPriceRow key={setting.id} setting={setting} />)}</div></State></PageLayout>;
}

function AdminGeneralSettingsPage() {
  const settings = useGeneralSettings();
  const update = useUpdateGeneralSettings();
  const qc = useQueryClient();
  const [form, setForm] = useState<GeneralSettings>({ siteName: 'Nodenesia', supportEmail: '', defaultCurrency: 'USD', usdToIdrRate: 16000, creditsPerUsd: 100, trialCreditAmount: 100 });
  useEffect(() => { if (settings.data) setForm(settings.data); }, [settings.data]);
  const inputClass = 'mt-2 block w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm outline-none focus:border-[#f46c43]';
  return <PageLayout admin eyebrow="system" title="Settings" body="General application defaults shared across modules."><State loading={settings.isLoading} error={settings.isError} onRetry={() => settings.refetch()}><div className="max-w-2xl rounded-3xl border border-[#dbe7e9] bg-white p-6"><div className="grid gap-4"><label className="text-sm font-bold">Site name<input className={inputClass} value={form.siteName} onChange={event => setForm({ ...form, siteName: event.target.value })} /></label><label className="text-sm font-bold">Support email<input className={inputClass} type="email" value={form.supportEmail} onChange={event => setForm({ ...form, supportEmail: event.target.value })} /></label><label className="text-sm font-bold">Default currency<input className={inputClass} maxLength={3} value={form.defaultCurrency} onChange={event => setForm({ ...form, defaultCurrency: event.target.value.toUpperCase() })} /></label><label className="text-sm font-bold">USD → IDR exchange rate<input className={inputClass} type="number" min="1" step="0.01" value={form.usdToIdrRate} onChange={event => setForm({ ...form, usdToIdrRate: Math.max(1, Number(event.target.value) || 1) })} /></label><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-bold">Credits per USD<input className={inputClass} type="number" min="0.01" step="0.01" value={form.creditsPerUsd} onChange={event => setForm({ ...form, creditsPerUsd: Math.max(.01, Number(event.target.value) || .01) })} /><span className="mt-1 block text-xs font-normal text-slate-500">Example: 100 means $1 = 100 credits.</span></label><label className="text-sm font-bold">New-user trial credit<input className={inputClass} type="number" min="0" step="0.01" value={form.trialCreditAmount} onChange={event => setForm({ ...form, trialCreditAmount: Math.max(0, Number(event.target.value) || 0) })} /><span className="mt-1 block text-xs font-normal text-slate-500">Set this to one node/day cost.</span></label></div><Button className="mt-2 w-fit" disabled={update.isPending} onClick={() => update.mutate({ data: { ...form, supportEmail: form.supportEmail || undefined } }, { onSuccess: () => { void qc.invalidateQueries({ queryKey: getGeneralSettingsQueryKey() }); void qc.invalidateQueries({ queryKey: ['catalog-settings'] }); }, onError: error => window.alert(error.message) })}>{update.isPending ? 'Saving…' : 'Save settings'}</Button></div></div></State></PageLayout>;
}

function CreditHistoryModal({ wallet, onClose }: { wallet: CreditWallet; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const history = useCreditHistory(wallet.id, page, 10);
  useEffect(() => { if (history.data && page > history.data.totalPages) setPage(history.data.totalPages); }, [history.data?.totalPages, page]);
  const typeLabel = (type: string) => type.replaceAll('_', ' ');
  return <Modal title={`Credit history · ${wallet.name}`} onClose={onClose}>
    <div className="mb-4 rounded-2xl border border-[#dbe7e9] bg-[#f8fbfb] px-4 py-3">
      <p className="text-xs text-slate-500">{wallet.email}</p>
      <p className="mono mt-1 text-lg font-extrabold text-[#13716e]">Current balance: {wallet.balance.toLocaleString()} cr</p>
    </div>
    <State loading={history.isLoading} error={history.isError} onRetry={() => history.refetch()} empty={!history.data?.items.length}>
      <div className="overflow-hidden rounded-2xl border border-[#dbe7e9]">
        <div className="divide-y divide-[#edf2f3]">{history.data?.items.map(entry => {
          const positive = entry.amount > 0;
          return <div key={entry.id} className="px-4 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge tone={positive ? 'green' : 'red'}>{typeLabel(entry.type)}</Badge>{entry.reference && <span className="mono break-all text-[10px] text-slate-400">{entry.reference}</span>}</div><p className="mt-2 break-words text-sm text-[#142037]">{entry.note || 'No note'}</p></div>
              <div className="shrink-0 text-right"><p className={cx('mono text-sm font-extrabold', positive ? 'text-[#13716e]' : 'text-red-600')}>{positive ? '+' : ''}{entry.amount.toLocaleString()} cr</p><p className="mt-1 text-[10px] text-slate-400">Balance {entry.balanceAfter.toLocaleString()} cr</p></div>
            </div>
            <div className="mt-3 flex flex-wrap justify-between gap-2 text-[10px] text-slate-400"><span>{entry.actor ? `By ${entry.actor.name} · ${entry.actor.email}` : 'System transaction'}</span><span>{new Date(entry.createdAt).toLocaleString()}</span></div>
          </div>;
        })}</div>
        <Pagination page={page} total={history.data?.totalPages || 1} onChange={setPage} />
      </div>
    </State>
  </Modal>;
}

function AdminCreditsPage() {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const wallets = useCreditWallets(page, 5, search);
  const topUp = useAddCreditTopUp();
  const deduct = useDeductCredit();
  const updateUser = useUpdateUser();
  const settings = useGeneralSettings();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<CreditWallet | null>(null);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'IDR'>('USD');
  const [note, setNote] = useState('Manual credit top-up');
  const [deducting, setDeducting] = useState<CreditWallet | null>(null);
  const [historyWallet, setHistoryWallet] = useState<CreditWallet | null>(null);
  const [deductionAmount, setDeductionAmount] = useState('');
  const [deductionNote, setDeductionNote] = useState('');
  const numericAmount = Number(amount);
  const credits = Number.isFinite(numericAmount) && numericAmount > 0 ? (currency === 'USD' ? numericAmount * (settings.data?.creditsPerUsd || 100) : (numericAmount / (settings.data?.usdToIdrRate || 16000)) * (settings.data?.creditsPerUsd || 100)) : 0;
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);
  useEffect(() => { if (wallets.data && page > wallets.data.totalPages) setPage(wallets.data.totalPages); }, [wallets.data?.totalPages, page]);
  const addCredit = () => {
    if (!selected || !note.trim() || credits <= 0) return;
    topUp.mutate({ id: selected.id, data: { amount: numericAmount, currency, note: note.trim() } }, { onSuccess: () => { setSelected(null); void qc.invalidateQueries({ queryKey: getCreditWalletsQueryKey() }); }, onError: error => window.alert(error.message) });
  };
  const deductCredit = () => {
    const amountToDeduct = Number(deductionAmount);
    if (!deducting || !Number.isFinite(amountToDeduct) || amountToDeduct <= 0 || amountToDeduct > deducting.balance || !deductionNote.trim()) return;
    deduct.mutate({ id: deducting.id, data: { amount: amountToDeduct, note: deductionNote.trim() } }, { onSuccess: () => { setDeducting(null); void qc.invalidateQueries({ queryKey: getCreditWalletsQueryKey() }); }, onError: error => window.alert(error.message) });
  };
  return <PageLayout admin eyebrow="billing" title="Credits" body="Manual top-ups and deductions are recorded in an immutable ledger. Trial users may rent only one node until promoted.">
    <label className="relative mb-3 block"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Search by name or email" aria-label="Search credit accounts by name or email" className="w-full rounded-xl border border-[#dbe7e9] bg-white py-3 pl-10 pr-10 text-sm outline-none focus:border-[#f46c43]" />{searchInput && <button type="button" onClick={() => setSearchInput('')} aria-label="Clear credit search" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-[#142037]"><X size={15} /></button>}</label>
    <State loading={wallets.isLoading} error={wallets.isError} onRetry={() => wallets.refetch()} empty={!wallets.data?.items.length}>
      <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white">
        <div className="hidden grid-cols-[1.3fr_.8fr_.7fr_160px] gap-4 border-b border-[#edf2f3] px-5 py-3 text-[10px] font-bold uppercase tracking-[.15em] text-slate-400 md:grid"><span>User</span><span>Account</span><span>Balance</span><span className="text-right">Actions</span></div>
        {wallets.data?.items.map(wallet => <div key={wallet.id} className="grid gap-3 border-b border-[#edf2f3] px-5 py-4 last:border-0 md:grid-cols-[1.3fr_.8fr_.7fr_160px] md:items-center md:gap-4">
          <div><p className="text-sm font-bold">{wallet.name}</p><p className="text-xs text-slate-500">{wallet.email}</p></div>
          <div><Badge tone={wallet.isTrial ? 'orange' : 'green'}>{wallet.isTrial ? 'trial' : 'regular'}</Badge></div>
          <p className="mono text-sm font-extrabold text-[#13716e]">{wallet.balance.toLocaleString()} cr</p>
          <div className="flex w-[160px] justify-end gap-2">
            <IconActionButton label="Credit history" onClick={() => setHistoryWallet(wallet)}><History size={15} /></IconActionButton>
            <IconActionButton label="Add credit" onClick={() => { setSelected(wallet); setAmount(''); setCurrency('USD'); setNote('Manual credit top-up'); }} disabled={topUp.isPending}><Plus size={15} /></IconActionButton>
            <IconActionButton label="Reduce credit" onClick={() => { setDeducting(wallet); setDeductionAmount(''); setDeductionNote(''); }} disabled={deduct.isPending || wallet.balance <= 0}><Ban size={15} /></IconActionButton>
            {wallet.isTrial && <IconActionButton label="Promote to regular account" onClick={() => updateUser.mutate({ id: wallet.id, data: { isTrial: false } }, { onSuccess: () => void qc.invalidateQueries({ queryKey: getCreditWalletsQueryKey() }), onError: error => window.alert(error.message) })} disabled={updateUser.isPending}><Power size={15} /></IconActionButton>}
          </div>
        </div>)}
        <Pagination page={page} total={wallets.data?.totalPages || 1} onChange={setPage} />
      </div>
    </State>
    {historyWallet && <CreditHistoryModal wallet={historyWallet} onClose={() => setHistoryWallet(null)} />}
    {selected && <Modal title={`Add credit · ${selected.name}`} onClose={() => setSelected(null)}><div className="grid gap-4"><p className="text-sm text-slate-500">Enter USD or IDR to calculate the Credit top-up.</p><div className="grid grid-cols-[1fr_120px] gap-3"><label className="text-sm font-bold">Amount<input autoFocus className="mt-2 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" /></label><label className="text-sm font-bold">Currency<select className="mt-2 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" value={currency} onChange={event => setCurrency(event.target.value as 'USD' | 'IDR')}><option>USD</option><option>IDR</option></select></label></div><div className="rounded-xl border border-[#bfe3df] bg-[#eaf8f6] px-4 py-3"><p className="text-xs text-[#13716e]">Credit to add</p><p className="mono mt-1 text-xl font-extrabold text-[#13716e]">{credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} cr</p></div><label className="text-sm font-bold">Audit note<input className="mt-2 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" value={note} onChange={event => setNote(event.target.value)} maxLength={300} /></label><div className="flex gap-3"><Button variant="outline" className="flex-1" onClick={() => setSelected(null)}>Cancel</Button><Button className="flex-1" disabled={topUp.isPending || credits <= 0 || !note.trim()} onClick={addCredit}>{topUp.isPending ? 'Adding…' : 'Add credit'}</Button></div></div></Modal>}
    {deducting && <Modal title={`Reduce credit · ${deducting.name}`} onClose={() => setDeducting(null)}><div className="grid gap-4"><p className="text-sm text-slate-500">The deduction is permanent and recorded in the immutable ledger. Current balance: <strong>{deducting.balance.toLocaleString()} cr</strong>.</p><label className="text-sm font-bold">Credits to reduce<input autoFocus className="mt-2 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" inputMode="decimal" value={deductionAmount} onChange={event => setDeductionAmount(event.target.value)} placeholder="0.00" /></label><label className="text-sm font-bold">Required audit note<input className="mt-2 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" value={deductionNote} onChange={event => setDeductionNote(event.target.value)} maxLength={300} /></label><div className="flex gap-3"><Button variant="outline" className="flex-1" onClick={() => setDeducting(null)}>Cancel</Button><Button variant="danger" className="flex-1" disabled={deduct.isPending || !(Number(deductionAmount) > 0) || Number(deductionAmount) > deducting.balance || !deductionNote.trim()} onClick={deductCredit}>{deduct.isPending ? 'Reducing…' : 'Reduce credit'}</Button></div></div></Modal>}
  </PageLayout>;
}

function AdminStaticResidentialPage() {
  const [page, setPage] = useState(1);
  const inventory = useStaticResidentialInventory(page, 10);
  const pricing = useStaticResidentialPricing();
  const importer = useImportStaticResidentialInventory();
  const inventoryChecker = useCheckStaticResidentialInventoryStatus();
  const inventoryEnabler = useEnableStaticResidentialInventoryProxy();
  const updatePrice = useUpdateStaticResidentialPricing();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [content, setContent] = useState('');
  const [label, setLabel] = useState('');
  const [price, setPrice] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => { if (pricing.data) setPrice(String(pricing.data.pricePerGbDay)); }, [pricing.data?.pricePerGbDay]);
  useEffect(() => { if (inventory.data && page > inventory.data.totalPages) setPage(inventory.data.totalPages); }, [inventory.data?.totalPages, page]);
  const savePrice = () => updatePrice.mutate({ data: { pricePerGbDay: Number(price) } }, { onSuccess: () => void qc.invalidateQueries({ queryKey: getStaticResidentialPricingQueryKey() }), onError: error => window.alert(error.message) });
  const submitImport = () => importer.mutate({ data: { content, label: label || undefined } }, { onSuccess: result => { setContent(''); setLabel(''); setPage(1); setImportOpen(false); toast({ title: 'Proxies imported', description: `${result.createdOrUpdated} created or updated · ${result.reconfiguredOrders} active order${result.reconfiguredOrders === 1 ? '' : 's'} refreshed${result.duplicatesInFile ? ` · ${result.duplicatesInFile} duplicate line${result.duplicatesInFile === 1 ? '' : 's'} merged` : ''}.` }); void qc.invalidateQueries({ queryKey: getStaticResidentialInventoryQueryKey() }); }, onError: error => toast({ variant: 'destructive', title: 'Import failed', description: error.message }) });
  const checkInventory = () => inventoryChecker.mutate(undefined, { onSuccess: result => { toast({ title: 'Proxy health check complete', description: `${result.healthy}/${result.checked} healthy · ${result.failed} failed · ${result.disabled} disabled after ${result.failureThreshold} failures · ${result.rotationsTriggered} nodes replaced.` }); void qc.invalidateQueries({ queryKey: getStaticResidentialInventoryQueryKey() }); }, onError: error => toast({ variant: 'destructive', title: 'Proxy health check failed', description: error.message }) });
  const enableInventoryProxy = (id: number) => inventoryEnabler.mutate({ id }, { onSuccess: () => { toast({ title: 'Proxy re-enabled', description: 'It is eligible for allocation and the next health check.' }); void qc.invalidateQueries({ queryKey: getStaticResidentialInventoryQueryKey() }); }, onError: error => toast({ variant: 'destructive', title: 'Unable to re-enable proxy', description: error.message }) });
  const available = inventory.data?.available || 0;
  return <><PageLayout admin eyebrow="static residential" title="US Static Residential Proxy" body="Import upstream SOCKS5 endpoints securely. Customer pages never receive this inventory or its credentials.">
    <div className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
      <div className="space-y-5">
        <div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><h2 className="font-extrabold">Fixed package pricing</h2><p className="mt-2 text-sm leading-6 text-slate-500">Every order has exactly 5 ports and a 1GB, 3GB, or 5GB shared quota. Price is per GB/day.</p><label className="mt-5 block text-sm font-bold">USD per GB / day<input className="mt-2 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} /></label><Button className="mt-4" disabled={updatePrice.isPending || !(Number(price) > 0)} onClick={savePrice}>{updatePrice.isPending ? 'Saving…' : 'Save price'}</Button></div>
      </div>
      <div className="overflow-hidden rounded-3xl border border-[#dbe7e9] bg-white"><div className="flex items-center justify-between gap-3 border-b border-[#edf2f3] px-5 py-4"><div><h2 className="font-extrabold">Inventory</h2><p className="mt-1 text-xs text-slate-500">{available} available · 5 required for every new order</p></div><div className="flex flex-wrap items-center justify-end gap-2"><Button variant="outline" className="min-h-9 px-3 text-xs" disabled={inventoryChecker.isPending} onClick={checkInventory}><Activity size={14} /> {inventoryChecker.isPending ? 'Checking…' : 'Check status'}</Button><Button variant="outline" className="min-h-9 px-3 text-xs" onClick={() => setImportOpen(true)}><Plus size={14} /> Import proxies</Button><Badge tone={available >= 5 ? 'green' : 'red'}>{available >= 5 ? 'ready' : 'low capacity'}</Badge></div></div><State loading={inventory.isLoading} error={inventory.isError} onRetry={() => inventory.refetch()} empty={!inventory.data?.items.length}><div className="divide-y divide-[#edf2f3]">{inventory.data?.items.map(item => <div key={item.id} className="flex items-center justify-between gap-4 px-5 py-3"><div className="min-w-0"><p className="truncate text-sm font-bold">{item.label || 'Imported proxy'} · #{item.id}</p><p className="mono mt-1 truncate text-[10px] text-slate-500">{item.host}:{item.port} · {item.username}</p>{item.health_failure_count > 0 && <p className="mt-1 truncate text-[10px] text-red-600" title={item.last_health_error || undefined}>{item.health_failure_count} consecutive health failure{item.health_failure_count === 1 ? '' : 's'}</p>}</div><div className="flex shrink-0 items-center gap-2"><Badge tone={item.status === 'available' ? 'green' : item.status === 'assigned' ? 'orange' : 'red'}>{item.status}</Badge>{item.status === 'disabled' && <Button variant="outline" className="min-h-8 px-2 text-[10px]" disabled={inventoryEnabler.isPending} onClick={() => enableInventoryProxy(item.id)}><Check size={13} /> Re-enable</Button>}</div></div>)}</div><Pagination page={page} total={inventory.data?.totalPages || 1} onChange={setPage} /></State></div>
    </div>
  </PageLayout>{importOpen && <Modal title="Import upstream proxies" onClose={() => setImportOpen(false)}><p className="text-sm leading-6 text-slate-500">Paste one SOCKS5 URL per line. Matching host, port, and username records are updated with the imported password; the label changes only when supplied. Any active orders using updated endpoints are refreshed. Upstream passwords are encrypted and never returned to the browser.</p><input autoFocus className="mt-4 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" placeholder="Optional batch label" value={label} onChange={event => setLabel(event.target.value)} /><textarea className="mt-3 min-h-52 w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 font-mono text-xs outline-none focus:border-[#f46c43]" placeholder={'socks5://user:pass@host:port\nsocks5://user:pass@host:port'} value={content} onChange={event => setContent(event.target.value)} /><div className="mt-4 flex gap-3"><Button variant="outline" className="flex-1" disabled={importer.isPending} onClick={() => setImportOpen(false)}>Cancel</Button><Button className="flex-1" disabled={!content.trim() || importer.isPending} onClick={submitImport}>{importer.isPending ? 'Importing…' : 'Import TXT list'}</Button></div></Modal>}</>;
}

function ClientDockNav({ active }: { active: 'services' | 'proxy' | 'static' }) {
  const items = [
    { href: '/client', label: 'Services', icon: Layers3, active: active === 'services' },
    { href: '/client/proxy', label: 'SOCKS5 Proxy', icon: Network, active: active === 'proxy' },
    { href: '/client/static-residential', label: 'Static Residential', icon: Globe2, active: active === 'static' },
  ];
  return <nav aria-label="Client navigation" className="group fixed bottom-[max(.75rem,env(safe-area-inset-bottom))] left-1/2 z-50 w-[min(calc(100%-1.5rem),24rem)] -translate-x-1/2 overflow-hidden rounded-2xl border border-[#dbe7e9] bg-white/95 p-1.5 shadow-[0_12px_35px_rgba(20,32,55,.14)] backdrop-blur-xl md:bottom-auto md:left-auto md:right-5 md:top-1/2 md:w-12 md:-translate-y-1/2 md:translate-x-0 md:transition-[width] md:duration-300 md:hover:w-48">
    <div className="grid grid-cols-3 gap-1 md:grid-cols-1">{items.map(item => <Link key={item.href} href={item.href} title={item.label} aria-current={item.active ? 'page' : undefined} className={cx('flex min-h-14 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-xl px-1 text-center text-[9px] font-bold leading-3 transition md:h-10 md:min-h-0 md:flex-row md:justify-start md:gap-3 md:px-2.5 md:text-left md:text-sm md:leading-normal', item.active ? 'bg-[#eaf8f6] text-[#13716e]' : 'text-slate-500 hover:bg-[#f4f8f8] hover:text-[#142037]')}><item.icon size={17} className="shrink-0" /><span className="max-w-full text-center md:whitespace-nowrap md:opacity-0 md:transition-opacity md:duration-150 md:group-hover:opacity-100">{item.label}</span></Link>)}</div>
  </nav>;
}

function ClientHeader({ active = 'services' }: { active?: 'services' | 'proxy' | 'static' }) {
  const { user, signOut } = useAuth();
  const [, setLocation] = useLocation();
  const identity = useCurrentUser();
  const creditBalance = useCreditBalance();
  const displayName = String(user?.user_metadata?.name || user?.email?.split('@')[0] || 'Customer');
  const logout = () => void signOut().then(() => { queryClient.clear(); setLocation('/'); });
  const { t } = useLocalePreferences();
  return <><ClientDockNav active={active} /><header className="sticky top-0 z-40 border-b border-[#dbe7e9] bg-white/90 backdrop-blur-xl"><div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between gap-4 px-5 lg:px-8"><Logo /><div className="flex items-center gap-2"><LocaleSwitcher /><div className="hidden items-center gap-1.5 rounded-xl border border-[#bfe3df] bg-[#eaf8f6] px-3 py-2 sm:flex" title="Credit balance"><Zap size={14} className="text-[#13716e]" /><span className="mono text-xs font-extrabold text-[#13716e]">{creditBalance.isLoading ? '…' : `${(creditBalance.data?.balance || 0).toLocaleString()} cr`}</span></div>{identity.data?.role === 'admin' && <Link href="/admin" className="hidden rounded-xl px-3 py-2 text-xs font-bold text-[#13716e] hover:bg-[#def5f3] sm:inline-flex">{t('admin')}</Link>}<div className="hidden text-right sm:block"><p className="text-xs font-bold">{displayName}</p><p className="text-[10px] text-slate-500">{user?.email}</p></div><button onClick={logout} className="grid h-10 w-10 place-items-center rounded-xl border border-[#dbe7e9] bg-white text-slate-600 hover:border-[#f46c43] hover:text-[#e05c37]" aria-label={t('signOut')}><LogOut size={16} /></button></div></div></header></>;
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
    <header className="border-b border-[#dbe7e9] bg-white"><div className="mx-auto flex h-[72px] max-w-3xl items-center px-5 lg:px-8"><Logo /><span className="mono ml-auto text-[10px] uppercase tracking-[.15em] text-slate-400">admin authentication</span></div></header>
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
  const { t } = useLocalePreferences();
  const services = [
    { name: 'US SOCKS5 Proxy', description: 'Rent rotating SOCKS5 nodes by quantity and number of live days.', status: 'available', href: '/client/proxy', route: '/client/proxy', icon: Network, tone: 'teal' },
    { name: 'US Static Residential Proxy', description: 'Five fixed SOCKS5 ports with 1GB, 3GB, or 5GB shared traffic and hourly upstream rotation.', status: 'available', href: '/client/static-residential', route: '/client/static-residential', icon: Globe2, tone: 'orange' },
    { name: 'API & Automation', description: 'Managed APIs, keys, and automated workflows.', status: 'coming soon', route: '/client/automation', icon: Zap, tone: 'teal' },
    { name: 'Cloud Servers', description: 'Short-lived servers and hosted workloads.', status: 'coming soon', route: '/client/servers', icon: Server, tone: 'orange' },
  ] as const;
  return <div className="min-h-[100dvh] bg-[#f4f8f8] text-[#142037]"><ClientHeader /><main className="mx-auto max-w-7xl px-5 py-9 pb-28 lg:px-8 lg:py-12"><div className="mb-8"><p className="mono text-[10px] uppercase tracking-[.2em] text-[#e4643d]">{t('serviceWorkspace')}</p><h1 className="mt-2 text-3xl font-extrabold tracking-[-.05em] md:text-4xl">{t('chooseService')}</h1><p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">{t('serviceIntro')}</p></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{services.map(service => { const Icon = service.icon; const available = service.status === 'available'; const content = <><div className="flex items-start justify-between gap-3"><span className={cx('grid h-11 w-11 place-items-center rounded-2xl', service.tone === 'teal' ? 'bg-[#def5f3] text-[#13716e]' : 'bg-[#fff0e8] text-[#d95432]')}><Icon size={20} /></span><Badge tone={available ? 'green' : 'neutral'}>{available ? t('available') : t('comingSoon')}</Badge></div><h2 className="mt-6 text-lg font-extrabold">{service.name}</h2><p className="mt-2 min-h-12 text-sm leading-6 text-slate-500">{service.description}</p><div className="mt-5 flex items-center justify-between border-t border-[#edf2f3] pt-4"><span className="mono text-[9px] text-slate-400">{service.route}</span>{available && <span className="inline-flex items-center gap-1 text-xs font-bold text-[#e05c37]">{t('open')} <ArrowRight size={13} /></span>}</div></>; return available ? <Link key={service.name} href={service.href} className="rounded-3xl border border-[#dbe7e9] bg-white p-5 transition hover:-translate-y-1 hover:border-[#f46c43] hover:shadow-[0_14px_35px_rgba(20,32,55,.07)]">{content}</Link> : <article key={service.name} aria-disabled="true" className="rounded-3xl border border-[#dbe7e9] bg-white/65 p-5 opacity-75">{content}</article>; })}</div></main></div>;
}

function ProxyOrderForm({ product, isTrial }: { product: CatalogProduct; isTrial?: boolean }) {
  const { locale, t, usdToIdrRate, creditsPerUsd } = useLocalePreferences();
  const [nodeCount, setNodeCount] = useState(5);
  const [rentalDays, setRentalDays] = useState(1);
  const payment = 'credit' as const;
  const quote = useOrderQuote(product.id, nodeCount, rentalDays, { query: { retry: false } });
  const createOrder = useCreateOrder();
  const creditBalance = useCreditBalance();
  const qc = useQueryClient();
  useEffect(() => {
    setNodeCount(isTrial ? 1 : 5);
    setRentalDays(1);
  }, [isTrial]);
  const submit = () => {
    if (!quote.data) return;
    createOrder.mutate({ data: { productId: product.id, nodeCount, rentalDays, paymentMethod: payment } }, {
      onSuccess: () => {
        setNodeCount(isTrial ? 1 : 5);
        setRentalDays(1);
        void qc.invalidateQueries({ queryKey: getListClientOrdersQueryKey() });
        void qc.invalidateQueries({ queryKey: getGetClientOverviewQueryKey() });
        void qc.invalidateQueries({ queryKey: ['credit-balance'] });
      },
      onError: error => window.alert(error.message),
    });
  };
  const fieldClass = 'w-full rounded-lg border border-[#dbe7e9] bg-white px-2.5 py-2 text-xs text-[#142037] outline-none focus:border-[#f46c43]';
  const code = product.countryCode || '—';
  const flag = product.countryCode ? String.fromCodePoint(...product.countryCode.split('').map(char => 127397 + char.charCodeAt(0))) : '🌐';
  const formatCredits = (value: number) => `${value.toLocaleString(locale === 'id' ? 'id-ID' : 'en-US', { maximumFractionDigits: 2 })} ${locale === 'id' ? 'kredit' : 'credits'}`;
  const formatUsd = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const formatIdr = (value: number) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value);
  const unitCreditCost = product.currency === 'USD' ? Math.ceil(product.unitPrice * creditsPerUsd * 100) / 100 : null;
  const unitIdrPrice = product.currency === 'USD' ? product.unitPrice * usdToIdrRate : null;
  let country = code;
  try { country = product.countryCode ? new Intl.DisplayNames([locale === 'id' ? 'id' : 'en'], { type: 'region' }).of(product.countryCode) || code : 'Global'; } catch { country = code; }
  return <>
    <tr className="border-b border-[#edf2f3] last:border-0">
      <td className="px-4 py-4"><div className="flex items-center gap-2"><span className="text-xl">{flag}</span><div><p className="text-xs font-bold text-[#142037]">{country}</p><p className="mono text-[9px] text-slate-400">{code}</p></div></div></td>
      <td className="px-4 py-4"><p className="text-xs font-bold text-[#142037]">{product.name}</p><p className="mt-1 max-w-[230px] truncate text-[10px] text-slate-500" title={product.description}>{product.description}</p></td>
      <td className="px-4 py-4 text-xs font-extrabold text-[#13716e]"><div className="whitespace-nowrap">{unitCreditCost === null ? '—' : formatCredits(unitCreditCost)}<span className="ml-1 font-normal text-slate-400">{t('perDay')}</span></div>{unitIdrPrice !== null && unitCreditCost !== null && <p className="mt-1 max-w-[180px] whitespace-normal text-[10px] font-medium leading-4 text-slate-400">{formatCredits(unitCreditCost)} ≈ {formatUsd(product.unitPrice)} ≈ {formatIdr(unitIdrPrice)}</p>}</td>
      <td className="w-24 px-3 py-4"><select aria-label={`Nodes for ${country}`} className={fieldClass} value={nodeCount} disabled={isTrial} onChange={event => setNodeCount(Number(event.target.value))}>{isTrial ? <option value={1}>1</option> : [5, 10, 20, 30].map(value => <option key={value} value={value}>{value}</option>)}</select></td>
      <td className="w-24 px-3 py-4"><select aria-label={`Days for ${country}`} className={fieldClass} value={rentalDays} disabled={isTrial} onChange={event => setRentalDays(Number(event.target.value))}>{isTrial ? <option value={1}>1</option> : [1, 3, 7, 15, 30].map(value => <option key={value} value={value}>{value}</option>)}</select></td>
      <td className="w-36 px-3 py-4"><span className="inline-flex min-h-9 items-center rounded-lg border border-[#bfe3df] bg-[#eaf8f6] px-2.5 text-xs font-bold text-[#13716e]">Credit</span></td>
      <td className="whitespace-nowrap px-4 py-4 text-sm font-extrabold text-[#142037]">{quote.isLoading ? '…' : <>{formatCredits(quote.data?.creditCost || 0)}<span className="mt-1 block text-[10px] font-medium text-[#13716e]">{creditBalance.data?.balance?.toLocaleString(locale === 'id' ? 'id-ID' : 'en-US') || 0} {locale === 'id' ? 'kredit tersedia' : 'credits available'}</span></>}</td>
      <td className="px-4 py-4"><Button className="min-h-9 whitespace-nowrap px-3 text-xs" disabled={isTrial === undefined || createOrder.isPending || quote.isLoading || !quote.data} onClick={submit}>{createOrder.isPending ? t('creating') : t('orderNow')}</Button></td>
    </tr>
    {quote.isError && <tr className="border-b border-[#edf2f3]"><td colSpan={8} className="bg-red-50 px-4 py-2 text-xs text-red-700">{country}: {quote.error.message}</td></tr>}
  </>;
}

function StaticResidentialPage() {
  const orders = useListStaticResidentialOrders();
  const identity = useCurrentUser();
  const credit = useCreditBalance();
  const create = useCreateStaticResidentialOrder();
  const extend = useExtendStaticResidentialOrder();
  const exporter = useExportStaticResidentialConnections();
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const [quotaGb, setQuotaGb] = useState<1 | 3 | 5>(5);
  const [extending, setExtending] = useState<StaticResidentialOrder | null>(null);
  const quoteResult = useStaticResidentialQuote(days, quotaGb, { query: { retry: false } });
  const isTrial = Boolean(identity.data?.isTrial);
  const quote = quoteResult;
  const activeStaticOrder = (orders.data || []).find(order => order.status === 'active' && new Date(order.expiresAt) > new Date());
  const refresh = () => { void qc.invalidateQueries({ queryKey: getStaticResidentialOrdersQueryKey() }); void qc.invalidateQueries({ queryKey: ['credit-balance'] }); };
  const download = () => exporter.mutate(undefined, { onSuccess: ({ filename, content, count }) => { if (!count) return window.alert('No active static residential ports are available.'); const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }, onError: error => window.alert(error.message) });
  return <div className="min-h-[100dvh] bg-[#f4f8f8] text-[#142037]"><ClientHeader active="static" /><main className="mx-auto max-w-7xl px-5 py-9 pb-28 lg:px-8 lg:py-12">
    <section className="relative overflow-hidden rounded-[2rem] bg-[#142037] px-6 py-8 text-white md:px-9"><div className="hero-grid absolute inset-0 opacity-20" /><div className="relative flex flex-col justify-between gap-5 md:flex-row md:items-end"><div><Link href="/client" className="mono text-[10px] uppercase tracking-[.18em] text-[#69d5d0] hover:text-white">services / static residential</Link><h1 className="mt-3 text-3xl font-extrabold tracking-[-.05em] md:text-4xl">US Static Residential Proxy</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Each order delivers exactly 5 private SOCKS5 ports. The ports remain stable while their upstream residential endpoint rotates every hour. All 5 ports share the selected traffic quota.</p></div><a href="#checkout" className="inline-flex min-h-10 items-center justify-center rounded-xl bg-[#f46c43] px-4 text-sm font-bold text-white hover:bg-[#df5934]">Order 5 ports <ArrowRight className="ml-2" size={15} /></a></div></section>
    <section className="mt-6 grid gap-4 sm:grid-cols-3"><Metric label="Fixed ports" value="5" detail="Per account order" icon={Network} tone="teal" /><Metric label="Shared traffic" value={`${quotaGb} GB`} detail="Inbound + outbound combined" icon={Gauge} tone="orange" /><Metric label="Upstream rotation" value="1 hour" detail="Public port stays unchanged" icon={RefreshCw} tone="teal" /></section>
    <section id="checkout" className="scroll-mt-24 pt-12"><SectionTitle eyebrow="credit checkout" title="Order static residential access" body="Trial accounts are not eligible. Credit is debited only by the server after capacity is reserved." /><div className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><div className="rounded-3xl border border-[#dbe7e9] bg-white p-6"><p className="mono text-[10px] uppercase tracking-[.16em] text-[#e4643d]">fixed package</p><p className="mt-3 text-2xl font-extrabold">5 ports · {quotaGb}GB shared</p><p className="mt-2 text-sm leading-6 text-slate-500">Choose how many days to keep this order active. Each extension keeps the same five ports and the order’s selected shared quota.</p><label className="mt-5 block text-sm font-bold">Choose shared traffic quota<div className="mt-2 grid grid-cols-3 gap-2">{([1, 3, 5] as const).map(value => <button key={value} type="button" disabled={Boolean(activeStaticOrder)} onClick={() => setQuotaGb(value)} className={cx('min-h-10 rounded-xl border px-3 text-sm font-extrabold transition disabled:cursor-not-allowed disabled:opacity-60', quotaGb === value ? 'border-[#f46c43] bg-[#fff2ed] text-[#d94f2c]' : 'border-[#dbe7e9] text-slate-600 hover:border-[#f46c43]')}>{value} GB</button>)}</div></label><label className="mt-5 block text-sm font-bold">Rental days<select disabled={Boolean(activeStaticOrder)} className="mt-2 block w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60" value={days} onChange={event => setDays(Number(event.target.value))}>{[1, 3, 7, 15, 30].map(value => <option key={value} value={value}>{value} day{value === 1 ? '' : 's'}</option>)}</select></label></div><div className="rounded-3xl bg-white p-6 shadow-[0_10px_35px_rgba(20,32,55,.04)]"><State loading={quote.isLoading} error={quote.isError} onRetry={() => quote.refetch()}><div className="grid gap-4 sm:grid-cols-2"><div><p className="text-xs font-bold text-slate-500">Price per GB / day</p><p className="mt-1 text-lg font-extrabold">${quote.data?.pricePerGbDay.toFixed(4) || '—'}</p></div><div><p className="text-xs font-bold text-slate-500">Total</p><p className="mt-1 text-lg font-extrabold">{quote.data ? `${quote.data.creditCost.toLocaleString()} credits` : '—'}</p></div><div><p className="text-xs font-bold text-slate-500">Available inventory</p><p className="mt-1 text-lg font-extrabold">{quote.data?.availableNodes ?? '—'} upstreams</p></div><div><p className="text-xs font-bold text-slate-500">Your credit balance</p><p className="mt-1 text-lg font-extrabold text-[#13716e]">{(credit.data?.balance || 0).toLocaleString()} cr</p></div></div><Button className="mt-6 w-full" disabled={identity.isLoading || isTrial || Boolean(activeStaticOrder) || create.isPending || !quote.data?.canFulfill || (credit.data?.balance || 0) < (quote.data?.creditCost || Infinity)} onClick={() => create.mutate({ data: { rentalDays: days, quotaGb } }, { onSuccess: refresh, onError: error => window.alert(error.message) })}>{isTrial ? 'Static residential is unavailable for trial accounts' : activeStaticOrder ? `Active order #${activeStaticOrder.id} already exists` : create.isPending ? 'Provisioning…' : 'Pay with credit & create 5 ports'}</Button>{activeStaticOrder ? <p className="mt-3 text-xs font-semibold text-[#b75d12]">You already have an active static residential order. Use Extend on order #{activeStaticOrder.id} to add time.</p> : isTrial ? <p className="mt-3 text-xs font-semibold text-[#b75d12]">Static residential access is available after your account is activated.</p> : quote.data && !quote.data.canFulfill && <p className="mt-3 text-xs font-semibold text-red-600">Five available upstream proxies are required before this order can be created.</p>}</State></div></div></section>
    <section className="scroll-mt-24 pt-14"><SectionTitle eyebrow="my static ports" title="Connection details" body="Only your account SOCKS5 credential is shown. Upstream provider credentials are never returned to the browser." action={<Button variant="outline" disabled={exporter.isPending} onClick={download}><Download size={15} />{exporter.isPending ? 'Preparing…' : 'Download TXT'}</Button>} /><State loading={orders.isLoading} error={orders.isError} onRetry={() => orders.refetch()} empty={!orders.data?.length}><div className="grid gap-5">{orders.data?.map(order => <div key={order.id} className="rounded-3xl border border-[#dbe7e9] bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h2 className="font-extrabold">Order #{order.id}</h2><Badge tone={order.status === 'active' ? 'green' : order.status === 'quota_exceeded' ? 'red' : 'neutral'}>{order.status.replace('_', ' ')}</Badge></div><p className="mt-1 text-sm text-slate-500">Expires {date(order.expiresAt)} · {bytes(order.usedBytes)} / {bytes(order.quotaBytes)} used</p></div><Button variant="outline" className="min-h-9 px-3 text-xs" onClick={() => setExtending(order)}>Extend</Button></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-[#edf2f3]"><div className="h-full rounded-full bg-[#69d5d0]" style={{ width: `${Math.min(100, (order.usedBytes / order.quotaBytes) * 100)}%` }} /></div><div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">{order.nodes.map(node => <StaticResidentialNodeCard key={node.id} node={node} />)}</div></div>)}</div></State></section>
  </main>{extending && <Modal title={`Extend static order #${extending.id}`} onClose={() => setExtending(null)}><p className="text-sm leading-6 text-slate-500">This adds time to your existing five public ports. The shared quota remains {bytes(extending.quotaBytes)}.</p><label className="mt-5 block text-sm font-bold">Additional days<select className="mt-2 block w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" value={days} onChange={event => setDays(Number(event.target.value))}>{[1, 3, 7, 15, 30].map(value => <option key={value} value={value}>{value} day{value === 1 ? '' : 's'}</option>)}</select></label><div className="mt-6 flex gap-3"><Button variant="outline" className="flex-1" onClick={() => setExtending(null)}>Cancel</Button><Button className="flex-1" disabled={extend.isPending} onClick={() => extend.mutate({ id: extending.id, data: { rentalDays: days } }, { onSuccess: () => { setExtending(null); refresh(); }, onError: error => window.alert(error.message) })}>{extend.isPending ? 'Extending…' : 'Pay & extend'}</Button></div></Modal>}</div>;
}

function StaticResidentialNodeCard({ node }: { node: StaticResidentialOrder['nodes'][number] }) {
  const connection = node.connection;
  const value = connection ? `socks5://${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password)}@${connection.host}:${connection.port}` : '';
  return <div className="min-w-0 rounded-2xl border border-[#e1eaec] bg-[#f8fbfb] p-4"><div className="flex items-center justify-between"><p className="mono text-[10px] text-slate-400">PORT {node.port}</p><Badge tone={node.status === 'active' ? 'green' : 'neutral'}>{node.status}</Badge></div><code className="mt-4 block break-all text-[11px] leading-5 text-[#13716e]">{value || 'Unavailable'}</code>{value && <button onClick={() => void navigator.clipboard?.writeText(value)} className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-[#e05c37]"><Copy size={13} /> Copy</button>}<p className="mt-3 text-[10px] text-slate-500">Upstream rotates {time(node.nextRotationAt)}</p></div>;
}

function ClientPortalPage() {
  const { t } = useLocalePreferences();
  const overview = useGetClientOverview();
  const products = useListProducts();
  const identity = useCurrentUser();
  const orders = useListClientOrders();
  const runtimeNodes = useListClientProxyNodes();
  const qc = useQueryClient();
  const recreateAll = useRecreateAllProxyNodes();
  const exportConnections = useExportProxyConnections();
  const extendOrder = useExtendOrder();
  const [extendingOrder, setExtendingOrder] = useState<Order | null>(null);
  const [extensionDays, setExtensionDays] = useState(1);
  const activeOrders = (orders.data || []).filter(order => order.status === 'active' && (!order.expiresAt || new Date(order.expiresAt) > new Date()));
  const activeNodeTotal = activeOrders.reduce((total, order) => total + order.nodeCount, 0);
  const failedOrderIds = new Set((orders.data || []).filter(order => order.status === 'provisioning_failed').map(order => String(order.id)));
  const failedNodeTotal = (runtimeNodes.data || []).filter(node => failedOrderIds.has(String(node.orderId)) && node.status !== 'online' && node.status !== 'terminated' && node.status !== 'terminating').length;
  const recreateNodeTotal = activeNodeTotal + failedNodeTotal;
  const orderById = new Map((orders.data || []).map(order => [String(order.id), order]));
  const visibleNodes = (runtimeNodes.data || []).filter(node => orderById.has(String(node.orderId)) && node.status !== 'terminated');
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
  const requestRecreateAll = () => {
    if (!recreateNodeTotal || recreateAll.isPending) return;
    const message = `Force recreate ${recreateNodeTotal} eligible node${recreateNodeTotal === 1 ? '' : 's'}? Active proxies will be temporarily unavailable and receive a new sandbox/IP. Failed provisioning nodes will be queued again.`;
    if (!window.confirm(message)) return;
    recreateAll.mutate(undefined, {
      onSuccess: result => {
        void qc.invalidateQueries({ queryKey: getListClientProxyNodesQueryKey() });
        void qc.invalidateQueries({ queryKey: getGetClientOverviewQueryKey() });
        window.alert(`Recreation queued for ${result.nodeIds.length} node${result.nodeIds.length === 1 ? '' : 's'}.`);
      },
      onError: error => window.alert(error.message),
    });
  };
  const downloadConnections = () => exportConnections.mutate(undefined, {
    onSuccess: ({ filename, content, count }) => {
      if (!count) return window.alert('No reachable proxy nodes are available to download yet.');
      const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = filename; anchor.click();
      URL.revokeObjectURL(url);
    },
    onError: error => window.alert(error.message),
  });
  const submitExtension = () => {
    if (!extendingOrder) return;
    extendOrder.mutate({ id: extendingOrder.id, data: { rentalDays: extensionDays } }, {
      onSuccess: () => {
        setExtendingOrder(null);
        void qc.invalidateQueries({ queryKey: getListClientOrdersQueryKey() });
        void qc.invalidateQueries({ queryKey: getListClientProxyNodesQueryKey() });
        void qc.invalidateQueries({ queryKey: ['credit-balance'] });
      },
      onError: error => window.alert(error.message),
    });
  };

  return <div className="min-h-[100dvh] bg-[#f4f8f8] text-[#142037]">
    <ClientHeader active="proxy" />

    <main className="mx-auto max-w-7xl px-5 py-9 pb-28 lg:px-8 lg:py-12">
      <section className="relative overflow-hidden rounded-[2rem] bg-[#142037] px-6 py-8 text-white md:px-9"><div className="hero-grid absolute inset-0 opacity-20" /><div className="relative flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><Link href="/client" className="mono text-[10px] uppercase tracking-[.18em] text-[#69d5d0] hover:text-white">{t('services')} / SOCKS5 Proxy</Link><h1 className="mt-3 text-3xl font-extrabold tracking-[-.05em] md:text-4xl">{t('proxyTitle')}</h1><p className="mt-3 max-w-xl text-sm leading-6 text-slate-300">{t('proxyIntro')}</p></div><a href="#catalog" className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-xl bg-[#f46c43] px-4 text-sm font-bold text-white hover:bg-[#df5934]">{t('orderProxy')} <ArrowRight size={15} /></a></div></section>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5"><Metric label={t('activeNodes')} value={String(liveNodeCount)} detail={t('liveStatus')} icon={Network} tone="teal" /><Metric label={t('requestsToday')} value={(overview.data?.requestsToday || 0).toLocaleString()} detail={t('proxyTraffic')} icon={Activity} tone="orange" /><Metric label="Total requests" value={(overview.data?.totalRequests || 0).toLocaleString()} detail="All recorded proxy connections" icon={Gauge} tone="teal" /><Metric label="Total bandwidth" value={bytes(overview.data?.totalBandwidthBytes || 0)} detail="Upload + download" icon={Activity} tone="orange" /><Metric label={t('successRate')} value={`${overview.data?.successRate ?? 100}%`} detail={t('last24Hours')} icon={Signal} tone="teal" /></section>

      <section id="my-services" className="scroll-mt-24 pt-16"><SectionTitle eyebrow="portfolio" title={t('myNodes')} body={t('myNodesBody')} action={<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!visibleNodes.length || exportConnections.isPending} onClick={downloadConnections}><Download size={15} />{exportConnections.isPending ? 'Preparing…' : 'Download'}</Button><Button variant="danger" disabled={!recreateNodeTotal || recreateAll.isPending} onClick={requestRecreateAll} data-testid="button-force-recreate-all-nodes"><RefreshCw size={15} className={recreateAll.isPending ? 'animate-spin' : ''} />{recreateAll.isPending ? t('recreating') : `${t('forceRecreate')} (${recreateNodeTotal})`}</Button></div>} />
        {!!activeOrders.length && <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{activeOrders.map(order => <div key={order.id} className="flex items-center justify-between gap-3 rounded-2xl border border-[#dbe7e9] bg-white px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-bold">Order #{order.id} · {order.nodeCount} nodes</p><p className="mt-1 text-xs text-slate-500">Expires {date(order.expiresAt)}</p></div><Button variant="outline" className="min-h-8 shrink-0 px-3 text-xs" onClick={() => { setExtendingOrder(order); setExtensionDays(1); }}>Extend</Button></div>)}</div>}
        <State loading={orders.isLoading || runtimeNodes.isLoading} error={orders.isError || runtimeNodes.isError} onRetry={() => { void orders.refetch(); void runtimeNodes.refetch(); }} empty={!visibleNodes.length}><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{visibleNodes.map(node => { const order = orderById.get(String(node.orderId))!; return <div key={node.id} className="min-w-0"><div className="mb-1.5 flex items-center justify-between px-0.5"><p className="truncate text-[11px] font-bold text-[#142037]">{order.productName}</p><span className="mono ml-2 shrink-0 text-[8px] uppercase text-slate-400">Order #{order.id} · node {node.id}</span></div><ActiveNodeItem order={order} node={node} /></div>; })}</div></State>
      </section>

      <section id="catalog" className="scroll-mt-24 pt-16"><SectionTitle eyebrow={t('catalog')} title={t('socksByCountry')} body={t('catalogBody')} /><State loading={products.isLoading || identity.isLoading} error={products.isError || identity.isError} onRetry={() => { void products.refetch(); void identity.refetch(); }} empty={!services.length}><div className="overflow-x-auto rounded-3xl border border-[#dbe7e9] bg-white"><table className="min-w-[980px] w-full text-left"><thead className="bg-[#f8fbfb] text-[9px] font-bold uppercase tracking-[.13em] text-slate-400"><tr><th className="px-4 py-3">{t('country')}</th><th className="px-4 py-3">{t('proxyService')}</th><th className="px-4 py-3">{t('priceNode')}</th><th className="px-3 py-3">{t('nodes')}</th><th className="px-3 py-3">{t('days')}</th><th className="px-3 py-3">{t('payment')}</th><th className="px-4 py-3">{t('total')}</th><th className="px-4 py-3">{t('action')}</th></tr></thead><tbody>{services.map(service => <ProxyOrderForm key={service.id} product={service} isTrial={identity.data?.isTrial} />)}</tbody></table></div></State></section>

      <section id="orders" className="scroll-mt-24 pt-16 pb-12"><SectionTitle eyebrow={t('accountHistory')} title={t('recentOrders')} body={t('ordersBody')} /><State loading={orders.isLoading} error={orders.isError} onRetry={() => orders.refetch()} empty={!orders.data?.length}><OrdersTable orders={(orders.data || []).slice(0, 8)} /></State></section>
    </main>
    {extendingOrder && <Modal title={`Extend order #${extendingOrder.id}`} onClose={() => setExtendingOrder(null)}><p className="text-sm leading-6 text-slate-500">Extend all {extendingOrder.nodeCount} current node{extendingOrder.nodeCount === 1 ? '' : 's'} in this order. Payment is charged from your Credit balance.</p><label className="mt-5 block text-sm font-bold">Additional days<select className="mt-2 block w-full rounded-xl border border-[#dbe7e9] bg-[#f8fbfb] px-3 py-3 text-sm" value={extensionDays} onChange={event => setExtensionDays(Number(event.target.value))}>{[1, 3, 7, 15, 30].map(days => <option key={days} value={days}>{days} day{days === 1 ? '' : 's'}</option>)}</select></label><div className="mt-6 flex gap-3"><Button variant="outline" className="flex-1" onClick={() => setExtendingOrder(null)}>Cancel</Button><Button className="flex-1" disabled={extendOrder.isPending} onClick={submitExtension}>{extendOrder.isPending ? 'Extending…' : 'Pay & extend'}</Button></div></Modal>}
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
  if (identity.data?.onboardingStatus !== 'verified') return <Redirect to="/verify-telegram" />;
  if (identity.data?.role === 'admin') return <Redirect to={identity.data.aal === 'aal2' ? '/admin' : '/admin/security'} />;
  return <Redirect to="/client" />;
}

function TurnstileChallenge({ onToken }: { onToken: (token: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef('');
  const siteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY || '').trim();

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !container.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        theme: 'light',
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      });
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-nodenesia-turnstile]');
    if (window.turnstile) render();
    else if (existing) existing.addEventListener('load', render, { once: true });
    else {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.nodenesiaTurnstile = 'true';
      script.addEventListener('load', render, { once: true });
      document.head.appendChild(script);
    }
    return () => {
      cancelled = true;
      existing?.removeEventListener('load', render);
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = '';
    };
  }, [onToken, siteKey]);

  if (!siteKey) return import.meta.env.PROD
    ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">Registration protection is not configured. Contact support.</div>
    : null;
  return <div ref={container} className="min-h-[65px]" />;
}

function AuthPage({ mode = 'sign-in' }: { mode?: 'sign-in' | 'sign-up' }) {
  const { user, loading } = useAuth();
  const isSignup = mode === 'sign-up';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const turnstileRequired = Boolean(String(import.meta.env.VITE_TURNSTILE_SITE_KEY || '').trim()) || import.meta.env.PROD;

  if (!loading && user) return <PostAuthRedirect />;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true); setError(''); setMessage('');
    try {
      if (turnstileRequired && !captchaToken) throw new Error('Complete the security check before continuing.');
      const { data, error: authError } = isSignup
        ? await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: { data: { name: name.trim() }, captchaToken: captchaToken || undefined },
        })
        : await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
          options: { captchaToken: captchaToken || undefined },
        });
      if (authError) throw authError;
      if (isSignup && !data.session) {
        setMessage('Check your inbox and confirm your email. After signing in, Telegram verification is required before dashboard access.');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : isSignup ? 'Registration failed' : 'Authentication failed');
    } finally {
      if (turnstileRequired) {
        setCaptchaToken('');
        setCaptchaAttempt(value => value + 1);
      }
      setPending(false);
    }
  };

  return <div className="grid min-h-[100dvh] place-items-center bg-[#eaf3f3] px-4 py-10"><div className="absolute left-6 top-6"><Logo /></div><div className="w-full max-w-[440px] rounded-3xl bg-white p-7 shadow-xl sm:p-9"><p className="mono text-[10px] uppercase tracking-[.18em] text-[#e4643d]">secure workspace</p><h1 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-[#142037]">{isSignup ? 'Create your account' : 'Welcome back'}</h1><p className="mt-2 text-sm text-slate-500">{isSignup ? 'Confirm your email, then verify Telegram to unlock your workspace and trial credit.' : 'Sign in to your Nodenesia workspace.'}</p><form onSubmit={submit} className="mt-7 grid gap-4">{isSignup && <label className="text-sm font-bold text-[#142037]">Name<input required minLength={2} maxLength={80} autoComplete="name" value={name} onChange={event => setName(event.target.value)} className="mt-2 block w-full rounded-xl border border-[#d9e2e6] bg-[#f3f7f8] px-4 py-3 font-normal outline-none focus:border-[#f46c43]" /></label>}<label className="text-sm font-bold text-[#142037]">Email<input required type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-2 block w-full rounded-xl border border-[#d9e2e6] bg-[#f3f7f8] px-4 py-3 font-normal outline-none focus:border-[#f46c43]" /></label><label className="text-sm font-bold text-[#142037]">Password<input required type="password" minLength={10} autoComplete={isSignup ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} className="mt-2 block w-full rounded-xl border border-[#d9e2e6] bg-[#f3f7f8] px-4 py-3 font-normal outline-none focus:border-[#f46c43]" /></label><TurnstileChallenge key={captchaAttempt} onToken={setCaptchaToken} />{error && <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}{message && <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div>}<Button type="submit" disabled={pending || (turnstileRequired && !captchaToken)} className="mt-1 w-full">{pending ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'}</Button></form><div className="mt-6 border-t border-[#edf2f3] pt-5 text-center"><p className="text-xs leading-5 text-slate-500">{isSignup ? 'Already have an account?' : 'New to Nodenesia?'}</p><Link href={isSignup ? '/sign-in' : '/sign-up'} className="mt-2 inline-flex text-sm font-bold text-[#d95432] hover:text-[#b33f24]">{isSignup ? 'Sign in' : 'Create an account'}</Link><CommunityLinks className="mt-3" /></div></div></div>;
}

function TelegramVerificationPage() {
  const { user, loading, signOut } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const identity = useCurrentUser({ query: { enabled: Boolean(user), refetchInterval: 3_000 } });
  const status = useTelegramVerificationStatus({ query: { enabled: Boolean(user), refetchInterval: 3_000 } });
  const [link, setLink] = useState<{ telegramUrl: string; expiresAt: string } | null>(null);
  const start = useStartTelegramVerification({
    onSuccess: data => {
      if (data.alreadyVerified) {
        qc.setQueryData(getCurrentUserQueryKey(), (current: CurrentUser | undefined) => current ? { ...current, onboardingStatus: 'verified' as const } : current);
        void qc.invalidateQueries({ queryKey: getCurrentUserQueryKey() });
        setLocation('/client');
      } else if (data.telegramUrl && data.expiresAt) setLink({ telegramUrl: data.telegramUrl, expiresAt: data.expiresAt });
    },
  });

  useEffect(() => {
    if (identity.data?.onboardingStatus === 'verified' || status.data?.onboardingStatus === 'verified') {
      qc.setQueryData(getCurrentUserQueryKey(), (current: CurrentUser | undefined) => current ? { ...current, onboardingStatus: 'verified' as const } : current);
      void qc.invalidateQueries({ queryKey: getCurrentUserQueryKey() });
      void qc.invalidateQueries({ queryKey: getTelegramVerificationStatusQueryKey() });
      setLocation('/client');
    }
  }, [identity.data?.onboardingStatus, status.data?.onboardingStatus, qc, setLocation]);

  if (loading || identity.isLoading) return <div className="grid min-h-[100dvh] place-items-center bg-[#eaf3f3]"><RefreshCw className="animate-spin text-[#f46c43]" /></div>;
  if (!user) return <Redirect to="/sign-in" />;
  const error = start.error?.message || (identity.isError || status.isError ? 'Unable to load verification status.' : '');
  return <div className="grid min-h-[100dvh] place-items-center bg-[#eaf3f3] px-4 py-10"><div className="absolute left-6 top-6"><Logo /></div><div className="w-full max-w-lg rounded-3xl bg-white p-7 shadow-xl sm:p-9"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#def5f3] text-[#13716e]"><Send size={22} /></div><p className="mono mt-6 text-[10px] uppercase tracking-[.18em] text-[#e4643d]">account verification</p><h1 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-[#142037]">Verify with Telegram</h1><p className="mt-3 text-sm leading-6 text-slate-500">Your account exists, but proxy, credit and dashboard APIs remain locked until your Telegram membership is verified.</p><div className="mt-6 grid gap-3 rounded-2xl bg-[#f4f8f8] p-4 text-sm text-slate-600"><p><strong className="text-[#142037]">1.</strong> Create a secure one-time verification link.</p><p><strong className="text-[#142037]">2.</strong> Open the bot and join the Nodenesia community.</p><p><strong className="text-[#142037]">3.</strong> Return here; this page checks verification automatically.</p></div>{error && <div className="mt-5 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}{link ? <div className="mt-6"><a href={link.telegramUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#229ED9] px-4 text-sm font-bold text-white hover:bg-[#168ac1]"><Send size={16} /> Continue in Telegram</a><p className="mt-2 text-center text-xs text-slate-400">Link expires {new Date(link.expiresAt).toLocaleTimeString()}</p><Button variant="outline" className="mt-3 w-full" onClick={() => { void identity.refetch(); void status.refetch(); }}><RefreshCw size={15} /> Check verification</Button></div> : <Button className="mt-6 w-full" disabled={start.isPending} onClick={() => start.mutate()}>{start.isPending ? <><RefreshCw size={15} className="animate-spin" /> Preparing…</> : <><Send size={15} /> Connect Telegram</>}</Button>}<button className="mx-auto mt-6 block text-xs font-bold text-slate-500 hover:text-[#142037]" onClick={() => void signOut().then(() => { queryClient.clear(); setLocation('/'); })}>Sign out</button></div></div>;
}

function AuthCacheInvalidator() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => { const id = user?.id ?? null; if (previous.current !== undefined && previous.current !== id) qc.clear(); previous.current = id; }, [user?.id, qc]);
  return null;
}

function SessionProfileValidator() {
  const { user } = useAuth();
  // Validate a restored browser session on every initial app load. This makes
  // an account suspended by an admin sign out immediately after reload.
  useCurrentUser({ query: { enabled: Boolean(user), staleTime: 0, retry: false, refetchOnMount: 'always', refetchOnWindowFocus: false } });
  return null;
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-[100dvh] bg-[#142037]" />;
  return user ? <PostAuthRedirect /> : <Landing />;
}

type ProtectedPage = 'client-dashboard' | 'client-proxy' | 'client-static-residential' | 'admin-security' | 'admin-overview' | 'admin-catalog' | 'admin-info-users' | 'admin-credits' | 'admin-proxy-api-keys' | 'admin-proxy-providers' | 'admin-proxy-orders' | 'admin-proxy-provisioning-logs' | 'admin-proxy-settings' | 'admin-static-residential' | 'admin-settings';

function Protected({ page }: { page: ProtectedPage }) {
  const { user, loading } = useAuth();
  const admin = page.startsWith('admin-');
  const identity = useCurrentUser({ query: { enabled: Boolean(user) } });
  if (loading || (user && identity.isLoading)) return <div className="grid min-h-[100dvh] place-items-center bg-[#f4f8f8]"><RefreshCw className="animate-spin text-[#f46c43]" /></div>;
  if (!user) return <Redirect to="/sign-in" />;
  if (!identity.isError && identity.data?.onboardingStatus !== 'verified') return <Redirect to="/verify-telegram" />;
  if (admin && (identity.isError || identity.data?.role !== 'admin')) return <Redirect to="/client" />;
  if (admin && page !== 'admin-security' && identity.data?.aal !== 'aal2') return <Redirect to="/admin/security" />;
  switch (page) {
    case 'client-dashboard': return <ClientDashboardPage />;
    case 'client-proxy': return <ClientPortalPage />;
    case 'client-static-residential': return <StaticResidentialPage />;
    case 'admin-security': return <SecurityPage />;
    case 'admin-overview': return <AdminOverviewPage />;
    case 'admin-catalog': return <AdminCatalogPage />;
    case 'admin-info-users': return <AdminUsersPage />;
    case 'admin-credits': return <AdminCreditsPage />;
    case 'admin-proxy-api-keys': return <AdminProviderApiKeysPage />;
    case 'admin-proxy-providers': return <AdminProvidersPage />;
    case 'admin-proxy-orders': return <AdminOrdersPage />;
    case 'admin-proxy-provisioning-logs': return <AdminProvisioningLogsPage />;
    case 'admin-proxy-settings': return <AdminProxySettingsPage />;
    case 'admin-static-residential': return <AdminStaticResidentialPage />;
    case 'admin-settings': return <AdminGeneralSettingsPage />;
    default: return <ClientDashboardPage />;
  }
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function RouterViews() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={() => <AuthPage mode="sign-in" />} /><Route path="/sign-up/*?" component={() => <AuthPage mode="sign-up" />} /><Route path="/verify-telegram" component={TelegramVerificationPage} /><Route path="/client/nodes" component={() => <Redirect to="/client/proxy#my-services" />} /><Route path="/client/orders" component={() => <Redirect to="/client/proxy#orders" />} /><Route path="/client/proxy" component={() => <Protected page="client-proxy" />} /><Route path="/client/static-residential" component={() => <Protected page="client-static-residential" />} /><Route path="/client" component={() => <Protected page="client-dashboard" />} /><Route path="/admin/security" component={() => <Protected page="admin-security" />} /><Route path="/admin/users" component={() => <Redirect to="/admin/info/users" />} /><Route path="/admin/credits" component={() => <Protected page="admin-credits" />} /><Route path="/admin/keys" component={() => <Redirect to="/admin/proxy/api-keys" />} /><Route path="/admin/orders" component={() => <Redirect to="/admin/proxy/orders" />} /><Route path="/admin/info/users" component={() => <Protected page="admin-info-users" />} /><Route path="/admin/proxy/api-keys" component={() => <Protected page="admin-proxy-api-keys" />} /><Route path="/admin/proxy/providers" component={() => <Protected page="admin-proxy-providers" />} /><Route path="/admin/proxy/orders" component={() => <Protected page="admin-proxy-orders" />} /><Route path="/admin/proxy/provisioning-logs" component={() => <Protected page="admin-proxy-provisioning-logs" />} /><Route path="/admin/proxy/settings" component={() => <Protected page="admin-proxy-settings" />} /><Route path="/admin/static-residential" component={() => <Protected page="admin-static-residential" />} /><Route path="/admin/settings" component={() => <Protected page="admin-settings" />} /><Route path="/admin/catalog" component={() => <Protected page="admin-catalog" />} /><Route path="/admin" component={() => <Protected page="admin-overview" />} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function App() {
  return <WouterRouter base={basePath}><QueryClientProvider client={queryClient}><AuthProvider><TooltipProvider delayDuration={0}><AuthCacheInvalidator /><SessionProfileValidator /><RouterViews /><Toaster /></TooltipProvider></AuthProvider></QueryClientProvider></WouterRouter>;
}

export default App;
