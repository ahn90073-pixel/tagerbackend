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
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0005_firebase_google_merchant_auth.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0006_company_profile.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0007_company_profile_document_blobs.sql
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
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token scoped to the target account with Workers Scripts edit and the `Workers KV Storage Write` permission group. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID hosting the `tagerbackend` Worker. |
| `DATABASE_URL` | The Neon PostgreSQL connection string. The workflow sets this as a Cloudflare Worker secret on each deployment. |
| `JWT_SECRET` | A high-entropy secret used to sign API session tokens. The workflow sets it as a Cloudflare Worker secret on each deployment. |

GitHub Actions passes the masked `DATABASE_URL` secret to `psql` to apply migrations `0001_initial.sql` through `0007_company_profile_document_blobs.sql` before deployment. It then sets both `DATABASE_URL` and `JWT_SECRET` as Worker secrets during deployment.

The Worker binds the production KV namespace `tager-company-kyc-files`. Its `previews` configuration binds a separate namespace, `tager-company-kyc-files-preview`, so branch previews cannot write KYC files into production. Neon is the source of truth: each document's bytes are saved as `BYTEA` in `public.company_profile_document_blobs`, linked by `document_id` to the company's document metadata. Uploads commit to Neon first, then write an optional KV mirror. Downloads read Neon first; legacy documents without a Neon blob can be fetched from KV and lazily copied into Neon. Missing KV data therefore does not affect downloads once the Neon copy exists. The profile API restricts KYC documents and payout/tax details to active company owners and admins.

Each PDF/JPEG/PNG upload is capped at 10 MiB. Neon storage grows by approximately the size of the files retained in the company profile. KV remains an additional mirror and accepts values up to 25 MiB; its cross-location propagation may take 60 seconds or more, but downloads use Neon as the primary copy. The Free plan includes 1 GB stored data, 100,000 reads/day, 1,000 writes/day, and 1,000 deletes/day. Paid-plan usage above included allowances is billed as described in [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/). See [KV limits](https://developers.cloudflare.com/kv/platform/limits/) and [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

User identities, companies, and memberships remain in `public` for authentication; tenant business data is stored in real per-company schemas. `0003_tenant_data_tables.sql` converts the earlier tenant views into tables, migrates existing categories/products, and provisions tables for product media/variants, inventory, customers/addresses, carts, orders/items, payments, shipments, coupons, reviews, wishlists, device tokens, notifications, and audit logs. Legacy `public.categories` and `public.products` rows are retained as a rollback copy; application reads and writes use the tenant tables. New products are always `pending`; the platform-admin moderation API can change them to `active` after approval. `0004_storefront_checkout.sql` adds an atomic public checkout function: it rechecks prices/stock in the database, reserves stock, and creates a separate pending order and shipment in each seller schema. Never place connection strings or Cloudflare tokens in committed workflow files.

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
| GET | `/api/companies/:companyId/profile` | Read private profile and completion status (active owner/admin only) |
| PUT | `/api/companies/:companyId/profile` | Save profile fields; omitted values remain unchanged |
| POST | `/api/companies/:companyId/profile/documents/:documentType` | Save a PDF/JPEG/PNG document in Neon and mirror it to KV when available (10 MiB limit) |
| GET | `/api/companies/:companyId/profile/documents/:documentType` | Download from Neon, with a KV fallback/backfill for legacy records (active owner/admin only) |

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
