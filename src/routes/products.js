import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { validate, isString, isNonNegativeNumber, isUUID } from '../middleware/validate.js';
import { slugify } from '../lib/slugify.js';

const products = new Hono();

// ---- Validation schemas ----

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
  const errors = [];
  const validStatuses = ['draft', 'pending', 'active', 'archived'];
  if (!isString(body.status) || !validStatuses.includes(body.status)) {
    errors.push({ field: 'status', message: 'Status must be one of: draft, pending, active, archived' });
  }
  return { valid: errors.length === 0, errors };
};

const updateProductSchema = (body) => {
  const errors = [];
  if (body.price !== undefined && !isNonNegativeNumber(body.price)) errors.push({ field: 'price', message: 'Price must be a non-negative number' });
  if (body.name !== undefined && typeof body.name !== 'string') errors.push({ field: 'name', message: 'Name must be a string' });
  return { valid: errors.length === 0, errors };
};

// ---- Helper: verify company membership ----

async function assertMember(supabase, companyId, userId) {
  const { data: membership } = await supabase
    .from('company_members')
    .select('role, is_active')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!membership) {
    return { error: errorResponse('You do not have access to this company', 403), membership: null };
  }
  if (!membership.is_active) {
    return { error: errorResponse('Your membership to this company is inactive', 403), membership: null };
  }
  return { error: null, membership };
}

// ---- Company-scoped product routes ----

/**
 * POST /api/companies/:companyId/products
 * Adds a product to a company. Status is automatically set to 'pending'
 * (awaiting admin approval).
 */
products.post('/:companyId/products', authMiddleware, validate(createProductSchema), async (c) => {
  const body = c.get('body');
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const supabase = createSupabaseClient(c.env);

  const { error: memberError } = await assertMember(supabase, companyId, user.id);
  if (memberError) return memberError;

  // Verify category belongs to this company
  if (body.categoryId) {
    const { data: cat } = await supabase
      .from('categories')
      .select('id')
      .eq('id', body.categoryId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (!cat) {
      return errorResponse('Category not found in this company', 400);
    }
  }

  // Check SKU uniqueness within company
  const { data: skuCheck } = await supabase
    .from('products')
    .select('id')
    .eq('company_id', companyId)
    .eq('sku', body.sku)
    .maybeSingle();

  if (skuCheck) {
    return errorResponse('A product with this SKU already exists in your company', 409);
  }

  const slug = slugify(body.name) + '-' + Date.now().toString(36);

  // Insert product with status = 'pending'
  const { data: product, error: insertError } = await supabase
    .from('products')
    .insert({
      company_id: companyId,
      category_id: body.categoryId || null,
      sku: body.sku,
      name: body.name,
      slug,
      description: body.description || null,
      short_description: body.shortDescription || null,
      status: 'pending', // Auto-pending — awaiting admin approval
      price: body.price,
      compare_at_price: body.compareAtPrice || null,
      cost_price: body.costPrice || null,
      currency: body.currency || 'EGP',
      weight_grams: body.weightGrams || null,
      brand: body.brand || null,
      seller_name: body.sellerName || null,
      trusted_seller: body.trustedSeller || false,
      free_shipping: body.freeShipping || false,
      is_featured: body.isFeatured || false,
      is_flash_deal: body.isFlashDeal || false,
      badge: body.badge || null,
      metadata: body.metadata || {},
    })
    .select('*')
    .single();

  if (insertError) {
    return errorResponse(insertError.message, 500);
  }

  return jsonResponse(created(product, 'Product created — pending admin approval'), 201);
});

/**
 * GET /api/companies/:companyId/products
 * Lists products for a company with optional status filter and pagination.
 */
products.get('/:companyId/products', authMiddleware, async (c) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const status = c.req.query('status');
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = (page - 1) * limit;
  const supabase = createSupabaseClient(c.env);

  const { error: memberError } = await assertMember(supabase, companyId, user.id);
  if (memberError) return memberError;

  let query = supabase
    .from('products')
    .select('*', { count: 'exact' })
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    query = query.eq('status', status);
  }

  const { data: items, count, error: queryError } = await query;

  if (queryError) {
    return errorResponse(queryError.message, 500);
  }

  return jsonResponse(ok({
    items: items || [],
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit) || 0,
    },
  }));
});

/**
 * GET /api/companies/:companyId/products/:productId
 * Gets a single product with its images.
 */
products.get('/:companyId/products/:productId', authMiddleware, async (c) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const productId = c.req.param('productId');
  const supabase = createSupabaseClient(c.env);

  const { error: memberError } = await assertMember(supabase, companyId, user.id);
  if (memberError) return memberError;

  const { data: product, error: queryError } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (queryError) {
    return errorResponse(queryError.message, 500);
  }

  if (!product) {
    return errorResponse('Product not found', 404);
  }

  return jsonResponse(ok(product));
});

/**
 * PUT /api/companies/:companyId/products/:productId
 * Updates product fields (non-status).
 */
products.put('/:companyId/products/:productId', authMiddleware, validate(updateProductSchema), async (c) => {
  const body = c.get('body');
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const productId = c.req.param('productId');
  const supabase = createSupabaseClient(c.env);

  const { error: memberError } = await assertMember(supabase, companyId, user.id);
  if (memberError) return memberError;

  const allowedFields = [
    'name', 'description', 'short_description', 'price',
    'compare_at_price', 'cost_price', 'weight_grams', 'brand',
    'seller_name', 'trusted_seller', 'free_shipping', 'is_featured',
    'is_flash_deal', 'badge', 'metadata',
  ];

  const updates = {};
  for (const [key, value] of Object.entries(body)) {
    const snakeKey = key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
    if (allowedFields.includes(snakeKey)) {
      updates[snakeKey] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse('No valid fields to update', 400);
  }

  const { data: product, error: updateError } = await supabase
    .from('products')
    .update(updates)
    .eq('id', productId)
    .eq('company_id', companyId)
    .select('*')
    .maybeSingle();

  if (updateError) {
    return errorResponse(updateError.message, 500);
  }

  if (!product) {
    return errorResponse('Product not found', 404);
  }

  return jsonResponse(ok(product, 'Product updated successfully'));
});

/**
 * DELETE /api/companies/:companyId/products/:productId
 * Deletes a product.
 */
products.delete('/:companyId/products/:productId', authMiddleware, async (c) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const productId = c.req.param('productId');
  const supabase = createSupabaseClient(c.env);

  const { error: memberError } = await assertMember(supabase, companyId, user.id);
  if (memberError) return memberError;

  const { error: deleteError } = await supabase
    .from('products')
    .delete()
    .eq('id', productId)
    .eq('company_id', companyId);

  if (deleteError) {
    return errorResponse(deleteError.message, 500);
  }

  return jsonResponse(ok(null, 'Product deleted successfully'));
});

// ---- Platform-admin approval routes ----

/**
 * GET /api/companies/admin/products/pending
 * Lists all products across all companies with the given status.
 * Platform admin only. Optional ?status=pending&page=1&limit=20
 */
products.get('/admin/products/pending', authMiddleware, requireAdmin, async (c) => {
  const status = c.req.query('status') || 'pending';
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = (page - 1) * limit;
  const supabase = createSupabaseClient(c.env);

  const { data: items, error: itemsError } = await supabase.rpc('get_pending_products', {
    p_status: status,
    p_limit: limit,
    p_offset: offset,
  });

  if (itemsError) {
    return errorResponse(itemsError.message, 500);
  }

  const { data: total, error: countError } = await supabase.rpc('count_pending_products', {
    p_status: status,
  });

  if (countError) {
    return errorResponse(countError.message, 500);
  }

  const totalCount = parseInt(total || '0', 10);

  return jsonResponse(ok({
    items: items || [],
    pagination: {
      page,
      limit,
      total: totalCount,
      totalPages: Math.ceil(totalCount / limit) || 0,
    },
  }));
});

/**
 * PATCH /api/companies/admin/products/:productId/status
 * Approves or rejects a product by setting its status.
 * Platform admin only. Body: { status: 'active' | 'pending' | 'draft' | 'archived' }
 */
products.patch('/admin/products/:productId/status', authMiddleware, requireAdmin, validate(updateProductStatusSchema), async (c) => {
  const body = c.get('body');
  const user = c.get('user');
  const productId = c.req.param('productId');
  const supabase = createSupabaseClient(c.env);

  const { data: product, error: rpcError } = await supabase.rpc('update_product_status', {
    p_product_id: productId,
    p_new_status: body.status,
    p_admin_user_id: user.id,
  });

  if (rpcError) {
    return errorResponse(rpcError.message, 500);
  }

  if (!product) {
    return errorResponse('Product not found', 404);
  }

  return jsonResponse(ok(product, `Product status updated to ${body.status}`));
});

export default products;
