import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getApproximateCloudflareLocation } from '../src/lib/cloudflareLocation.js';
import { upsertMerchantNotificationToken } from '../src/lib/notificationContacts.js';

const migration = readFileSync(new URL('../migrations/0015_merchant_notification_company_location.sql', import.meta.url), 'utf8');
const route = readFileSync(new URL('../src/routes/companies.js', import.meta.url), 'utf8');

test('sanitizes Cloudflare metadata and rounds coordinates to a coarse city-scale point', () => {
  assert.deepEqual(getApproximateCloudflareLocation({
    city: ' القاهرة ',
    region: 'Cairo',
    country: 'eg',
    latitude: '30.0444',
    longitude: '31.2357',
    ip: '203.0.113.7',
  }), {
    city: 'القاهرة',
    region: 'Cairo',
    country: 'EG',
    latitude: 30,
    longitude: 31.2,
  });
});

test('rejects invalid coordinates and malformed country codes without storing IP metadata', () => {
  assert.deepEqual(getApproximateCloudflareLocation({
    city: 'Alexandria', country: 'Egypt', latitude: '91', longitude: 'not-a-number', ip: '203.0.113.7',
  }), {
    city: 'Alexandria', region: null, country: null, latitude: null, longitude: null,
  });
  assert.doesNotMatch(migration, /ADD COLUMN[^;]*\bip\b/i);
});

test('merchant token upsert stores company snapshot and IP-derived location in PostGIS', async () => {
  let capturedSql = '';
  let capturedValues = [];
  const db = {
    query: async (sql, values) => {
      capturedSql = sql;
      capturedValues = values;
      return [{ id: 'contact-1' }];
    },
  };
  const location = getApproximateCloudflareLocation({ city: 'Cairo', region: 'Cairo', country: 'EG', latitude: 30.0444, longitude: 31.2357 });
  const result = await upsertMerchantNotificationToken(db, {
    companyId: 'company-1', userId: 'user-1', phone: '+201000000000', token: 'fcm-token',
    platform: 'android', appVersion: '1.1.8', companyName: 'شركة النيل', location,
  });
  assert.equal(result.id, 'contact-1');
  assert.match(capturedSql, /company_name, location_city, location_region, location_country, location_point/);
  assert.match(capturedSql, /ST_SetSRID\(ST_MakePoint\(\$13::double precision, \$12::double precision\), 4326\)::geography/);
  assert.match(capturedSql, /location_point = COALESCE\(EXCLUDED\.location_point, notification_contacts\.location_point\)/);
  assert.deepEqual(capturedValues.slice(7), ['شركة النيل', 'Cairo', 'Cairo', 'EG', 30, 31.2]);
});

test('migration adds idempotent company and PostGIS fields and backfills verified company names', () => {
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS postgis/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS company_name TEXT/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS location_point geography\(Point, 4326\)/i);
  assert.match(migration, /UPDATE public\.notification_contacts[\s\S]*FROM public\.companies/i);
  assert.match(migration, /USING GIST \(location_point\)/i);
});

test('merchant token endpoint uses the authenticated company name and Cloudflare metadata', () => {
  assert.match(route, /SELECT COALESCE\(NULLIF\(BTRIM\(display_name\), ''\), NULLIF\(BTRIM\(legal_name\), ''\)\) AS company_name/);
  assert.match(route, /companyName: company\?\.company_name/);
  assert.match(route, /getApproximateCloudflareLocation\(c\.req\.raw\?\.cf\)/);
});
