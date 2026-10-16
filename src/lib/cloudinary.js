const CLOUDINARY_KEYS = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];

export function cloudinaryConfigState(env = {}) {
  const configured = CLOUDINARY_KEYS.filter((key) => typeof env[key] === 'string' && env[key].trim());
  if (configured.length === 0) return 'missing';
  if (configured.length !== CLOUDINARY_KEYS.length) return 'partial';
  return 'ready';
}

function canonicalizeUploadParams(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');
}

export async function createCloudinarySignature(params, apiSecret, cryptoProvider = globalThis.crypto) {
  if (!apiSecret || !cryptoProvider?.subtle) throw new Error('Cloudinary signing is not configured.');
  const payload = `${canonicalizeUploadParams(params)}${apiSecret}`;
  const digest = await cryptoProvider.subtle.digest('SHA-1', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function uploadProductImage(env, {
  bytes,
  contentType,
  extension,
  companyId,
  imageId,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
}) {
  if (cloudinaryConfigState(env) !== 'ready') throw new Error('Cloudinary is not fully configured.');
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('Product image data is empty.');

  const timestamp = Math.floor(now / 1000);
  const params = {
    asset_folder: `tager/products/${companyId}`,
    public_id: imageId,
    timestamp,
  };
  const signature = await createCloudinarySignature(params, env.CLOUDINARY_API_SECRET);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), `${imageId}.${extension}`);
  form.append('api_key', env.CLOUDINARY_API_KEY.trim());
  for (const [key, value] of Object.entries(params)) form.append(key, String(value));
  form.append('signature', signature);

  const cloudName = env.CLOUDINARY_CLOUD_NAME.trim();
  const response = await fetchImpl(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, {
    method: 'POST',
    body: form,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || typeof result?.secure_url !== 'string') {
    throw new Error(`Cloudinary upload failed with status ${response.status}.`);
  }

  let secureUrl;
  try {
    secureUrl = new URL(result.secure_url);
  } catch {
    throw new Error('Cloudinary returned an invalid secure URL.');
  }
  if (secureUrl.protocol !== 'https:') throw new Error('Cloudinary did not return an HTTPS image URL.');

  return {
    secureUrl: secureUrl.toString(),
    publicId: result.public_id || imageId,
    assetId: result.asset_id || null,
  };
}
