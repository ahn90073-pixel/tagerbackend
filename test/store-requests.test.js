import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeStoreSlug, prepareStoreApplication } from '../src/lib/storeRequests.js';

const user = { id: 'user-1', email: 'Merchant@Example.com', full_name: 'مريم علي', phone: '+201001234567' };

test('prepares a complete personal and store application with normalized email and governorate', () => {
  const result = prepareStoreApplication({
    fullName: '  مريم علي  ',
    phone: ' +201001234567 ',
    storeName: '  متجر مريم  ',
    governorate: 'القاهرة',
  }, user);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.application, {
    fullName: 'مريم علي',
    phone: '+201001234567',
    storeName: 'متجر مريم',
    governorate: 'القاهرة',
    email: 'merchant@example.com',
  });
});

test('requires personal contact information, a store name and a valid Egyptian governorate', () => {
  assert.match(prepareStoreApplication({ storeName: 'متجر', governorate: 'القاهرة' }, { email: user.email }).error, /الاسم الكامل/);
  assert.match(prepareStoreApplication({ fullName: 'مريم علي', storeName: 'متجر', governorate: 'القاهرة' }, { ...user, phone: '' }).error, /رقم هاتف/);
  assert.match(prepareStoreApplication({ fullName: 'مريم علي', phone: '+201001234567', storeName: 'متجر', governorate: 'مكة' }, user).error, /محافظة/);
});

test('creates unique safe slugs and uses the existing Arabic-company schema fallback', () => {
  assert.equal(makeStoreSlug('My Shop', 'abc12'), 'my-shop-abc12');
  assert.equal(makeStoreSlug('متجر القاهرة', 'abc12'), 'merchant-abc12');
  assert.match(makeStoreSlug('A'.repeat(100), 'abc12'), /^[a-z0-9-]{1,46}$/);
});

test('tenant provisioning is invoked only by explicit admin approval, never Google sign-in', async () => {
  const migration = await readFile(new URL('../migrations/0010_merchant_store_requests.sql', import.meta.url), 'utf8');
  const googleSection = migration.split('-- Google sign-in creates/links only the user.')[1];
  const approvalSection = migration.split('CREATE OR REPLACE FUNCTION public.approve_merchant_store_request')[1]?.split('-- Google sign-in creates/links only the user.')[0];
  assert.ok(googleSection);
  assert.doesNotMatch(googleSection, /create_company_with_owner|provision_company_schema/i);
  assert.match(approvalSection || '', /create_company_with_owner/i);
  assert.match(migration, /CREATE UNIQUE INDEX[^;]+WHERE status = 'pending'/is);
});
