import { verifyToken } from '../lib/jwt.js';
import { errorResponse } from '../lib/response.js';

/**
 * JWT authentication middleware.
 * Extracts the Bearer token from the Authorization header, verifies it,
 * and attaches the user payload to c.set('user', ...).
 */
export async function authMiddleware(c, next) {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return errorResponse('Authentication token is required', 401);
  }

  const token = header.split(' ')[1];
  let payload;
  try {
    payload = await verifyToken(token, c.env.JWT_SECRET);
  } catch {
    return errorResponse('Invalid or expired token', 401);
  }

  c.set('user', {
    id: payload.sub,
    email: payload.email,
    is_platform_admin: payload.is_platform_admin || false,
  });
  // Do not catch errors from route handlers here; database/application errors
  // must reach the global error handler instead of masquerading as JWT failures.
  await next();
}

/**
 * Requires the authenticated user to be a platform admin.
 * Must be used after authMiddleware.
 */
export async function requireAdmin(c, next) {
  const user = c.get('user');
  if (!user?.is_platform_admin) {
    return errorResponse('Platform admin access required', 403);
  }
  await next();
}
