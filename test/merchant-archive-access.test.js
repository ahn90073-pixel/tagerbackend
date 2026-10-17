import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVED_MERCHANT_MESSAGE, findSuspendedCompany } from '../src/lib/merchantAccess.js';
import { requireCompanyTenant } from '../src/lib/tenantDb.js';

function mockDb(rows) {
  const calls = [];
  const db = async (strings, ...values) => {
    calls.push({ sql: strings.join('?'), values });
    return rows;
  };
  db.calls = calls;
  return db;
}

test('findSuspendedCompany finds a suspended company for an active membership', async () => {
  const company = { id: 'company-1', display_name: 'متجر مؤرشف' };
  const db = mockDb([company]);

  assert.deepEqual(await findSuspendedCompany(db, 'user-1'), company);
  assert.match(db.calls[0].sql, /cm\.is_active = TRUE/);
  assert.match(db.calls[0].sql, /c\.status = 'suspended'/);
  assert.deepEqual(db.calls[0].values, ['user-1']);
  assert.match(ARCHIVED_MERCHANT_MESSAGE, /محفوظة/);
});

test('requireCompanyTenant rejects an archived company without returning its schema', async () => {
  const db = mockDb([{
    tenant_schema_name: 'tenant_store_12345678',
    company_status: 'suspended',
    is_active: true,
  }]);

  const result = await requireCompanyTenant(db, 'company-1', 'user-1');
  assert.equal(result.schema, undefined);
  assert.equal(result.error.status, 403);
  const body = await result.error.json();
  assert.match(body.message, /أرشفته|إيقاف/);
});

test('requireCompanyTenant continues to allow an active company and preserve its schema', async () => {
  const db = mockDb([{
    tenant_schema_name: 'tenant_store_12345678',
    company_status: 'active',
    is_active: true,
  }]);

  const result = await requireCompanyTenant(db, 'company-1', 'user-1');
  assert.deepEqual(result, { schema: 'tenant_store_12345678' });
});
