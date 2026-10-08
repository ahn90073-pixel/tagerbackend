import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { UnauthorizedError, ForbiddenError } from '../utils/AppError.js';

/**
 * Extracts and verifies the JWT from the Authorization header.
 * Attaches `req.user` with { id, email, isPlatformAdmin }.
 */
export function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authentication token is required');
    }

    const token = header.split(' ')[1];
    const payload = jwt.verify(token, config.jwt.secret);

    req.user = {
      id: payload.sub,
      email: payload.email,
      isPlatformAdmin: payload.isPlatformAdmin || false,
    };

    next();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return next(err);
    }
    next(new UnauthorizedError('Invalid or expired token'));
  }
}

/**
 * Requires the authenticated user to be a platform admin.
 */
export function requirePlatformAdmin(req, _res, next) {
  if (!req.user?.isPlatformAdmin) {
    return next(new ForbiddenError('Platform admin access required'));
  }
  next();
}


