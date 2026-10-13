import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeStoreSlug, prepareCompleteStoreApplication, prepareStoreApplication } from '../src/lib/storeRequests.js';

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

test('prepares the full commercial profile for a private store application', () => {
  const result = prepareCompleteStoreApplication({
    fullName: 'مريم علي',
    phone: '+201001234567',
    profileData: {
      legalName: 'شركة مريم للتجارة',
      displayName: 'متجر مريم',
      email: 'company@example.com',
      commercialRegisterNumber: '123456',
      taxId: '654321',
      warehouseAddress: { governorate: ' القاهرة ', city: 'مدينة نصر', street: 'شارع المثال 1' },
      payoutMethod: 'instapay',
      payoutNumber: 'mariam@instapay',
    },
  }, user);
  assert.equal(result.error, undefined);
  assert.equal(result.application.governorate, 'القاهرة');
  assert.equal(result.application.storeName, 'متجر مريم');
  assert.equal(result.application.profileData.email, 'company@example.com');
  assert.equal(result.application.profileData.warehouseAddress.governorate, 'القاهرة');
});

test('rejects incomplete commercial profile fields before draft save', () => {
  const result = prepareCompleteStoreApplication({
    fullName: 'مريم علي',
    phone: '+201001234567',
    profileData: {
      legalName: 'شركة مريم', displayName: 'متجر مريم', email: 'company@example.com',
      commercialRegisterNumber: '', taxId: '', warehouseAddress: { governorate: 'القاهرة', city: '', street: '' },
      payoutMethod: '', payoutNumber: '',
    },
  }, user);
  assert.match(result.error, /رقم السجل التجاري/);
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

test('full-profile migration stores documents privately and requires them before provisioning', async () => {
  const migration = await readFile(new URL('../migrations/0011_merchant_store_request_profile.sql', import.meta.url), 'utf8');
  assert.match(migration, /merchant_store_request_document_blobs/);
  assert.match(migration, /status IN \('draft', 'pending', 'approved', 'rejected'\)/);
  assert.match(migration, /STORE_REQUEST_PROFILE_INCOMPLETE/);
  assert.match(migration, /COUNT\(DISTINCT d\.document_type\)[\s\S]+< 3/);
  assert.match(migration, /INSERT INTO public\.company_profile_document_blobs/);
  assert.match(migration, /create_company_with_owner/i);
});
