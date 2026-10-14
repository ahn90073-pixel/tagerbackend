const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const JWT_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToBytes(pem) {
  const normalized = String(pem).replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeJwtPart(value) {
  return base64UrlEncode(JSON.stringify(value));
}

async function createServiceAccountAssertion(serviceAccount, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) throw new Error('FCM service account is incomplete.');
  const header = encodeJwtPart({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeJwtPart({
    iss: serviceAccount.client_email,
    scope: FCM_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
  const unsignedToken = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBytes(serviceAccount.private_key),
    JWT_ALGORITHM,
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(JWT_ALGORITHM, key, new TextEncoder().encode(unsignedToken));
  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

async function getOAuthAccessToken(serviceAccount, fetchImpl = fetch) {
  const assertion = await createServiceAccountAssertion(serviceAccount);
  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!response.ok) throw new Error(`FCM OAuth token request failed (${response.status}).`);
  const body = await response.json();
  if (!body?.access_token) throw new Error('FCM OAuth token response was incomplete.');
  return body.access_token;
}

function parseServiceAccount(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function serviceAccountFor(env, appName = 'taget') {
  const raw = appName === 'online-store'
    ? env?.FCM_PUBLIC_SERVICE_ACCOUNT_JSON
    : env?.FCM_SERVICE_ACCOUNT_JSON;
  return parseServiceAccount(raw);
}

function stringData(data = {}) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [String(key), String(value)]));
}

/**
 * Send one FCM HTTP v1 message. Tokens and credentials are intentionally never
 * included in logs or returned values.
 */
export async function sendFcmMessage({ env, token, title, body, data = {}, appName = 'taget', fetchImpl = fetch }) {
  const serviceAccount = serviceAccountFor(env, appName);
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    return { ok: false, reason: 'configuration_missing' };
  }
  if (typeof token !== 'string' || token.length < 1 || token.length > 4096) {
    return { ok: false, reason: 'invalid_token' };
  }
  const projectId = serviceAccount.project_id
    || (appName === 'online-store' ? env?.FIREBASE_PUBLIC_PROJECT_ID : env?.FIREBASE_PROJECT_ID);
  if (!projectId) return { ok: false, reason: 'configuration_missing' };
  const accessToken = await getOAuthAccessToken(serviceAccount, fetchImpl);
  const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title: String(title), body: String(body) }, data: stringData(data) } }),
  });
  if (!response.ok) return { ok: false, reason: 'delivery_failed', status: response.status };
  return { ok: true };
}

export const fcmInternals = { base64UrlEncode, createServiceAccountAssertion, getOAuthAccessToken, parseServiceAccount, serviceAccountFor, stringData };
