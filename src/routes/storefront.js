import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { tenantTable } from '../lib/tenantDb.js';

const storefront = new Hono();
const tenantSchemaPattern = /^tenant_[a-z0-9_]{1,54}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function validateCheckoutPayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['بيانات الطلب غير صالحة.'];

  const customer = body.customer;
  const address = body.address;
  const items = body.items;
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
    errors.push('بيانات العميل مطلوبة.');
  } else {
    if (typeof customer.fullName !== 'string' || customer.fullName.trim().length < 2 || customer.fullName.length > 120) {
      errors.push('اسم العميل مطلوب (2 إلى 120 حرفًا).');
    }
    if (typeof customer.phone !== 'string' || !/^[+\d\s()\-]{7,24}$/.test(customer.phone.trim())) {
      errors.push('رقم هاتف صالح مطلوب.');
    }
    if (customer.email && (typeof customer.email !== 'string' || customer.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))) {
      errors.push('البريد الإلكتروني غير صالح.');
    }
  }

  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    errors.push('عنوان التوصيل مطلوب.');
  } else {
    for (const [field, label] of [['governorate', 'المحافظة'], ['city', 'المدينة'], ['street', 'العنوان التفصيلي']]) {
      if (typeof address[field] !== 'string' || address[field].trim().length < 2 || address[field].length > 240) {
        errors.push(`${label} مطلوب.`);
      }
    }
    for (const field of ['district', 'building', 'apartment', 'postalCode', 'notes']) {
      if (address[field] !== undefined && (typeof address[field] !== 'string' || address[field].length > 240)) {
        errors.push(`حقل العنوان ${field} غير صالح.`);
      }
    }
  }

  if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
    errors.push('يجب أن يحتوي الطلب على منتج واحد على الأقل وبحد أقصى 50 منتجًا.');
  } else {
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || !uuidPattern.test(item.productId || '') || !uuidPattern.test(item.vendorId || '')) {
        errors.push(`بيانات المنتج رقم ${index + 1} غير صالحة.`);
      }
      if (!Number.isInteger(item?.quantity) || item.quantity < 1 || item.quantity > 99) {
        errors.push(`كمية المنتج رقم ${index + 1} يجب أن تكون من 1 إلى 99.`);
      }
    });
  }

  if (body.customerNote !== undefined && (typeof body.customerNote !== 'string' || body.customerNote.length > 1000)) {
    errors.push('ملاحظات الطلب غير صالحة.');
  }
  return errors;
}

// Public immutable product media URL; image bytes are held in the dedicated KV namespace.
storefront.get('/media/products/:companyId/:fileName', async (c) => {
  const companyId = c.req.param('companyId');
  const fileName = c.req.param('fileName');
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|webp)$/i.exec(fileName);
  if (!uuidPattern.test(companyId) || !match) {
    return errorResponse('Product image not found', 404);
  }

  const imagesStore = c.env.PRODUCT_IMAGES;
  if (!imagesStore) return errorResponse('Product image storage is not configured', 503);
  const imageId = match[1];
  let bytes;
  try {
    bytes = await imagesStore.get(`products/${companyId}/${imageId}`, { type: 'arrayBuffer' });
  } catch (error) {
    console.error('Unable to read product image from KV.', error);
    return errorResponse('Product image is temporarily unavailable', 503);
  }
  if (!bytes) {
    const response = errorResponse('Product image not found', 404);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  const contentType = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[match[2].toLowerCase()];
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
});

storefront.get('/products', async (c) => {
  const db = createDb(c.env);
  const page = positiveInt(c.req.query('page'), 1, 1000000);
  const limit = positiveInt(c.req.query('limit'), 60, 100);
  const offset = (page - 1) * limit;
  const search = (c.req.query('q') || '').trim().slice(0, 120);
  const category = (c.req.query('category') || '').trim().slice(0, 120);

  const companies = await db`
    SELECT id, display_name, slug, tenant_schema_name
    FROM public.companies
    WHERE status = 'active' AND tenant_schema_name IS NOT NULL
    ORDER BY display_name ASC
  `;
  if (!companies.length) {
    return jsonResponse(ok({ items: [], pagination: { page, limit, total: 0, totalPages: 0 } }));
  }

  const values = companies.map((company) => company.id);
  values.push(search ? `%${search}%` : null, category || null, limit, offset);
  const searchParam = `$${companies.length + 1}`;
  const categoryParam = `$${companies.length + 2}`;
  const limitParam = `$${companies.length + 3}`;
  const offsetParam = `$${companies.length + 4}`;

  const branches = companies.map((company, index) => {
    if (!tenantSchemaPattern.test(company.tenant_schema_name || '')) {
      throw new Error(`Company ${company.id} has an invalid tenant schema.`);
    }
    const products = tenantTable(company.tenant_schema_name, 'products');
    const categories = tenantTable(company.tenant_schema_name, 'categories');
    const images = tenantTable(company.tenant_schema_name, 'product_images');
    return `
      SELECT p.id, p.company_id AS vendor_id, c.display_name AS vendor_name, c.slug AS vendor_slug,
        p.name, p.slug AS product_slug, p.description, p.short_description,
        p.price::numeric AS price, p.compare_at_price::numeric AS compare_at_price,
        p.currency, p.weight_grams, p.brand, p.seller_name, p.trusted_seller,
        p.free_shipping, p.is_featured, p.is_flash_deal, p.badge,
        p.stock_quantity, COALESCE(NULLIF(p.metadata->>'categoryLabel', ''), cat.name) AS category_name,
        COALESCE(image.url, p.metadata->>'image') AS image_url,
        COALESCE(image.urls, '[]'::jsonb) AS image_urls,
        p.created_at
      FROM ${products} p
      JOIN public.companies c ON c.id = p.company_id AND c.status = 'active'
      LEFT JOIN ${categories} cat ON cat.id = p.category_id
      LEFT JOIN LATERAL (
        SELECT
          (array_agg(url ORDER BY is_primary DESC, sort_order ASC, created_at ASC))[1] AS url,
          COALESCE(jsonb_agg(url ORDER BY is_primary DESC, sort_order ASC, created_at ASC), '[]'::jsonb) AS urls
        FROM ${images} WHERE product_id = p.id
      ) image ON TRUE
      WHERE p.company_id = $${index + 1}::uuid
        AND p.status = 'active'
        AND (${searchParam}::text IS NULL OR p.name ILIKE ${searchParam} OR coalesce(p.description, '') ILIKE ${searchParam} OR coalesce(p.seller_name, c.display_name) ILIKE ${searchParam} OR coalesce(NULLIF(p.metadata->>'categoryLabel', ''), cat.name, '') ILIKE ${searchParam})
        AND (${categoryParam}::text IS NULL OR COALESCE(NULLIF(p.metadata->>'categoryLabel', ''), cat.name) = ${categoryParam})
    `;
  });

  const rows = await db.query(
    `WITH catalog AS (${branches.join(' UNION ALL ')})
     SELECT catalog.*, count(*) OVER()::int AS _total
     FROM catalog
     ORDER BY is_featured DESC, created_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );
  const total = rows.length ? rows[0]._total : 0;
  const items = rows.map((row) => {
    const imageUrls = Array.isArray(row.image_urls) && row.image_urls.length
      ? row.image_urls
      : row.image_url ? [row.image_url] : [];
    return ({
    id: row.id,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    vendorSlug: row.vendor_slug,
    name: row.name,
    slug: row.product_slug,
    description: row.description || row.short_description || '',
    price: Number(row.price || 0),
    compareAtPrice: row.compare_at_price === null ? null : Number(row.compare_at_price),
    currency: row.currency?.trim() || 'EGP',
    weightGrams: row.weight_grams === null ? null : Number(row.weight_grams),
    brand: row.brand || '',
    sellerName: row.seller_name || row.vendor_name,
    trustedSeller: Boolean(row.trusted_seller),
    freeShipping: Boolean(row.free_shipping),
    isFeatured: Boolean(row.is_featured),
    isFlashDeal: Boolean(row.is_flash_deal),
    badge: row.badge || '',
    stockQuantity: Number(row.stock_quantity || 0),
    category: row.category_name || 'عام',
    imageUrl: imageUrls[0] || '',
    images: imageUrls,
  });
  });
  return jsonResponse(ok({ items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }));
});

storefront.post('/checkout', async (c) => {
  const body = await c.req.json().catch(() => null);
  const validationErrors = validateCheckoutPayload(body);
  if (validationErrors.length) return errorResponse('يرجى مراجعة بيانات الطلب.', 400, validationErrors);

  try {
    const db = createDb(c.env);
    const [row] = await db.query(
      'SELECT public.create_storefront_orders($1::jsonb) AS orders',
      [JSON.stringify(body)],
    );
    const orders = row?.orders || [];
    await notifyMerchantUsers(db, orders, body);
    return jsonResponse(createdResponse(orders), 201);
  } catch (error) {
    if (error?.code === '22023') return errorResponse('بيانات الطلب أو التاجر غير صالحة.', 400);
    if (error?.code === 'P0001' || error?.code === '23503' || error?.code === '23514') {
      return errorResponse('تعذر تأكيد الطلب؛ قد تكون بعض المنتجات غير متاحة أو نفد مخزونها. حدّث السلة وحاول مرة أخرى.', 409);
    }
    throw error;
  }
});

async function notifyMerchantUsers(db, orders, payload) {
  const customerName = String(payload?.customer?.fullName || 'عميل جديد').trim();
  for (const order of orders) {
    const [company] = await db.query(
      'SELECT tenant_schema_name FROM public.companies WHERE id = $1 AND status = \'active\' LIMIT 1',
      [order.vendorId],
    );
    if (!company?.tenant_schema_name || !tenantSchemaPattern.test(company.tenant_schema_name)) continue;
    const notificationTable = tenantTable(company.tenant_schema_name, 'notifications');
    const data = JSON.stringify({
      type: 'new_order',
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      vendorId: order.vendorId,
    });
    await db.query(
      `INSERT INTO ${notificationTable} (company_id, user_id, title, body, data, sent_at)
       SELECT $1, cm.user_id, $2, $3, $4::jsonb, now()
       FROM public.company_members cm
       WHERE cm.company_id = $1 AND cm.is_active = TRUE`,
      [order.vendorId, 'طلب شراء جديد', `استلم متجرك طلبًا جديدًا ${order.orderNumber} من ${customerName}.`, data],
    );
  }
}

function createdResponse(orders) {
  return { success: true, message: 'تم تسجيل الطلب وإرساله إلى لوحة الإدارة لمراجعته.', data: { orders } };
}

export default storefront;
