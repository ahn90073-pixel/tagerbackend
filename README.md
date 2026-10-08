# سوق اون لين — Marketplace Backend

A lightweight, multi-tenant marketplace backend built with **Node.js + Express + PostgreSQL**. Designed for easy deployment to free-tier cloud platforms (Render, Railway).

## Features

- **Authentication** — Register & Login with bcrypt password hashing and JWT tokens
- **Multi-tenant company setup** — Each company gets an isolated PostgreSQL schema (`tenant_<uuid>`) with filtered views, provisioned automatically via database functions
- **Product management** — Add products per company; new products are automatically set to `pending` status
- **Admin approval workflow** — Platform admins can approve/reject products by updating their status
- **Clean architecture** — Controllers, Routes, Services, Middleware separation
- **Input validation** — `express-validator` on all endpoints
- **Error handling** — Centralized error middleware with structured JSON responses
- **Security** — Helmet headers, CORS, bcrypt, JWT

## Project Structure

```
src/
├── config/
│   ├── env.js          # Environment variable loader with validation
│   └── db.js           # PostgreSQL connection pool
├── controllers/
│   ├── authController.js
│   ├── companyController.js
│   └── productController.js
├── middleware/
│   ├── auth.js          # JWT authentication + admin guard
│   ├── validate.js      # express-validator error collector
│   └── errorHandler.js  # Centralized error handler + 404
├── routes/
│   ├── authRoutes.js
│   └── companyRoutes.js
├── services/
│   ├── authService.js
│   ├── companyService.js
│   └── productService.js
├── utils/
│   ├── ApiResponse.js   # Standard JSON response helpers
│   ├── AppError.js      # Custom error classes
│   └── slugify.js
├── app.js               # Express app setup
└── server.js            # Entry point
```

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account (bcrypt-hashed password) |
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
| GET | `/api/companies/admin/products/pending` | List pending products across all companies |
| PATCH | `/api/companies/admin/products/:productId/status` | Approve/reject product (platform admin only) |

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require
JWT_SECRET=your-long-random-secret-string
JWT_EXPIRES_IN=7d
CORS_ORIGIN=*
```

## Local Development

```bash
npm install
npm run dev
```

The server starts on `http://localhost:3000`. Health check at `/health`.

## Database Schema

The schema uses a **shared tables + company_id** multi-tenant model. All data lives in the `app` schema. Each company also gets a private `tenant_<uuid>` namespace with filtered views for that company's data.

Key tables: `companies`, `users`, `company_members`, `products`, `categories`, `orders`, `customers`, `inventory`, `coupons`, `reviews`, and more.

Product status flow: `pending` → `active` (after admin approval) or `archived`.

## Deployment

### Render (free tier)

1. Create a new **Web Service** on [render.com](https://render.com)
2. Connect your repository
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables (DATABASE_URL, JWT_SECRET, etc.)
6. Add a PostgreSQL database (Render Postgres free tier) and link it

### Railway (free tier)

1. Create a new project on [railway.app](https://railway.app)
2. Add a PostgreSQL plugin
3. Deploy from GitHub repo
4. Set environment variables in the Railway dashboard
5. Railway auto-detects `npm start`

### Important

- Set `JWT_SECRET` to a long, random string in production
- Set `NODE_ENV=production` for SSL and security headers
- Set `CORS_ORIGIN` to your frontend URL (not `*` in production)
- Never expose `DATABASE_URL` or `JWT_SECRET` to the browser
