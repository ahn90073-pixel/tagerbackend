export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PRODUCT_IMAGES = 2;
export const MAX_PRODUCT_CREATE_REQUEST_BYTES = MAX_PRODUCT_IMAGE_BYTES * MAX_PRODUCT_IMAGES + 1024 * 1024;

export function isProductImageDataUrl(value) {
  return typeof value === 'string' && /^data:/i.test(value);
}

export function isHttpProductImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && Boolean(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function detectProductImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { contentType: 'image/png', extension: 'png' };
  }

  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }

  return null;
}

export function decodeProductImageDataUrl(value) {
  if (typeof value !== 'string') return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match || match[2].length === 0 || match[2].length > Math.ceil(MAX_PRODUCT_IMAGE_BYTES / 3) * 4) return null;

  let binary;
  try {
    binary = atob(match[2]);
  } catch {
    return null;
  }

  if (binary.length === 0 || binary.length > MAX_PRODUCT_IMAGE_BYTES) return null;
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const detected = detectProductImageType(bytes);
  if (!detected || detected.contentType !== match[1].toLowerCase()) return null;
  return { bytes, ...detected };
}
