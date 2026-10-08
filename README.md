# سوق اون لاين — Marketplace API

Multi-tenant marketplace API built with Hono on Cloudflare Workers. **All application database reads and writes use Neon PostgreSQL directly through `@neondatabase/serverless`; this project does not use or contact Supabase.**

## Database setup (Neon)

1. Create or select the Neon PostgreSQL database that will store the Tager API data.
2. Apply database migrations in order from the Neon SQL Editor, or with `psql`:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_initial.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0002_tenant_schemas.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0003_tenant_data_tables.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0004_storefront_checkout.sql
   ```

   These migrations are additive and repeatable; they do not drop existing data. They do not copy accounts or other records from the former Supabase database.
3. Set the Worker secrets (do not put them in `wrangler.toml` or commit real values):

   ```bash
   npx wrangler secret put DATABASE_URL
   npx wrangler secret put JWT_SECRET
   ```

   Paste the Neon connection string only into Wrangler's secure prompt. For local development, copy `.dev.vars.example` to `.dev.vars` and set local-only values.
4. Deploy the Worker:

   ```bash
   npm install
   npm run deploy
   ```

The deployed Worker name is `tagerbackend`; health check: `/health`.

## Automatic deployment with GitHub Actions

`.github/workflows/deploy-cloudflare-worker.yml` deploys this Worker after each push or merge to `main`. It installs dependencies, builds the Worker, applies the Neon schema migrations, deploys using Cloudflare's official Wrangler Action, then checks the public `/health` endpoint. Manual dispatch is also available, but the workflow only deploys when the selected ref is `main`.

Before enabling the workflow, add these repository **Actions secrets** in GitHub (`Settings → Secrets and variables → Actions`):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token scoped to the target account with Workers Scripts edit permission. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID hosting the `tagerbackend` Worker. |
| `DATABASE_URL` | The Neon PostgreSQL connection string. The workflow sets this as a Cloudflare Worker secret on each deployment. |

GitHub Actions passes the masked `DATABASE_URL` secret to `psql` to apply migrations `0001_initial.sql` through `0004_storefront_checkout.sql` before deployment, then to Wrangler to create or update the Worker runtime secret with the same name. User identities, companies, and memberships remain in `public` for authentication; tenant business data is stored in real per-company schemas. `0003_tenant_data_tables.sql` converts the earlier tenant views into tables, migrates existing categories/products, and provisions tables for product media/variants, inventory, customers/addresses, carts, orders/items, payments, shipments, coupons, reviews, wishlists, device tokens, notifications, and audit logs. Legacy `public.categories` and `public.products` rows are retained as a rollback copy; application reads and writes use the tenant tables. New products are always `pending`; the platform-admin moderation API can change them to `active` after approval. `0004_storefront_checkout.sql` adds an atomic public checkout function: it rechecks prices/stock in the database, reserves stock, and creates a separate pending order and shipment in each seller schema. `JWT_SECRET` remains configured on the Worker and is not changed by this workflow. Never place connection strings or Cloudflare tokens in committed workflow files.

> Existing users and records remain untouched in the old database but are not visible to this Neon-backed API. If those records are needed, migrate them to Neon before switching traffic. Do not delete the old database as part of this code change.

## API routes

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Create user and password hash directly in Neon; returns a JWT |
| POST | `/api/auth/login` | Verify credentials against Neon and return a JWT |
| GET | `/api/auth/me` | Authenticated profile and companies |
| GET | `/api/auth/me/companies` | List authenticated user's companies |

### Companies

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/companies` | Create company and owner membership atomically in Neon |
| GET | `/api/companies` | List companies for the authenticated user |
| GET | `/api/companies/:companyId` | Get member-accessible company details |

### Products

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/companies/:companyId/products` | Create product (initial status `pending`) |
| GET | `/api/companies/:companyId/products` | List products with optional `status`, `page`, `limit` |
| GET | `/api/companies/:companyId/products/:productId` | Get one product |
| PUT | `/api/companies/:companyId/products/:productId` | Update product fields |
| DELETE | `/api/companies/:companyId/products/:productId` | Delete a product |
| GET | `/api/companies/admin/products/pending` | List products by status (platform admin) |
| PATCH | `/api/companies/admin/products/:productId/status` | Change product status (platform admin) |

All protected routes require `Authorization: Bearer <JWT>`.

### Public storefront

These two routes are deliberately public so the consumer app can browse and check out without a customer account. Prices and stock are read from each active seller's tenant schema; checkout trusts no browser-supplied price and creates one pending order per seller.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/storefront/products?page=1&limit=100&q=&category=` | Public catalog of active products across active companies. |
| POST | `/api/storefront/checkout` | Guest checkout with `{ customer, address, items: [{ vendorId, productId, quantity }], customerNote? }`; creates per-vendor orders and atomically reserves inventory. |

The public checkout defaults to cash on delivery. It does not charge a payment method or connect to a shipping carrier. Mange administrators can review the order details and record vendor/shipping instructions separately.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
# Fill local Neon connection string and JWT secret in .dev.vars
npm run dev
```

## Configuration

- `DATABASE_URL`: Neon PostgreSQL connection string, set as a Cloudflare Worker secret.
- `JWT_SECRET`: JWT signing secret, set as a Cloudflare Worker secret.

No Supabase URL, key, client, SDK, or REST endpoint is used by the application.
