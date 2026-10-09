import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { jsonResponse, ok } from '../lib/response.js';
import { requireCompanyTenant, tenantTable } from '../lib/tenantDb.js';

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

  const rows = await db.query(
    `SELECT o.id, o.company_id, o.order_number, o.status, o.payment_method, o.payment_status,
       o.currency, o.subtotal, o.shipping_total, o.tax_total, o.grand_total,
       o.customer_note, o.placed_at, o.created_at, o.updated_at,
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
     LEFT JOIN ${itemTable} oi ON oi.order_id = o.id
     WHERE o.company_id = $1 AND ($2::text IS NULL OR o.status = $2)
     GROUP BY o.id, c.id, a.id
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

export default orders;
