import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { validate, isString, isNonNegativeNumber, isUUID } from '../middleware/validate.js';
import { slugify } from '../lib/slugify.js';
import { requireCompanyTenant, tenantTable } from '../lib/tenantDb.js';

const products = new Hono();
const createProductSchema = (body) => {
  const errors = [];
  if (!isString(body.sku)) errors.push({ field: 'sku', message: 'SKU is required' });
  if (!isString(body.name)) errors.push({ field: 'name', message: 'Product name is required' });
  if (!isNonNegativeNumber(body.price)) errors.push({ field: 'price', message: 'Price must be a non-negative number' });
  if (body.stockQuantity !== undefined && (!Number.isInteger(body.stockQuantity) || body.stockQuantity < 0)) errors.push({ field: 'stockQuantity', message: 'Stock quantity must be a non-negative integer' });
  if (body.compareAtPrice !== undefined && !isNonNegativeNumber(body.compareAtPrice)) errors.push({ field: 'compareAtPrice', message: 'Compare-at price must be non-negative' });
  if (body.costPrice !== undefined && !isNonNegativeNumber(body.costPrice)) errors.push({ field: 'costPrice', message: 'Cost price must be a non-negative number' });
  if (body.weightGrams !== undefined && (typeof body.weightGrams !== 'number' || body.weightGrams < 0)) errors.push({ field: 'weightGrams', message: 'Weight must be a non-negative integer' });
  if (body.categoryId && !isUUID(body.categoryId)) errors.push({ field: 'categoryId', message: 'Category ID must be a valid UUID' });
  return { valid: errors.length === 0, errors };
};
const productStatuses = ['draft', 'pending', 'active', 'archived'];
const updateProductStatusSchema = (body) => {
  const errors = !isString(body.status) || !productStatuses.includes(body.status)
    ? [{ field: 'status', message: `Status must be one of: ${productStatuses.join(', ')}` }] : [];
  return { valid: errors.length === 0, errors };
};
const updateProductSchema = (body) => {
  const errors = [];
  if (body.price !== undefined && !isNonNegativeNumber(body.price)) errors.push({ field: 'price', message: 'Price must be a non-negative number' });
  if (body.stockQuantity !== undefined && (!Number.isInteger(body.stockQuantity) || body.stockQuantity < 0)) errors.push({ field: 'stockQuantity', message: 'Stock quantity must be a non-negative integer' });
  if (body.name !== undefined && typeof body.name !== 'string') errors.push({ field: 'name', message: 'Name must be a string' });
  return { valid: errors.length === 0, errors };
};

// POST /api/companies/:companyId/products — every product is created pending moderation.
products.post('/:companyId/products', authMiddleware, validate(createProductSchema), async (c) => {
  const body = c.get('body'); const user = c.get('user'); const companyId = c.req.param('companyId'); const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;
  const categoryTable = tenantTable(tenant.schema, 'categories');
  const productTable = tenantTable(tenant.schema, 'products');

  if (body.categoryId) {
    const [category] = await db.query(
      `SELECT id FROM ${categoryTable} WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [body.categoryId, companyId]
    );
    if (!category) return errorResponse('Category not found in this company', 400);
  }

  try {
    const [product] = await db.query(
      `INSERT INTO ${productTable} (
        company_id, category_id, sku, name, slug, description, short_description, status,
        price, compare_at_price, cost_price, currency, weight_grams, brand, seller_name,
        trusted_seller, free_shipping, is_featured, is_flash_deal, badge, metadata, stock_quantity
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20::jsonb, $21
      ) RETURNING *`,
      [companyId, body.categoryId || null, body.sku, body.name,
        `${slugify(body.name)}-${Date.now().toString(36)}`, body.description || null,
        body.shortDescription || null, body.price, body.compareAtPrice ?? null,
        body.costPrice ?? null, body.currency || 'EGP', body.weightGrams ?? null,
        body.brand || null, body.sellerName || null, body.trustedSeller || false,
        body.freeShipping || false, body.isFeatured || false, body.isFlashDeal || false,
        body.badge || null, JSON.stringify(body.metadata || {}), body.stockQuantity ?? 0]
    );
    return jsonResponse(created(product, 'Product created — pending admin approval'), 201);
  } catch (error) {
    if (error.code === '23505') return errorResponse('A product with this SKU already exists in your company', 409);
    throw error;
  }
});

// GET /api/companies/:companyId/products
products.get('/:companyId/products', authMiddleware, async (c) => {
  const user = c.get('user'); const companyId = c.req.param('companyId'); const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = (page - 1) * limit; const status = c.req.query('status') || null;
  const table = tenantTable(tenant.schema, 'products');
  const rows = await db.query(
    `SELECT *, count(*) OVER()::int AS _total FROM ${table}
     WHERE company_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [companyId, status, limit, offset]
  );
  const total = rows.length ? rows[0]._total : 0;
  return jsonResponse(ok({ items: rows.map(({ _total, ...product }) => product), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 } }));
});

// GET /api/companies/:companyId/products/:productId
products.get('/:companyId/products/:productId', authMiddleware, async (c) => {
  const user = c.get('user'); const companyId = c.req.param('companyId'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;
  const [product] = await db.query(
    `SELECT * FROM ${tenantTable(tenant.schema, 'products')} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [productId, companyId]
  );
  if (!product) return errorResponse('Product not found', 404);
  return jsonResponse(ok(product));
});

// PUT /api/companies/:companyId/products/:productId
products.put('/:companyId/products/:productId', authMiddleware, validate(updateProductSchema), async (c) => {
  const body = c.get('body'); const user = c.get('user'); const companyId = c.req.param('companyId'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;
  const [product] = await db.query(
    `UPDATE ${tenantTable(tenant.schema, 'products')} SET
      name = COALESCE($1, name), description = COALESCE($2, description),
      short_description = COALESCE($3, short_description), price = COALESCE($4, price),
      compare_at_price = COALESCE($5, compare_at_price), cost_price = COALESCE($6, cost_price),
      weight_grams = COALESCE($7, weight_grams), brand = COALESCE($8, brand),
      seller_name = COALESCE($9, seller_name), trusted_seller = COALESCE($10, trusted_seller),
      free_shipping = COALESCE($11, free_shipping), is_featured = COALESCE($12, is_featured),
      is_flash_deal = COALESCE($13, is_flash_deal), badge = COALESCE($14, badge),
      metadata = COALESCE($15::jsonb, metadata), stock_quantity = COALESCE($16, stock_quantity), updated_at = now()
     WHERE id = $17 AND company_id = $18 RETURNING *`,
    [body.name ?? null, body.description ?? null, body.shortDescription ?? null,
      body.price ?? null, body.compareAtPrice ?? null, body.costPrice ?? null,
      body.weightGrams ?? null, body.brand ?? null, body.sellerName ?? null,
      body.trustedSeller ?? null, body.freeShipping ?? null, body.isFeatured ?? null,
      body.isFlashDeal ?? null, body.badge ?? null,
      body.metadata === undefined ? null : JSON.stringify(body.metadata), body.stockQuantity ?? null, productId, companyId]
  );
  if (!product) return errorResponse('Product not found', 404);
  return jsonResponse(ok(product, 'Product updated successfully'));
});

// DELETE /api/companies/:companyId/products/:productId
products.delete('/:companyId/products/:productId', authMiddleware, async (c) => {
  const user = c.get('user'); const companyId = c.req.param('companyId'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;
  const rows = await db.query(
    `DELETE FROM ${tenantTable(tenant.schema, 'products')} WHERE id = $1 AND company_id = $2 RETURNING id`,
    [productId, companyId]
  );
  if (!rows.length) return errorResponse('Product not found', 404);
  return jsonResponse(ok(null, 'Product deleted successfully'));
});

// Admin product moderation routes. Status changes are applied to each tenant's product table.
products.get('/admin/products/pending', authMiddleware, requireAdmin, async (c) => {
  const status = c.req.query('status') || 'pending';
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = (page - 1) * limit; const db = createDb(c.env);
  const tenants = await db`SELECT tenant_schema_name FROM public.companies ORDER BY created_at DESC`;
  if (!tenants.length) return jsonResponse(ok({ items: [], pagination: { page, limit, total: 0, totalPages: 0 } }));
  const union = tenants.map(({ tenant_schema_name }) =>
    `SELECT * FROM ${tenantTable(tenant_schema_name, 'products')}`
  ).join(' UNION ALL ');
  const rows = await db.query(
    `WITH tenant_products AS (${union})
     SELECT p.*, c.display_name AS company_name, count(*) OVER()::int AS _total
     FROM tenant_products p
     LEFT JOIN public.companies c ON c.id = p.company_id
     WHERE p.status = $1
     ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );
  const total = rows.length ? rows[0]._total : 0;
  return jsonResponse(ok({ items: rows.map(({ _total, ...product }) => product), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 } }));
});

products.patch('/admin/products/:productId/status', authMiddleware, requireAdmin, validate(updateProductStatusSchema), async (c) => {
  const { status } = c.get('body'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const tenants = await db`SELECT tenant_schema_name FROM public.companies ORDER BY created_at DESC`;
  for (const { tenant_schema_name } of tenants) {
    const [product] = await db.query(
      `UPDATE ${tenantTable(tenant_schema_name, 'products')}
       SET status = $1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [status, productId]
    );
    if (product) return jsonResponse(ok(product, `Product status updated to ${status}`));
  }
  return errorResponse('Product not found', 404);
});

export default products;
