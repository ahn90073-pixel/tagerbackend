import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { createDb } from '../lib/db.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { createToken } from '../lib/jwt.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, isEmail, isString } from '../middleware/validate.js';
import { verifyFirebaseGoogleIdToken } from '../lib/firebaseAuth.js';

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
    const token = await createToken(user, c.env.JWT_SECRET);
    return jsonResponse(created({ user, token }, 'Account created successfully'), 201);
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
  const user = {
    id: credentials.id, email: credentials.email, full_name: credentials.full_name,
    phone: credentials.phone, is_platform_admin: credentials.is_platform_admin,
  };
  const token = await createToken(user, c.env.JWT_SECRET);
  return jsonResponse(ok({ user, token }, 'Login successful'));
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
  const token = await createToken(user, c.env.JWT_SECRET);
  return jsonResponse(ok({ user, token, company }, company
    ? 'تم تسجيل الدخول إلى متجرك.'
    : 'تم تسجيل الدخول. أكمل طلب إنشاء المتجر لإرساله إلى الإدارة للمراجعة.'));
});

// GET /api/auth/me
auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = createDb(c.env);
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
  const companies = await db`
    SELECT c.id, c.slug, c.legal_name, c.display_name, c.email, c.status, c.created_at, c.updated_at,
           cm.role, cm.is_active AS membership_active
    FROM companies c JOIN company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${user.id} AND cm.is_active = TRUE ORDER BY c.created_at DESC
  `;
  return jsonResponse(ok(companies));
});

export default auth;
