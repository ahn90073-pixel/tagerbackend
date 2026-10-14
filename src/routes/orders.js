import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { requireCompanyTenant, tenantTable } from '../lib/tenantDb.js';
import { sendFcmMessage } from '../lib/fcm.js';
import { normalizeEgyptPhone } from '../lib/phone.js';

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
     LEFT JOIN ${itemTable} oi ON oi.order_id = o.id
     WHERE o.company_id = $1 AND ($2::text IS NULL OR o.status = $2)
     GROUP BY o.id, c.id, a.id, s.status
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

// POST /api/companies/:companyId/orders/:orderId/ready — mark a parcel ready once.
orders.post('/:companyId/orders/:orderId/ready', authMiddleware, async (c) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  const orderId = c.req.param('orderId');
  const db = createDb(c.env);
  const tenant = await requireCompanyTenant(db, companyId, user.id);
  if (tenant.error) return tenant.error;
  const orderTable = tenantTable(tenant.schema, 'orders');
  const shipmentTable = tenantTable(tenant.schema, 'shipments');
  const customerTable = tenantTable(tenant.schema, 'customers');
  const [order] = await db.query(
    `SELECT o.id, o.order_number, o.status AS order_status, c.phone AS customer_phone,
            s.status AS shipment_status
       FROM ${orderTable} o
       LEFT JOIN ${customerTable} c ON c.id = o.customer_id
       LEFT JOIN ${shipmentTable} s ON s.order_id = o.id
      WHERE o.id = $1::uuid AND o.company_id = $2::uuid
      LIMIT 1`,
    [orderId, companyId],
  );
  if (!order) return errorResponse('Order not found', 404);
  if (['cancelled', 'delivered', 'shipped', 'returned', 'refunded'].includes(order.order_status)
      || ['delivered', 'in_transit', 'picked_up'].includes(order.shipment_status)) {
    return errorResponse('This order cannot be marked ready', 409);
  }
  if (order.shipment_status === 'ready') {
    return jsonResponse(ok({ orderId: order.id, shipmentStatus: 'ready' }, 'Shipment is already ready'));
  }

  const [updated] = await db.query(
    `UPDATE ${shipmentTable} s
        SET status = 'ready', updated_at = NOW()
       FROM ${orderTable} o
      WHERE s.order_id = o.id AND o.id = $1::uuid AND o.company_id = $2::uuid
        AND o.status NOT IN ('cancelled', 'delivered', 'shipped')
        AND s.status NOT IN ('ready', 'delivered', 'in_transit', 'picked_up')
      RETURNING s.order_id`,
    [orderId, companyId],
  );
  if (!updated) {
    const [current] = await db.query(`SELECT status FROM ${shipmentTable} WHERE order_id = $1::uuid LIMIT 1`, [orderId]);
    if (current?.status === 'ready') return jsonResponse(ok({ orderId, shipmentStatus: 'ready' }, 'Shipment is already ready'));
    return errorResponse('Shipment could not be marked ready', 409);
  }

  const phone = normalizeEgyptPhone(order.customer_phone);
  if (phone) {
    const contacts = await db.query(
      `SELECT fcm_token FROM public.notification_contacts
        WHERE audience = 'customer' AND company_id = $1 AND whatsapp_phone = $2
          AND push_enabled = TRUE AND fcm_token IS NOT NULL`,
      [companyId, phone],
    );
    for (const contact of contacts) {
      try {
        await sendFcmMessage({
          env: c.env,
          token: contact.fcm_token,
          appName: 'online-store',
          title: 'تم تجهيز طردك',
          body: `تم تجهيز طلبك ${order.order_number} للشحن.`,
          data: { type: 'shipment_ready', orderId: order.id, orderNumber: order.order_number },
        });
      } catch {
        console.warn('Shipment status updated, but a customer FCM notification failed.');
      }
    }
  }
  return jsonResponse(ok({ orderId: order.id, shipmentStatus: 'ready' }, 'Shipment marked ready'));
});

export default orders;
