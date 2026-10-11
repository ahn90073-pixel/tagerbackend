import { createRemoteJWKSet, jwtVerify } from 'jose';

const FIREBASE_GOOGLE_JWKS_URL = new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
);
const jwksByProject = new Map();

function getFirebaseJwks(projectId) {
  if (!jwksByProject.has(projectId)) {
    jwksByProject.set(projectId, createRemoteJWKSet(FIREBASE_GOOGLE_JWKS_URL));
  }
  return jwksByProject.get(projectId);
}

export function validateFirebaseGoogleClaims(payload, projectId) {
  if (!projectId || payload?.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (payload?.aud !== projectId || typeof payload?.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 128) return null;
  if (payload.email_verified !== true || typeof payload.email !== 'string') return null;
  if (payload.firebase?.sign_in_provider !== 'google.com') return null;

  const email = payload.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;

  return {
    uid: payload.sub,
    email,
    fullName: typeof payload.name === 'string' ? payload.name.trim().slice(0, 100) : '',
  };
}

export async function verifyFirebaseGoogleIdToken(idToken, projectId) {
  if (!projectId) {
    const error = new Error('Firebase Google authentication is not configured.');
    error.status = 503;
    throw error;
  }
  if (typeof idToken !== 'string' || idToken.length > 12_000) return null;

  const { payload, protectedHeader } = await jwtVerify(idToken, getFirebaseJwks(projectId), {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ['RS256'],
  });
  if (protectedHeader.alg !== 'RS256') return null;
  return validateFirebaseGoogleClaims(payload, projectId);
}
