import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { createDb } from '../lib/db.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { createToken } from '../lib/jwt.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, isEmail, isString } from '../middleware/validate.js';

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
  if (!credentials || !(await bcrypt.compare(body.password, credentials.password_hash))) {
    return errorResponse('Invalid email or password', 401);
  }
  const user = {
    id: credentials.id, email: credentials.email, full_name: credentials.full_name,
    phone: credentials.phone, is_platform_admin: credentials.is_platform_admin,
  };
  const token = await createToken(user, c.env.JWT_SECRET);
  return jsonResponse(ok({ user, token }, 'Login successful'));
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
