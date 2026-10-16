import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { validate, isString, isNonNegativeNumber, isUUID } from '../middleware/validate.js';
import { slugify } from '../lib/slugify.js';
import { requireCompanyTenant, tenantTable } from '../lib/tenantDb.js';
import { cloudinaryConfigState, uploadProductImage } from '../lib/cloudinary.js';
import {
  decodeProductImageDataUrl,
  detectProductImageType,
  MAX_PRODUCT_IMAGE_BYTES,
  MAX_PRODUCT_IMAGES,
  MAX_PRODUCT_CREATE_REQUEST_BYTES,
  isHttpProductImageUrl,
  isProductImageDataUrl,
} from '../lib/productImages.js';

const products = new Hono();
export const createProductSchema = (body) => {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: [{ field: 'body', message: 'Product data is required' }] };
  }
  if (!isString(body.sku)) errors.push({ field: 'sku', message: 'SKU is required' });
  if (!isString(body.name)) errors.push({ field: 'name', message: 'Product name is required' });
  if (!isNonNegativeNumber(body.price)) errors.push({ field: 'price', message: 'Price must be a non-negative number' });
  if (body.stockQuantity !== undefined && (!Number.isInteger(body.stockQuantity) || body.stockQuantity < 0)) errors.push({ field: 'stockQuantity', message: 'Stock quantity must be a non-negative integer' });
  if (body.compareAtPrice !== undefined && !isNonNegativeNumber(body.compareAtPrice)) errors.push({ field: 'compareAtPrice', message: 'Compare-at price must be non-negative' });
  if (body.costPrice !== undefined && !isNonNegativeNumber(body.costPrice)) errors.push({ field: 'costPrice', message: 'Cost price must be non-negative' });
  if (body.weightGrams !== undefined && (typeof body.weightGrams !== 'number' || body.weightGrams < 0)) errors.push({ field: 'weightGrams', message: 'Weight must be a non-negative integer' });
  if (body.categoryId && !isUUID(body.categoryId)) errors.push({ field: 'categoryId', message: 'Category ID must be a valid UUID' });
  if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata))) errors.push({ field: 'metadata', message: 'Product metadata must be an object' });
  if (body.images !== undefined) errors.push({ field: 'images', message: 'Upload product images as files, not JSON values' });
  if (body.metadata && Object.prototype.hasOwnProperty.call(body.metadata, 'image')) {
    const image = body.metadata.image;
    if (typeof image !== 'string') errors.push({ field: 'metadata.image', message: 'Product image must be a URL or an uploaded image file' });
    else if (!isProductImageDataUrl(image) && image.trim() !== '' && !isHttpProductImageUrl(image)) errors.push({ field: 'metadata.image', message: 'Product image must be an absolute HTTP(S) URL or an uploaded image file' });
    if (typeof image === 'string' && !isProductImageDataUrl(image) && image.length > 2048) errors.push({ field: 'metadata.image', message: 'Product image URL is too long' });
  }
  return { valid: errors.length === 0, errors };
};
const productStatuses = ['draft', 'pending', 'active', 'archived'];
const updateProductStatusSchema = (body) => {
  const errors = !isString(body.status) || !productStatuses.includes(body.status)
    ? [{ field: 'status', message: `Status must be one of: ${productStatuses.join(', ')}` }] : [];
  return { valid: errors.length === 0, errors };
};
export const updateProductSchema = (body) => {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: [{ field: 'body', message: 'Product update data is required' }] };
  }
  if (body.price !== undefined && !isNonNegativeNumber(body.price)) errors.push({ field: 'price', message: 'Price must be a non-negative number' });
  if (body.stockQuantity !== undefined && (!Number.isInteger(body.stockQuantity) || body.stockQuantity < 0)) errors.push({ field: 'stockQuantity', message: 'Stock quantity must be a non-negative integer' });
  if (body.name !== undefined && typeof body.name !== 'string') errors.push({ field: 'name', message: 'Name must be a string' });
  if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata))) errors.push({ field: 'metadata', message: 'Product metadata must be an object' });
  if (body.metadata && Object.prototype.hasOwnProperty.call(body.metadata, 'image')) {
    const image = body.metadata.image;
    if (typeof image !== 'string') errors.push({ field: 'metadata.image', message: 'Product image must be a URL' });
    else if (isProductImageDataUrl(image) || (image.trim() !== '' && !isHttpProductImageUrl(image)) || image.length > 2048) {
      errors.push({ field: 'metadata.image', message: 'Use an absolute HTTP(S) image URL instead of storing image data in Neon' });
    }
  }
  return { valid: errors.length === 0, errors };
};

async function readProductCreatePayload(c) {
  const contentLength = Number(c.req.header('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PRODUCT_CREATE_REQUEST_BYTES) {
    return { error: errorResponse('Product image request must not exceed 11 MiB', 413) };
  }
  const contentType = (c.req.header('content-type') || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) {
    const body = await c.req.json().catch(() => null);
    return { body, files: [] };
  }

  let form;
  try {
    form = await c.req.formData();
  } catch {
    return { error: errorResponse('Upload must use valid multipart form data', 400) };
  }

  const serialized = form.get('product');
  if (typeof serialized !== 'string') return { error: errorResponse('Product data is required', 400) };
  let body;
  try {
    body = JSON.parse(serialized);
  } catch {
    return { error: errorResponse('Product data must be valid JSON', 400) };
  }

  const entries = form.getAll('images');
  if (entries.some((entry) => !entry || typeof entry.arrayBuffer !== 'function' || typeof entry.size !== 'number')) {
    return { error: errorResponse('Product images must be uploaded as files', 400) };
  }
  return { body, files: entries };
}

async function prepareProductImages(c, companyId, productName, imageSources) {
  if (!imageSources.length) return { images: [] };
  if (imageSources.length > MAX_PRODUCT_IMAGES) {
    return { error: { message: `A product can have at most ${MAX_PRODUCT_IMAGES} images`, status: 400 } };
  }

  const cloudinaryState = cloudinaryConfigState(c.env);
  if (cloudinaryState === 'partial') {
    return { error: { message: 'Cloudinary image storage is only partially configured', status: 503 } };
  }
  const useCloudinary = cloudinaryState === 'ready';
  if (!useCloudinary && !c.env.PRODUCT_IMAGES) {
    return { error: { message: 'Product image storage is not configured', status: 503 } };
  }

  const images = [];
  for (const source of imageSources) {
    let bytes;
    let detected;
    if (source.legacy) {
      bytes = source.legacy.bytes;
      detected = source.legacy;
    } else {
      if (source.file.size <= 0 || source.file.size > MAX_PRODUCT_IMAGE_BYTES) {
        return { error: { message: 'Each product image must be between 1 byte and 5 MB', status: 413 } };
      }
      bytes = new Uint8Array(await source.file.arrayBuffer());
      detected = detectProductImageType(bytes);
      if (!detected) return { error: { message: 'Only real JPEG, PNG, or WebP images are accepted', status: 415 } };
      if (source.file.type && source.file.type !== 'application/octet-stream' && source.file.type !== detected.contentType) {
        return { error: { message: 'Image content does not match its declared file type', status: 415 } };
      }
    }
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_PRODUCT_IMAGE_BYTES) {
      return { error: { message: 'Each product image must be between 1 byte and 5 MB', status: 413 } };
    }
    const id = crypto.randomUUID();
    images.push({
      id,
      key: `products/${companyId}/${id}`,
      url: '',
      contentType: detected.contentType,
      extension: detected.extension,
      bytes,
      altText: productName,
      sortOrder: images.length,
      isPrimary: images.length === 0,
      storage: useCloudinary ? 'cloudinary' : 'kv',
    });
  }

  try {
    if (useCloudinary) {
      for (const image of images) {
        const result = await uploadProductImage(c.env, {
          bytes: image.bytes,
          contentType: image.contentType,
          extension: image.extension,
          companyId,
          imageId: image.id,
        });
        image.url = result.secureUrl;
        image.publicId = result.publicId;
      }
    } else {
      for (const image of images) {
        image.url = new URL(
          `/api/storefront/media/products/${encodeURIComponent(companyId)}/${image.id}.${image.extension}`,
          c.req.url,
        ).toString();
        await c.env.PRODUCT_IMAGES.put(image.key, image.bytes.buffer, {
          metadata: { companyId, imageId: image.id, contentType: image.contentType },
        });
      }
    }
    return { images };
  } catch (error) {
    await Promise.allSettled(images.filter((image) => image.storage === 'kv').map(({ key }) => c.env.PRODUCT_IMAGES.delete(key)));
    console.error('Unable to store product image.', error);
    return { error: { message: 'تعذر تخزين صور المنتج الآن. حاول مرة أخرى.', status: 503 } };
  }
}

function productImagesJoin(imagesTable) {
  return `LEFT JOIN LATERAL (
    SELECT
      COALESCE(jsonb_agg(jsonb_build_object(
        'id', image.id,
        'url', image.url,
        'altText', image.alt_text,
        'sortOrder', image.sort_order,
        'isPrimary', image.is_primary
      ) ORDER BY image.is_primary DESC, image.sort_order ASC, image.created_at ASC), '[]'::jsonb) AS images,
      (array_agg(image.url ORDER BY image.is_primary DESC, image.sort_order ASC, image.created_at ASC))[1] AS image_url
    FROM ${imagesTable} image
    WHERE image.product_id = product.id
  ) product_image_data ON TRUE`;
}

// POST /api/companies/:companyId/products — products are created pending moderation.
// New image uploads use Cloudinary when configured; KV remains the legacy-compatible fallback.
products.post('/:companyId/products', authMiddleware, async (c) => {
  const parsed = await readProductCreatePayload(c);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const validation = createProductSchema(body);
  if (!validation.valid) return errorResponse('Validation failed', 400, validation.errors);

  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;

  const categoryTable = tenantTable(tenant.schema, 'categories');
  const productTable = tenantTable(tenant.schema, 'products');
  const imagesTable = tenantTable(tenant.schema, 'product_images');
  if (body.categoryId) {
    const [category] = await db.query(
      `SELECT id FROM ${categoryTable} WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [body.categoryId, companyId]
    );
    if (!category) return errorResponse('Category not found in this company', 400);
  }

  const metadata = { ...(body.metadata || {}) };
  let legacyImage = null;
  if (isProductImageDataUrl(metadata.image)) {
    legacyImage = decodeProductImageDataUrl(metadata.image);
    if (!legacyImage) return errorResponse('Legacy image data must be a valid JPEG, PNG, or WebP file up to 5 MB', 415);
    if (parsed.files.length) return errorResponse('Upload each product image only once', 400);
    metadata.image = '';
  }

  const imageSources = parsed.files.map((file) => ({ file }));
  if (legacyImage) imageSources.push({ legacy: legacyImage });
  const preparedResult = await prepareProductImages(c, companyId, body.name, imageSources);
  if (preparedResult.error) return errorResponse(preparedResult.error.message, preparedResult.error.status);
  const preparedImages = preparedResult.images;

  if (preparedImages.length) metadata.image = preparedImages[0].url;
  const imagesJson = JSON.stringify(preparedImages.map(({ id, url, altText, sortOrder, isPrimary }) => ({
    id, url, alt_text: altText, sort_order: sortOrder, is_primary: isPrimary,
  })));

  try {
    const [product] = await db.query(
      `WITH new_product AS (
        INSERT INTO ${productTable} (
          company_id, category_id, sku, name, slug, description, short_description, status,
          price, compare_at_price, cost_price, currency, weight_grams, brand, seller_name,
          trusted_seller, free_shipping, is_featured, is_flash_deal, badge, metadata, stock_quantity
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20::jsonb, $21
        ) RETURNING *
      ), new_images AS (
        INSERT INTO ${imagesTable} (id, product_id, url, alt_text, sort_order, is_primary)
        SELECT image.id::uuid, product.id, image.url, image.alt_text, image.sort_order, image.is_primary
        FROM new_product product
        CROSS JOIN jsonb_to_recordset($22::jsonb) AS image(
          id text, url text, alt_text text, sort_order integer, is_primary boolean
        )
        RETURNING id, product_id, url, alt_text, sort_order, is_primary, created_at
      )
      SELECT product.*,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', image.id,
            'url', image.url,
            'altText', image.alt_text,
            'sortOrder', image.sort_order,
            'isPrimary', image.is_primary
          ) ORDER BY image.is_primary DESC, image.sort_order ASC, image.created_at ASC)
          FROM new_images image WHERE image.product_id = product.id
        ), '[]'::jsonb) AS images
      FROM new_product product`,
      [companyId, body.categoryId || null, body.sku, body.name,
        `${slugify(body.name)}-${Date.now().toString(36)}`, body.description || null,
        body.shortDescription || null, body.price, body.compareAtPrice ?? null,
        body.costPrice ?? null, body.currency || 'EGP', body.weightGrams ?? null,
        body.brand || null, body.sellerName || null, body.trustedSeller || false,
        body.freeShipping || false, body.isFeatured || false, body.isFlashDeal || false,
        body.badge || null, JSON.stringify(metadata), body.stockQuantity ?? 0, imagesJson]
    );
    if (!product) throw new Error('Product insert returned no row.');
    return jsonResponse(created(product, 'Product created — pending admin approval'), 201);
  } catch (error) {
    await Promise.allSettled(preparedImages.filter((image) => image.storage === 'kv').map(({ key }) => c.env.PRODUCT_IMAGES.delete(key)));
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
  const imageJoin = productImagesJoin(tenantTable(tenant.schema, 'product_images'));
  const rows = await db.query(
    `SELECT product.*, count(*) OVER()::int AS _total,
       product_image_data.images, COALESCE(product_image_data.image_url, product.metadata->>'image') AS image_url
     FROM ${table} product
     ${imageJoin}
     WHERE product.company_id = $1 AND ($2::text IS NULL OR product.status = $2)
     ORDER BY product.created_at DESC LIMIT $3 OFFSET $4`,
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
  const imageJoin = productImagesJoin(tenantTable(tenant.schema, 'product_images'));
  const [product] = await db.query(
    `SELECT product.*, product_image_data.images,
       COALESCE(product_image_data.image_url, product.metadata->>'image') AS image_url
     FROM ${tenantTable(tenant.schema, 'products')} product
     ${imageJoin}
     WHERE product.id = $1 AND product.company_id = $2 LIMIT 1`,
    [productId, companyId]
  );
  if (!product) return errorResponse('Product not found', 404);
  return jsonResponse(ok(product));
});

// PUT /api/companies/:companyId/products/:productId
products.put('/:companyId/products/:productId', authMiddleware, async (c) => {
  const parsed = await readProductCreatePayload(c);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const validation = updateProductSchema(body);
  if (!validation.valid) return errorResponse('Validation failed', 400, validation.errors);

  const user = c.get('user'); const companyId = c.req.param('companyId'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;
  const productTable = tenantTable(tenant.schema, 'products');
  const imagesTable = tenantTable(tenant.schema, 'product_images');
  const [existing] = await db.query(
    `SELECT id, name, metadata FROM ${productTable} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [productId, companyId]
  );
  if (!existing) return errorResponse('Product not found', 404);

  const imageSources = parsed.files.map((file) => ({ file }));
  const preparedResult = await prepareProductImages(c, companyId, body.name || existing.name || '', imageSources);
  if (preparedResult.error) return errorResponse(preparedResult.error.message, preparedResult.error.status);
  const preparedImages = preparedResult.images;
  const currentMetadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
    ? existing.metadata
    : {};
  const nextMetadata = { ...currentMetadata, ...(body.metadata || {}) };
  if (preparedImages.length) nextMetadata.image = preparedImages[0].url;
  const metadataJson = body.metadata === undefined && !preparedImages.length ? null : JSON.stringify(nextMetadata);

  try {
    const [product] = await db.query(
      `UPDATE ${productTable} SET
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
        body.isFlashDeal ?? null, body.badge ?? null, metadataJson,
        body.stockQuantity ?? null, productId, companyId]
    );
    if (!product) {
      await Promise.allSettled(preparedImages.filter((image) => image.storage === 'kv').map(({ key }) => c.env.PRODUCT_IMAGES.delete(key)));
      return errorResponse('Product not found', 404);
    }

    if (preparedImages.length) {
      const imagesJson = JSON.stringify(preparedImages.map(({ id, url, altText, sortOrder, isPrimary }) => ({
        id, url, alt_text: altText, sort_order: sortOrder, is_primary: isPrimary,
      })));
      await db.query(
        `WITH deleted_images AS (
           DELETE FROM ${imagesTable} WHERE product_id = $1 RETURNING id
         ), new_images AS (
           INSERT INTO ${imagesTable} (id, product_id, url, alt_text, sort_order, is_primary)
           SELECT image.id::uuid, $1, image.url, image.alt_text, image.sort_order, image.is_primary
           FROM jsonb_to_recordset($2::jsonb) AS image(
             id text, url text, alt_text text, sort_order integer, is_primary boolean
           )
           CROSS JOIN (SELECT count(*) FROM deleted_images) AS delete_barrier
           RETURNING id
         ) SELECT count(*)::int AS inserted_count FROM new_images`,
        [productId, imagesJson]
      );
    }

    const imageJoin = productImagesJoin(imagesTable);
    const [updatedProduct] = await db.query(
      `SELECT product.*, product_image_data.images,
         COALESCE(product_image_data.image_url, product.metadata->>'image') AS image_url
       FROM ${productTable} product
       ${imageJoin}
       WHERE product.id = $1 AND product.company_id = $2 LIMIT 1`,
      [productId, companyId]
    );
    return jsonResponse(ok(updatedProduct, 'Product updated successfully'));
  } catch (error) {
    await Promise.allSettled(preparedImages.filter((image) => image.storage === 'kv').map(({ key }) => c.env.PRODUCT_IMAGES.delete(key)));
    throw error;
  }
});

// DELETE /api/companies/:companyId/products/:productId
products.delete('/:companyId/products/:productId', authMiddleware, async (c) => {
  const user = c.get('user'); const companyId = c.req.param('companyId'); const productId = c.req.param('productId'); const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;
  const imageTable = tenantTable(tenant.schema, 'product_images');
  const imageRows = await db.query(`SELECT id FROM ${imageTable} WHERE product_id = $1`, [productId]);
  const rows = await db.query(
    `DELETE FROM ${tenantTable(tenant.schema, 'products')} WHERE id = $1 AND company_id = $2 RETURNING id`,
    [productId, companyId]
  );
  if (!rows.length) return errorResponse('Product not found', 404);
  if (c.env.PRODUCT_IMAGES) {
    const cleanup = await Promise.allSettled(imageRows.map(({ id }) => c.env.PRODUCT_IMAGES.delete(`products/${companyId}/${id}`)));
    if (cleanup.some((result) => result.status === 'rejected')) console.warn('Some product image objects could not be removed from KV.');
  }
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
