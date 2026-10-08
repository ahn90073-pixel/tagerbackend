import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, isEmail, isString, matches } from '../middleware/validate.js';

const companies = new Hono();

// ---- Validation schema ----

const createCompanySchema = (body) => {
  const errors = [];
  if (!isString(body.slug) || !matches(body.slug, /^[a-z0-9-]+$/)) {
    errors.push({ field: 'slug', message: 'Slug must contain only lowercase letters, numbers, and hyphens' });
  }
  if (body.slug && (body.slug.length < 3 || body.slug.length > 50)) {
    errors.push({ field: 'slug', message: 'Slug must be between 3 and 50 characters' });
  }
  if (!isString(body.legalName)) errors.push({ field: 'legalName', message: 'Legal name is required' });
  if (!isString(body.displayName)) errors.push({ field: 'displayName', message: 'Display name is required' });
  if (body.email && !isEmail(body.email)) errors.push({ field: 'email', message: 'A valid email is required' });
  return { valid: errors.length === 0, errors };
};

// ---- Routes ----

/**
 * POST /api/companies
 * Creates a new company. The calling user becomes the owner.
 * The database function app.create_company_with_owner handles:
 *   1. Inserting the company record
 *   2. Creating the owner membership
 *   3. Provisioning a private tenant_<uuid> schema with filtered views
 */
companies.post('/', authMiddleware, validate(createCompanySchema), async (c) => {
  const body = c.get('body');
  const user = c.get('user');
  const supabase = createSupabaseClient(c.env);

  // Check slug uniqueness
  const { data: existing } = await supabase
    .from('companies')
    .select('id')
    .eq('slug', body.slug)
    .maybeSingle();

  if (existing) {
    return errorResponse('A company with this slug already exists', 409);
  }

  // Create company + owner membership + tenant schema atomically via RPC
  const { data: companyId, error: rpcError } = await supabase.rpc('create_company_with_owner', {
    p_slug: body.slug,
    p_legal_name: body.legalName,
    p_display_name: body.displayName,
    p_owner_user_id: user.id,
    p_email: body.email || null,
  });

  if (rpcError) {
    return errorResponse(rpcError.message, 500);
  }

  // Fetch the created company
  const { data: company } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .maybeSingle();

  return jsonResponse(created(company, 'Company created successfully'), 201);
});

/**
 * GET /api/companies
 * Lists all companies the authenticated user is a member of.
 */
companies.get('/', authMiddleware, async (c) => {
  const user = c.get('user');
  const supabase = createSupabaseClient(c.env);

  const { data: userCompanies, error } = await supabase.rpc('get_user_companies', {
    p_user_id: user.id,
  });

  if (error) {
    return errorResponse(error.message, 500);
  }

  return jsonResponse(ok(userCompanies));
});

/**
 * GET /api/companies/:companyId
 * Gets details of a specific company. Must be a member.
 */
companies.get('/:companyId', authMiddleware, async (c) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const supabase = createSupabaseClient(c.env);

  // Verify membership
  const { data: membership } = await supabase
    .from('company_members')
    .select('role, is_active')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership) {
    return errorResponse('You do not have access to this company', 403);
  }

  if (!membership.is_active) {
    return errorResponse('Your membership to this company is inactive', 403);
  }

  const { data: company } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .maybeSingle();

  if (!company) {
    return errorResponse('Company not found', 404);
  }

  return jsonResponse(ok(company));
});

export default companies;
