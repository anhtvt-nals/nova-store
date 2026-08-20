# Proxy Node

Vite/React storefront and dashboard backed by NestJS and Supabase Auth/Postgres. The catalog is intentionally product-agnostic (`products`, `plans`, `resources`) so another hosted service can be added without redesigning orders, usage, or administration.

## Local setup

1. Create a Supabase project and run the SQL files in `supabase/migrations` in filename order, then run `supabase/seed.sql` (or use `supabase db push` and `supabase db reset` with the CLI). If the old Clerk schema was already deployed, run `202608130002_supabase_auth.sql` to upgrade it.
2. In Supabase Authentication, enable Email signup, require email confirmation, and enable Cloudflare Turnstile under **Bot and Abuse Protection**. The frontend passes the Turnstile token to Supabase; all new profiles remain Telegram-pending until verification.
3. Copy `.env.example` to `.env` and fill in the Supabase publishable and secret keys.
4. Create the first account in Supabase Authentication, copy its immutable Auth user UUID, then explicitly promote that bound profile: `update public.profiles set role = 'admin' where auth_user_id = '<AUTH_USER_UUID>';`. Never bootstrap admin access from an email allowlist.
5. Visit `/client/security`, enroll TOTP, verify the current session, and set `ADMIN_REQUIRE_MFA=true` before exposing admin routes.
6. Replace the placeholder `resources.secrets` values from the seed with the real proxy endpoint credentials.
7. Run `npm install`, then `npm run dev`. Web runs on `http://localhost:5173`; Nest runs on `http://localhost:3001/api`.

The Supabase secret key is server-only and must never use a `VITE_` prefix. Browser requests go through Nest; all exposed tables have RLS enabled and direct `anon`/`authenticated` grants revoked.

Browser sessions are capped at three days by `VITE_SESSION_MAX_AGE_DAYS=3`. For matching server-side enforcement, set the Supabase Auth session timebox to `259200` seconds (three days). On every page load, the app validates `/auth/me`; a profile suspended by an administrator receives `401`, clears its local session, and returns to sign-in.

## Useful commands

```bash
npm run dev
npm run typecheck
npm run build
```

Health check: `GET /api/health`. Public catalog endpoints are `GET /api/catalog/plans` and `GET /api/catalog/resources`; all other endpoints require a Supabase access token. Admin endpoints additionally require `profiles.role = 'admin'`.

### Per-node rotation URL

Each active SOCKS5 node has an icon to copy its unique signed rotation URL. It
is a direct **GET** URL, so call it with `curl '<copied-url>'`. The URL contains
no proxy credentials, works only
while the corresponding order is active, changes after an extension, and is
rate-limited to six calls per minute per source IP. Set a distinct
`PROXY_ROTATION_URL_SECRET` of at least 32 random characters; the existing
proxy encryption secret is used only as a backward-compatible fallback. Treat
the URL as a password: link previews and anyone who obtains it can trigger a rotation.

### NodeOps CreateOS sandbox + GOST test

This one-off test does not use the database or create an order. It creates one
CreateOS sandbox, installs GOST, opens a reverse SOCKS5 tunnel on port `39996`,
authenticates the SOCKS5 endpoint from the machine running the test, prints the
connection string and proxy egress IP, then keeps the sandbox running. Configure the
`NODEOPS_*` WSS values in `.env` (dedicated tunnel credentials are recommended),
then run:

```bash
NODEOPS_TEST_API_KEY='your-createos-api-key' npm run test:nodeops-gost
```

Press Ctrl+C to destroy the sandbox and release the test port. On errors it also
destroys the sandbox; set `NODEOPS_TEST_KEEP_ON_FAILURE=true` only for manual
diagnostics.

### Namespace Labs instance + GOST test

This one-off test uses the official `@namespacelabs/cloud` TypeScript SDK. It
does not touch the database: it preflights the supplied Namespace bearer token,
creates one Linux instance with a one-hour deadline from the official public
`gogost/gost:3.2.6` image, starts GOST without runtime package installation or
binary download, verifies the reverse SOCKS5 tunnel from the master, prints
the SOCKS5 connection string and egress IP, then remains live until Ctrl+C.

The script calls `WaitInstanceSync` as a bounded, non-blocking diagnostic, but
starts SOCKS5 reachability checks immediately after `CreateInstance`. The
actual success criterion is a SOCKS5 authentication handshake, not a delayed
control-plane ready signal. Configure `NAMESPACE_*` and the dedicated WSS
tunnel values in `.env`, then pass the short-lived token only to the command:

```bash
NAMESPACE_TEST_TOKEN='your-namespace-tenant-token' npm run test:namespace-gost
```

For compatibility with the official Namespace example, `NSC_TOKEN` is also
accepted; inside a Namespace workload, `NSC_TOKEN_FILE` is accepted when it
contains a JSON `bearer_token`. No Namespace CLI is used by this script.

`NAMESPACE_REGION` accepts one region or a `|`-separated candidate list, such
as `us|eu`; one region is selected randomly for each new sandbox/test run. By
default the test sends the matching hard placement constraint
`NAMESPACE_PLACEMENT=continent:<selected-region>` (for example,
`continent:eu`); this prevents Namespace from silently placing an EU request
in US capacity. Supply `NAMESPACE_PLACEMENT` as an ordered `|`-separated list
such as `site:zrh|continent:eu` only when Namespace has confirmed those site
names for the workspace.

The Namespace token must grant `instance:create`, `instance:get`,
`instance:list`, `instance:wait`, and `instance:destroy`. Add
`instance/o11y/logs:get` to include startup diagnostics.

Ctrl+C/SIGTERM calls Namespace `destroyInstance`, retries transient API errors,
and polls until the instance is removed (up to
`NAMESPACE_CLEANUP_TIMEOUT_MS`, default 90 seconds). If that cleanup cannot
run, the instance still terminates at `NAMESPACE_INSTANCE_DURATION_SECONDS`
(default one hour). Development tokens often expire within 24 hours; this test
performs a read-only SDK preflight before it creates billable compute, so an
expired token fails without creating an instance. Set
`NAMESPACE_TEST_KEEP_ON_FAILURE=true` only to retain an instance for diagnostics
until its deadline.

## Proxy usage telemetry

Apply `202608160041_proxy_usage_observer.sql`, then configure a public HTTPS callback for sandbox observers:

```env
PROXY_USAGE_OBSERVER_URL=https://nodenesia.id/api/internal/proxy-usage
PROXY_USAGE_OBSERVER_SECRET=<a new random secret of at least 32 characters>
```

Newly provisioned E2B, Runloop, and Blaxel nodes run a local GOST handler observer every five seconds. The observer reports cumulative connection and byte counters through a node-scoped HMAC URL; Nest accepts only valid tokens and stores the positive delta atomically, so retries do not double-count. Existing nodes must be recreated/rotated once after deployment before they begin reporting.

### Telegram-gated registration

Apply `202608180001_telegram_onboarding.sql`,
`202608180002_integrated_telegram_bot.sql`, and
`202608180003_harden_telegram_onboarding.sql` before deploying this code. Also
apply `202608180004_fix_rate_limit_bucket_ambiguity.sql` so persistent
Telegram/order rate limits work on PostgreSQL without ambiguous column
references. The
migration marks every existing profile as verified, so current users are not
interrupted. Profiles created afterwards default to `telegram_pending`, receive
an empty credit wallet, and may call only `/api/auth/me` plus the Telegram
start/status endpoints. All business APIs return `403
TELEGRAM_VERIFICATION_REQUIRED` until verification succeeds.

Configure the Nodenesia API:

```env
VITE_TURNSTILE_SITE_KEY=<Cloudflare Turnstile site key>
TELEGRAM_BOT_TOKEN=<BotFather token>
TELEGRAM_BOT_USERNAME=NodenesiaVerifyBot
TELEGRAM_GROUP_ID=-1001234567890
TELEGRAM_GROUP_JOIN_URL=https://t.me/+your-private-invite
TELEGRAM_WEBHOOK_BASE_URL=https://nodenesia.id
TELEGRAM_WEBHOOK_PATH_SECRET=<random URL-safe 32+ character secret>
TELEGRAM_WEBHOOK_HEADER_SECRET=<different random 32+ character secret>
TELEGRAM_LINK_TOKEN_TTL_SECONDS=600
```

Add the bot as an administrator in the target Telegram group. Nodenesia stores
only SHA-256 hashes of ten-minute deep-link tokens. The webhook binds `/start`
to the Telegram sender, verifies membership with `getChatMember` or a
`chat_member` update, prevents Telegram/profile reuse in PostgreSQL, changes
onboarding to `verified`, and grants the configured trial credit atomically. It
does not automatically create a proxy order.

The hardening migration also returns a verified profile to
`telegram_pending` when Telegram sends a `left` or `kicked` membership update.
The same Telegram account can verify again after rejoining, but the immutable
credit ledger prevents a second trial grant. Keep `chat_member` in the webhook's
allowed updates and keep the bot as a group administrator.

After the API is publicly reachable, register and inspect the webhook:

```bash
npm run telegram:webhook:setup
```

The command verifies `TELEGRAM_BOT_USERNAME` against the BotFather token and
registers `message`, `chat_member`, and `callback_query` updates at
`https://nodenesia.id/api/telegram/webhook/<path-secret>` without printing the
secret URL. Enable **Confirm Email** and Cloudflare Turnstile under Supabase
Authentication > Bot and Abuse Protection before enabling public signup. The
same Turnstile challenge is sent for both sign-up and password sign-in; frontend
validation alone is not a security boundary. Set the Supabase Auth session
timebox to `259200` seconds so the three-day lifetime is enforced server-side.

Migration `202608140007_security_hardening.sql` must be applied after the provisioning migration. It removes email profile takeover, expires pending reservations after 30 minutes, limits each profile to three pending order groups, reserves resources throughout provisioning, prevents duplicate live tunnel endpoints, enforces provider concurrency in Postgres, and adds renewable provisioning leases.

Migration `202608140008_dynamic_proxy_allocation.sql` removes static resource allocation from proxy checkout. Creating an order records only product, node count, rental duration, price, and payment state. A `proxy_nodes` row, provider capacity lease, and unique tunnel endpoint are created only after an administrator approves that individual node order. Configure `GOST_PUBLIC_HOST` and the `GOST_TUNNEL_PORT_MIN`/`GOST_TUNNEL_PORT_MAX` pool for the master VPS.

Migration `202608170007_dynamic_provider_api_key_capacity.sql` makes active provider API-key limits the allocatable sandbox capacity. Set **Max sandboxes for this key** when adding or editing each key (for example, `10`); use the `∞` action on a Provider to remove its aggregate cap, or retain a Provider max only when an explicit cross-key safety ceiling is required. Replacement slots remain reserved across the provider key pool.

Apply `202608170009_balance_provider_capacity_by_utilization.sql` to distribute new reservations across providers and API keys with the same priority by their live utilization ratio. Provider priority remains an explicit override through `proxy_providers.metadata.priority` (lower runs first); with the default equal priority, E2B and GitHub are balanced instead of selecting the oldest provider repeatedly. GitHub nodes use the dedicated `GITHUB_GOST_*` WSS tunnel settings.

To recover from an E2B account-cap incident, stop `nodenesia-api`, apply migrations `202608170007` and `202608170008`, then preview the destructive reset with `npm run reset:e2b-runtime`. The command deletes every sandbox visible to every configured E2B credential, sets each active E2B key to a safe limit (default `10`), releases stale E2B leases, and queues active E2B nodes for replacement. Run the confirmation command printed by the preview only after reviewing its summary.

### US Static Residential Proxy

The static-residential module is isolated from sandbox proxy provisioning. Each non-trial order receives exactly five stable public SOCKS5 ports, shares a selected 1GB, 3GB, or 5GB total traffic quota, and swaps each hidden upstream SOCKS5 endpoint every hour. End users only receive their Nodenesia credential and the master hostname; imported upstream credentials are encrypted and never sent to a client.

Before enabling checkout, install the separate pinned GOST v3.2.6 control plane on the master VPS and keep its API loopback-only:

```bash
sudo STATIC_GOST_VERSION=3.2.6 STATIC_GOST_API_ADDR=127.0.0.1:18081 STATIC_GOST_METRICS_ADDR=127.0.0.1:19000 \
  bash scripts/install-gost-static-master.sh
```

Set `STATIC_RESIDENTIAL_ENABLED=true`, `STATIC_GOST_API_ADDR=127.0.0.1:18081`, `STATIC_GOST_METRICS_ADDR=127.0.0.1:19000`, `STATIC_GOST_USAGE_POLL_MS=1000`, and `STATIC_RESIDENTIAL_HEALTH_FAILURE_THRESHOLD=2` in the API environment. Open only the public static range `10000:20000` in the VPS firewall; do not expose ports `18081` or `19000`. In Admin → Static residential, set the USD/GB/day price and import one `socks5://user:pass@host:port` URL per line. At least five available upstreams are required to create an order. The health-check button verifies SOCKS5 username/password and a real egress `CONNECT`; an upstream is disabled only after the configured number of consecutive failures, and can be explicitly re-enabled by an admin.

The installer pins GOST `3.2.6`, creates an unprivileged `nodenesia-gost` user, and configures a conservative 5MB/s per-port bandwidth limit plus connection and request limits. Nest samples GOST's private Prometheus counters once per second and disables an order at its 5GB soft cap. This is intentionally a bounded soft limit: active connections can consume a small amount after the final sample. Imported upstream hostnames are resolved once and stored as validated public IP literals; loopback, private, link-local, multicast, and DNS-rebinding targets are rejected.

`worker/app.js` is retained only as reference material and now refuses to start unless `ALLOW_LEGACY_WORKER=true` is explicitly supplied to the process. It is not part of the supported production runtime.

## Sumopod Credit top-ups

Apply migrations `202608190010_sumopod_credit_topups.sql` through
`202608190012_remove_sumopod_topup_ceiling.sql`, then configure the values
from `.env.example`. In the Sumopod project settings, set the webhook
URL to:

```text
https://your-domain/api/payments/sumopod/webhook
```

Use the project's **Svix signing secret** (`whsec_...`) for
`SUMOPOD_WEBHOOK_SECRET`. Nodenesia requires the signed raw webhook body and
accepts `payment.completed`, `payment.failed`, and `payment.expired` events.
The `X-Webhook-Token` fallback is accepted only in sandbox mode. Production
requires the Svix headers and signature; do not configure a browser-accessible
API key or use the return URL as payment confirmation.

For real payments configure:

```dotenv
SUMOPOD_ENABLED=true
SUMOPOD_MODE=production
SUMOPOD_CUSTOMER_TOPUPS_ENABLED=true
SUMOPOD_API_BASE_URL=https://api-pay.sumopod.com/api/v1
SUMOPOD_API_KEY=live-api-key-from-sumopod
SUMOPOD_WEBHOOK_SECRET=whsec_live-signing-secret
SUMOPOD_WEBHOOK_TOKEN=
```

The API refuses a production mode/endpoint mismatch. It creates the invoice
before calling SumoPod and exposes only the hosted payment URL to the browser.
A completed payment is accepted only when its signed event, merchant order ID,
payment ID, gross amount, fee/net settlement (when supplied), and currency
match the server-created invoice. For the live QRIS surcharge model, Credit is
calculated from the server-created invoice amount; the gateway fee is paid in
addition by the customer and does not reduce Credit. The database locks the invoice and records a
unique ledger reference, so webhook retries cannot add Credit twice.

Before enabling customer top-ups, activate the required payment method in the
Sumopod live merchant dashboard. The current checkout uses the live QRIS code
`qris`; a `400 ... payment_method_type_code is not active` response means that
code is not activated for the merchant, not that the customer payment failed.

## Adding another service

Add a `products` row, its `plans`, and service capacity/endpoints in `resources`. Product-specific behavior belongs in JSON `config`/`capabilities` or a new provisioning adapter; the shared order, payment approval, user, API-key, and usage model stays unchanged.

## Digital catalog administration

Run `202608130003_digital_catalog.sql`, then open `/admin/catalog`. Admins can create and edit categories and products, classify a product as `account`, `digital`, `service`, or `other`, choose automatic/manual/service fulfillment, set base price, stock, SKU, image, featured state, and publication state. Existing SOCKS5 products are migrated into the **Services** category automatically.

Catalog stock is metadata only at this stage. Do not put account passwords, license keys, or download secrets in product descriptions/config; individual sellable credentials need a separate encrypted inventory and fulfillment flow.

## Proxy node/day pricing

Run `202608140001_proxy_node_day_pricing.sql`. For products whose `service_type` is `proxy`, **Base price** in `/admin/catalog` is the price for one node for one day. Customers choose node quantity and rental days; Nest/Postgres calculate the authoritative total and allocate currently free resources atomically. The create-order API does not accept an amount from the browser.

Run `202608140002_product_based_proxy_orders.sql` after it. Proxy quote/create requests use `productId` directly and do not accept or resolve a `planId`; new proxy orders have a direct `orders.product_id` relation and a nullable `plan_id`.

## Modular admin

Run `202608140004_admin_modules.sql` to add proxy providers, provider-scoped API keys, and general settings. Admin routes are grouped under Dashboard, Info, Proxy, and System. Set `PROVIDER_SECRET_ENCRYPTION_KEY` to at least 32 random characters before saving a provider API key; provider secrets are encrypted with AES-256-GCM and API responses only contain a masked value.

Run `202608140003_proxy_product_country.sql` to add `products.country_code`. Each proxy product represents one orderable country row in the client table; set its two-letter ISO country code in `/admin/catalog`.
