# سوق اون لين — Marketplace API on Cloudflare Workers

A lightweight, multi-tenant marketplace API built with **Hono** and deployed on **Cloudflare Workers**. Uses Supabase (PostgreSQL) as the database via the PostgREST API — no TCP database driver needed, fully Edge-compatible.

## Features

- **Authentication** — Register & Login with `bcryptjs` (Edge-compatible bcrypt) and JWT tokens via Web Crypto API
- **Multi-tenant company setup** — Each company gets an isolated PostgreSQL schema (`tenant_<uuid>`) with filtered views, provisioned automatically via database functions
- **Product management** — Add products per company; new products are automatically set to `pending` status
- **Admin approval workflow** — Platform admins can approve/reject products by updating their status
- **Clean architecture** — Routes, middleware, and library modules with clear separation
- **Input validation** — Custom validation middleware on all endpoints
- **Error handling** — Centralized error handler with structured JSON responses
- **Edge-compatible** — No Node.js `fs`, `path`, or TCP dependencies. Uses `bcryptjs` instead of `bcrypt`, Web Crypto JWT instead of `jsonwebtoken`

## Project Structure

```
src/
├── index.js              # Cloudflare Workers entry point (Hono app)
├── lib/
│   ├── supabase.js       # Supabase client factory (PostgREST)
│   ├── jwt.js            # JWT sign/verify via Web Crypto API
│   ├── response.js       # Standard JSON response helpers
│   └── slugify.js        # URL slug generator
├── middleware/
│   ├── auth.js           # JWT authentication + admin guard
│   ├── validate.js       # Input validation middleware
│   └── errorHandler.js   # Global error handler + 404
└── routes/
    ├── auth.js           # Register, Login, Profile endpoints
    ├── companies.js      # Company CRUD + tenant schema provisioning
    └── products.js       # Product CRUD + admin approval
wrangler.toml             # Cloudflare Workers config
.dev.vars.example         # Local dev secrets template
```

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account (bcryptjs-hashed password) |
| POST | `/api/auth/login` | Login → returns JWT |
| GET | `/api/auth/me` | Get profile + companies (auth required) |
| GET | `/api/auth/me/companies` | List user's companies (auth required) |

### Companies

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/companies` | Create company + tenant schema (auth required) |
| GET | `/api/companies` | List user's companies (auth required) |
| GET | `/api/companies/:companyId` | Get company details (auth + member) |

### Products

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/companies/:companyId/products` | Add product (auto-set to `pending`) |
| GET | `/api/companies/:companyId/products` | List products (filter by `?status=`) |
| GET | `/api/companies/:companyId/products/:productId` | Get single product |
| PUT | `/api/companies/:companyId/products/:productId` | Update product fields |
| DELETE | `/api/companies/:companyId/products/:productId` | Delete product |

### Admin Approval

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/companies/admin/products/pending` | List pending products (platform admin) |
| PATCH | `/api/companies/admin/products/:productId/status` | Approve/reject product (platform admin) |

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Copy `.dev.vars.example` to `.dev.vars` and fill in your secrets:
```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your JWT_SECRET and SUPABASE_SERVICE_ROLE_KEY
```

3. Start the dev server:
```bash
npm run dev
```

The server runs on `http://localhost:3000`. Health check at `/health`.

## Deployment

### Prerequisites
- Install Wrangler: `npm install -g wrangler` (or use `npx wrangler`)
- Authenticate: `wrangler login`

### Set Secrets

Never put real secrets in `wrangler.toml`. Set them as Workers secrets:

```bash
wrangler secret put JWT_SECRET
# Paste your long random secret string

wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# Paste your Supabase service role key
```

### Deploy

```bash
npm run deploy
```

This runs `wrangler deploy` which bundles the code and pushes it to Cloudflare's edge network. Your API will be available at `https://souq-online-api.<your-subdomain>.workers.dev`.

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `SUPABASE_URL` | `wrangler.toml` [vars] | Supabase project URL |
| `SUPABASE_ANON_KEY` | `wrangler.toml` [vars] | Supabase anon key |
| `JWT_SECRET` | `wrangler secret put` | Secret for signing JWT tokens |
| `SUPABASE_SERVICE_ROLE_KEY` | `wrangler secret put` | Supabase service role key (bypasses RLS) |

## Why Cloudflare Workers + Hono?

- **Edge runtime**: Runs in 300+ locations worldwide, auto-scales, no cold starts
- **No TCP needed**: Uses Supabase REST API (PostgREST) instead of raw PostgreSQL connections
- **bcryptjs**: Pure JS bcrypt implementation that works on V8/Workers (unlike native `bcrypt`)
- **Web Crypto JWT**: Uses Hono's built-in JWT utils backed by the Web Crypto API
- **Free tier**: 100,000 requests/day on Cloudflare Workers free plan

## Database Schema

All data lives in the `app` schema with a shared-tables + `company_id` multi-tenant model. Each company gets a private `tenant_<uuid>` namespace with filtered views. Product status flow: `pending` → `active` (after admin approval) or `archived`.
