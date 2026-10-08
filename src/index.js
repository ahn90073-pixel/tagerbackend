import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import authRoutes from './routes/auth.js';
import companyRoutes from './routes/companies.js';
import productRoutes from './routes/products.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

const app = new Hono();

// ---- Middleware ----
app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// ---- Health check ----
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- API routes ----
app.route('/api/auth', authRoutes);
app.route('/api/companies', companyRoutes);
app.route('/api/companies', productRoutes);

// ---- 404 + error handler (must be last) ----
app.notFound(notFound);
app.onError(errorHandler);

// ---- Cloudflare Workers entry point ----
export default {
  port: 3000,
  fetch: app.fetch,
};
