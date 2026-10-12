import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDocumentBytes, encodeDocumentBytes } from '../src/lib/companyDocumentBlob.js';

test('round-trips arbitrary binary bytes and respects typed-array offsets', () => {
  const source = Uint8Array.from([0xaa, 0x00, 0xff, 0x25, 0x80, 0x7f, 0xbb]);
  const view = source.subarray(1, 6);
  const encoded = encodeDocumentBytes(view);
  const decoded = decodeDocumentBytes(encoded);

  assert.deepEqual(Array.from(decoded), [0x00, 0xff, 0x25, 0x80, 0x7f]);
  assert.equal(encodeDocumentBytes(decoded), encoded);
});

test('round-trips a full 10 MiB document payload', () => {
  const bytes = new Uint8Array(10 * 1024 * 1024);
  bytes[0] = 0x25;
  bytes[1] = 0x50;
  bytes[bytes.length >> 1] = 0xff;
  bytes[bytes.length - 1] = 0xd8;

  const encoded = encodeDocumentBytes(bytes);
  const decoded = decodeDocumentBytes(encoded);

  assert.equal(decoded.byteLength, bytes.byteLength);
  assert.equal(decoded[0], 0x25);
  assert.equal(decoded[1], 0x50);
  assert.equal(decoded[bytes.length >> 1], 0xff);
  assert.equal(decoded[bytes.length - 1], 0xd8);
  assert.equal(encodeDocumentBytes(decoded), encoded);
});
