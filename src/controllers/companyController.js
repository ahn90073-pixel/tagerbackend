import { asyncHandler } from '../middleware/errorHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { validate } from '../middleware/validate.js';
import { body } from 'express-validator';
import * as companyService from '../services/companyService.js';

export const createCompanyValidation = [
  body('slug')
    .matches(/^[a-z0-9-]+$/)
    .withMessage('Slug must contain only lowercase letters, numbers, and hyphens')
    .isLength({ min: 3, max: 50 })
    .withMessage('Slug must be between 3 and 50 characters'),
  body('legalName').notEmpty().withMessage('Legal name is required').isLength({ max: 200 }),
  body('displayName').notEmpty().withMessage('Display name is required').isLength({ max: 200 }),
  body('email').optional().isEmail().withMessage('A valid email is required'),
  validate,
];

export const createCompany = asyncHandler(async (req, res) => {
  const company = await companyService.createCompany({
    slug: req.body.slug,
    legalName: req.body.legalName,
    displayName: req.body.displayName,
    email: req.body.email,
    ownerId: req.user.id,
  });
  return ApiResponse.created(res, company, 'Company created successfully');
});

export const getCompany = asyncHandler(async (req, res) => {
  const company = await companyService.getCompanyById(req.params.companyId, req.user.id);
  return ApiResponse.success(res, company);
});

export const listMyCompanies = asyncHandler(async (req, res) => {
  const companies = await companyService.listUserCompanies(req.user.id);
  return ApiResponse.success(res, companies);
});
