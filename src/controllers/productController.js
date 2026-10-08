import { asyncHandler } from '../middleware/errorHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { validate } from '../middleware/validate.js';
import { body, query, param } from 'express-validator';
import * as productService from '../services/productService.js';

export const createProductValidation = [
  body('sku').notEmpty().withMessage('SKU is required').isLength({ max: 100 }),
  body('name').notEmpty().withMessage('Product name is required').isLength({ max: 300 }),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a non-negative number'),
  body('compareAtPrice').optional().isFloat({ min: 0 }),
  body('costPrice').optional().isFloat({ min: 0 }),
  body('currency').optional().isLength({ exactly: 3 }),
  body('weightGrams').optional().isInt({ min: 0 }),
  body('categoryId').optional().isUUID(),
  body('description').optional().isLength({ max: 5000 }),
  body('shortDescription').optional().isLength({ max: 500 }),
  body('brand').optional().isLength({ max: 200 }),
  body('sellerName').optional().isLength({ max: 200 }),
  body('badge').optional().isLength({ max: 50 }),
  validate,
];

export const createProduct = asyncHandler(async (req, res) => {
  const product = await productService.createProduct(req.params.companyId, req.user.id, req.body);
  return ApiResponse.created(res, product, 'Product created — pending admin approval');
});

export const listProducts = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const result = await productService.listProducts(req.params.companyId, req.user.id, {
    status,
    page: parseInt(page || '1', 10),
    limit: parseInt(limit || '20', 10),
  });
  return ApiResponse.success(res, result);
});

export const getProduct = asyncHandler(async (req, res) => {
  const product = await productService.getProductById(req.params.companyId, req.user.id, req.params.productId);
  return ApiResponse.success(res, product);
});

export const updateProductStatusValidation = [
  body('status')
    .isIn(['draft', 'pending', 'active', 'archived'])
    .withMessage('Status must be one of: draft, pending, active, archived'),
  validate,
];

export const updateProductStatus = asyncHandler(async (req, res) => {
  const product = await productService.updateProductStatus(
    req.params.productId,
    req.body.status,
    req.user.id,
    req.user.isPlatformAdmin
  );
  return ApiResponse.success(res, product, `Product status updated to ${req.body.status}`);
});

export const updateProductValidation = [
  body('name').optional().isLength({ max: 300 }),
  body('price').optional().isFloat({ min: 0 }),
  body('description').optional().isLength({ max: 5000 }),
  validate,
];

export const updateProduct = asyncHandler(async (req, res) => {
  const product = await productService.updateProduct(
    req.params.companyId,
    req.user.id,
    req.params.productId,
    req.body
  );
  return ApiResponse.success(res, product, 'Product updated successfully');
});

export const deleteProduct = asyncHandler(async (req, res) => {
  await productService.deleteProduct(req.params.companyId, req.user.id, req.params.productId);
  return ApiResponse.success(res, null, 'Product deleted successfully');
});

// Platform-admin endpoints (no company context — operates across all companies)

export const listPendingProducts = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const result = await productService.listPendingProductsAllCompanies({
    status: status || 'pending',
    page: parseInt(page || '1', 10),
    limit: parseInt(limit || '20', 10),
  });
  return ApiResponse.success(res, result);
});
