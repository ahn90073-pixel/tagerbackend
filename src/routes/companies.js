import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, isEmail, isString, matches } from '../middleware/validate.js';

const companies = new Hono();
const createCompanySchema = (body) => {
  const errors = [];
  if (!isString(body.slug) || !matches(body.slug, /^[a-z0-9-]+$/)) errors.push({ field: 'slug', message: 'Slug must contain only lowercase letters, numbers, and hyphens' });
  if (body.slug && (body.slug.length < 3 || body.slug.length > 50)) errors.push({ field: 'slug', message: 'Slug must be between 3 and 50 characters' });
  if (!isString(body.legalName)) errors.push({ field: 'legalName', message: 'Legal name is required' });
  if (!isString(body.displayName)) errors.push({ field: 'displayName', message: 'Display name is required' });
  if (body.email && !isEmail(body.email)) errors.push({ field: 'email', message: 'A valid email is required' });
  return { valid: errors.length === 0, errors };
};

// POST /api/companies — atomically create the company and its owner membership.
companies.post('/', authMiddleware, validate(createCompanySchema), async (c) => {
  const body = c.get('body');
  const user = c.get('user');
  const db = createDb(c.env);
  try {
    const [createdCompany] = await db`
      SELECT public.create_company_with_owner(
        ${body.slug}, ${body.legalName}, ${body.displayName}, ${user.id}, ${body.email || null}
      ) AS company_id
    `;
    const [company] = await db`
      SELECT * FROM public.companies WHERE id = ${createdCompany.company_id} LIMIT 1
    `;
    if (!company) throw new Error('Company creation completed without returning the company record.');
    return jsonResponse(created(company, 'Company created successfully'), 201);
  } catch (error) {
    if (error.code === '23505') return errorResponse('A company with this slug already exists', 409);
    throw error;
  }
});

// GET /api/companies
companies.get('/', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = createDb(c.env);
  const rows = await db`
    SELECT c.*, cm.role, cm.is_active AS membership_active
    FROM companies c JOIN company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${user.id} AND cm.is_active = TRUE ORDER BY c.created_at DESC
  `;
  return jsonResponse(ok(rows));
});

// GET /api/companies/:companyId
companies.get('/:companyId', authMiddleware, async (c) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const db = createDb(c.env);
  const [company] = await db`
    SELECT c.*, cm.role, cm.is_active AS membership_active
    FROM companies c JOIN company_members cm ON cm.company_id = c.id
    WHERE c.id = ${companyId} AND cm.user_id = ${user.id} LIMIT 1
  `;
  if (!company) return errorResponse('You do not have access to this company', 403);
  if (!company.membership_active) return errorResponse('Your membership to this company is inactive', 403);
  return jsonResponse(ok(company));
});

export default companies;
