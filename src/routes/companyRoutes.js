import { Router } from 'express';
import {
  createProductValidation,
  createProduct,
  listProducts,
  getProduct,
  updateProductStatusValidation,
  updateProductStatus,
  updateProductValidation,
  updateProduct,
  deleteProduct,
  listPendingProducts,
} from '../controllers/productController.js';
import { authenticate, requirePlatformAdmin } from '../middleware/auth.js';

const router = Router();

// ---- Company-scoped product routes ----

/**
 * POST /api/companies/:companyId/products
 * Add a product to a company. Status is set to 'pending' automatically.
 */
router.post(
  '/:companyId/products',
  authenticate,
  createProductValidation,
  createProduct
);

/**
 * GET /api/companies/:companyId/products
 * List products for a company (optional ?status=pending|active|draft|archived).
 */
router.get('/:companyId/products', authenticate, listProducts);

/**
 * GET /api/companies/:companyId/products/:productId
 * Get a single product with its images.
 */
router.get('/:companyId/products/:productId', authenticate, getProduct);

/**
 * PUT /api/companies/:companyId/products/:productId
 * Update product fields (non-status).
 */
router.put(
  '/:companyId/products/:productId',
  authenticate,
  updateProductValidation,
  updateProduct
);

/**
 * DELETE /api/companies/:companyId/products/:productId
 * Delete a product.
 */
router.delete('/:companyId/products/:productId', authenticate, deleteProduct);

// ---- Platform-admin approval routes ----

/**
 * GET /api/companies/admin/products/pending
 * List all products across all companies with the given status.
 * Platform admin only. Optional ?status=pending&?page=1&?limit=20
 */
router.get(
  '/admin/products/pending',
  authenticate,
  requirePlatformAdmin,
  listPendingProducts
);

/**
 * PATCH /api/companies/admin/products/:productId/status
 * Approve or reject a product by setting its status.
 * Platform admin only. Body: { status: 'active' | 'pending' | 'draft' | 'archived' }
 */
router.patch(
  '/admin/products/:productId/status',
  authenticate,
  requirePlatformAdmin,
  updateProductStatusValidation,
  updateProductStatus
);

export default router;
