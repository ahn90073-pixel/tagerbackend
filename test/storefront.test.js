import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCheckoutPayload } from '../src/routes/storefront.js';

const productId = '4c606bbc-2f91-4c84-9c2e-1189c25163b0';
const vendorId = 'cf11af60-946d-4197-b5e1-6d68b69a8e9a';
const validPayload = {
  customer: { fullName: 'مها أحمد', phone: '+201012345678', email: 'maha@example.com' },
  address: { governorate: 'القاهرة', city: 'مدينة نصر', street: 'شارع عباس العقاد، عمارة 10' },
  items: [{ productId, vendorId, quantity: 2 }],
  customerNote: 'الاتصال قبل الوصول',
};

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
