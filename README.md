# Proxy Node

Vite/React storefront and dashboard backed by NestJS and Supabase Auth/Postgres. The catalog is intentionally product-agnostic (`products`, `plans`, `resources`) so another hosted service can be added without redesigning orders, usage, or administration.

## Local setup

1. Create a Supabase project and run the SQL files in `supabase/migrations` in filename order, then run `supabase/seed.sql` (or use `supabase db push` and `supabase db reset` with the CLI). If the old Clerk schema was already deployed, run `202608130002_supabase_auth.sql` to upgrade it.
2. In Supabase Authentication, enable the Email provider, then disable **Allow new users to sign up**. Accounts are provisioned only by admins through `/admin/users`; Supabase Admin API bypasses the public-signup setting and auto-confirms each created email.
3. Copy `.env.example` to `.env` and fill in the Supabase publishable and secret keys.
4. Create the first account in Supabase Authentication, copy its immutable Auth user UUID, then explicitly promote that bound profile: `update public.profiles set role = 'admin' where auth_user_id = '<AUTH_USER_UUID>';`. Never bootstrap admin access from an email allowlist.
5. Visit `/client/security`, enroll TOTP, verify the current session, and set `ADMIN_REQUIRE_MFA=true` before exposing admin routes.
6. Replace the placeholder `resources.secrets` values from the seed with the real proxy endpoint credentials.
7. Run `npm install`, then `npm run dev`. Web runs on `http://localhost:5173`; Nest runs on `http://localhost:3001/api`.

The Supabase secret key is server-only and must never use a `VITE_` prefix. Browser requests go through Nest; all exposed tables have RLS enabled and direct `anon`/`authenticated` grants revoked.

## Useful commands

```bash
npm run dev
npm run typecheck
npm run build
```

Health check: `GET /api/health`. Public catalog endpoints are `GET /api/catalog/plans` and `GET /api/catalog/resources`; all other endpoints require a Supabase access token. Admin endpoints additionally require `profiles.role = 'admin'`.

Public registration is intentionally unavailable. `/sign-up` redirects to `/sign-in`. An admin creates a customer with name, email, and a temporary password from the Users page and communicates those credentials securely to the customer.

Migration `202608140007_security_hardening.sql` must be applied after the provisioning migration. It removes email profile takeover, expires pending reservations after 30 minutes, limits each profile to three pending order groups, reserves resources throughout provisioning, prevents duplicate live tunnel endpoints, enforces provider concurrency in Postgres, and adds renewable provisioning leases.

Migration `202608140008_dynamic_proxy_allocation.sql` removes static resource allocation from proxy checkout. Creating an order records only product, node count, rental duration, price, and payment state. A `proxy_nodes` row, provider capacity lease, and unique tunnel endpoint are created only after an administrator approves that individual node order. Configure `GOST_PUBLIC_HOST` and the `GOST_TUNNEL_PORT_MIN`/`GOST_TUNNEL_PORT_MAX` pool for the master VPS.

`worker/app.js` is retained only as reference material and now refuses to start unless `ALLOW_LEGACY_WORKER=true` is explicitly supplied to the process. It is not part of the supported production runtime.

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
