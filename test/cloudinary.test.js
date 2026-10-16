import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cloudinaryConfigState, createCloudinarySignature, uploadProductImage } from '../src/lib/cloudinary.js';

const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const env = {
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
};

test('Cloudinary configuration distinguishes missing, partial, and complete credentials', () => {
  assert.equal(cloudinaryConfigState({}), 'missing');
  assert.equal(cloudinaryConfigState({ CLOUDINARY_CLOUD_NAME: 'test-cloud' }), 'partial');
  assert.equal(cloudinaryConfigState(env), 'ready');
});

test('upload signature sorts parameter names and appends the API secret', async () => {
  const params = { timestamp: 1700000000, public_id: 'image-uuid', asset_folder: 'tager/products/company-id' };
  const expectedPayload = 'asset_folder=tager/products/company-id&public_id=image-uuid&timestamp=1700000000test-secret';
  const expected = createHash('sha1').update(expectedPayload).digest('hex');
  assert.equal(await createCloudinarySignature(params, 'test-secret'), expected);
});

test('product image upload sends a signed multipart request and returns only the secure URL metadata', async () => {
  let requestUrl;
  let requestInit;
  const result = await uploadProductImage(env, {
    bytes,
    contentType: 'image/jpeg',
    extension: 'jpg',
    companyId: 'company-id',
    imageId: 'image-uuid',
    now: 1700000000000,
    fetchImpl: async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1700000000/image-uuid.jpg',
          public_id: 'image-uuid',
          asset_id: 'asset-uuid',
        }),
      };
    },
  });

  assert.equal(requestUrl, 'https://api.cloudinary.com/v1_1/test-cloud/image/upload');
  assert.equal(requestInit.method, 'POST');
  assert.ok(requestInit.body instanceof FormData);
  assert.equal(requestInit.body.get('api_key'), 'test-key');
  assert.equal(requestInit.body.get('asset_folder'), 'tager/products/company-id');
  assert.equal(requestInit.body.get('public_id'), 'image-uuid');
  assert.equal(requestInit.body.get('timestamp'), '1700000000');
  assert.match(requestInit.body.get('signature'), /^[a-f0-9]{40}$/);
  assert.equal(result.secureUrl, 'https://res.cloudinary.com/test-cloud/image/upload/v1700000000/image-uuid.jpg');
  assert.equal(result.publicId, 'image-uuid');
  assert.equal(result.assetId, 'asset-uuid');
});

test('product image upload rejects incomplete credentials and non-HTTPS delivery URLs', async () => {
  await assert.rejects(
    () => uploadProductImage({ CLOUDINARY_CLOUD_NAME: 'test-cloud' }, {
      bytes, contentType: 'image/jpeg', extension: 'jpg', companyId: 'company-id', imageId: 'image-uuid',
    }),
    /not fully configured/,
  );
  await assert.rejects(
    () => uploadProductImage(env, {
      bytes,
      contentType: 'image/jpeg',
      extension: 'jpg',
      companyId: 'company-id',
      imageId: 'image-uuid',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ secure_url: 'http://res.cloudinary.com/test/image.jpg' }) }),
    }),
    /HTTPS/,
  );
});
