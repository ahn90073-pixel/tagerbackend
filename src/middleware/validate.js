import { validationResult } from 'express-validator';
import { BadRequestError } from '../utils/AppError.js';

/**
 * Runs after express-validator chain. Collects validation errors and
 * throws a BadRequestError with a structured list if any exist.
 */
export function validate(req, _res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }

  const formatted = errors.array().map((e) => ({
    field: e.path,
    message: e.msg,
  }));

  const error = new BadRequestError('Validation failed');
  error.errors = formatted;
  next(error);
}
