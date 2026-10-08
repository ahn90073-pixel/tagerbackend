import { errorResponse } from '../lib/response.js';

/**
 * Global error handler — catches unhandled exceptions and returns
 * a structured JSON error response. Logs to console for debugging.
 */
export function errorHandler(err, c) {
  console.error('[error]', err.message, err.stack);

  const status = err.status || 500;
  const message = err.message || 'Internal server error';

  return errorResponse(message, status);
}

/**
 * 404 handler for unmatched routes.
 */
export function notFound(c) {
  return errorResponse(`Route not found: ${c.req.method} ${c.req.path}`, 404);
}
