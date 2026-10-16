import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { requireCompanyTenant, tenantTable } from '../lib/tenantDb.js';
import { isUUID } from '../middleware/validate.js';

const orders = new Hono();
const allowedStatuses = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned', 'refunded']);

// GET /api/companies/:companyId/orders — orders created by public checkout for this merchant.
orders.get('/:companyId/orders', authMiddleware, async (c) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;

  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
  const offset = (page - 1) * limit;
  const requestedStatus = c.req.query('status') || null;
  const status = requestedStatus && allowedStatuses.has(requestedStatus) ? requestedStatus : null;
  const orderTable = tenantTable(tenant.schema, 'orders');
  const customerTable = tenantTable(tenant.schema, 'customers');
  const addressTable = tenantTable(tenant.schema, 'addresses');
  const itemTable = tenantTable(tenant.schema, 'order_items');
  const shipmentTable = tenantTable(tenant.schema, 'shipments');

  const rows = await db.query(
    `SELECT o.id, o.company_id, o.order_number, o.status, o.payment_method, o.payment_status,
       o.currency, o.subtotal, o.shipping_total, o.tax_total, o.grand_total,
       o.customer_note, o.placed_at, o.created_at, o.updated_at,
       s.status AS shipment_status,
       request.status AS shipping_request_status,
       request.requested_at AS shipping_requested_at,
       c.full_name AS customer_name,
       COALESCE(c.email, c.metadata->>'contactEmail') AS customer_email,
       c.phone AS customer_phone,
       a.recipient_name, a.country, a.governorate, a.city, a.district,
       a.street, a.building, a.apartment, a.postal_code, a.notes AS address_notes,
       COALESCE(json_agg(json_build_object(
         'id', oi.id, 'productId', oi.product_id, 'name', oi.product_name,
         'sku', oi.sku, 'quantity', oi.quantity, 'unitPrice', oi.unit_price,
         'totalPrice', oi.total_price
       ) ORDER BY oi.product_name) FILTER (WHERE oi.id IS NOT NULL), '[]'::json) AS items,
       count(*) OVER()::int AS _total
     FROM ${orderTable} o
     LEFT JOIN ${customerTable} c ON c.id = o.customer_id
     LEFT JOIN ${addressTable} a ON a.id = o.address_id
     LEFT JOIN ${shipmentTable} s ON s.order_id = o.id
     LEFT JOIN public.shipment_activation_requests request ON request.company_id = o.company_id AND request.order_id = o.id
     LEFT JOIN ${itemTable} oi ON oi.order_id = o.id
     WHERE o.company_id = $1 AND ($2::text IS NULL OR o.status = $2)
     GROUP BY o.id, c.id, a.id, s.status, request.status, request.requested_at
     ORDER BY o.created_at DESC
     LIMIT $3 OFFSET $4`,
    [companyId, status, limit, offset],
  );
  const total = rows.length ? rows[0]._total : 0;
  return jsonResponse(ok({
    items: rows.map(({ _total, ...order }) => ({
      ...order,
      subtotal: Number(order.subtotal || 0),
      shipping_total: Number(order.shipping_total || 0),
      tax_total: Number(order.tax_total || 0),
      grand_total: Number(order.grand_total || 0),
      items: Array.isArray(order.items) ? order.items : [],
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 },
  }));
});

// POST /api/companies/:companyId/orders/:orderId/activate-shipping — request shipping activation from Mange.
orders.post('/:companyId/orders/:orderId/activate-shipping', authMiddleware, async (c) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const orderId = c.req.param('orderId');
  if (!isUUID(companyId) || !isUUID(orderId)) return errorResponse('معرّف المتجر أو الطلب غير صالح.', 400);

  const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;
  const orderTable = tenantTable(tenant.schema, 'orders');
  const shipmentTable = tenantTable(tenant.schema, 'shipments');
  const [order] = await db.query(
    `SELECT o.id, o.order_number, o.status AS order_status, s.status AS shipment_status
       FROM ${orderTable} o
       LEFT JOIN ${shipmentTable} s ON s.order_id = o.id
      WHERE o.id = $1::uuid AND o.company_id = $2::uuid
      LIMIT 1`,
    [orderId, companyId],
  );
  if (!order) return errorResponse('الطلب غير موجود.', 404);
  if (['cancelled', 'delivered', 'shipped', 'returned', 'refunded'].includes(order.order_status)
      || ['ready', 'picked_up', 'in_transit', 'delivered'].includes(order.shipment_status)) {
    return errorResponse('لا يمكن طلب تفعيل الشحن لهذه الحالة.', 409);
  }

  const [created] = await db.query(
    `INSERT INTO public.shipment_activation_requests (company_id, order_id, order_number, requested_by)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
     ON CONFLICT (company_id, order_id) DO NOTHING
     RETURNING id, status, requested_at`,
    [companyId, orderId, order.order_number, user.id],
  );
  if (created) {
    return jsonResponse(ok({ orderId, orderNumber: order.order_number, requestId: created.id, status: created.status, requestedAt: created.requested_at }, 'تم إرسال طلب تفعيل الشحن إلى الإدارة.'));
  }

  const [existing] = await db.query(
    `SELECT id, status, requested_at FROM public.shipment_activation_requests
      WHERE company_id = $1::uuid AND order_id = $2::uuid LIMIT 1`,
    [companyId, orderId],
  );
  if (existing?.status === 'pending') {
    return jsonResponse(ok({ orderId, orderNumber: order.order_number, requestId: existing.id, status: existing.status, requestedAt: existing.requested_at, alreadyRequested: true }, 'طلب تفعيل الشحن موجود لدى الإدارة بالفعل.'));
  }
  return errorResponse('تمت معالجة طلب تفعيل الشحن لهذا الطلب بالفعل.', 409);
});

// Legacy merchant action is retained only to direct older app versions to the admin workflow.
orders.post('/:companyId/orders/:orderId/ready', authMiddleware, async () => (
  errorResponse('تم نقل تجهيز الطرد وإشعار العميل إلى تطبيق الإدارة.', 403)
));

export default orders;
