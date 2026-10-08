/**
 * Standard JSON API response helpers.
 */
export function ok(data = null, message = 'Success') {
  return { success: true, message, data };
}

export function created(data, message = 'Created successfully') {
  return { success: true, message, data };
}

export function error(message = 'Something went wrong', errors = null) {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return body;
}

/**
 * Returns a JSON response with the given status code.
 */
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Error response helper — takes message, status, and optional validation errors.
 */
export function errorResponse(message, status = 500, errors = null) {
  return jsonResponse(error(message, errors), status);
}
