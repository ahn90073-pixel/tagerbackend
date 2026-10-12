import { Buffer } from 'node:buffer';

/**
 * Neon HTTP uses JSON parameters. Encode binary payloads as Base64 and decode
 * them in PostgreSQL with decode(value, 'base64') to avoid driver BYTEA issues.
 */
export function encodeDocumentBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
}

export function decodeDocumentBytes(base64) {
  if (typeof base64 !== 'string') throw new TypeError('A Base64 document value is required');
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
