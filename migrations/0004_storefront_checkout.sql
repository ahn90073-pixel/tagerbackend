BEGIN;

-- One public checkout creates one order per merchant tenant. Any validation or
-- stock failure raises an exception and rolls back the complete checkout.
CREATE OR REPLACE FUNCTION public.create_storefront_orders(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_expected_vendors INTEGER;
  v_company RECORD;
  v_product RECORD;
  v_item JSONB;
  v_line JSONB;
  v_lines JSONB;
  v_orders JSONB := '[]'::jsonb;
  v_schema TEXT;
  v_name TEXT;
  v_phone TEXT;
  v_email TEXT;
  v_currency TEXT;
  v_subtotal NUMERIC(14,2);
  v_quantity INTEGER;
  v_product_id UUID;
  v_customer_id UUID;
  v_address_id UUID;
  v_order_id UUID;
  v_order_number TEXT;
  v_address_snapshot JSONB;
  v_order_note TEXT;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload->'items') <> 'array'
     OR jsonb_array_length(p_payload->'items') < 1
     OR jsonb_array_length(p_payload->'items') > 50 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_ORDER_ITEMS';
  END IF;

  v_name := btrim(p_payload #>> '{customer,fullName}');
  v_phone := btrim(p_payload #>> '{customer,phone}');
  v_email := nullif(btrim(p_payload #>> '{customer,email}'), '');
  v_order_note := nullif(btrim(p_payload->>'customerNote'), '');

  IF coalesce(v_name, '') = '' OR coalesce(v_phone, '') = ''
     OR coalesce(btrim(p_payload #>> '{address,governorate}'), '') = ''
     OR coalesce(btrim(p_payload #>> '{address,city}'), '') = ''
     OR coalesce(btrim(p_payload #>> '{address,street}'), '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MISSING_CUSTOMER_OR_ADDRESS';
  END IF;

  SELECT count(DISTINCT (line.value->>'vendorId')::uuid)
    INTO v_expected_vendors
  FROM jsonb_array_elements(p_payload->'items') AS line(value);

  IF v_expected_vendors = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_VENDOR';
  END IF;

  FOR v_company IN
    SELECT DISTINCT c.id, c.display_name, c.tenant_schema_name
    FROM jsonb_array_elements(p_payload->'items') AS line(value)
    JOIN public.companies c ON c.id = (line.value->>'vendorId')::uuid
    WHERE c.status = 'active'
    ORDER BY c.id
  LOOP
    v_schema := v_company.tenant_schema_name;
    IF v_schema !~ '^tenant_[a-z0-9_]{1,54}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_TENANT_SCHEMA';
    END IF;

    v_lines := '[]'::jsonb;
    v_subtotal := 0;
    v_currency := NULL;

    FOR v_item IN
      SELECT line.value
      FROM jsonb_array_elements(p_payload->'items') AS line(value)
      WHERE (line.value->>'vendorId')::uuid = v_company.id
    LOOP
      v_product_id := (v_item->>'productId')::uuid;
      v_quantity := (v_item->>'quantity')::integer;
      IF v_quantity < 1 OR v_quantity > 99 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_QUANTITY';
      END IF;

      EXECUTE format(
        'SELECT id, name, sku, price, currency, stock_quantity, seller_name
           FROM %I.products
          WHERE id = $1 AND company_id = $2 AND status = ''active''
          FOR UPDATE',
        v_schema
      ) INTO v_product USING v_product_id, v_company.id;

      IF v_product.id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PRODUCT_NOT_AVAILABLE';
      END IF;
      IF v_product.stock_quantity < v_quantity THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSUFFICIENT_STOCK';
      END IF;
      IF v_currency IS NOT NULL AND v_currency <> v_product.currency THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MIXED_CURRENCY_NOT_SUPPORTED';
      END IF;
      v_currency := coalesce(v_currency, v_product.currency, 'EGP');
      v_subtotal := v_subtotal + (v_product.price * v_quantity);

      EXECUTE format(
        'UPDATE %I.products SET stock_quantity = stock_quantity - $1, updated_at = now()
          WHERE id = $2 AND company_id = $3',
        v_schema
      ) USING v_quantity, v_product_id, v_company.id;

      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'productId', v_product.id,
        'name', v_product.name,
        'sku', v_product.sku,
        'quantity', v_quantity,
        'unitPrice', v_product.price,
        'currency', v_product.currency,
        'vendorId', v_company.id,
        'vendorName', coalesce(v_product.seller_name, v_company.display_name)
      ));
    END LOOP;

    IF jsonb_array_length(v_lines) = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EMPTY_VENDOR_ORDER';
    END IF;

    EXECUTE format(
      'INSERT INTO %I.customers AS current_customer (company_id, phone, full_name, metadata)
       VALUES ($1, $2, $3, jsonb_strip_nulls(jsonb_build_object(''contactEmail'', $4::text)))
       ON CONFLICT (company_id, phone) DO UPDATE
         SET full_name = EXCLUDED.full_name,
             metadata = current_customer.metadata || EXCLUDED.metadata,
             updated_at = now()
       RETURNING id',
      v_schema
    ) INTO v_customer_id USING v_company.id, v_phone, v_name, v_email;

    v_address_snapshot := jsonb_strip_nulls(jsonb_build_object(
      'recipientName', v_name,
      'phone', v_phone,
      'email', v_email,
      'country', coalesce(nullif(btrim(p_payload #>> '{address,country}'), ''), 'Egypt'),
      'governorate', btrim(p_payload #>> '{address,governorate}'),
      'city', btrim(p_payload #>> '{address,city}'),
      'district', nullif(btrim(p_payload #>> '{address,district}'), ''),
      'street', btrim(p_payload #>> '{address,street}'),
      'building', nullif(btrim(p_payload #>> '{address,building}'), ''),
      'apartment', nullif(btrim(p_payload #>> '{address,apartment}'), ''),
      'postalCode', nullif(btrim(p_payload #>> '{address,postalCode}'), ''),
      'notes', nullif(btrim(p_payload #>> '{address,notes}'), '')
    ));

    EXECUTE format(
      'INSERT INTO %I.addresses (
         customer_id, label, recipient_name, phone, country, governorate, city,
         district, street, building, apartment, postal_code, notes
       ) VALUES (
         $1, ''عنوان الطلب'', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       ) RETURNING id',
      v_schema
    ) INTO v_address_id USING
      v_customer_id,
      v_name,
      v_phone,
      v_address_snapshot->>'country',
      v_address_snapshot->>'governorate',
      v_address_snapshot->>'city',
      v_address_snapshot->>'district',
      v_address_snapshot->>'street',
      v_address_snapshot->>'building',
      v_address_snapshot->>'apartment',
      v_address_snapshot->>'postalCode',
      v_address_snapshot->>'notes';

    v_order_id := gen_random_uuid();
    v_order_number := 'SO-' || to_char(clock_timestamp(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    EXECUTE format(
      'INSERT INTO %I.orders (
         id, order_number, company_id, customer_id, address_id, status,
         payment_method, payment_status, currency, subtotal, discount_total,
         shipping_total, tax_total, grand_total, customer_note
       ) VALUES (
         $1, $2, $3, $4, $5, ''pending'', ''cash_on_delivery'', ''pending'',
         $6, $7, 0, 0, 0, $7, $8
       )',
      v_schema
    ) USING v_order_id, v_order_number, v_company.id, v_customer_id,
      v_address_id, v_currency, v_subtotal, v_order_note;

    FOR v_line IN SELECT line.value FROM jsonb_array_elements(v_lines) AS line(value)
    LOOP
      EXECUTE format(
        'INSERT INTO %I.order_items (
           order_id, product_id, product_name, sku, quantity, unit_price, product_snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        v_schema
      ) USING v_order_id, (v_line->>'productId')::uuid,
        v_line->>'name', v_line->>'sku', (v_line->>'quantity')::integer,
        (v_line->>'unitPrice')::numeric, v_line;
    END LOOP;

    EXECUTE format(
      'INSERT INTO %I.shipments (order_id, status, shipping_address)
       VALUES ($1, ''pending'', $2)',
      v_schema
    ) USING v_order_id, v_address_snapshot;

    v_orders := v_orders || jsonb_build_array(jsonb_build_object(
      'orderId', v_order_id,
      'orderNumber', v_order_number,
      'vendorId', v_company.id,
      'vendorName', v_company.display_name,
      'status', 'pending',
      'paymentMethod', 'cash_on_delivery',
      'currency', v_currency,
      'subtotal', v_subtotal,
      'shippingTotal', 0,
      'total', v_subtotal,
      'itemCount', jsonb_array_length(v_lines)
    ));
  END LOOP;

  IF jsonb_array_length(v_orders) <> v_expected_vendors THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENDOR_NOT_AVAILABLE';
  END IF;

  RETURN v_orders;
END;
$function$;

COMMIT;
