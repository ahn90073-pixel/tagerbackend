/*
# Multi-tenant Marketplace Schema (سوق اون لين)

This migration creates the complete database schema for a multi-tenant marketplace platform.
Based on the user-provided Neon PostgreSQL schema with two additions:
1. password_hash column on app.users for bcrypt-based authentication
2. 'pending' added to app.product_status enum for admin-approval workflow

## New Schemas
- app: main application schema (all shared tables)
- audit: reserved for audit logging

## New Types (Enums)
- company_status: pending, active, suspended, closed
- member_role: owner, admin, catalog_manager, order_manager, support, viewer
- product_status: draft, pending, active, archived (pending = awaiting admin approval)
- order_status: pending, confirmed, processing, shipped, delivered, cancelled, returned, refunded
- payment_status: pending, authorized, paid, failed, refunded, partially_refunded
- payment_method: cash_on_delivery, card, wallet, bank_transfer
- shipment_status: pending, label_created, picked_up, in_transit, delivered, failed, returned
- discount_type: percentage, fixed

## New Tables (all under app schema)
- companies: multi-tenant company records with tenant schema isolation
- users: platform users with password_hash for auth
- company_members: many-to-many company/user with roles
- categories: product categories per company
- products: products per company with status including pending for approval
- product_images: images per product
- product_variants: variant combinations per product
- inventory: stock tracking per product/variant/warehouse
- customers: customer records per company
- addresses: customer shipping addresses
- carts: shopping carts (customer or anonymous)
- cart_items: items in carts
- orders: order records
- order_items: line items with computed totals
- payments: payment records
- shipments: shipping/tracking records
- coupons: discount codes per company
- order_coupons: coupons applied to orders
- reviews: product reviews
- wishlists: customer wishlists
- wishlist_items: items in wishlists
- device_tokens: push notification tokens
- notifications: notification records
- audit_logs: audit trail

## Functions
- app.set_updated_at(): trigger function to auto-update updated_at
- app.provision_company_schema(p_company_id): creates tenant_<uuid> schema with filtered views
- app.create_company_with_owner(...): creates company + owner membership + provisions schema
- app.make_order_number(): auto-generates order numbers

## Triggers
- orders_order_number_trigger: auto order number on insert
- *_updated_at triggers on all tables with updated_at

## Security
- RLS enabled on all tables
- Policies allow anon+authenticated access (this is a backend API that enforces auth via JWT)
- The Express backend uses service role / DATABASE_URL for direct queries

## Important Notes
1. The app.users table includes password_hash for bcrypt-based auth (not Supabase Auth)
2. product_status includes 'pending' for the admin approval workflow
3. tenant_* schemas are filtered views, canonical data stays in app.*
4. All tenant queries must include company_id from the JWT, never from the client
*/

create extension if not exists pgcrypto;
create extension if not exists citext;

create schema if not exists app;
create schema if not exists audit;

create type app.company_status as enum ('pending', 'active', 'suspended', 'closed');
create type app.member_role as enum ('owner', 'admin', 'catalog_manager', 'order_manager', 'support', 'viewer');
create type app.product_status as enum ('draft', 'pending', 'active', 'archived');
create type app.order_status as enum ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned', 'refunded');
create type app.payment_status as enum ('pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_refunded');
create type app.payment_method as enum ('cash_on_delivery', 'card', 'wallet', 'bank_transfer');
create type app.shipment_status as enum ('pending', 'label_created', 'picked_up', 'in_transit', 'delivered', 'failed', 'returned');
create type app.discount_type as enum ('percentage', 'fixed');

create or replace function app.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists app.companies (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique,
  legal_name text not null,
  display_name text not null,
  logo_url text,
  description text,
  email citext,
  phone text,
  status app.company_status not null default 'pending',
  currency char(3) not null default 'EGP',
  timezone text not null default 'Africa/Cairo',
  tenant_schema_name text not null unique,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (tenant_schema_name ~ '^tenant_[a-f0-9]{32}$')
);

create table if not exists app.users (
  id uuid primary key default gen_random_uuid(),
  firebase_uid text unique,
  email citext unique,
  phone text unique,
  full_name text,
  avatar_url text,
  password_hash text,
  is_platform_admin boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.company_members (
  company_id uuid not null references app.companies(id) on delete cascade,
  user_id uuid not null references app.users(id) on delete cascade,
  role app.member_role not null default 'viewer',
  is_active boolean not null default true,
  invited_by uuid references app.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

create table if not exists app.categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references app.companies(id) on delete cascade,
  parent_id uuid references app.categories(id) on delete set null,
  name text not null,
  slug citext not null,
  icon text,
  image_url text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, slug),
  unique (id, company_id)
);

create table if not exists app.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references app.companies(id) on delete cascade,
  category_id uuid,
  sku text not null,
  name text not null,
  slug citext not null,
  description text,
  short_description text,
  status app.product_status not null default 'pending',
  price numeric(14,2) not null default 0 check (price >= 0),
  compare_at_price numeric(14,2) check (compare_at_price is null or compare_at_price >= 0),
  cost_price numeric(14,2) check (cost_price is null or cost_price >= 0),
  currency char(3) not null default 'EGP',
  weight_grams integer check (weight_grams is null or weight_grams >= 0),
  brand text,
  seller_name text,
  trusted_seller boolean not null default false,
  free_shipping boolean not null default false,
  is_featured boolean not null default false,
  is_flash_deal boolean not null default false,
  badge text,
  rating numeric(2,1) not null default 0 check (rating between 0 and 5),
  review_count integer not null default 0 check (review_count >= 0),
  metadata jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, sku),
  unique (company_id, slug),
  foreign key (category_id, company_id) references app.categories(id, company_id) on delete set null
);

create table if not exists app.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references app.products(id) on delete cascade,
  url text not null,
  alt_text text,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists app.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references app.products(id) on delete cascade,
  sku text not null,
  name text not null,
  options jsonb not null default '{}'::jsonb,
  price numeric(14,2),
  compare_at_price numeric(14,2),
  weight_grams integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, sku)
);

create table if not exists app.inventory (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references app.companies(id) on delete cascade,
  product_id uuid not null references app.products(id) on delete cascade,
  variant_id uuid references app.product_variants(id) on delete cascade,
  quantity_on_hand integer not null default 0 check (quantity_on_hand >= 0),
  quantity_reserved integer not null default 0 check (quantity_reserved >= 0),
  reorder_level integer not null default 0 check (reorder_level >= 0),
  warehouse text not null default 'main',
  updated_at timestamptz not null default now(),
  unique (company_id, product_id, variant_id, warehouse)
);

create table if not exists app.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app.users(id) on delete set null,
  company_id uuid references app.companies(id) on delete cascade,
  email citext,
  phone text,
  full_name text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, email),
  unique (company_id, phone)
);

create table if not exists app.addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references app.customers(id) on delete cascade,
  label text,
  recipient_name text not null,
  phone text not null,
  country text not null default 'Egypt',
  governorate text,
  city text,
  district text,
  street text,
  building text,
  apartment text,
  postal_code text,
  notes text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.carts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references app.companies(id) on delete cascade,
  customer_id uuid references app.customers(id) on delete set null,
  anonymous_key text,
  status text not null default 'active' check (status in ('active', 'converted', 'abandoned')),
  currency char(3) not null default 'EGP',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (customer_id is not null or anonymous_key is not null)
);

create unique index if not exists carts_active_customer_idx on app.carts(company_id, customer_id) where status = 'active' and customer_id is not null;
create unique index if not exists carts_active_anonymous_idx on app.carts(company_id, anonymous_key) where status = 'active' and anonymous_key is not null;

create table if not exists app.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references app.carts(id) on delete cascade,
  product_id uuid not null references app.products(id) on delete restrict,
  variant_id uuid references app.product_variants(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  product_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cart_id, product_id, variant_id)
);

create table if not exists app.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  company_id uuid not null references app.companies(id) on delete restrict,
  customer_id uuid references app.customers(id) on delete set null,
  address_id uuid references app.addresses(id) on delete set null,
  status app.order_status not null default 'pending',
  payment_method app.payment_method not null default 'cash_on_delivery',
  payment_status app.payment_status not null default 'pending',
  currency char(3) not null default 'EGP',
  subtotal numeric(14,2) not null default 0,
  discount_total numeric(14,2) not null default 0,
  shipping_total numeric(14,2) not null default 0,
  tax_total numeric(14,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  customer_note text,
  internal_note text,
  placed_at timestamptz not null default now(),
  confirmed_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references app.orders(id) on delete cascade,
  product_id uuid references app.products(id) on delete set null,
  variant_id uuid references app.product_variants(id) on delete set null,
  product_name text not null,
  sku text,
  quantity integer not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  total_price numeric(14,2) generated always as (quantity * unit_price) stored,
  product_snapshot jsonb not null default '{}'::jsonb
);

create table if not exists app.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references app.orders(id) on delete cascade,
  provider text,
  provider_payment_id text,
  amount numeric(14,2) not null check (amount >= 0),
  currency char(3) not null default 'EGP',
  status app.payment_status not null default 'pending',
  provider_response jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_payment_id)
);

create table if not exists app.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references app.orders(id) on delete cascade,
  carrier text,
  tracking_number text,
  status app.shipment_status not null default 'pending',
  shipping_address jsonb not null default '{}'::jsonb,
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.coupons (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references app.companies(id) on delete cascade,
  code citext not null,
  discount_type app.discount_type not null,
  discount_value numeric(14,2) not null check (discount_value >= 0),
  minimum_order_value numeric(14,2) not null default 0,
  maximum_discount numeric(14,2),
  usage_limit integer,
  used_count integer not null default 0,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code)
);

create table if not exists app.order_coupons (
  order_id uuid not null references app.orders(id) on delete cascade,
  coupon_id uuid not null references app.coupons(id) on delete restrict,
  amount numeric(14,2) not null check (amount >= 0),
  primary key (order_id, coupon_id)
);

create table if not exists app.reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references app.companies(id) on delete cascade,
  product_id uuid not null references app.products(id) on delete cascade,
  customer_id uuid references app.customers(id) on delete set null,
  order_id uuid references app.orders(id) on delete set null,
  rating integer not null check (rating between 1 and 5),
  title text,
  body text,
  is_verified_purchase boolean not null default false,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.wishlists (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references app.customers(id) on delete cascade,
  name text not null default 'المفضلة',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.wishlist_items (
  wishlist_id uuid not null references app.wishlists(id) on delete cascade,
  product_id uuid not null references app.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (wishlist_id, product_id)
);

create table if not exists app.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app.users(id) on delete cascade,
  customer_id uuid references app.customers(id) on delete cascade,
  company_id uuid references app.companies(id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('android', 'ios', 'web')),
  app_version text,
  enabled boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references app.companies(id) on delete cascade,
  user_id uuid references app.users(id) on delete cascade,
  customer_id uuid references app.customers(id) on delete cascade,
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists app.audit_logs (
  id bigint generated always as identity primary key,
  company_id uuid references app.companies(id) on delete set null,
  user_id uuid references app.users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index if not exists products_company_status_idx on app.products(company_id, status);
create index if not exists products_company_category_idx on app.products(company_id, category_id);
create index if not exists products_search_idx on app.products using gin (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')));
create index if not exists orders_company_status_idx on app.orders(company_id, status, created_at desc);
create index if not exists orders_customer_idx on app.orders(customer_id, created_at desc);
create index if not exists reviews_product_idx on app.reviews(product_id, is_published);
create index if not exists notifications_user_idx on app.notifications(user_id, created_at desc);
create index if not exists audit_company_idx on app.audit_logs(company_id, created_at desc);

create or replace function app.provision_company_schema(p_company_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, app, public
as $$
declare
  v_schema text := 'tenant_' || replace(p_company_id::text, '-', '');
begin
  execute format('create schema if not exists %I', v_schema);
  execute format('create or replace view %I.products as select * from app.products where company_id = %L::uuid', v_schema, p_company_id);
  execute format('create or replace view %I.categories as select * from app.categories where company_id = %L::uuid', v_schema, p_company_id);
  execute format('create or replace view %I.orders as select * from app.orders where company_id = %L::uuid', v_schema, p_company_id);
  execute format('create or replace view %I.coupons as select * from app.coupons where company_id = %L::uuid', v_schema, p_company_id);
  update app.companies set tenant_schema_name = v_schema where id = p_company_id;
  return v_schema;
end;
$$;

create or replace function app.create_company_with_owner(
  p_slug text,
  p_legal_name text,
  p_display_name text,
  p_owner_user_id uuid,
  p_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, app, public
as $$
declare
  v_company_id uuid;
  v_schema text;
begin
  insert into app.companies(slug, legal_name, display_name, email, tenant_schema_name)
  values (p_slug, p_legal_name, p_display_name, p_email, 'tenant_' || replace(gen_random_uuid()::text, '-', ''))
  returning id into v_company_id;

  insert into app.company_members(company_id, user_id, role)
  values (v_company_id, p_owner_user_id, 'owner');

  v_schema := app.provision_company_schema(v_company_id);
  return v_company_id;
end;
$$;

create or replace function app.make_order_number()
returns trigger language plpgsql as $$
begin
  if new.order_number is null or new.order_number = '' then
    new.order_number := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(replace(new.id::text, '-', ''), 1, 8));
  end if;
  return new;
end;
$$;

drop trigger if exists orders_order_number_trigger on app.orders;
create trigger orders_order_number_trigger before insert on app.orders for each row execute function app.make_order_number();

DO $$
declare t text;
begin
  foreach t in array array['companies','users','company_members','categories','products','product_variants','inventory','customers','addresses','carts','cart_items','orders','payments','shipments','coupons','reviews','wishlists','device_tokens'] loop
    execute format('drop trigger if exists %I on app.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on app.%I for each row execute function app.set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;

-- Enable RLS on all tables (the Express backend connects with service role which bypasses RLS)
ALTER TABLE app.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.order_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.wishlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_logs ENABLE ROW LEVEL SECURITY;

-- Policies: allow anon+authenticated (the Express API enforces auth via JWT at the application layer)
-- The service role key used by the backend bypasses RLS entirely.
-- These policies allow direct Supabase client access if needed in the future.
DO $$
declare
  t text;
  tables text[] := array['companies','users','company_members','categories','products','product_images','product_variants','inventory','customers','addresses','carts','cart_items','orders','order_items','payments','shipments','coupons','order_coupons','reviews','wishlists','wishlist_items','device_tokens','notifications','audit_logs'];
begin
  foreach t in array tables loop
    execute format('DROP POLICY IF EXISTS "anon_select_%s" ON app.%I', t, t);
    execute format('CREATE POLICY "anon_select_%s" ON app.%I FOR SELECT TO anon, authenticated USING (true)', t, t);
    execute format('DROP POLICY IF EXISTS "anon_insert_%s" ON app.%I', t, t);
    execute format('CREATE POLICY "anon_insert_%s" ON app.%I FOR INSERT TO anon, authenticated WITH CHECK (true)', t, t);
    execute format('DROP POLICY IF EXISTS "anon_update_%s" ON app.%I', t, t);
    execute format('CREATE POLICY "anon_update_%s" ON app.%I FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true)', t, t);
    execute format('DROP POLICY IF EXISTS "anon_delete_%s" ON app.%I', t, t);
    execute format('CREATE POLICY "anon_delete_%s" ON app.%I FOR DELETE TO anon, authenticated USING (true)', t, t);
  end loop;
END $$;
