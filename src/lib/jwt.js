import { sign, verify } from 'hono/utils/jwt/jwt';

function requireJwtSecret(secret) {
  if (typeof secret !== 'string' || !secret.trim()) {
    const error = new Error('JWT_SECRET is not available in this Worker.');
    error.status = 503;
    error.code = 'JWT_SECRET_MISSING';
    throw error;
  }
  return secret;
}

/**
 * Creates a JWT token for the authenticated user.
 * Uses Hono's built-in JWT utilities (Web Crypto API — Edge-compatible).
 */
export async function createToken(user, secret) {
  secret = requireJwtSecret(secret);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.id,
    email: user.email,
    is_platform_admin: user.is_platform_admin || false,
    iat: now,
    exp: now + 60 * 60 * 24 * 7, // 7 days
  };
  return await sign(payload, secret, 'HS256');
}

/**
 * Verifies a JWT token and returns the payload.
 * Throws if invalid or expired.
 */
export async function verifyToken(token, secret) {
  secret = requireJwtSecret(secret);
  return await verify(token, secret, 'HS256');
}
