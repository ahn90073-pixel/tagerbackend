import { query } from '../config/db.js';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/AppError.js';
import { assertCompanyMember } from './companyService.js';
import { slugify } from '../utils/slugify.js';

/**
 * Creates a new product for a company.
 * Status is automatically set to 'pending' (awaiting admin approval).
 */
export async function createProduct(companyId, userId, productData) {
  await assertCompanyMember(companyId, userId);

  const {
    categoryId,
    sku,
    name,
    description,
    shortDescription,
    price,
    compareAtPrice,
    costPrice,
    currency = 'EGP',
    weightGrams,
    brand,
    sellerName,
    trustedSeller = false,
    freeShipping = false,
    isFeatured = false,
    isFlashDeal = false,
    badge,
    metadata = {},
  } = productData;

  if (!sku || !name) {
    throw new BadRequestError('SKU and name are required');
  }

  const slug = slugify(name) + '-' + Date.now().toString(36);

  // If category provided, verify it belongs to this company
  if (categoryId) {
    const catCheck = await query(
      'SELECT id FROM app.categories WHERE id = $1 AND company_id = $2',
      [categoryId, companyId]
    );
    if (catCheck.rows.length === 0) {
      throw new BadRequestError('Category not found in this company');
    }
  }

  // Check SKU uniqueness within company
  const skuCheck = await query(
    'SELECT id FROM app.products WHERE company_id = $1 AND sku = $2',
    [companyId, sku]
  );
  if (skuCheck.rows.length > 0) {
    throw new BadRequestError('A product with this SKU already exists in your company');
  }

  const result = await query(
    `INSERT INTO app.products
      (company_id, category_id, sku, name, slug, description, short_description,
       status, price, compare_at_price, cost_price, currency, weight_grams,
       brand, seller_name, trusted_seller, free_shipping, is_featured,
       is_flash_deal, badge, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING *`,
    [
      companyId,
      categoryId || null,
      sku,
      name,
      slug,
      description || null,
      shortDescription || null,
      price,
      compareAtPrice || null,
      costPrice || null,
      currency,
      weightGrams || null,
      brand || null,
      sellerName || null,
      trustedSeller,
      freeShipping,
      isFeatured,
      isFlashDeal,
      badge || null,
      JSON.stringify(metadata),
    ]
  );

  return result.rows[0];
}

/**
 * Lists products for a company with optional status filter and pagination.
 */
export async function listProducts(companyId, userId, { status, page = 1, limit = 20 } = {}) {
  await assertCompanyMember(companyId, userId);

  const offset = (page - 1) * limit;
  const params = [companyId];
  let statusFilter = '';

  if (status) {
    params.push(status);
    statusFilter = `AND status = $${params.length}`;
  }

  const countResult = await query(
    `SELECT COUNT(*) as total FROM app.products WHERE company_id = $1 ${statusFilter}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT id, company_id, category_id, sku, name, slug, description,
            short_description, status, price, compare_at_price, cost_price,
            currency, brand, seller_name, trusted_seller, free_shipping,
            is_featured, is_flash_deal, badge, rating, review_count,
            published_at, created_at, updated_at
     FROM app.products
     WHERE company_id = $1 ${statusFilter}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: result.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    },
  };
}

/**
 * Fetches a single product by ID within a company.
 */
export async function getProductById(companyId, userId, productId) {
  await assertCompanyMember(companyId, userId);

  const result = await query(
    `SELECT p.*, 
       (SELECT json_agg(row_to_json(pi)) FROM app.product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order) AS images
     FROM app.products p
     WHERE p.id = $1 AND p.company_id = $2`,
    [productId, companyId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Product not found');
  }

  return result.rows[0];
}

/**
 * Updates a product's status. Only platform admins can approve/reject products.
 */
export async function updateProductStatus(productId, newStatus, userId, isPlatformAdmin) {
  if (!isPlatformAdmin) {
    throw new ForbiddenError('Only platform administrators can approve or reject products');
  }

  const validStatuses = ['draft', 'pending', 'active', 'archived'];
  if (!validStatuses.includes(newStatus)) {
    throw new BadRequestError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
  }

  const result = await query(
    `UPDATE app.products
     SET status = $1,
         published_at = CASE WHEN $1 = 'active' THEN now() ELSE published_at END
     WHERE id = $2
     RETURNING *`,
    [newStatus, productId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Product not found');
  }

  await query(
    `INSERT INTO app.audit_logs (user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'product_status_change', 'product', $2, $3)`,
    [userId, productId, JSON.stringify({ newStatus })]
  );

  return result.rows[0];
}

/**
 * Lists all products across all companies with a given status.
 * Platform-admin only — used for the approval queue.
 */
export async function listPendingProductsAllCompanies({ page = 1, limit = 20, status = 'pending' } = {}) {
  const offset = (page - 1) * limit;

  const countResult = await query(
    `SELECT COUNT(*) as total FROM app.products WHERE status = $1`,
    [status]
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const result = await query(
    `SELECT p.id, p.company_id, c.display_name AS company_name,
            p.sku, p.name, p.slug, p.status, p.price, p.currency,
            p.brand, p.seller_name, p.trusted_seller,
            p.created_at, p.updated_at
     FROM app.products p
     JOIN app.companies c ON c.id = p.company_id
     WHERE p.status = $1
     ORDER BY p.created_at ASC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );

  return {
    items: result.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    },
  };
}

/**
 * Updates a product (non-status fields). Company members only.
 */
export async function updateProduct(companyId, userId, productId, updates) {
  await assertCompanyMember(companyId, userId);

  const allowedFields = [
    'name', 'description', 'short_description', 'price',
    'compare_at_price', 'cost_price', 'weight_grams', 'brand',
    'seller_name', 'trusted_seller', 'free_shipping', 'is_featured',
    'is_flash_deal', 'badge', 'metadata',
  ];

  const setClauses = [];
  const params = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(updates)) {
    const snakeKey = camelToSnake(key);
    if (!allowedFields.includes(snakeKey)) continue;

    if (snakeKey === 'metadata') {
      params.push(JSON.stringify(value));
    } else {
      params.push(value);
    }
    setClauses.push(`${snakeKey} = $${paramIdx}`);
    paramIdx++;
  }

  if (setClauses.length === 0) {
    throw new BadRequestError('No valid fields to update');
  }

  params.push(productId, companyId);
  const result = await query(
    `UPDATE app.products
     SET ${setClauses.join(', ')}
     WHERE id = $${paramIdx} AND company_id = $${paramIdx + 1}
     RETURNING *`,
    params
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Product not found');
  }

  return result.rows[0];
}

/**
 * Deletes a product. Company members only.
 */
export async function deleteProduct(companyId, userId, productId) {
  await assertCompanyMember(companyId, userId);

  const result = await query(
    'DELETE FROM app.products WHERE id = $1 AND company_id = $2 RETURNING id',
    [productId, companyId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Product not found');
  }

  return { id: result.rows[0].id };
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
