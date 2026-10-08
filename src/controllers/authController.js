import { asyncHandler } from '../middleware/errorHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { validate } from '../middleware/validate.js';
import { body } from 'express-validator';
import * as authService from '../services/authService.js';

export const registerValidation = [
  body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('fullName').optional().isLength({ max: 100 }).withMessage('Full name must be under 100 characters'),
  body('phone').optional().isLength({ max: 20 }),
  validate,
];

export const loginValidation = [
  body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
  validate,
];

export const register = asyncHandler(async (req, res) => {
  const { user, token } = await authService.registerUser(req.body);
  return ApiResponse.created(res, { user, token }, 'Account created successfully');
});

export const login = asyncHandler(async (req, res) => {
  const { user, token } = await authService.loginUser(req.body);
  return ApiResponse.success(res, { user, token }, 'Login successful');
});

export const getProfile = asyncHandler(async (req, res) => {
  const user = await authService.getUserById(req.user.id);
  const companies = await authService.getUserCompanies(req.user.id);
  return ApiResponse.success(res, { ...user, companies });
});

export const getMyCompanies = asyncHandler(async (req, res) => {
  const companies = await authService.getUserCompanies(req.user.id);
  return ApiResponse.success(res, companies);
});
