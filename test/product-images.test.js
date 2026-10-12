import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PRODUCT_IMAGE_BYTES,
  MAX_PRODUCT_IMAGES,
  decodeProductImageDataUrl,
  detectProductImageType,
  isHttpProductImageUrl,
  isProductImageDataUrl,
} from '../src/lib/productImages.js';
import productRoutes, { createProductSchema, updateProductSchema } from '../src/routes/products.js';
import { createToken } from '../src/lib/jwt.js';

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

test('recognizes JPEG, PNG, and WebP from file signatures', () => {
  assert.deepEqual(detectProductImageType(jpeg), { contentType: 'image/jpeg', extension: 'jpg' });
  assert.deepEqual(detectProductImageType(png), { contentType: 'image/png', extension: 'png' });
  assert.deepEqual(detectProductImageType(webp), { contentType: 'image/webp', extension: 'webp' });
  assert.equal(detectProductImageType(new TextEncoder().encode('not an image file')), null);
});

test('decodes only correctly typed image data URLs for legacy app clients', () => {
  const encoded = Buffer.from(png).toString('base64');
  const decoded = decodeProductImageDataUrl(`data:image/png;base64,${encoded}`);
  assert.ok(decoded);
  assert.deepEqual(decoded.bytes, png);
  assert.equal(decoded.contentType, 'image/png');
  assert.equal(decodeProductImageDataUrl(`DATA:IMAGE/PNG;BASE64,${encoded}`)?.contentType, 'image/png');
  assert.equal(decodeProductImageDataUrl(`data:image/jpeg;base64,${encoded}`), null);
  assert.equal(decodeProductImageDataUrl('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(decodeProductImageDataUrl('not-a-data-url'), null);
});

test('detects data URLs case-insensitively so they cannot bypass Neon image-data checks', () => {
  assert.equal(isProductImageDataUrl('data:image/png;base64,abc'), true);
  assert.equal(isProductImageDataUrl('DATA:image/png;base64,abc'), true);
  assert.equal(isProductImageDataUrl('https://cdn.example/image.png'), false);
});

test('accepts only absolute HTTP(S) URLs as persisted image links', () => {
  assert.equal(isHttpProductImageUrl('https://cdn.example.test/image.png'), true);
  assert.equal(isHttpProductImageUrl('http://cdn.example.test/image.png'), true);
  assert.equal(isHttpProductImageUrl('iVBORw0KGgo='), false);
  assert.equal(isHttpProductImageUrl('javascript:alert(1)'), false);
  assert.equal(isHttpProductImageUrl('/images/product.png'), false);
  assert.equal(isHttpProductImageUrl('https://user:secret@cdn.example.test/image.png'), false);
});

test('product creation accepts URLs or legacy data URLs for KV conversion, but rejects raw Base64', () => {
  const product = { sku: 'sku-1', name: 'Test product', price: 10 };
  assert.equal(createProductSchema({ ...product, metadata: { image: 'https://cdn.example.test/product.jpg' } }).valid, true);
  assert.equal(createProductSchema({ ...product, metadata: { image: 'data:image/png;base64,iVBORw0KGgo=' } }).valid, true);
  assert.equal(createProductSchema({ ...product, metadata: { image: 'iVBORw0KGgo=' } }).valid, false);
  assert.equal(createProductSchema({ ...product, metadata: { image: 'javascript:alert(1)' } }).valid, false);
});

test('product updates accept only bounded HTTP(S) URLs and reject inline or raw image data', () => {
  assert.equal(updateProductSchema({ metadata: { image: 'https://cdn.example.test/product.webp' } }).valid, true);
  assert.equal(updateProductSchema({ metadata: { image: 'DATA:image/png;base64,iVBORw0KGgo=' } }).valid, false);
  assert.equal(updateProductSchema({ metadata: { image: 'iVBORw0KGgo=' } }).valid, false);
  assert.equal(updateProductSchema({ metadata: { image: `https://cdn.example.test/${'x'.repeat(2100)}` } }).valid, false);
});

test('HTTP product routes reject raw Base64 before initializing the Neon client', async () => {
  const secret = 'integration-test-jwt-secret';
  const token = await createToken({ id: 'user-test-id', email: 'test@example.test' }, secret);
  const env = { JWT_SECRET: secret }; // Without DATABASE_URL, reaching a database handler would fail with 500.
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const createResponse = await productRoutes.request('/company-test/products', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sku: 'sku-1', name: 'Test product', price: 10, metadata: { image: 'iVBORw0KGgo=' } }),
  }, env);
  assert.equal(createResponse.status, 400);

  const updateResponse = await productRoutes.request('/company-test/products/product-test', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ metadata: { image: 'iVBORw0KGgo=' } }),
  }, env);
  assert.equal(updateResponse.status, 400);
});

test('keeps the product image limits aligned with the upload interface', () => {
  assert.equal(MAX_PRODUCT_IMAGES, 2);
  assert.equal(MAX_PRODUCT_IMAGE_BYTES, 5 * 1024 * 1024);
});
