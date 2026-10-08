import { errorResponse } from '../lib/response.js';

/**
 * Validates the request body against a validation schema.
 * The schema is a function that receives the body and returns
 * { errors: [{field, message}], valid: boolean }.
 */
export function validate(schema) {
  return async (c, next) => {
    const body = await c.req.json().catch(() => ({}));
    c.set('body', body);

    const result = schema(body);
    if (!result.valid) {
      return errorResponse('Validation failed', 400, result.errors);
    }

    await next();
  };
}

/**
 * Common validation helpers.
 */
export function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isString(value) {
  return typeof value === 'string' && value.length > 0;
}

export function isNumber(value) {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
}

export function isNonNegativeNumber(value) {
  return isNumber(value) && value >= 0;
}

export function isUUID(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function matches(value, regex) {
  return typeof value === 'string' && regex.test(value);
}
