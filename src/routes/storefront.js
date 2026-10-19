import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { tenantTable } from '../lib/tenantDb.js';
import { normalizeEgyptPhone } from '../lib/phone.js';
import { sendFcmMessage } from '../lib/fcm.js';
import { upsertCustomerDeviceNotificationToken, upsertCustomerNotificationContact } from '../lib/notificationContacts.js';
import { filterAndPageCatalog, readCatalogSnapshot, writeCatalogSnapshot } from '../lib/productCatalogCache.js';
import { cloudinaryConfigState, createCloudinarySignature } from '../lib/cloudinary.js';

const storefront = new Hono();
const tenantSchemaPattern = /^tenant_[a-z0-9_]{1,54}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const promotionAdminAuthMeFallback = 'https://mangerbackend.ahn90073.workers.dev/api/admin/auth/me';
const promotionContentTypes = new Map([
  ['image/jpeg', 'image'],
  ['image/png', 'image'],
  ['image/webp', 'image'],
  ['video/mp4', 'video'],
  ['video/webm', 'video'],
]);

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

async function authorizePromotionSuperAdmin(c, fetchImpl) {
  const authorization = c.req.header('Authorization') || '';
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return errorResponse('Authentication token is required', 401);
  }

  const configuredAuthUrl = typeof c.env?.ADMIN_AUTH_ME_URL === 'string' ? c.env.ADMIN_AUTH_ME_URL.trim() : '';
  let response;
  try {
    response = await fetchImpl(configuredAuthUrl || promotionAdminAuthMeFallback, {
      method: 'GET',
      headers: { Authorization: authorization },
    });
  } catch {
    return errorResponse('Authentication service is temporarily unavailable.', 503);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.data?.role === undefined) {
    return errorResponse('Invalid or expired token', 401);
  }
  if (payload.data.role !== 'super_admin') {
    return errorResponse('Super admin access required', 403);
  }
  return null;
}

async function readJsonBody(c) {
  return c.req.json().catch(() => null);
}

export function promotionRowToApi(row) {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    ctaLabel: row.cta_label,
    targetUrl: row.target_url,
    mediaUrl: row.media_url,
    mediaKey: row.media_key,
    mediaType: row.media_type,
    theme: row.theme,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    if (typeof customer.phone !== 'string' || !normalizeEgyptPhone(customer.phone)) {
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
  if (body.notificationConsent !== undefined && typeof body.notificationConsent !== 'boolean') {
    errors.push('موافقة الإشعارات غير صالحة.');
  }
  if (body.fcmToken !== undefined && (typeof body.fcmToken !== 'string' || body.fcmToken.trim().length < 1 || body.fcmToken.length > 4096)) {
    errors.push('رمز الإشعارات غير صالح.');
  }
  if (body.platform !== undefined && (typeof body.platform !== 'string' || !['android', 'ios', 'web'].includes(body.platform))) {
    errors.push('منصة الإشعارات غير صالحة.');
  }
  if (body.appVersion !== undefined && (typeof body.appVersion !== 'string' || body.appVersion.trim().length > 64)) {
    errors.push('إصدار التطبيق غير صالح.');
  }
  if (body.notificationConsent === true && (!body.fcmToken || !body.platform)) {
    errors.push('رمز ومنصة الإشعارات مطلوبان عند الموافقة.');
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

async function queryProductsFromNeon(env, { page, limit, search = '', category = '' }) {
  const db = createDb(env);
  const offset = (page - 1) * limit;
  const companies = await db`
    SELECT id, display_name, slug, tenant_schema_name
    FROM public.companies
    WHERE status = 'active' AND tenant_schema_name IS NOT NULL
    ORDER BY display_name ASC
  `;
  if (!companies.length) return { items: [], pagination: { page, limit, total: 0, totalPages: 0 } };

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
  const total = Number(rows[0]?._total || 0);
  const items = rows.map((row) => {
    const imageUrls = Array.isArray(row.image_urls) && row.image_urls.length
      ? row.image_urls
      : row.image_url ? [row.image_url] : [];
    return {
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
    };
  });
  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function loadCompleteCatalog(env) {
  const products = [];
  const pageSize = 1000;
  for (let page = 1; page <= 10000; page += 1) {
    const result = await queryProductsFromNeon(env, { page, limit: pageSize });
    products.push(...result.items);
    if (page >= result.pagination.totalPages) return products;
  }
  throw new Error('Catalog refresh exceeded the 10,000-page safety limit.');
}

export async function refreshProductCatalog(env) {
  if (!env.PRODUCT_CATALOG) throw new Error('PRODUCT_CATALOG KV binding is not configured.');
  const products = await loadCompleteCatalog(env);
  const manifest = await writeCatalogSnapshot(env.PRODUCT_CATALOG, products);
  console.info('Product catalog snapshot refreshed.', { productCount: products.length, updatedAt: manifest.updatedAt });
  return { productCount: products.length, updatedAt: manifest.updatedAt };
}

storefront.get('/products', async (c) => {
  const page = positiveInt(c.req.query('page'), 1, 1000000);
  const limit = positiveInt(c.req.query('limit'), 60, 100);
  const search = (c.req.query('q') || '').trim().slice(0, 120);
  const category = (c.req.query('category') || '').trim().slice(0, 120);

  if (!c.env.PRODUCT_CATALOG) {
    const result = await queryProductsFromNeon(c.env, { page, limit, search, category });
    return jsonResponse(ok(result));
  }

  let snapshot = await readCatalogSnapshot(c.env.PRODUCT_CATALOG);
  if (!snapshot) {
    const products = await loadCompleteCatalog(c.env);
    const manifest = await writeCatalogSnapshot(c.env.PRODUCT_CATALOG, products);
    snapshot = { products, updatedAt: manifest.updatedAt, version: manifest.version };
  }
  return jsonResponse(ok(filterAndPageCatalog(snapshot.products, { page, limit, search, category })));
});

storefront.get('/promotions', async (c) => {
  const db = createDb(c.env);
  const rows = await db`
    SELECT id, title, subtitle, description, cta_label, target_url,
      media_url, media_key, media_type, theme, is_active, sort_order,
      starts_at, ends_at, created_at, updated_at
    FROM public.storefront_promotions
    WHERE is_active = TRUE
      AND (starts_at IS NULL OR starts_at <= NOW())
      AND (ends_at IS NULL OR ends_at > NOW())
    ORDER BY sort_order ASC, created_at ASC
  `;
  return jsonResponse({ items: rows.map(promotionRowToApi) });
});

storefront.post('/admin/promotions/upload-signature', async (c) => {
  const fetchImpl = typeof c.env?.FETCH_IMPL === 'function' ? c.env.FETCH_IMPL : globalThis.fetch;
  const authorizationError = await authorizePromotionSuperAdmin(c, fetchImpl);
  if (authorizationError) return authorizationError;
  if (cloudinaryConfigState(c.env) !== 'ready') {
    return errorResponse('Cloudinary storage is not configured.', 503);
  }

  const body = await readJsonBody(c);
  const contentType = typeof body?.contentType === 'string' ? body.contentType.trim().toLowerCase() : '';
  const resourceType = promotionContentTypes.get(contentType);
  if (!resourceType) return errorResponse('Unsupported promotion media type.', 400);

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = globalThis.crypto.randomUUID();
  const assetFolder = 'tager/promotions';
  const params = { asset_folder: assetFolder, public_id: publicId, timestamp };
  let signature;
  try {
    signature = await createCloudinarySignature(params, c.env.CLOUDINARY_API_SECRET);
  } catch {
    return errorResponse('Cloudinary signing is temporarily unavailable.', 503);
  }

  return jsonResponse(ok({
    cloudName: c.env.CLOUDINARY_CLOUD_NAME.trim(),
    apiKey: c.env.CLOUDINARY_API_KEY.trim(),
    timestamp,
    signature,
    assetFolder,
    publicId,
    resourceType,
  }));
});

storefront.post('/admin/promotions/delete-media', async (c) => {
  const fetchImpl = typeof c.env?.FETCH_IMPL === 'function' ? c.env.FETCH_IMPL : globalThis.fetch;
  const authorizationError = await authorizePromotionSuperAdmin(c, fetchImpl);
  if (authorizationError) return authorizationError;
  if (cloudinaryConfigState(c.env) !== 'ready') {
    return errorResponse('Cloudinary storage is not configured.', 503);
  }

  const body = await readJsonBody(c);
  const publicId = typeof body?.publicId === 'string' ? body.publicId.trim() : '';
  const mediaType = typeof body?.mediaType === 'string' ? body.mediaType.trim().toLowerCase() : '';
  if (!uuidPattern.test(publicId) || !['image', 'video'].includes(mediaType)) {
    return errorResponse('Promotion media reference is invalid.', 400);
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: publicId, timestamp };
  let signature;
  try {
    signature = await createCloudinarySignature(params, c.env.CLOUDINARY_API_SECRET);
  } catch {
    return errorResponse('Cloudinary signing is temporarily unavailable.', 503);
  }

  const cloudName = c.env.CLOUDINARY_CLOUD_NAME.trim();
  const form = new URLSearchParams({
    api_key: c.env.CLOUDINARY_API_KEY.trim(),
    timestamp: String(timestamp),
    public_id: publicId,
    signature,
  });
  let response;
  try {
    response = await fetchImpl(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${mediaType}/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
  } catch {
    return errorResponse('Cloudinary media deletion is temporarily unavailable.', 503);
  }

  const result = await response.json().catch(() => null);
  if (result?.result === 'ok' || result?.result === 'not found') {
    return jsonResponse(ok({ deleted: true }));
  }
  return errorResponse('Unable to delete promotion media.', 502);
});

storefront.post('/notifications/token', async (c) => {
  const body = await c.req.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  const platform = body?.platform;
  const appVersion = body?.appVersion;
  if (!token || token.length > 4096) return errorResponse('رمز الإشعارات غير صالح.', 400);
  if (!['android', 'ios', 'web'].includes(platform)) return errorResponse('منصة الإشعارات غير صالحة.', 400);
  if (appVersion !== undefined && (typeof appVersion !== 'string' || appVersion.trim().length > 64)) {
    return errorResponse('إصدار التطبيق غير صالح.', 400);
  }
  const db = createDb(c.env);
  const contact = await upsertCustomerDeviceNotificationToken(db, {
    token, platform, appVersion: appVersion?.trim() || null,
  });
  return jsonResponse(ok({ registered: Boolean(contact?.id) }, 'تم حفظ توكن الإشعارات.'));
});

storefront.post('/checkout', async (c) => {
  const body = await c.req.json().catch(() => null);
  const validationErrors = validateCheckoutPayload(body);
  if (validationErrors.length) return errorResponse('يرجى مراجعة بيانات الطلب.', 400, validationErrors);

  const normalizedBody = {
    ...body,
    customer: { ...body.customer, phone: normalizeEgyptPhone(body.customer.phone) },
  };

  try {
    const db = createDb(c.env);
    const [row] = await db.query(
      'SELECT public.create_storefront_orders($1::jsonb) AS orders',
      [JSON.stringify(normalizedBody)],
    );
    const orders = row?.orders || [];
    await saveCustomerContacts(db, orders, normalizedBody).catch(() => {
      console.warn('Checkout succeeded, but notification contact persistence failed.');
    });
    await notifyMerchantUsers(db, orders, normalizedBody, c.env).catch(() => {
      console.warn('Checkout succeeded, but merchant notification delivery failed.');
    });
    return jsonResponse(createdResponse(orders), 201);
  } catch (error) {
    if (error?.code === '22023') return errorResponse('بيانات الطلب أو التاجر غير صالحة.', 400);
    if (error?.code === 'P0001' || error?.code === '23503' || error?.code === '23514') {
      return errorResponse('تعذر تأكيد الطلب؛ قد تكون بعض المنتجات غير متاحة أو نفد مخزونها. حدّث السلة وحاول مرة أخرى.', 409);
    }
    throw error;
  }
});

async function saveCustomerContacts(db, orders, payload) {
  const token = payload.notificationConsent === true ? payload.fcmToken.trim() : null;
  const platform = token ? payload.platform : null;
  const appVersion = token ? (payload.appVersion?.trim() || null) : null;
  for (const order of orders) {
    try {
      await upsertCustomerNotificationContact(db, {
        companyId: order.vendorId,
        phone: payload.customer.phone,
        token,
        platform,
        appVersion,
        consent: payload.notificationConsent === true,
      });
    } catch {
      console.warn('A customer notification contact could not be persisted.');
    }
  }
}

async function notifyMerchantUsers(db, orders, payload, env) {
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

    const merchantContacts = await db.query(
      `SELECT fcm_token FROM public.notification_contacts
        WHERE audience = 'merchant' AND company_id = $1
          AND push_enabled = TRUE AND fcm_token IS NOT NULL`,
      [order.vendorId],
    );
    for (const contact of merchantContacts) {
      try {
        await sendFcmMessage({
          env,
          token: contact.fcm_token,
          appName: 'taget',
          title: 'طلب شراء جديد',
          body: `استلم متجرك طلبًا جديدًا ${order.orderNumber}.`,
          data: { type: 'new_order', orderId: order.orderId, orderNumber: order.orderNumber },
        });
      } catch {
        console.warn('A merchant FCM notification could not be delivered.');
      }
    }
  }
}

function createdResponse(orders) {
  return { success: true, message: 'تم تسجيل الطلب وإرساله إلى لوحة الإدارة لمراجعته.', data: { orders } };
}

export default storefront;
