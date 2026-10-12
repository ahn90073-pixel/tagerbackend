import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCompanyDocumentType,
  getCompanyProfileCompletion,
  mergeCompanyProfile,
  validateCompanyProfile,
} from '../src/lib/companyProfile.js';

const completeCompany = {
  legal_name: 'شركة النور',
  display_name: 'متجر النور',
  email: 'owner@example.com',
  commercial_register_number: '123456',
  tax_id: '987654',
  warehouse_address: { governorate: 'القاهرة', city: 'مدينة نصر', street: 'شارع المثال 1' },
  payout_method: 'instapay',
  payout_number: 'owner@instapay',
};
const allDocuments = ['nationalId', 'commercialRegister', 'propertyContract'].map((document_type) => ({ document_type }));

test('accepts a trimmed partial company profile so merchants can save progress', () => {
  const result = validateCompanyProfile({
    legalName: ' شركة النور ',
    displayName: ' متجر النور ',
    email: 'owner@example.com',
    commercialRegisterNumber: '',
    taxId: '',
    warehouseAddress: { governorate: '', city: '', street: '' },
    payoutMethod: '',
    payoutNumber: '',
  });
  assert.equal(result.valid, true);
  assert.equal(result.value.legalName, 'شركة النور');
  assert.equal(result.value.commercialRegisterNumber, null);
  assert.deepEqual(result.value.warehouseAddress, { governorate: '', city: '', street: '' });
});

test('rejects invalid company identity, email, payout method, and excessive lengths', () => {
  const result = validateCompanyProfile({
    legalName: 'x',
    displayName: 'x',
    email: 'not-an-email',
    commercialRegisterNumber: '1'.repeat(101),
    taxId: '',
    warehouseAddress: { governorate: '', city: '', street: '' },
    payoutMethod: 'crypto',
    payoutNumber: '1'.repeat(101),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.field === 'legalName'));
  assert.ok(result.errors.some((error) => error.field === 'email'));
  assert.ok(result.errors.some((error) => error.field === 'payoutMethod'));
});

test('merges sparse updates with persisted company data without clearing unrelated fields', () => {
  const merged = mergeCompanyProfile({
    legal_name: 'شركة النور',
    display_name: 'متجر النور',
    email: 'owner@example.com',
    commercial_register_number: '123456',
    tax_id: '987654',
    warehouse_address: { governorate: 'القاهرة', city: 'مدينة نصر', street: 'شارع المثال 1' },
    payout_method: 'instapay',
    payout_number: 'owner@instapay',
  }, { taxId: '222222' });
  assert.equal(merged.commercialRegisterNumber, '123456');
  assert.equal(merged.taxId, '222222');
  assert.deepEqual(merged.warehouseAddress, { governorate: 'القاهرة', city: 'مدينة نصر', street: 'شارع المثال 1' });
  assert.equal(merged.payoutNumber, 'owner@instapay');
});

test('keeps an incomplete profile at zero and reports all required sections', () => {
  const result = getCompanyProfileCompletion({}, []);
  assert.equal(result.percentage, 0);
  assert.equal(result.isComplete, false);
  assert.equal(result.totalCount, 8);
  assert.equal(result.checks.filter((check) => !check.complete).length, 8);
});

test('marks the profile complete only after every field and private document exists', () => {
  const result = getCompanyProfileCompletion(completeCompany, allDocuments);
  assert.equal(result.percentage, 100);
  assert.equal(result.completedCount, 8);
  assert.equal(result.isComplete, true);
});

test('detects supported PDF, JPEG, and PNG signatures rather than trusting file names', () => {
  assert.equal(detectCompanyDocumentType(Buffer.from('%PDF-1.7')).contentType, 'application/pdf');
  assert.equal(detectCompanyDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0x00])).contentType, 'image/jpeg');
  assert.equal(detectCompanyDocumentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).contentType, 'image/png');
  assert.equal(detectCompanyDocumentType(Buffer.from('not a document')), null);
});
