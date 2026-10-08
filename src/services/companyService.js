import { query } from '../config/db.js';
import { ConflictError, NotFoundError, ForbiddenError } from '../utils/AppError.js';

/**
 * Creates a new company, provisions its tenant schema, and assigns
 * the calling user as the owner. Uses the database function
 * app.create_company_with_owner which handles schema + membership atomically.
 */
export async function createCompany({
  slug,
  legalName,
  displayName,
  email,
  ownerId,
}) {
  // Check slug uniqueness
  const existing = await query(
    'SELECT id FROM app.companies WHERE slug = $1',
    [slug]
  );
  if (existing.rows.length > 0) {
    throw new ConflictError('A company with this slug already exists');
  }

  // Create company + owner membership + tenant schema atomically
  const result = await query(
    'SELECT app.create_company_with_owner($1, $2, $3, $4, $5) AS company_id',
    [slug, legalName, displayName, ownerId, email || null]
  );

  const companyId = result.rows[0].company_id;

  const company = await getCompanyById(companyId, ownerId);

  return company;
}

/**
 * Fetches a company by ID — verifies the requesting user is a member.
 */
export async function getCompanyById(companyId, userId) {
  const result = await query(
    `SELECT c.id, c.slug, c.legal_name, c.display_name, c.logo_url,
            c.description, c.email, c.phone, c.status, c.currency,
            c.timezone, c.tenant_schema_name, c.settings,
            c.created_at, c.updated_at
     FROM app.companies c
     WHERE c.id = $1`,
    [companyId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Company not found');
  }

  if (userId) {
    await assertCompanyMember(companyId, userId);
  }

  return result.rows[0];
}

/**
 * Lists all companies the user is a member of.
 */
export async function listUserCompanies(userId) {
  const result = await query(
    `SELECT c.id, c.slug, c.legal_name, c.display_name, c.status,
            cm.role, cm.is_active, c.created_at
     FROM app.company_members cm
     JOIN app.companies c ON c.id = cm.company_id
     WHERE cm.user_id = $1
     ORDER BY cm.joined_at DESC`,
    [userId]
  );

  return result.rows;
}

/**
 * Throws if the user is not an active member of the company.
 * Returns the membership row (with role) if they are.
 */
export async function assertCompanyMember(companyId, userId) {
  const result = await query(
    `SELECT role, is_active FROM app.company_members
     WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId]
  );

  if (result.rows.length === 0) {
    throw new ForbiddenError('You do not have access to this company');
  }

  if (!result.rows[0].is_active) {
    throw new ForbiddenError('Your membership to this company is inactive');
  }

  return result.rows[0];
}

/**
 * Throws if the user does not have one of the allowed roles.
 */
export async function assertCompanyRole(companyId, userId, allowedRoles) {
  const membership = await assertCompanyMember(companyId, userId);
  if (!allowedRoles.includes(membership.role)) {
    throw new ForbiddenError(`This action requires one of: ${allowedRoles.join(', ')}`);
  }
  return membership;
}
