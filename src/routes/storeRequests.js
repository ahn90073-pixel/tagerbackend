import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok, created } from '../lib/response.js';
import { authMiddleware } from '../middleware/auth.js';
import { makeStoreSlug, prepareStoreApplication } from '../lib/storeRequests.js';

const storeRequests = new Hono();

storeRequests.get('/me', authMiddleware, async (c) => {
  const db = createDb(c.env);
  const user = c.get('user');
  const [request] = await db`
    SELECT id, full_name AS "fullName", email, phone, store_name AS "storeName",
      governorate, status, admin_note AS "adminNote", company_id AS "companyId",
      created_at AS "createdAt", reviewed_at AS "reviewedAt"
    FROM public.merchant_store_requests
    WHERE user_id = ${user.id}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  return jsonResponse(ok(request || { status: 'none' }));
});

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
        (user_id, email, full_name, phone, store_name, company_slug, governorate)
      VALUES
        (${user.id}, ${email}, ${fullName}, ${phone}, ${storeName}, ${makeStoreSlug(storeName)}, ${governorate})
      RETURNING id, full_name AS "fullName", email, phone, store_name AS "storeName",
        governorate, status, admin_note AS "adminNote", company_id AS "companyId",
        created_at AS "createdAt"
    `;
    return jsonResponse(created(request, 'تم إرسال طلب إنشاء المتجر إلى الإدارة للمراجعة.'), 201);
  } catch (error) {
    if (error?.code === '23505') return errorResponse('لديك طلب إنشاء متجر قيد المراجعة بالفعل.', 409);
    throw error;
  }
});

export default storeRequests;
