import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { validate, isString, isNonNegativeNumber, isUUID } from '../middleware/validate.js';
import { slugify } from '../lib/slugify.js';

const products = new Hono();
const createProductSchema = (body) => {
  const errors = [];
  if (!isString(body.sku)) errors.push({ field: 'sku', message: 'SKU is required' });
  if (!isString(body.name)) errors.push({ field: 'name', message: 'Product name is required' });
  if (!isNonNegativeNumber(body.price)) errors.push({ field: 'price', message: 'Price must be a non-negative number' });
  if (body.compareAtPrice !== undefined && !isNonNegativeNumber(body.compareAtPrice)) errors.push({ field: 'compareAtPrice', message: 'Compare-at price must be non-negative' });
  if (body.costPrice !== undefined && !isNonNegativeNumber(body.costPrice)) errors.push({ field: 'costPrice', message: 'Cost price must be non-negative' });
  if (body.weightGrams !== undefined && (typeof body.weightGrams !== 'number' || body.weightGrams < 0)) errors.push({ field: 'weightGrams', message: 'Weight must be a non-negative integer' });
  if (body.categoryId && !isUUID(body.categoryId)) errors.push({ field: 'categoryId', message: 'Category ID must be a valid UUID' });
  return { valid: errors.length === 0, errors };
};
const updateProductStatusSchema = (body) => {
  const validStatuses = ['draft', 'pending', 'active', 'archived'];
  const errors = !isString(body.status) || !validStatuses.includes(body.status)
    ? [{ field: 'status', message: 'Status must be one of: draft, pending, active, archived' }] : [];
  return { valid: errors.length === 0, errors };
};
const updateProductSchema = (body) => {
  const errors = [];
  if (body.price !== undefined && !isNonNegativeNumber(body.price)) errors.push({ field: 'price', message: 'Price must be a non-negative number' });
  if (body.name !== undefined && typeof body.name !== 'string') errors.push({ field: 'name', message: 'Name must be a string' });
  return { valid: errors.length === 0, errors };
};

async function assertMember(db, companyId, userId) {
  const [member] = await db`SELECT role, is_active FROM company_members WHERE company_id = ${companyId} AND user_id = ${userId} LIMIT 1`;
  if (!member) return errorResponse('You do not have access to this company', 403);
  if (!member.is_active) return errorResponse('Your membership to this company is inactive', 403);
  return null;
}

// POST /api/companies/:companyId/products — inserted directly into Neon.
products.post('/:companyId/products', authMiddleware, validate(createProductSchema), async (c) => {
  const body = c.get('body'); const user = c.get('user'); const companyId = c.req.param('companyId'); const db = createDb(c.env);
  const memberError = await assertMember(db, companyId, user.id); if (memberError) return memberError;
  if (body.categoryId) {
    const [category] = await db`SELECT id FROM categories WHERE id = ${body.categoryId} AND company_id = ${companyId} LIMIT 1`;
    if (!category) return errorResponse('Category not found in this company', 400);
  }
  try {
    const [product] = await db`
      INSERT INTO products (
        company_id, category_id, sku, name, slug, description, short_description, status,
        price, compare_at_price, cost_price, currency, weight_grams, brand, seller_name,
        trusted_seller, free_shipping, is_featured, is_flash_deal, badge, metadata
      ) VALUES (
        ${companyId}, ${body.categoryId || null}, ${body.sku}, ${body.name}, ${slugify(body.name) + '-' + Date.now().toString(36)},
        ${body.description || null}, ${body.shortDescription || null}, 'pending',
        ${body.price}, ${body.compareAtPrice ?? null}, ${body.costPrice ?? null}, ${body.currency || 'EGP'},
        ${body.weightGrams ?? null}, ${body.brand || null}, ${body.sellerName || null},
        ${body.trustedSeller || false}, ${body.freeShipping || false}, ${body.isFeatured || false},
        ${body.isFlashDeal || false}, ${body.badge || null}, ${JSON.stringify(body.metadata || {})}::jsonb
      ) RETURNING *
    `;
    return jsonResponse(created(product, 'Product created — pending admin approval'), 201);
  } catch (error) {
    if (error.code === '23505') return errorResponse('A product with this SKU already exists in your company', 409);
    throw error;
  }
});

// GET /api/companies/:companyId/products
products.get('/:companyId/products', authMiddleware, async (c) => {
  const user = c.get('user'); const companyId = c.req.param('companyId'); const db = createDb(c.env);
  const memberError = await assertMember(db, companyId, user.id); if (memberError) return memberError;
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = (page - 1) * limit; const status = c.req.query('status');
  const rows = status
    ? await db`SELECT *, count(*) OVER()::int AS _total FROM products WHERE company_id = ${companyId} AND status = ${status} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
    : await db`SELECT *, count(*) OVER()::int AS _total FROM products WHERE company_id = ${companyId} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const total = rows.length ? rows[0]._total : 0;
  return jsonResponse(ok({ items: rows.map(({ _total, ...product }) => product), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 } }));
});

// GET /api/companies/:companyId/products/:productId
products.get('/:companyId/products/:productId', authMiddleware, async (c) => {
  const user = c.get('user'); const companyId = c.req.param('companyId'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const memberError = await assertMember(db, companyId, user.id); if (memberError) return memberError;
  const [product] = await db`SELECT * FROM products WHERE id = ${productId} AND company_id = ${companyId} LIMIT 1`;
  if (!product) return errorResponse('Product not found', 404);
  return jsonResponse(ok(product));
});

// PUT /api/companies/:companyId/products/:productId
products.put('/:companyId/products/:productId', authMiddleware, validate(updateProductSchema), async (c) => {
  const body = c.get('body'); const user = c.get('user'); const companyId = c.req.param('companyId'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const memberError = await assertMember(db, companyId, user.id); if (memberError) return memberError;
  const [product] = await db`
    UPDATE products SET
      name = COALESCE(${body.name ?? null}, name), description = COALESCE(${body.description ?? null}, description),
      short_description = COALESCE(${body.shortDescription ?? null}, short_description), price = COALESCE(${body.price ?? null}, price),
      compare_at_price = COALESCE(${body.compareAtPrice ?? null}, compare_at_price), cost_price = COALESCE(${body.costPrice ?? null}, cost_price),
      weight_grams = COALESCE(${body.weightGrams ?? null}, weight_grams), brand = COALESCE(${body.brand ?? null}, brand),
      seller_name = COALESCE(${body.sellerName ?? null}, seller_name), trusted_seller = COALESCE(${body.trustedSeller ?? null}, trusted_seller),
      free_shipping = COALESCE(${body.freeShipping ?? null}, free_shipping), is_featured = COALESCE(${body.isFeatured ?? null}, is_featured),
      is_flash_deal = COALESCE(${body.isFlashDeal ?? null}, is_flash_deal), badge = COALESCE(${body.badge ?? null}, badge),
      metadata = COALESCE(${body.metadata === undefined ? null : JSON.stringify(body.metadata)}::jsonb, metadata), updated_at = now()
    WHERE id = ${productId} AND company_id = ${companyId} RETURNING *
  `;
  if (!product) return errorResponse('Product not found', 404);
  return jsonResponse(ok(product, 'Product updated successfully'));
});

// DELETE /api/companies/:companyId/products/:productId
products.delete('/:companyId/products/:productId', authMiddleware, async (c) => {
  const user = c.get('user'); const companyId = c.req.param('companyId'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const memberError = await assertMember(db, companyId, user.id); if (memberError) return memberError;
  const rows = await db`DELETE FROM products WHERE id = ${productId} AND company_id = ${companyId} RETURNING id`;
  if (!rows.length) return errorResponse('Product not found', 404);
  return jsonResponse(ok(null, 'Product deleted successfully'));
});

// Admin product moderation routes.
products.get('/admin/products/pending', authMiddleware, requireAdmin, async (c) => {
  const status = c.req.query('status') || 'pending'; const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10))); const offset = (page - 1) * limit; const db = createDb(c.env);
  const [countRow] = await db`SELECT count(*)::int AS total FROM products WHERE status = ${status}`;
  const items = await db`SELECT p.*, c.display_name AS company_name FROM products p LEFT JOIN companies c ON c.id = p.company_id WHERE p.status = ${status} ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const total = countRow?.total || 0;
  return jsonResponse(ok({ items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 } }));
});

products.patch('/admin/products/:productId/status', authMiddleware, requireAdmin, validate(updateProductStatusSchema), async (c) => {
  const { status } = c.get('body'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const [product] = await db`UPDATE products SET status = ${status}, updated_at = now() WHERE id = ${productId} RETURNING *`;
  if (!product) return errorResponse('Product not found', 404);
  return jsonResponse(ok(product, `Product status updated to ${status}`));
});

export default products;
