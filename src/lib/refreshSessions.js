const REFRESH_SESSION_TTL_DAYS = 365;

export function generateRefreshToken(cryptoApi = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function hashRefreshToken(token, cryptoApi = globalThis.crypto) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 200) {
    throw new TypeError('Refresh token is invalid.');
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createRefreshSession(db, userId) {
  const refreshToken = generateRefreshToken();
  const tokenHash = await hashRefreshToken(refreshToken);
  await db`
    INSERT INTO public.auth_refresh_sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, NOW() + (${REFRESH_SESSION_TTL_DAYS} * INTERVAL '1 day'))
  `;
  return refreshToken;
}
