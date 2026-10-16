export const CATALOG_MANIFEST_KEY = 'product-catalog:current';
export const CATALOG_CHUNK_PREFIX = 'product-catalog:snapshot';
export const CATALOG_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_TTL_SECONDS = 60 * 60 * 48;

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

export function splitCatalogIntoChunks(products, maxBytes = CATALOG_CHUNK_MAX_BYTES) {
  if (!Array.isArray(products)) throw new TypeError('Catalog products must be an array.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new RangeError('Chunk size must be at least 256 bytes.');

  const chunks = [];
  let current = [];
  for (const product of products) {
    const candidate = [...current, product];
    const serialized = JSON.stringify(candidate);
    if (utf8Bytes(serialized) > maxBytes) {
      if (!current.length) throw new RangeError('A product exceeds the maximum KV chunk size.');
      chunks.push(current);
      current = [product];
      if (utf8Bytes(JSON.stringify(current)) > maxBytes) throw new RangeError('A product exceeds the maximum KV chunk size.');
    } else {
      current = candidate;
    }
  }
  if (current.length || chunks.length === 0) chunks.push(current);
  return chunks;
}

export function filterAndPageCatalog(products, { page = 1, limit = 60, search = '', category = '' } = {}) {
  const normalizedSearch = String(search || '').trim().toLocaleLowerCase();
  const normalizedCategory = String(category || '').trim();
  const filtered = products.filter((product) => {
    if (normalizedCategory && product.category !== normalizedCategory) return false;
    if (!normalizedSearch) return true;
    return [product.name, product.description, product.sellerName, product.vendorName, product.category, product.brand]
      .some((value) => String(value || '').toLocaleLowerCase().includes(normalizedSearch));
  });
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 60)));
  const offset = (safePage - 1) * safeLimit;
  return {
    items: filtered.slice(offset, offset + safeLimit),
    pagination: { page: safePage, limit: safeLimit, total: filtered.length, totalPages: Math.ceil(filtered.length / safeLimit) },
  };
}

export async function readCatalogSnapshot(kv) {
  const manifest = await kv.get(CATALOG_MANIFEST_KEY, { type: 'json' });
  if (!manifest || !Array.isArray(manifest.chunkKeys) || !Number.isInteger(manifest.productCount)) return null;
  const chunks = await Promise.all(manifest.chunkKeys.map((key) => kv.get(key, { type: 'json' })));
  if (chunks.some((chunk) => !Array.isArray(chunk))) return null;
  const products = chunks.flat();
  if (products.length !== manifest.productCount) return null;
  return { products, updatedAt: manifest.updatedAt || null, version: manifest.version || null };
}

export async function writeCatalogSnapshot(kv, products, now = new Date()) {
  const chunks = splitCatalogIntoChunks(products);
  const version = String(now instanceof Date ? now.getTime() : new Date(now).getTime());
  const chunkKeys = chunks.map((_, index) => `${CATALOG_CHUNK_PREFIX}:${version}:${index}`);

  for (let index = 0; index < chunks.length; index += 1) {
    await kv.put(chunkKeys[index], JSON.stringify(chunks[index]), { expirationTtl: SNAPSHOT_TTL_SECONDS });
  }

  const manifest = {
    version,
    updatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    productCount: products.length,
    chunkKeys,
  };
  // Publish the pointer last: readers never see a snapshot until all chunks are written.
  await kv.put(CATALOG_MANIFEST_KEY, JSON.stringify(manifest));
  return manifest;
}
