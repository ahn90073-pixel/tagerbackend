import test from 'node:test';
import assert from 'node:assert/strict';
import { EGYPT_GOVERNORATES, normalizeGovernorate } from '../src/lib/governorates.js';

test('merchant registration governorate list contains 27 unique governorates', () => {
  assert.equal(EGYPT_GOVERNORATES.length, 27);
  assert.equal(new Set(EGYPT_GOVERNORATES).size, 27);
});

test('governorate validation trims harmless whitespace but rejects unknown values', () => {
  assert.equal(normalizeGovernorate('  القاهرة  '), 'القاهرة');
  assert.equal(normalizeGovernorate('  البحر   الأحمر  '), 'البحر الأحمر');
  assert.equal(normalizeGovernorate('مكة'), null);
  assert.equal(normalizeGovernorate(''), null);
  assert.equal(normalizeGovernorate(null), null);
});
