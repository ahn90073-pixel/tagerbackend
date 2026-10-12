import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { ok, created, jsonResponse, errorResponse } from '../lib/response.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, isEmail, isString, matches } from '../middleware/validate.js';
import {
  COMPANY_PROFILE_DOCUMENT_TYPES,
  detectCompanyDocumentType,
  getCompanyProfileCompletion,
  mergeCompanyProfile,
  validateCompanyProfile,
} from '../lib/companyProfile.js';
import { decodeDocumentBytes, encodeDocumentBytes } from '../lib/companyDocumentBlob.js';

const companies = new Hono();
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const documentExtensions = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

const createCompanySchema = (body) => {
  const errors = [];
  if (!isString(body.slug) || !matches(body.slug, /^[a-z0-9-]+$/)) errors.push({ field: 'slug', message: 'Slug must contain only lowercase letters, numbers, and hyphens' });
  if (body.slug && (body.slug.length < 3 || body.slug.length > 50)) errors.push({ field: 'slug', message: 'Slug must be between 3 and 50 characters' });
  if (!isString(body.legalName)) errors.push({ field: 'legalName', message: 'Legal name is required' });
  if (!isString(body.displayName)) errors.push({ field: 'displayName', message: 'Display name is required' });
  if (body.email && !isEmail(body.email)) errors.push({ field: 'email', message: 'A valid email is required' });
  return { valid: errors.length === 0, errors };
};

async function requireCompanyProfileOwner(c, db, companyId) {
  const user = c.get('user');
  const [membership] = await db`
    SELECT cm.role, cm.is_active
    FROM public.companies c
    LEFT JOIN public.company_members cm ON cm.company_id = c.id AND cm.user_id = ${user.id}
    WHERE c.id = ${companyId}
    LIMIT 1
  `;
  if (!membership) return errorResponse('Company not found', 404);
  if (!membership.is_active) return errorResponse('You do not have active access to this company', 403);
  if (!['owner', 'admin'].includes(membership.role)) return errorResponse('Company owner access is required for sensitive profile data', 403);
  return null;
}

async function loadCompanyProfile(db, companyId) {
  const [companyRow] = await db`
    SELECT c.*
    FROM public.companies c
    WHERE c.id = ${companyId}
    LIMIT 1
  `;
  if (!companyRow) return null;
  const company = { ...companyRow, email: companyRow.email || '' };
  const documents = await db`
    SELECT document_type, content_type, size_bytes, uploaded_at
    FROM public.company_profile_documents
    WHERE company_id = ${companyId}
    ORDER BY document_type
  `;
  return { company, documents, completion: getCompanyProfileCompletion(company, documents) };
}

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

// GET /api/companies — companies accessible to the authenticated user.
companies.get('/', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = createDb(c.env);
  const rows = await db`
    SELECT c.id, c.slug, c.legal_name, c.display_name, c.email, c.status, c.created_at, c.updated_at,
           cm.role, cm.is_active AS membership_active
    FROM companies c JOIN company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${user.id} AND cm.is_active = TRUE ORDER BY c.created_at DESC
  `;
  return jsonResponse(ok(rows));
});

// GET /api/companies/:companyId/profile — sensitive company data is owner/admin-only.
companies.get('/:companyId/profile', authMiddleware, async (c) => {
  const companyId = c.req.param('companyId');
  const db = createDb(c.env);
  const denied = await requireCompanyProfileOwner(c, db, companyId);
  if (denied) return denied;
  const profile = await loadCompanyProfile(db, companyId);
  if (!profile) return errorResponse('Company not found', 404);
  return jsonResponse(ok(profile));
});

// PUT /api/companies/:companyId/profile — save partial profile progress without marking it verified.
companies.put('/:companyId/profile', authMiddleware, async (c) => {
  const companyId = c.req.param('companyId');
  const db = createDb(c.env);
  const denied = await requireCompanyProfileOwner(c, db, companyId);
  if (denied) return denied;

  let body;
  try { body = await c.req.json(); } catch { return errorResponse('A JSON profile body is required', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
    return errorResponse('At least one company profile field is required', 400);
  }
  const [existing] = await db`
    SELECT legal_name, display_name, email, commercial_register_number, tax_id,
           warehouse_address, payout_method, payout_number
    FROM public.companies WHERE id = ${companyId} LIMIT 1
  `;
  if (!existing) return errorResponse('Company not found', 404);
  const validation = validateCompanyProfile(mergeCompanyProfile(existing, body));
  if (!validation.valid) return jsonResponse({ success: false, message: 'Company profile validation failed', errors: validation.errors }, 400);
  const value = validation.value;
  const [company] = await db`
    UPDATE public.companies
    SET legal_name = ${value.legalName},
        display_name = ${value.displayName},
        email = ${value.email},
        commercial_register_number = ${value.commercialRegisterNumber},
        tax_id = ${value.taxId},
        warehouse_address = ${JSON.stringify(value.warehouseAddress)}::jsonb,
        payout_method = ${value.payoutMethod},
        payout_number = ${value.payoutNumber},
        updated_at = NOW()
    WHERE id = ${companyId}
    RETURNING *
  `;
  if (!company) return errorResponse('Company not found', 404);
  const profile = await loadCompanyProfile(db, companyId);
  return jsonResponse(ok(profile, 'Company profile saved'));
});

// POST /api/companies/:companyId/profile/documents/:documentType — private KV upload.
companies.post('/:companyId/profile/documents/:documentType', authMiddleware, async (c) => {
  const companyId = c.req.param('companyId');
  const documentType = c.req.param('documentType');
  if (!COMPANY_PROFILE_DOCUMENT_TYPES.includes(documentType)) return errorResponse('Unsupported company document type', 400);
  const db = createDb(c.env);
  const denied = await requireCompanyProfileOwner(c, db, companyId);
  if (denied) return denied;
  const documentsStore = c.env.COMPANY_KYC_DOCUMENTS;

  const contentLength = Number(c.req.header('content-length') || 0);
  if (contentLength > MAX_DOCUMENT_BYTES + 64 * 1024) return errorResponse('Document exceeds the 10 MB limit', 413);
  let form;
  try { form = await c.req.formData(); } catch { return errorResponse('Upload must use multipart form data', 400); }
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function' || typeof file.size !== 'number') return errorResponse('A document file is required', 400);
  if (file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) return errorResponse('Document must be between 1 byte and 10 MB', 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectCompanyDocumentType(bytes);
  if (!detected) return errorResponse('Only real PDF, JPEG, or PNG files are accepted', 415);
  const storageKey = `${companyId}/${documentType}/${crypto.randomUUID()}.${detected.extension}`;
  const user = c.get('user');
  const [previous] = await db`
    SELECT storage_key FROM public.company_profile_documents
    WHERE company_id = ${companyId} AND document_type = ${documentType}
    LIMIT 1
  `;
  const base64File = encodeDocumentBytes(bytes);
  const [savedDocument] = await db`
    WITH upserted_document AS (
      INSERT INTO public.company_profile_documents
        (company_id, document_type, storage_key, content_type, size_bytes, uploaded_by, uploaded_at)
      VALUES (${companyId}, ${documentType}, ${storageKey}, ${detected.contentType}, ${bytes.byteLength}, ${user.id}, NOW())
      ON CONFLICT (company_id, document_type) DO UPDATE SET
        storage_key = EXCLUDED.storage_key,
        content_type = EXCLUDED.content_type,
        size_bytes = EXCLUDED.size_bytes,
        uploaded_by = EXCLUDED.uploaded_by,
        uploaded_at = NOW()
      RETURNING id, storage_key
    ),
    upserted_blob AS (
      INSERT INTO public.company_profile_document_blobs (document_id, file_data)
      SELECT id, decode(${base64File}, 'base64')
      FROM upserted_document
      WHERE TRUE
      ON CONFLICT (document_id) DO UPDATE SET
        file_data = EXCLUDED.file_data,
        updated_at = NOW()
      RETURNING document_id
    )
    SELECT d.id, d.storage_key
    FROM upserted_document d
    INNER JOIN upserted_blob b ON b.document_id = d.id
  `;
  if (!savedDocument) throw new Error('Company document could not be persisted in Neon.');

  // Neon is authoritative. KV is only an additional copy and may be unavailable.
  if (documentsStore) {
    try {
      await documentsStore.put(storageKey, bytes.buffer, {
        metadata: { companyId, documentType, uploadedBy: user.id },
      });
    } catch (error) {
      console.warn('Company document is saved in Neon, but its KV mirror could not be written.', error);
    }

    const [currentDocument] = await db`
      SELECT storage_key FROM public.company_profile_documents
      WHERE company_id = ${companyId} AND document_type = ${documentType}
      LIMIT 1
    `;
    if (currentDocument?.storage_key !== storageKey) {
      await documentsStore.delete(storageKey).catch(() => console.warn('Unable to remove a superseded company profile upload'));
    } else if (previous?.storage_key && previous.storage_key !== currentDocument.storage_key) {
      await documentsStore.delete(previous.storage_key).catch(() => console.warn('Unable to remove replaced company profile document'));
    }
  }
  const profile = await loadCompanyProfile(db, companyId);
  return jsonResponse(ok(profile, 'Company document saved to Neon with an optional KV mirror'));
});

// GET /api/companies/:companyId/profile/documents/:documentType — authenticated Neon-first download.
companies.get('/:companyId/profile/documents/:documentType', authMiddleware, async (c) => {
  const companyId = c.req.param('companyId');
  const documentType = c.req.param('documentType');
  if (!COMPANY_PROFILE_DOCUMENT_TYPES.includes(documentType)) return errorResponse('Unsupported company document type', 400);
  const db = createDb(c.env);
  const denied = await requireCompanyProfileOwner(c, db, companyId);
  if (denied) return denied;
  const documentsStore = c.env.COMPANY_KYC_DOCUMENTS;
  const [document] = await db`
    SELECT d.id, d.storage_key, d.content_type, encode(b.file_data, 'base64') AS file_data_base64
    FROM public.company_profile_documents d
    LEFT JOIN public.company_profile_document_blobs b ON b.document_id = d.id
    WHERE d.company_id = ${companyId} AND d.document_type = ${documentType}
    LIMIT 1
  `;
  if (!document) return errorResponse('Company document not found', 404);
  let bytes = document.file_data_base64 ? decodeDocumentBytes(document.file_data_base64) : null;
  if (!bytes && documentsStore) {
    try {
      const legacyBytes = await documentsStore.get(document.storage_key, { type: 'arrayBuffer', cacheTtl: 30 });
      if (legacyBytes) {
        bytes = new Uint8Array(legacyBytes);
        const legacyBase64 = encodeDocumentBytes(bytes);
        // Lazily backfill documents uploaded before the Neon blob migration.
        await db`
          INSERT INTO public.company_profile_document_blobs (document_id, file_data)
          VALUES (${document.id}, decode(${legacyBase64}, 'base64'))
          ON CONFLICT (document_id) DO NOTHING
        `;
      }
    } catch (error) {
      console.warn('Unable to retrieve or backfill a legacy KV company document.', error);
    }
  }
  if (!bytes) return errorResponse('Stored company document not found', 404);
  const headers = new Headers();
  headers.set('Content-Type', document.content_type);
  headers.set('Content-Disposition', `attachment; filename="${documentType}.${documentExtensions[document.content_type]}"`);
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(bytes, { status: 200, headers });
});

// GET /api/companies/:companyId — company access is available to active members.
companies.get('/:companyId', authMiddleware, async (c) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const db = createDb(c.env);
  const [company] = await db`
    SELECT c.id, c.slug, c.legal_name, c.display_name, c.email, c.status, c.created_at, c.updated_at,
           cm.role, cm.is_active AS membership_active
    FROM companies c JOIN company_members cm ON cm.company_id = c.id
    WHERE c.id = ${companyId} AND cm.user_id = ${user.id} LIMIT 1
  `;
  if (!company) return errorResponse('You do not have access to this company', 403);
  if (!company.membership_active) return errorResponse('Your membership to this company is inactive', 403);
  return jsonResponse(ok(company));
});

export default companies;
