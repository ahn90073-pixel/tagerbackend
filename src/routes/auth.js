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

// POST /api/auth/google — verify a Firebase Google ID token, then atomically
// create/link the Neon user, owner membership, company, and tenant schema.
auth.post('/google', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.idToken !== 'string' || !body.idToken || body.idToken.length > 12_000) {
    return errorResponse('بيانات تسجيل Google غير صالحة.', 400);
  }
  const storeName = typeof body.storeName === 'string' ? body.storeName.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (storeName && (storeName.length < 2 || storeName.length > 120)) {
    return errorResponse('اسم المتجر يجب أن يكون بين حرفين و120 حرفًا.', 400);
  }
  if (phone.length > 20) return errorResponse('رقم الهاتف غير صالح.', 400);

  let identity;
  try {
    identity = await verifyFirebaseGoogleIdToken(body.idToken, c.env.FIREBASE_PROJECT_ID);
  } catch (error) {
    if (error?.status === 503) return errorResponse('مصادقة Google غير مهيأة على الخادم.', 503);
    console.warn(JSON.stringify({ event: 'firebase_google_token_rejected', reason: error?.code || error?.name || 'invalid_token' }));
    return errorResponse('تعذر التحقق من حساب Google. حدّث التطبيق وحاول مرة أخرى.', 401);
  }
  if (!identity) return errorResponse('يجب استخدام حساب Google ببريد مؤكّد.', 401);

  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 5);
  const slugBase = storeName.normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 40);
  const companySlug = slugBase ? `${slugBase}-${suffix}` : `merchant-${suffix}`;

  let registration;
  try {
    [registration] = await createDb(c.env)`
      SELECT * FROM public.register_firebase_google_merchant(
        ${identity.uid}, ${identity.email}, ${identity.fullName || null},
        ${phone || null}, ${storeName || null}, ${companySlug}
      )
    `;
  } catch (error) {
    const message = String(error?.message || '');
    if (message.includes('STORE_NAME_REQUIRED')) {
      return errorResponse('لإنشاء حساب تاجر جديد، أدخل اسم المتجر ثم اختر المتابعة باستخدام Google.', 400);
    }
    if (message.includes('FIREBASE_UID_LINKED') || message.includes('EMAIL_LINKED_TO_ANOTHER_FIREBASE_ACCOUNT')) {
      return errorResponse('هذا البريد مرتبط بهوية Google مختلفة. استخدم الحساب المرتبط أو تواصل مع إدارة المنصة.', 409);
    }
    if (error?.code === '23505') {
      return errorResponse('البريد أو رقم الهاتف مرتبط بالفعل بحساب آخر.', 409);
    }
    throw error;
  }

  if (!registration?.out_user_id || !registration?.out_company_id) {
    throw new Error('Firebase merchant registration did not return its account and company.');
  }
  const user = {
    id: registration.out_user_id,
    email: registration.out_email,
    full_name: registration.out_full_name,
    phone: registration.out_phone,
    is_platform_admin: registration.out_is_platform_admin,
  };
  const company = {
    id: registration.out_company_id,
    slug: registration.out_company_slug,
    display_name: registration.out_company_display_name,
  };
  const token = await createToken(user, c.env.JWT_SECRET);
  return jsonResponse(ok({ user, token, company }, 'تم تسجيل الدخول وإنشاء مساحة المتجر بنجاح.'));
});

// GET /api/auth/me
auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = createDb(c.env);
  const [profile] = await db`SELECT id, email, full_name, phone, is_platform_admin, created_at FROM users WHERE id = ${user.id} LIMIT 1`;
  if (!profile) return errorResponse('User not found', 404);
  const companies = await db`
    SELECT c.*, cm.role, cm.is_active AS membership_active
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
    SELECT c.*, cm.role, cm.is_active AS membership_active
    FROM companies c JOIN company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${user.id} AND cm.is_active = TRUE ORDER BY c.created_at DESC
  `;
  return jsonResponse(ok(companies));
});

export default auth;
