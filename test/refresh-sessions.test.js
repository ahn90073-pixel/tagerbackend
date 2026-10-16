import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateRefreshToken, hashRefreshToken } from '../src/lib/refreshSessions.js';
import authRoutes from '../src/routes/auth.js';

const migration = new URL('../migrations/0017_auth_refresh_sessions.sql', import.meta.url);

test('refresh tokens are high-entropy URL-safe opaque values', () => {
  const first = generateRefreshToken();
  const second = generateRefreshToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test('refresh token hashing is deterministic and does not expose the raw token', async () => {
  const token = generateRefreshToken();
  const firstHash = await hashRefreshToken(token);
  assert.equal(firstHash, await hashRefreshToken(token));
  assert.match(firstHash, /^[a-f0-9]{64}$/);
  assert.notEqual(firstHash, token);
  await assert.rejects(() => hashRefreshToken('short'), /invalid/i);
});

test('refresh route rejects malformed tokens before opening a database connection', async () => {
  const response = await authRoutes.request('/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: 'too-short' }),
  }, {});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).success, false);
});

test('refresh session migration stores only unique hashes and supports expiry and revocation', async () => {
  const sql = await readFile(migration, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.auth_refresh_sessions/i);
  assert.match(sql, /user_id UUID NOT NULL REFERENCES public\.users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /revoked_at TIMESTAMPTZ/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/i);
});
