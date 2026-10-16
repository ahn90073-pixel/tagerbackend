import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeEgyptPhone } from '../src/lib/phone.js';
import { encodeJwtPart, fcmInternals } from '../src/lib/fcm.js';
import { getCloudflareLocation, validateCheckoutPayload } from '../src/routes/storefront.js';

function decodeBase64Url(value) {
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - value.length % 4) % 4)}`;
  return Buffer.from(padded, 'base64').toString('utf8');
}

test('normalizes Egyptian local mobile numbers to E.164', () => {
  assert.equal(normalizeEgyptPhone('010 1234 5678'), '+201012345678');
  assert.equal(normalizeEgyptPhone('+20 (10) 1234-5678'), '+201012345678');
  assert.equal(normalizeEgyptPhone('00201012345678'), '+201012345678');
  assert.equal(normalizeEgyptPhone('01112345678'), '+201112345678');
  assert.equal(normalizeEgyptPhone('02012345678'), null);
});

test('extracts only bounded city, region, and country labels from Cloudflare metadata', () => {
  assert.deepEqual(getCloudflareLocation({ cf: {
    city: ' Cairo ', region: 'Cairo Governorate', country: 'eg', ip: '203.0.113.1', latitude: '30.0',
  } }), {
    locationCity: 'Cairo', locationRegion: 'Cairo Governorate', locationCountry: 'EG',
  });
  assert.deepEqual(getCloudflareLocation({ cf: { city: 'x'.repeat(120), country: 'Egypt' } }), {
    locationCity: 'x'.repeat(100), locationRegion: null, locationCountry: null,
  });
  assert.deepEqual(getCloudflareLocation({}), {
    locationCity: null, locationRegion: null, locationCountry: null,
  });
});

test('encodes JWT parts as URL-safe JSON and keeps FCM data string-only', () => {
  assert.deepEqual(JSON.parse(decodeBase64Url(encodeJwtPart({ alg: 'RS256', typ: 'JWT' }))), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(fcmInternals.stringData({ orderId: 42, enabled: true, empty: null }), { orderId: '42', enabled: 'true', empty: 'null' });
});

test('validates checkout notification consent and bounded device fields', () => {
  const base = {
    customer: { fullName: 'مها أحمد', phone: '+201012345678' },
    address: { governorate: 'القاهرة', city: 'مدينة نصر', street: 'شارع رئيسي' },
    items: [{ productId: '4c606bbc-2f91-4c84-9c2e-1189c25163b0', vendorId: 'cf11af60-946d-4197-b5e1-6d68b69a8e9a', quantity: 1 }],
  };
  assert.deepEqual(validateCheckoutPayload({ ...base, notificationConsent: true }), ['رمز ومنصة الإشعارات مطلوبان عند الموافقة.']);
  assert.ok(validateCheckoutPayload({ ...base, notificationConsent: 'yes' }).some((error) => error.includes('موافقة')));
  assert.ok(validateCheckoutPayload({ ...base, fcmToken: 'x'.repeat(4097), platform: 'android' }).some((error) => error.includes('رمز')));
});

test('notification migration declares public idempotent objects and ready shipment support', () => {
  const migration = readFileSync(new URL('../migrations/0012_notification_contacts.sql', import.meta.url), 'utf8');
  const tenantMigration = readFileSync(new URL('../migrations/0003_tenant_data_tables.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.notification_contacts/i);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS notification_contacts_token_uq/i);
  assert.match(migration, /public\.companies/i);
  assert.match(migration, /public\.users/i);
  assert.match(migration, /audience = 'merchant'.*user_id IS NOT NULL/is);
  assert.match(migration, /audience = 'customer'.*whatsapp_phone IS NOT NULL/is);
  assert.match(tenantMigration, /status IN \('pending', 'ready', 'label_created'/i);
});

test('customer device-token migration permits pre-checkout registration and deduplicates device tokens', () => {
  const migration = readFileSync(new URL('../migrations/0013_unlinked_customer_notification_tokens.sql', import.meta.url), 'utf8');
  assert.match(migration, /ALTER COLUMN company_id DROP NOT NULL/i);
  assert.match(migration, /audience = 'customer' AND \(company_id IS NULL OR whatsapp_phone IS NOT NULL\)/i);
  assert.match(migration, /notification_contacts_customer_device_token_uq/i);
});

test('customer IP-location migration stores only coarse location labels', () => {
  const migration = readFileSync(new URL('../migrations/0014_notification_contact_ip_location.sql', import.meta.url), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS location_city TEXT/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS location_region TEXT/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS location_country TEXT/i);
  assert.doesNotMatch(migration, /ip_address|latitude|longitude/i);
});
