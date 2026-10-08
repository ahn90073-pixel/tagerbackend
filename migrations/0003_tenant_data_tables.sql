-- Convert company namespaces from filtered views to independent tenant tables.
-- Account identity and company membership remain central in public.*.
-- Legacy public product/category rows are retained as a rollback copy.
BEGIN;

CREATE OR REPLACE FUNCTION public.provision_company_schema(p_company_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_slug TEXT;
  v_display_name TEXT;
  v_schema TEXT;
  v_existing_schema TEXT;
  v_categories_kind "char";
  v_products_kind "char";
  v_legacy_views BOOLEAN := FALSE;
  v_count BIGINT;
BEGIN
  SELECT slug, display_name, tenant_schema_name
    INTO v_slug, v_display_name, v_existing_schema
    FROM public.companies
    WHERE id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company % not found', p_company_id USING ERRCODE = 'P0002';
  END IF;

  v_schema := coalesce(v_existing_schema, public.company_tenant_schema_name(v_slug, v_display_name, p_company_id));
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema);

  SELECT c.relkind INTO v_categories_kind
  FROM pg_class c
  WHERE c.oid = to_regclass(format('%I.categories', v_schema));
  SELECT c.relkind INTO v_products_kind
  FROM pg_class c
  WHERE c.oid = to_regclass(format('%I.products', v_schema));

  IF v_categories_kind = 'r'
     AND v_products_kind = 'r'
     AND to_regclass(format('%I.orders', v_schema)) IS NOT NULL
     AND to_regclass(format('%I.audit_logs', v_schema)) IS NOT NULL THEN
    RETURN v_schema;
  END IF;

  v_legacy_views := v_categories_kind = 'v' OR v_products_kind = 'v';
  IF v_categories_kind = 'v' THEN
    EXECUTE format('DROP VIEW %I.categories', v_schema);
  END IF;
  IF v_products_kind = 'v' THEN
    EXECUTE format('DROP VIEW %I.products', v_schema);
  END IF;

  -- Core tables mirror the current API model and keep the tenant's company id
  -- for traceability, while each schema contains only that company's records.
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      parent_id UUID,
      name TEXT NOT NULL,
      slug TEXT,
      icon TEXT,
      image_url TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, name),
      UNIQUE (id, company_id)
    )
  $ddl$, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      category_id UUID,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT,
      short_description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft', 'pending', 'active', 'archived')),
      price NUMERIC(14,2) NOT NULL CHECK (price >= 0),
      compare_at_price NUMERIC(14,2) CHECK (compare_at_price IS NULL OR compare_at_price >= 0),
      cost_price NUMERIC(14,2) CHECK (cost_price IS NULL OR cost_price >= 0),
      currency TEXT NOT NULL DEFAULT 'EGP',
      weight_grams INTEGER CHECK (weight_grams IS NULL OR weight_grams >= 0),
      brand TEXT,
      seller_name TEXT,
      trusted_seller BOOLEAN NOT NULL DEFAULT FALSE,
      free_shipping BOOLEAN NOT NULL DEFAULT FALSE,
      is_featured BOOLEAN NOT NULL DEFAULT FALSE,
      is_flash_deal BOOLEAN NOT NULL DEFAULT FALSE,
      badge TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, sku)
    )
  $ddl$, v_schema);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass(format('%I.products', v_schema))
      AND conname = 'products_category_id_fkey'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.products ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES %I.categories(id) ON DELETE SET NULL',
      v_schema, v_schema
    );
  END IF;

  EXECUTE format('CREATE INDEX IF NOT EXISTS products_company_created_idx ON %I.products (company_id, created_at DESC)', v_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS products_company_status_idx ON %I.products (company_id, status)', v_schema);

  -- Additional commerce records are created in the same private namespace.
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.product_images (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id UUID NOT NULL REFERENCES %I.products(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      alt_text TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.product_variants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id UUID NOT NULL REFERENCES %I.products(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      options JSONB NOT NULL DEFAULT '{}'::jsonb,
      price NUMERIC(14,2),
      compare_at_price NUMERIC(14,2),
      weight_grams INTEGER,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (product_id, sku)
    )
  $ddl$, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.inventory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES %I.products(id) ON DELETE CASCADE,
      variant_id UUID REFERENCES %I.product_variants(id) ON DELETE CASCADE,
      quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
      quantity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
      reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
      warehouse TEXT NOT NULL DEFAULT 'main',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, product_id, variant_id, warehouse)
    )
  $ddl$, v_schema, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.customers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
      email TEXT,
      phone TEXT,
      full_name TEXT,
      notes TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, email),
      UNIQUE (company_id, phone)
    )
  $ddl$, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES %I.customers(id) ON DELETE CASCADE,
      label TEXT,
      recipient_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'Egypt',
      governorate TEXT,
      city TEXT,
      district TEXT,
      street TEXT,
      building TEXT,
      apartment TEXT,
      postal_code TEXT,
      notes TEXT,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.carts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      customer_id UUID REFERENCES %I.customers(id) ON DELETE SET NULL,
      anonymous_key TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'abandoned')),
      currency CHAR(3) NOT NULL DEFAULT 'EGP',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (customer_id IS NOT NULL OR anonymous_key IS NOT NULL)
    )
  $ddl$, v_schema, v_schema);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS carts_active_customer_idx ON %I.carts (company_id, customer_id) WHERE status = ''active'' AND customer_id IS NOT NULL', v_schema);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS carts_active_anonymous_idx ON %I.carts (company_id, anonymous_key) WHERE status = ''active'' AND anonymous_key IS NOT NULL', v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.cart_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cart_id UUID NOT NULL REFERENCES %I.carts(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES %I.products(id) ON DELETE RESTRICT,
      variant_id UUID REFERENCES %I.product_variants(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
      product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (cart_id, product_id, variant_id)
    )
  $ddl$, v_schema, v_schema, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number TEXT NOT NULL UNIQUE,
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
      customer_id UUID REFERENCES %I.customers(id) ON DELETE SET NULL,
      address_id UUID REFERENCES %I.addresses(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned', 'refunded')),
      payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery' CHECK (payment_method IN ('cash_on_delivery', 'card', 'wallet', 'bank_transfer')),
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_refunded')),
      currency CHAR(3) NOT NULL DEFAULT 'EGP',
      subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
      discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      shipping_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      grand_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      customer_note TEXT,
      internal_note TEXT,
      placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, v_schema, v_schema, v_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS orders_company_status_idx ON %I.orders (company_id, status, created_at DESC)', v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.order_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES %I.orders(id) ON DELETE CASCADE,
      product_id UUID REFERENCES %I.products(id) ON DELETE SET NULL,
      variant_id UUID REFERENCES %I.product_variants(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
      total_price NUMERIC(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
      product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  $ddl$, v_schema, v_schema, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES %I.orders(id) ON DELETE CASCADE,
      provider TEXT,
      provider_payment_id TEXT,
      amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
      currency CHAR(3) NOT NULL DEFAULT 'EGP',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_refunded')),
      provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, provider_payment_id)
    )
  $ddl$, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.shipments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL UNIQUE REFERENCES %I.orders(id) ON DELETE CASCADE,
      carrier TEXT,
      tracking_number TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'label_created', 'picked_up', 'in_transit', 'delivered', 'failed', 'returned')),
      shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,
      shipped_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.coupons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
      discount_value NUMERIC(14,2) NOT NULL CHECK (discount_value >= 0),
      minimum_order_value NUMERIC(14,2) NOT NULL DEFAULT 0,
      maximum_discount NUMERIC(14,2),
      usage_limit INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, code)
    )
  $ddl$, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.order_coupons (
      order_id UUID NOT NULL REFERENCES %I.orders(id) ON DELETE CASCADE,
      coupon_id UUID NOT NULL REFERENCES %I.coupons(id) ON DELETE RESTRICT,
      amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
      PRIMARY KEY (order_id, coupon_id)
    )
  $ddl$, v_schema, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES %I.products(id) ON DELETE CASCADE,
      customer_id UUID REFERENCES %I.customers(id) ON DELETE SET NULL,
      order_id UUID REFERENCES %I.orders(id) ON DELETE SET NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      title TEXT,
      body TEXT,
      is_verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, v_schema, v_schema, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.wishlists (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES %I.customers(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'المفضلة',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.wishlist_items (
      wishlist_id UUID NOT NULL REFERENCES %I.wishlists(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES %I.products(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (wishlist_id, product_id)
    )
  $ddl$, v_schema, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.device_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
      customer_id UUID REFERENCES %I.customers(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
      app_version TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
      customer_id UUID REFERENCES %I.customers(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, v_schema, v_schema);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.audit_logs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
      user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id UUID,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip_address INET,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, v_schema);

  IF v_legacy_views THEN
    EXECUTE format(
      'INSERT INTO %I.categories (id, company_id, name, slug, created_at) SELECT id, company_id, name, slug, created_at FROM public.categories WHERE company_id = $1 ON CONFLICT (id) DO NOTHING',
      v_schema
    ) USING p_company_id;
    EXECUTE format(
      'INSERT INTO %I.products (id, company_id, category_id, sku, name, slug, description, short_description, status, price, compare_at_price, cost_price, currency, weight_grams, brand, seller_name, trusted_seller, free_shipping, is_featured, is_flash_deal, badge, metadata, stock_quantity, created_at, updated_at) SELECT id, company_id, category_id, sku, name, slug, description, short_description, status, price, compare_at_price, cost_price, currency, weight_grams, brand, seller_name, trusted_seller, free_shipping, is_featured, is_flash_deal, badge, metadata, stock_quantity, created_at, updated_at FROM public.products WHERE company_id = $1 ON CONFLICT (id) DO NOTHING',
      v_schema
    ) USING p_company_id;

    EXECUTE 'SELECT count(*) FROM public.categories WHERE company_id = $1' INTO v_count USING p_company_id;
    IF v_count <> 0 THEN
      EXECUTE format('SELECT count(*) FROM %I.categories WHERE company_id = $1', v_schema) INTO STRICT v_count USING p_company_id;
      IF v_count <> (SELECT count(*) FROM public.categories WHERE company_id = p_company_id) THEN
        RAISE EXCEPTION 'Category migration verification failed for company %', p_company_id;
      END IF;
    END IF;
    EXECUTE 'SELECT count(*) FROM public.products WHERE company_id = $1' INTO v_count USING p_company_id;
    IF v_count <> 0 THEN
      EXECUTE format('SELECT count(*) FROM %I.products WHERE company_id = $1', v_schema) INTO STRICT v_count USING p_company_id;
      IF v_count <> (SELECT count(*) FROM public.products WHERE company_id = p_company_id) THEN
        RAISE EXCEPTION 'Product migration verification failed for company %', p_company_id;
      END IF;
    END IF;
  END IF;

  UPDATE public.companies
    SET tenant_schema_name = v_schema
    WHERE id = p_company_id AND tenant_schema_name IS DISTINCT FROM v_schema;

  RETURN v_schema;
END;
$$;

-- Provision and copy every existing tenant. The public source rows are retained
-- as a rollback copy; all application reads/writes switch to the tenant tables.
DO $$
DECLARE
  v_company RECORD;
BEGIN
  FOR v_company IN SELECT id FROM public.companies ORDER BY created_at, id LOOP
    PERFORM public.provision_company_schema(v_company.id);
  END LOOP;
END;
$$;

COMMIT;
