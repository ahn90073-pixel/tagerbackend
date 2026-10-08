import { AppError } from '../utils/AppError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { config } from '../config/env.js';

/**
 * Centralized error handler — must be registered last.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  if (statusCode >= 500) {
    console.error('[error]', {
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });
  } else if (statusCode >= 400) {
    console.warn('[warn]', { message: err.message, path: req.path, method: req.method });
  }

  const body = {
    success: false,
    message,
  };

  if (err.errors) {
    body.errors = err.errors;
  }

  if (!config.isProduction && statusCode >= 500) {
    body.stack = err.stack;
  }

  return res.status(statusCode).json(body);
}

/**
 * Catches async route handlers so rejected promises reach the error middleware.
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * 404 handler for unmatched routes.
 */
export function notFound(req, _res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

// silence unused import in some bundlers
void ApiResponse;
