import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_MANIFEST_KEY,
  filterAndPageCatalog,
  readCatalogSnapshot,
  splitCatalogIntoChunks,
  writeCatalogSnapshot,
} from '../src/lib/productCatalogCache.js';

function memoryKv() {
  const values = new Map();
  return {
    values,
    async get(key, options = {}) {
      const value = values.get(key);
      if (value === undefined) return null;
      return options.type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, value); },
  };
}

const products = [
  { id: '1', name: 'هاتف تجريبي', category: 'هواتف', sellerName: 'تاجر أ' },
  { id: '2', name: 'حقيبة', category: 'حقائب', sellerName: 'تاجر ب' },
  { id: '3', name: 'هاتف آخر', category: 'هواتف', sellerName: 'تاجر أ' },
];

test('splits a catalog into UTF-8 sized chunks and preserves every product', () => {
  const largeProducts = products.map((product) => ({ ...product, description: 'وصف'.repeat(40) }));
  const chunks = splitCatalogIntoChunks(largeProducts, 512);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), largeProducts);
});

test('writes chunk data before publishing a readable manifest snapshot', async () => {
  const kv = memoryKv();
  const manifest = await writeCatalogSnapshot(kv, products, new Date('2026-10-17T00:00:00.000Z'));
  assert.equal(manifest.productCount, 3);
  assert.ok(kv.values.has(CATALOG_MANIFEST_KEY));
  const snapshot = await readCatalogSnapshot(kv);
  assert.deepEqual(snapshot.products, products);
  assert.equal(snapshot.updatedAt, '2026-10-17T00:00:00.000Z');
});

test('does not expose an incomplete snapshot if one chunk is missing', async () => {
  const kv = memoryKv();
  const manifest = await writeCatalogSnapshot(kv, products, new Date('2026-10-17T00:00:00.000Z'));
  kv.values.delete(manifest.chunkKeys[0]);
  assert.equal(await readCatalogSnapshot(kv), null);
});

test('filters and paginates cached products with storefront-compatible search', () => {
  const result = filterAndPageCatalog(products, { search: 'هاتف', category: 'هواتف', page: 2, limit: 1 });
  assert.deepEqual(result.items.map((product) => product.id), ['3']);
  assert.deepEqual(result.pagination, { page: 2, limit: 1, total: 2, totalPages: 2 });
});
