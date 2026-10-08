import { Router } from 'express';
import {
  registerValidation,
  loginValidation,
  register,
  login,
  getProfile,
  getMyCompanies,
} from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/auth/register
 * Create a new user account. Password is hashed with bcrypt.
 */
router.post('/register', registerValidation, register);

/**
 * POST /api/auth/login
 * Authenticate with email + password. Returns a JWT.
 */
router.post('/login', loginValidation, login);

/**
 * GET /api/auth/me
 * Get the authenticated user's profile + companies.
 */
router.get('/me', authenticate, getProfile);

/**
 * GET /api/auth/me/companies
 * List companies the user belongs to.
 */
router.get('/me/companies', authenticate, getMyCompanies);

export default router;
