# سوق اون لاين — Marketplace API

Multi-tenant marketplace API built with Hono on Cloudflare Workers. **All application database reads and writes use Neon PostgreSQL directly through `@neondatabase/serverless`; this project does not use or contact Supabase.**

## Database setup (Neon)

1. Create or select the Neon PostgreSQL database that will store the Tager API data.
2. Apply the initial schema once from the Neon SQL Editor, or with `psql`:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_initial.sql
   ```

   The migration uses `CREATE ... IF NOT EXISTS` and does not drop or overwrite data. It is for a fresh Neon schema; it does not copy accounts or other records from the former Supabase database.
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
