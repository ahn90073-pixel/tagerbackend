import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { createDb } from '../lib/db.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { createToken } from '../lib/jwt.js';
import { createRefreshSession, generateRefreshToken, hashRefreshToken } from '../lib/refreshSessions.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, isEmail, isString } from '../middleware/validate.js';
import { verifyFirebaseGoogleIdToken } from '../lib/firebaseAuth.js';
import { ARCHIVED_MERCHANT_MESSAGE, findSuspendedCompany } from '../lib/merchantAccess.js';

const auth = new Hono();
const registerSchema = (body) => {
  const errors = [];
  if (!isEmail(body.email)) errors.push({ field: 'email', message: 'A valid email is required' });
  if (!isString(body.password) || body.password.length < 6) errors.push({ field: 'password', message: 'Password must be at least 6 characters' });
  if (body.fullName && body.fullName.length > 100) errors.push({ field: 'fullName', message: 'Full name must be under 100 characters' });
  if (body.phone && body.phone.length > 20) errors.push({ field: 'phone', message: 'Phone must be under 20 characters' });
  return { valid: errors.length === 0, errors };
};
const loginSchema = (body) => {
  const errors = [];
  if (!isEmail(body.email)) errors.push({ field: 'email', message: 'A valid email is required' });
  if (!isString(body.password)) errors.push({ field: 'password', message: 'Password is required' });
  return { valid: errors.length === 0, errors };
};

async function createAuthSession(db, user, secret) {
  const token = await createToken(user, secret);
  const refreshToken = await createRefreshSession(db, user.id);
  return { token, refreshToken };
}

// POST /api/auth/register — account data is written directly to Neon.
auth.post('/register', validate(registerSchema), async (c) => {
  const body = c.get('body');
  const db = createDb(c.env);
  const passwordHash = await bcrypt.hash(body.password, 10);
  try {
    const [user] = await db`
      INSERT INTO users (email, password_hash, full_name, phone)
      VALUES (${body.email.toLowerCase()}, ${passwordHash}, ${body.fullName || null}, ${body.phone || null})
      RETURNING id, email, full_name, phone, is_platform_admin
    `;
    const session = await createAuthSession(db, user, c.env.JWT_SECRET);
    return jsonResponse(created({ user, ...session }, 'Account created successfully'), 201);
  } catch (error) {
    if (error.code === '23505') {
      return errorResponse(String(error.constraint ?? '').includes('phone') ? 'A user with this phone already exists' : 'A user with this email already exists', 409);
    }
    throw error;
  }
});

// POST /api/auth/login
auth.post('/login', validate(loginSchema), async (c) => {
  const body = c.get('body');
  const db = createDb(c.env);
  const [credentials] = await db`
    SELECT id, email, full_name, phone, is_platform_admin, password_hash
    FROM users WHERE email = ${body.email.toLowerCase()} LIMIT 1
  `;
  if (!credentials || !credentials.password_hash || !(await bcrypt.compare(body.password, credentials.password_hash))) {
    return errorResponse('Invalid email or password', 401);
  }
  if (await findSuspendedCompany(db, credentials.id)) {
    return errorResponse(ARCHIVED_MERCHANT_MESSAGE, 403);
  }
  const user = {
    id: credentials.id, email: credentials.email, full_name: credentials.full_name,
    phone: credentials.phone, is_platform_admin: credentials.is_platform_admin,
  };
  const session = await createAuthSession(db, user, c.env.JWT_SECRET);
  return jsonResponse(ok({ user, ...session }, 'Login successful'));
});

// POST /api/auth/google — verify Firebase identity and create/link only the user.
auth.post('/google', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.idToken !== 'string' || !body.idToken || body.idToken.length > 12_000) {
    return errorResponse('بيانات تسجيل Google غير صالحة.', 400);
  }
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (phone.length > 30) return errorResponse('رقم الهاتف غير صالح.', 400);

  let identity;
  try {
    identity = await verifyFirebaseGoogleIdToken(body.idToken, c.env.FIREBASE_PROJECT_ID);
  } catch (error) {
    if (error?.status === 503) return errorResponse('مصادقة Google غير مهيأة على الخادم.', 503);
    console.warn(JSON.stringify({ event: 'firebase_google_token_rejected', reason: error?.code || error?.name || 'invalid_token' }));
    return errorResponse('تعذر التحقق من حساب Google. حدّث التطبيق وحاول مرة أخرى.', 401);
  }
  if (!identity) return errorResponse('يجب استخدام حساب Google ببريد مؤكّد.', 401);

  const db = createDb(c.env);
  let registration;
  try {
    [registration] = await db`
      SELECT * FROM public.register_firebase_google_merchant(
        ${identity.uid}, ${identity.email}, ${identity.fullName || null},
        ${phone || null}, ${null}, ${null}
      )
    `;
  } catch (error) {
    const message = String(error?.message || '');
    if (message.includes('FIREBASE_UID_LINKED') || message.includes('EMAIL_LINKED_TO_ANOTHER_FIREBASE_ACCOUNT')) {
      return errorResponse('هذا البريد مرتبط بهوية Google مختلفة. استخدم الحساب المرتبط أو تواصل مع إدارة المنصة.', 409);
    }
    if (error?.code === '23505') {
      return errorResponse('البريد أو رقم الهاتف مرتبط بالفعل بحساب آخر.', 409);
    }
    throw error;
  }

  if (!registration?.out_user_id) throw new Error('Firebase merchant registration did not return its account.');
  if (await findSuspendedCompany(db, registration.out_user_id)) {
    return errorResponse(ARCHIVED_MERCHANT_MESSAGE, 403);
  }
  const user = {
    id: registration.out_user_id,
    email: registration.out_email,
    full_name: registration.out_full_name,
    phone: registration.out_phone,
    is_platform_admin: registration.out_is_platform_admin,
  };
  const company = registration.out_company_id ? {
    id: registration.out_company_id,
    slug: registration.out_company_slug,
    display_name: registration.out_company_display_name,
    tenant_schema_name: registration.out_tenant_schema_name,
  } : null;
  const session = await createAuthSession(db, user, c.env.JWT_SECRET);
  return jsonResponse(ok({ user, ...session, company }, company
    ? 'تم تسجيل الدخول إلى متجرك.'
    : 'تم تسجيل الدخول. أكمل طلب إنشاء المتجر لإرساله إلى الإدارة للمراجعة.'));
});

// POST /api/auth/refresh — rotate the one-time refresh token and issue a new access token.
auth.post('/refresh', async (c) => {
  const body = await c.req.json().catch(() => null);
  const previousRefreshToken = body?.refreshToken;
  if (typeof previousRefreshToken !== 'string' || previousRefreshToken.length < 32 || previousRefreshToken.length > 200) {
    return errorResponse('Refresh token is invalid.', 400);
  }

  const previousHash = await hashRefreshToken(previousRefreshToken);
  const refreshToken = generateRefreshToken();
  const refreshHash = await hashRefreshToken(refreshToken);
  const db = createDb(c.env);
  const [refreshOwner] = await db`
    SELECT user_id FROM public.auth_refresh_sessions
    WHERE token_hash = ${previousHash}
      AND revoked_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `;
  if (!refreshOwner) return errorResponse('Refresh session expired or revoked.', 401);
  if (await findSuspendedCompany(db, refreshOwner.user_id)) {
    return errorResponse(ARCHIVED_MERCHANT_MESSAGE, 403);
  }
  const [user] = await db`
    WITH rotated AS (
      UPDATE public.auth_refresh_sessions
      SET token_hash = ${refreshHash},
          expires_at = NOW() + INTERVAL '365 days',
          last_used_at = NOW()
      WHERE token_hash = ${previousHash}
        AND revoked_at IS NULL
        AND expires_at > NOW()
      RETURNING user_id
    )
    SELECT u.id, u.email, u.full_name, u.phone, u.is_platform_admin
    FROM rotated r
    JOIN public.users u ON u.id = r.user_id
    LIMIT 1
  `;
  if (!user) return errorResponse('Refresh session expired or revoked.', 401);

  const token = await createToken(user, c.env.JWT_SECRET);
  return jsonResponse(ok({ user, token, refreshToken }, 'Session refreshed'));
});

// POST /api/auth/refresh-token — upgrades a valid pre-refresh-token access session once.
auth.post('/refresh-token', authMiddleware, async (c) => {
  const db = createDb(c.env);
  if (await findSuspendedCompany(db, c.get('user').id)) {
    return errorResponse(ARCHIVED_MERCHANT_MESSAGE, 403);
  }
  const [user] = await db`
    SELECT id, email, full_name, phone, is_platform_admin
    FROM public.users WHERE id = ${c.get('user').id} LIMIT 1
  `;
  if (!user) return errorResponse('User not found', 404);
  const refreshToken = await createRefreshSession(db, user.id);
  return jsonResponse(ok({ refreshToken }, 'Persistent session created'));
});

// POST /api/auth/logout — revoke this device's refresh token; access JWTs expire independently.
auth.post('/logout', async (c) => {
  const body = await c.req.json().catch(() => null);
  const refreshToken = body?.refreshToken;
  if (typeof refreshToken === 'string' && refreshToken.length >= 32 && refreshToken.length <= 200) {
    const tokenHash = await hashRefreshToken(refreshToken);
    const db = createDb(c.env);
    await db`
      UPDATE public.auth_refresh_sessions
      SET revoked_at = NOW(), last_used_at = NOW()
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    `;
  }
  return jsonResponse(ok({ loggedOut: true }, 'Logged out'));
});

// GET /api/auth/me
auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = createDb(c.env);
  if (await findSuspendedCompany(db, user.id)) {
    return errorResponse(ARCHIVED_MERCHANT_MESSAGE, 403);
  }
  const [profile] = await db`SELECT id, email, full_name, phone, is_platform_admin, created_at FROM users WHERE id = ${user.id} LIMIT 1`;
  if (!profile) return errorResponse('User not found', 404);
  const companies = await db`
    SELECT c.id, c.slug, c.legal_name, c.display_name, c.email, c.status, c.created_at, c.updated_at,
           cm.role, cm.is_active AS membership_active
    FROM companies c JOIN company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${user.id} AND cm.is_active = TRUE ORDER BY c.created_at DESC
  `;
  return jsonResponse(ok({ ...profile, companies }));
});

// GET /api/auth/me/companies
auth.get('/me/companies', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = createDb(c.env);
  if (await findSuspendedCompany(db, user.id)) {
    return errorResponse(ARCHIVED_MERCHANT_MESSAGE, 403);
  }
  const companies = await db`
    SELECT c.id, c.slug, c.legal_name, c.display_name, c.email, c.status, c.created_at, c.updated_at,
           cm.role, cm.is_active AS membership_active
    FROM companies c JOIN company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${user.id} AND cm.is_active = TRUE ORDER BY c.created_at DESC
  `;
  return jsonResponse(ok(companies));
});

export default auth;
