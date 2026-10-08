import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { createSupabaseClient } from '../lib/supabase.js';
import { createToken } from '../lib/jwt.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, isEmail, isString, matches } from '../middleware/validate.js';

const auth = new Hono();

// ---- Validation schemas ----

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

// ---- Routes ----

/**
 * POST /api/auth/register
 * Creates a new user account. Password is hashed with bcryptjs (Edge-compatible).
 */
auth.post('/register', validate(registerSchema), async (c) => {
  const body = c.get('body');
  const supabase = createSupabaseClient(c.env);

  // Check for existing email
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', body.email.toLowerCase())
    .maybeSingle();

  if (existing) {
    return errorResponse('A user with this email already exists', 409);
  }

  // Check existing phone if provided
  if (body.phone) {
    const { data: existingPhone } = await supabase
      .from('users')
      .select('id')
      .eq('phone', body.phone)
      .maybeSingle();
    if (existingPhone) {
      return errorResponse('A user with this phone already exists', 409);
    }
  }

  // Hash password with bcryptjs (works on Edge runtime)
  const passwordHash = await bcrypt.hash(body.password, 10);

  // Create user via RPC (handles password_hash in the app.users table)
  const { data: user, error: rpcError } = await supabase.rpc('register_user', {
    p_email: body.email.toLowerCase(),
    p_password_hash: passwordHash,
    p_full_name: body.fullName || null,
    p_phone: body.phone || null,
  });

  if (rpcError) {
    return errorResponse(rpcError.message, 500);
  }

  const token = await createToken(user, c.env.JWT_SECRET);
  return jsonResponse(created({ user, token }, 'Account created successfully'), 201);
});

/**
 * POST /api/auth/login
 * Authenticates with email + password. Returns a JWT.
 */
auth.post('/login', validate(loginSchema), async (c) => {
  const body = c.get('body');
  const supabase = createSupabaseClient(c.env);

  // Fetch credentials including password_hash via RPC
  const { data: credentials, error: rpcError } = await supabase.rpc('verify_user_credentials', {
    p_email: body.email.toLowerCase(),
  });

  if (rpcError) {
    return errorResponse(rpcError.message, 500);
  }

  if (!credentials) {
    return errorResponse('Invalid email or password', 401);
  }

  // Verify password with bcryptjs
  const match = await bcrypt.compare(body.password, credentials.password_hash);
  if (!match) {
    return errorResponse('Invalid email or password', 401);
  }

  const user = {
    id: credentials.id,
    email: credentials.email,
    full_name: credentials.full_name,
    phone: credentials.phone,
    is_platform_admin: credentials.is_platform_admin,
  };

  const token = await createToken(user, c.env.JWT_SECRET);
  return jsonResponse(ok({ user, token }, 'Login successful'));
});

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile + companies.
 */
auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const supabase = createSupabaseClient(c.env);

  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile) {
    return errorResponse('User not found', 404);
  }

  const { data: companies } = await supabase.rpc('get_user_companies', {
    p_user_id: user.id,
  });

  return jsonResponse(ok({ ...profile, companies }));
});

/**
 * GET /api/auth/me/companies
 * Lists companies the user belongs to.
 */
auth.get('/me/companies', authMiddleware, async (c) => {
  const user = c.get('user');
  const supabase = createSupabaseClient(c.env);

  const { data: companies, error } = await supabase.rpc('get_user_companies', {
    p_user_id: user.id,
  });

  if (error) {
    return errorResponse(error.message, 500);
  }

  return jsonResponse(ok(companies));
});

export default auth;
