import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok, created } from '../lib/response.js';
import { authMiddleware } from '../middleware/auth.js';
import { COMPANY_PROFILE_DOCUMENT_TYPES, detectCompanyDocumentType } from '../lib/companyProfile.js';
import { encodeDocumentBytes } from '../lib/companyDocumentBlob.js';
import { makeStoreSlug, prepareCompleteStoreApplication, prepareStoreApplication } from '../lib/storeRequests.js';

const storeRequests = new Hono();
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const documentExtensions = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

async function loadRequest(db, userId) {
  const [request] = await db`
    SELECT r.id, r.full_name AS "fullName", r.email, r.phone,
      r.store_name AS "storeName", r.governorate, r.status,
      r.admin_note AS "adminNote", r.company_id AS "companyId",
      r.profile_data AS "profileData", r.created_at AS "createdAt",
      r.reviewed_at AS "reviewedAt",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'documentType', d.document_type,
          'contentType', d.content_type,
          'sizeBytes', d.size_bytes,
          'uploadedAt', d.uploaded_at
        ) ORDER BY d.document_type)
        FROM public.merchant_store_request_documents d WHERE d.request_id = r.id
      ), '[]'::jsonb) AS documents
    FROM public.merchant_store_requests r
    WHERE r.user_id = ${userId}
    ORDER BY CASE WHEN r.status = 'pending' THEN 0 WHEN r.status = 'draft' THEN 1 ELSE 2 END,
      r.created_at DESC, r.id DESC
    LIMIT 1
  `;
  return request || { status: 'none' };
}

storeRequests.get('/me', authMiddleware, async (c) => {
  const db = createDb(c.env);
  const user = c.get('user');
  return jsonResponse(ok(await loadRequest(db, user.id)));
});

// Save the complete company profile as a private draft (or update the current
// pending application). Drafts are not returned to the admin review queue.
storeRequests.put('/me/profile', authMiddleware, async (c) => {
  const user = c.get('user');
  let body;
  try { body = await c.req.json(); } catch { return errorResponse('بيانات ملف الشركة غير صالحة.', 400); }
  const prepared = prepareCompleteStoreApplication(body, user);
  if (prepared.error) return errorResponse(prepared.error, 400);
  const { fullName, phone, storeName, governorate, email, profileData } = prepared.application;
  const db = createDb(c.env);
  const [existingCompany] = await db`
    SELECT c.id FROM public.companies c
    JOIN public.company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${user.id} AND cm.is_active = TRUE
    LIMIT 1
  `;
  if (existingCompany) return errorResponse('يوجد متجر معتمد مرتبط بهذا الحساب بالفعل.', 409);

  const [current] = await db`
    SELECT id, status FROM public.merchant_store_requests
    WHERE user_id = ${user.id} AND status IN ('pending', 'draft')
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
    LIMIT 1
  `;
  if (current) {
    const [updated] = await db`
      UPDATE public.merchant_store_requests
      SET email = ${email}, full_name = ${fullName}, phone = ${phone},
          store_name = ${storeName}, company_slug = ${makeStoreSlug(storeName)},
          governorate = ${governorate}, profile_data = ${JSON.stringify(profileData)}::jsonb,
          updated_at = NOW()
      WHERE id = ${current.id} AND status IN ('pending', 'draft')
      RETURNING id
    `;
    if (!updated) return errorResponse('تمت معالجة الطلب أثناء تحديث الملف. أعد تحميل حالة الطلب.', 409);
  } else {
    try {
      await db`
        INSERT INTO public.merchant_store_requests
          (user_id, email, full_name, phone, store_name, company_slug, governorate, status, profile_data)
        VALUES
          (${user.id}, ${email}, ${fullName}, ${phone}, ${storeName}, ${makeStoreSlug(storeName)},
           ${governorate}, 'draft', ${JSON.stringify(profileData)}::jsonb)
        ON CONFLICT (user_id) WHERE status = 'draft'
        DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name,
          phone = EXCLUDED.phone, store_name = EXCLUDED.store_name,
          company_slug = EXCLUDED.company_slug, governorate = EXCLUDED.governorate,
          profile_data = EXCLUDED.profile_data, updated_at = NOW()
      `;
    } catch (error) {
      if (error?.code === '23505') return errorResponse('يوجد طلب قيد المراجعة. حدّث الملف الحالي بدل إنشاء طلب جديد.', 409);
      throw error;
    }
  }
  return jsonResponse(ok(await loadRequest(db, user.id), 'تم حفظ ملف التقديم بأمان.'));
});

// Private KYC documents are stored in Neon under the merchant request. They
// are copied to company-profile storage only by the admin approval function.
storeRequests.post('/me/documents/:documentType', authMiddleware, async (c) => {
  const user = c.get('user');
  const documentType = c.req.param('documentType');
  if (!COMPANY_PROFILE_DOCUMENT_TYPES.includes(documentType)) return errorResponse('نوع المستند غير مدعوم.', 400);
  const contentLength = Number(c.req.header('content-length') || 0);
  if (contentLength > MAX_DOCUMENT_BYTES + 64 * 1024) return errorResponse('حجم المستند يتجاوز 10 ميجابايت.', 413);
  let form;
  try { form = await c.req.formData(); } catch { return errorResponse('يجب رفع المستند بصيغة نموذج ملفات.', 400); }
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function' || typeof file.size !== 'number') return errorResponse('اختر ملف المستند أولًا.', 400);
  if (file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) return errorResponse('يجب أن يكون حجم المستند بين بايت واحد و10 ميجابايت.', 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectCompanyDocumentType(bytes);
  if (!detected) return errorResponse('الملفات المقبولة PDF أو JPG أو PNG صحيحة المحتوى.', 415);

  const db = createDb(c.env);
  const [request] = await db`
    SELECT id FROM public.merchant_store_requests
    WHERE user_id = ${user.id} AND status IN ('draft', 'pending')
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
    LIMIT 1
  `;
  if (!request) return errorResponse('احفظ بيانات ملف التقديم قبل رفع المستندات.', 409);
  const storageKey = `${request.id}/${documentType}/${crypto.randomUUID()}.${documentExtensions[detected.contentType]}`;
  const base64File = encodeDocumentBytes(bytes);
  const [saved] = await db`
    WITH eligible_request AS (
      SELECT id FROM public.merchant_store_requests
      WHERE id = ${request.id} AND user_id = ${user.id} AND status IN ('draft', 'pending')
      FOR UPDATE
    ), upserted_document AS (
      INSERT INTO public.merchant_store_request_documents
        (request_id, document_type, storage_key, content_type, size_bytes, uploaded_by, uploaded_at)
      SELECT id, ${documentType}, ${storageKey}, ${detected.contentType}, ${bytes.byteLength}, ${user.id}, NOW()
      FROM eligible_request
      ON CONFLICT (request_id, document_type) DO UPDATE SET
        storage_key = EXCLUDED.storage_key, content_type = EXCLUDED.content_type,
        size_bytes = EXCLUDED.size_bytes, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = NOW()
      RETURNING id
    ), upserted_blob AS (
      INSERT INTO public.merchant_store_request_document_blobs (document_id, file_data)
      SELECT id, decode(${base64File}, 'base64') FROM upserted_document
      ON CONFLICT (document_id) DO UPDATE SET file_data = EXCLUDED.file_data, updated_at = NOW()
      RETURNING document_id
    )
    SELECT d.id FROM upserted_document d JOIN upserted_blob b ON b.document_id = d.id
  `;
  if (!saved) return errorResponse('تمت معالجة الطلب ولا يمكن تغيير مستنداته الآن.', 409);
  return jsonResponse(ok(await loadRequest(db, user.id), 'تم حفظ المستند في ملف الطلب الخاص.'));
});

storeRequests.post('/me/submit', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = createDb(c.env);
  const [request] = await db`
    SELECT id, full_name AS "fullName", phone, profile_data AS "profileData", status
    FROM public.merchant_store_requests
    WHERE user_id = ${user.id} AND status IN ('draft', 'pending')
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
    LIMIT 1
  `;
  if (!request) return errorResponse('احفظ بيانات الملف وارفع المستندات قبل إرسال الطلب.', 409);
  const prepared = prepareCompleteStoreApplication({
    fullName: request.fullName,
    phone: request.phone,
    profileData: request.profileData,
  }, user);
  if (prepared.error) return errorResponse(prepared.error, 400);
  const documents = await db`
    SELECT document_type FROM public.merchant_store_request_documents WHERE request_id = ${request.id}
  `;
  const suppliedTypes = new Set(documents.map((document) => document.document_type));
  const missingTypes = COMPANY_PROFILE_DOCUMENT_TYPES.filter((type) => !suppliedTypes.has(type));
  if (missingTypes.length) return errorResponse('ارفع البطاقة الشخصية والسجل التجاري وإثبات عنوان المستودع قبل إرسال الطلب.', 400);
  const [submitted] = await db`
    UPDATE public.merchant_store_requests
    SET status = 'pending', updated_at = NOW()
    WHERE id = ${request.id} AND status IN ('draft', 'pending')
    RETURNING id
  `;
  if (!submitted) return errorResponse('تمت معالجة الطلب أثناء الإرسال. حدّث حالة الملف.', 409);
  return jsonResponse(ok(await loadRequest(db, user.id), 'تم إرسال الملف الكامل إلى الإدارة للمراجعة.'));
});

// Compatibility endpoint for previously installed app versions. The admin
// approval routine refuses provisioning until the complete profile is supplied.
storeRequests.post('/', authMiddleware, async (c) => {
  const user = c.get('user');
  let body;
  try { body = await c.req.json(); } catch { return errorResponse('بيانات طلب المتجر غير صالحة.', 400); }
  const prepared = prepareStoreApplication(body, user);
  if (prepared.error) return errorResponse(prepared.error, 400);
  const { fullName, phone, storeName, governorate, email } = prepared.application;
  const db = createDb(c.env);
  const [existingCompany] = await db`
    SELECT c.id FROM public.companies c
    JOIN public.company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${user.id} AND cm.is_active = TRUE
    LIMIT 1
  `;
  if (existingCompany) return errorResponse('يوجد متجر معتمد مرتبط بهذا الحساب بالفعل.', 409);
  try {
    const [request] = await db`
      INSERT INTO public.merchant_store_requests
        (user_id, email, full_name, phone, store_name, company_slug, governorate, status)
      VALUES
        (${user.id}, ${email}, ${fullName}, ${phone}, ${storeName}, ${makeStoreSlug(storeName)}, ${governorate}, 'pending')
      RETURNING id, full_name AS "fullName", email, phone, store_name AS "storeName",
        governorate, status, admin_note AS "adminNote", company_id AS "companyId",
        profile_data AS "profileData", created_at AS "createdAt"
    `;
    return jsonResponse(created(request, 'تم إرسال طلب إنشاء المتجر إلى الإدارة للمراجعة.'), 201);
  } catch (error) {
    if (error?.code === '23505') return errorResponse('لديك طلب إنشاء متجر قيد المراجعة بالفعل.', 409);
    throw error;
  }
});

export default storeRequests;
