import { errorResponse } from './response.js';

const schemaNamePattern = /^tenant_[a-z0-9_]{1,54}$/;
const tenantTables = new Set([
  'categories', 'products', 'product_images', 'product_variants', 'inventory',
  'customers', 'addresses', 'carts', 'cart_items', 'orders', 'order_items',
  'payments', 'shipments', 'coupons', 'order_coupons', 'reviews', 'wishlists',
  'wishlist_items', 'device_tokens', 'notifications', 'audit_logs',
]);

export async function requireCompanyTenant(db, companyId, userId) {
  const [member] = await db`
    SELECT c.tenant_schema_name, cm.is_active
    FROM public.companies c
    JOIN public.company_members cm ON cm.company_id = c.id
    WHERE c.id = ${companyId} AND cm.user_id = ${userId}
    LIMIT 1
  `;

  if (!member) return { error: errorResponse('You do not have access to this company', 403) };
  if (!member.is_active) return { error: errorResponse('Your membership to this company is inactive', 403) };
  if (!schemaNamePattern.test(member.tenant_schema_name || '')) {
    throw new Error('Company tenant schema is missing or invalid.');
  }

  return { schema: member.tenant_schema_name };
}

export function tenantTable(schema, table) {
  if (!schemaNamePattern.test(schema || '') || !tenantTables.has(table)) {
    throw new Error('Invalid tenant table reference.');
  }
  // Names are additionally restricted to generated ASCII identifiers; values
  // in queries remain parameterized through Neon .query().
  return `"${schema}"."${table}"`;
}
