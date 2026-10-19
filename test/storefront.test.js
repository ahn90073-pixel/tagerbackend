import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import storefront, { promotionRowToApi, validateCheckoutPayload } from '../src/routes/storefront.js';

const productId = '4c606bbc-2f91-4c84-9c2e-1189c25163b0';
const vendorId = 'cf11af60-946d-4197-b5e1-6d68b69a8e9a';
const validPayload = {
  customer: { fullName: 'مها أحمد', phone: '+201012345678', email: 'maha@example.com' },
  address: { governorate: 'القاهرة', city: 'مدينة نصر', street: 'شارع عباس العقاد، عمارة 10' },
  items: [{ productId, vendorId, quantity: 2 }],
  customerNote: 'الاتصال قبل الوصول',
};
const cloudinaryEnv = {
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
};
const authHeaders = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };

function authResponse(role = 'super_admin') {
  return new Response(JSON.stringify({ success: true, data: { role } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('accepts a complete Arabic cash-on-delivery checkout payload', () => {
  assert.deepEqual(validateCheckoutPayload(validPayload), []);
});

test('rejects missing delivery contact and address fields', () => {
  const errors = validateCheckoutPayload({ items: validPayload.items });
  assert.ok(errors.some((message) => message.includes('بيانات العميل')));
  assert.ok(errors.some((message) => message.includes('عنوان التوصيل')));
});

test('rejects malformed product IDs and non-positive quantities', () => {
  const errors = validateCheckoutPayload({
    ...validPayload,
    items: [{ productId: '1', vendorId, quantity: 0 }],
  });
  assert.ok(errors.some((message) => message.includes('بيانات المنتج')));
  assert.ok(errors.some((message) => message.includes('كمية المنتج')));
});

test('limits a checkout to 50 products and quantities to 99 units', () => {
  const tooManyItems = Array.from({ length: 51 }, () => ({ productId, vendorId, quantity: 1 }));
  assert.ok(validateCheckoutPayload({ ...validPayload, items: tooManyItems }).some((message) => message.includes('50')));
  assert.ok(validateCheckoutPayload({ ...validPayload, items: [{ productId, vendorId, quantity: 100 }] }).some((message) => message.includes('كمية المنتج')));
});

test('maps storefront promotion database fields to the public camelCase contract', () => {
  assert.deepEqual(promotionRowToApi({
    id: 'promotion-1',
    title: 'عنوان',
    subtitle: 'عنوان فرعي',
    description: 'وصف',
    cta_label: 'تسوق الآن',
    target_url: '/products',
    media_url: 'https://example.com/promo.jpg',
    media_key: null,
    media_type: 'image',
    theme: 'blue',
    is_active: true,
    sort_order: 4,
    starts_at: null,
    ends_at: null,
    created_at: '2026-10-19T00:00:00.000Z',
    updated_at: '2026-10-19T00:00:00.000Z',
  }), {
    id: 'promotion-1',
    title: 'عنوان',
    subtitle: 'عنوان فرعي',
    description: 'وصف',
    ctaLabel: 'تسوق الآن',
    targetUrl: '/products',
    mediaUrl: 'https://example.com/promo.jpg',
    mediaKey: null,
    mediaType: 'image',
    theme: 'blue',
    isActive: true,
    sortOrder: 4,
    startsAt: null,
    endsAt: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  });
});

test('returns a signed Cloudinary upload payload after validating the super-admin token', async () => {
  const requests = [];
  const env = {
    ...cloudinaryEnv,
    ADMIN_AUTH_ME_URL: 'https://auth.test/api/admin/auth/me',
    FETCH_IMPL: async (url, init) => {
      requests.push({ url, init });
      return authResponse();
    },
  };
  const response = await storefront.request('/admin/promotions/upload-signature', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ contentType: 'image/webp' }),
  }, env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.cloudName, 'test-cloud');
  assert.equal(payload.data.apiKey, 'test-key');
  assert.equal(payload.data.assetFolder, 'tager/promotions');
  assert.equal(payload.data.resourceType, 'image');
  assert.match(payload.data.publicId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(payload.data.signature, /^[a-f0-9]{40}$/);
  assert.equal(Object.hasOwn(payload.data, 'apiSecret'), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, env.ADMIN_AUTH_ME_URL);
  assert.equal(requests[0].init.headers.Authorization, authHeaders.Authorization);
});

test('rejects non-super-admin promotion media requests without contacting Cloudinary', async () => {
  let requestCount = 0;
  const env = {
    ...cloudinaryEnv,
    FETCH_IMPL: async () => {
      requestCount += 1;
      return authResponse('admin');
    },
  };
  const response = await storefront.request('/admin/promotions/upload-signature', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ contentType: 'image/jpeg' }),
  }, env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).success, false);
  assert.equal(requestCount, 1);
});

test('deletes image or video media with a signed Cloudinary destroy request and treats not found as success', async () => {
  const requests = [];
  const publicId = '4c606bbc-2f91-4c84-9c2e-1189c25163b0';
  const env = {
    ...cloudinaryEnv,
    FETCH_IMPL: async (url, init) => {
      requests.push({ url, init });
      return requests.length === 1 ? authResponse() : new Response(JSON.stringify({ result: 'not found' }), { status: 404 });
    },
  };
  const response = await storefront.request('/admin/promotions/delete-media', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ publicId, mediaType: 'video' }),
  }, env);
  const payload = await response.json();
  const form = new URLSearchParams(requests[1].init.body);
  const expectedSignature = createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${form.get('timestamp')}${cloudinaryEnv.CLOUDINARY_API_SECRET}`)
    .digest('hex');

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data, { deleted: true });
  assert.equal(requests[1].url, 'https://api.cloudinary.com/v1_1/test-cloud/video/destroy');
  assert.equal(form.get('api_key'), 'test-key');
  assert.equal(form.get('public_id'), publicId);
  assert.equal(form.get('signature'), expectedSignature);
});

test('validates promotion media type and Cloudinary readiness without making an external request', async () => {
  let requestCount = 0;
  const env = {
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-key',
    FETCH_IMPL: async () => {
      requestCount += 1;
      return authResponse();
    },
  };
  const missingConfigResponse = await storefront.request('/admin/promotions/upload-signature', {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ contentType: 'image/jpeg' }),
  }, env);
  assert.equal(missingConfigResponse.status, 503);

  const invalidDeleteResponse = await storefront.request('/admin/promotions/delete-media', {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ publicId: 'not-a-uuid', mediaType: 'audio' }),
  }, { ...cloudinaryEnv, FETCH_IMPL: async () => { requestCount += 1; return authResponse(); } });
  assert.equal(invalidDeleteResponse.status, 400);
  assert.equal(requestCount, 2);
});
