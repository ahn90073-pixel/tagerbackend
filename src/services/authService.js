import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query } from '../config/db.js';
import { config } from '../config/env.js';
import { ConflictError, UnauthorizedError, NotFoundError } from '../utils/AppError.js';

const BCRYPT_ROUNDS = 10;

/**
 * Registers a new user with an email + password.
 * Password is hashed with bcrypt before storage.
 */
export async function registerUser({ email, password, fullName, phone }) {
  // Check for existing email
  const existing = await query(
    'SELECT id FROM app.users WHERE email = $1',
    [email.toLowerCase()]
  );
  if (existing.rows.length > 0) {
    throw new ConflictError('A user with this email already exists');
  }

  if (phone) {
    const existingPhone = await query(
      'SELECT id FROM app.users WHERE phone = $1',
      [phone]
    );
    if (existingPhone.rows.length > 0) {
      throw new ConflictError('A user with this phone already exists');
    }
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const result = await query(
    `INSERT INTO app.users (email, password_hash, full_name, phone)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, full_name, phone, is_platform_admin, created_at`,
    [email.toLowerCase(), passwordHash, fullName || null, phone || null]
  );

  const user = result.rows[0];
  const token = generateToken(user);

  return { user, token };
}

/**
 * Authenticates a user by email + password and returns a JWT.
 */
export async function loginUser({ email, password }) {
  const result = await query(
    'SELECT id, email, full_name, phone, password_hash, is_platform_admin FROM app.users WHERE email = $1',
    [email.toLowerCase()]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const user = result.rows[0];

  if (!user.password_hash) {
    throw new UnauthorizedError('Password is not set for this account');
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const token = generateToken(user);

  return {
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      phone: user.phone,
      is_platform_admin: user.is_platform_admin,
    },
    token,
  };
}

/**
 * Fetches a user by ID (for profile / auth checks).
 */
export async function getUserById(userId) {
  const result = await query(
    'SELECT id, email, full_name, phone, avatar_url, is_platform_admin, created_at FROM app.users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('User not found');
  }

  return result.rows[0];
}

/**
 * Returns the list of companies the user is a member of, with their role.
 */
export async function getUserCompanies(userId) {
  const result = await query(
    `SELECT c.id, c.slug, c.legal_name, c.display_name, c.status,
            cm.role, cm.is_active
     FROM app.company_members cm
     JOIN app.companies c ON c.id = cm.company_id
     WHERE cm.user_id = $1
     ORDER BY cm.joined_at DESC`,
    [userId]
  );

  return result.rows;
}

function generateToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      isPlatformAdmin: user.is_platform_admin,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}
