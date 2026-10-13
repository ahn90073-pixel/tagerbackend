import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { ok, jsonResponse, errorResponse } from '../lib/response.js';
import { authMiddleware } from '../middleware/auth.js';
import { tenantTable } from '../lib/tenantDb.js';
import { calculateWalletSummary } from '../lib/financialSummary.js';
import {
  COMPANY_PROFILE_DOCUMENT_TYPES,
  detectCompanyDocumentType,
  getCompanyProfileCompletion,
  mergeCompanyProfile,
  validateCompanyProfile,
} from '../lib/companyProfile.js';
import { decodeDocumentBytes, encodeDocumentBytes } from '../lib/companyDocumentBlob.js';
import { normalizeGovernorate } from '../lib/governorates.js';

const companies = new Hono();
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const documentExtensions = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

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

// Company creation is intentionally unavailable to merchant sessions. The
// company and tenant schema are provisioned atomically by admin approval only.
companies.post('/', authMiddleware, (c) => errorResponse(
  'يجب إرسال طلب إنشاء متجر وانتظار موافقة الإدارة قبل تفعيل المتجر.', 403,
));

// GET /api/companies — companies accessible to the authenticated user.
companies.get('/', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = createDb(c.env);
  const rows = await db`
    SELECT c.id, c.slug, c.legal_name, c.display_name, c.email, c.governorate, c.status, c.created_at, c.updated_at,
           cm.role, cm.is_active AS membership_active
    FROM companies c JOIN company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${user.id} AND cm.is_active = TRUE ORDER BY c.created_at DESC
  `;
  return jsonResponse(ok(rows));
});

// PATCH /api/companies/:companyId/governorate — one-time completion for stores without a location.
companies.patch('/:companyId/governorate', authMiddleware, async (c) => {
  const companyId = c.req.param('companyId');
  if (!matches(companyId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)) {
    return errorResponse('معرّف المتجر غير صالح.', 400);
  }
  const body = await c.req.json().catch(() => null);
  const governorate = normalizeGovernorate(body?.governorate);
  if (!governorate) return errorResponse('اختر محافظة صحيحة من القائمة.', 400);

  const db = createDb(c.env);
  const denied = await requireCompanyProfileOwner(c, db, companyId);
  if (denied) return denied;
  const [existing] = await db`SELECT governorate FROM public.companies WHERE id = ${companyId} LIMIT 1`;
  if (!existing) return errorResponse('Company not found', 404);
  if (existing.governorate && existing.governorate !== governorate) {
    return errorResponse('لا يمكن تغيير محافظة المتجر بعد اعتمادها. تواصل مع إدارة المنصة عند الحاجة إلى تصحيحها.', 409);
  }
  const [updated] = await db`
    UPDATE public.companies SET governorate = ${governorate}, updated_at = NOW()
    WHERE id = ${companyId} AND (governorate IS NULL OR governorate = ${governorate})
    RETURNING id, governorate
  `;
  if (!updated) return errorResponse('تعذر حفظ محافظة المتجر. أعد المحاولة.', 409);
  return jsonResponse(ok(updated, 'تم حفظ محافظة المتجر.'));
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

// GET /api/companies/:companyId/wallet — owner/admin view using the same
// sales, commission and completed-payout model as the Mange admin dashboard.
companies.get('/:companyId/wallet', authMiddleware, async (c) => {
  const companyId = c.req.param('companyId');
  const db = createDb(c.env);
  const denied = await requireCompanyProfileOwner(c, db, companyId);
  if (denied) return denied;
  const [company] = await db`
    SELECT c.id, c.tenant_schema_name,
           COALESCE(settings.commission_type, 'percentage') AS commission_type,
           COALESCE(settings.commission_value, 0)::numeric AS commission_value
    FROM public.companies c
    LEFT JOIN public.admin_company_settings settings ON settings.company_id = c.id
    WHERE c.id = ${companyId}
    LIMIT 1
  `;
  if (!company) return errorResponse('Company not found', 404);
  const ordersTable = tenantTable(company.tenant_schema_name, 'orders');
  const [sales] = await db.query(
    `SELECT COALESCE(SUM(grand_total), 0)::numeric AS total_sales
       FROM ${ordersTable}
      WHERE company_id = $1::uuid AND status NOT IN ('cancelled', 'refunded')`,
    [companyId],
  );
  const [payouts] = await db.query(
    `SELECT COALESCE(SUM(net_amount) FILTER (WHERE status = 'completed'), 0)::numeric AS settled_amount
       FROM public.admin_settlements WHERE company_id = $1::uuid`,
    [companyId],
  );
  const settlements = await db.query(
    `SELECT id, amount::numeric AS amount, commission_amount::numeric AS commission_deducted,
            net_amount::numeric AS net_amount, currency, period, paid_at, created_at, status, method, reference
       FROM public.admin_settlements
      WHERE company_id = $1::uuid AND status <> 'void'
      ORDER BY created_at DESC LIMIT 50`,
    [companyId],
  );
  const summary = calculateWalletSummary({
    totalSales: sales?.total_sales || 0,
    commissionType: company.commission_type,
    commissionValue: company.commission_value,
    settledAmount: payouts?.settled_amount || 0,
  });
  return jsonResponse(ok({
    ...summary,
    currency: c.env.DEFAULT_CURRENCY || 'EGP',
    settlements: settlements.map((row) => ({
      id: row.id,
      amount: Number(row.amount || 0),
      commissionDeducted: Number(row.commission_deducted || 0),
      netAmount: Number(row.net_amount || 0),
      currency: row.currency?.trim() || c.env.DEFAULT_CURRENCY || 'EGP',
      period: row.period,
      date: row.paid_at || row.created_at,
      status: row.status,
      method: row.method,
      reference: row.reference,
    })),
  }));
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
