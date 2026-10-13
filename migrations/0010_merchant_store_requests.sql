-- New merchant accounts may sign in and submit personal/store details without
-- creating a company or tenant schema. Company provisioning happens only inside
-- the admin approval transaction below.
BEGIN;

CREATE TABLE IF NOT EXISTS public.merchant_store_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  store_name TEXT NOT NULL,
  company_slug TEXT NOT NULL,
  governorate TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note TEXT,
  company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
  reviewed_by_admin_user_id UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (LENGTH(BTRIM(full_name)) BETWEEN 2 AND 160),
  CHECK (LENGTH(BTRIM(phone)) BETWEEN 5 AND 30),
  CHECK (LENGTH(BTRIM(store_name)) BETWEEN 2 AND 120),
  CHECK (company_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CHECK (LENGTH(BTRIM(governorate)) > 0)
);

CREATE INDEX IF NOT EXISTS merchant_store_requests_status_created_idx
  ON public.merchant_store_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS merchant_store_requests_user_created_idx
  ON public.merchant_store_requests (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_store_requests_one_pending_per_user_uq
  ON public.merchant_store_requests (user_id) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.approve_merchant_store_request(
  p_request_id UUID,
  p_admin_user_id UUID
)
RETURNS TABLE (
  request_id UUID,
  company_id UUID,
  company_slug TEXT,
  store_name TEXT,
  governorate TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request public.merchant_store_requests%ROWTYPE;
  v_company_id UUID;
BEGIN
  SELECT * INTO v_request
  FROM public.merchant_store_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'STORE_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'STORE_REQUEST_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.user_id = v_request.user_id AND cm.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'MERCHANT_ALREADY_HAS_STORE' USING ERRCODE = 'P0001';
  END IF;

  -- This existing function creates the company, owner membership and tenant
  -- schema using the submitted company name only after this approval call.
  SELECT public.create_company_with_owner(
    v_request.company_slug,
    v_request.store_name,
    v_request.store_name,
    v_request.user_id,
    v_request.email,
    v_request.governorate
  ) INTO v_company_id;

  UPDATE public.merchant_store_requests
  SET status = 'approved', company_id = v_company_id,
      reviewed_by_admin_user_id = p_admin_user_id,
      reviewed_at = NOW(), updated_at = NOW(), admin_note = NULL
  WHERE id = v_request.id;

  RETURN QUERY SELECT v_request.id, v_company_id, v_request.company_slug,
    v_request.store_name, v_request.governorate;
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_merchant_store_request(UUID, UUID) FROM PUBLIC;

-- Google sign-in creates/links only the user. It returns an existing company
-- when one is already approved, but never provisions a new company or schema.
CREATE OR REPLACE FUNCTION public.register_firebase_google_merchant(
  p_firebase_uid TEXT,
  p_email TEXT,
  p_full_name TEXT,
  p_phone TEXT,
  p_store_name TEXT,
  p_company_slug TEXT
)
RETURNS TABLE (
  out_user_id UUID,
  out_email TEXT,
  out_full_name TEXT,
  out_phone TEXT,
  out_is_platform_admin BOOLEAN,
  out_company_id UUID,
  out_company_slug TEXT,
  out_company_display_name TEXT,
  out_tenant_schema_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_uid_owner public.users%ROWTYPE;
  v_company public.companies%ROWTYPE;
BEGIN
  IF NULLIF(BTRIM(p_firebase_uid), '') IS NULL
     OR NULLIF(BTRIM(p_email), '') IS NULL THEN
    RAISE EXCEPTION 'INVALID_FIREBASE_IDENTITY' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(LOWER(p_email))::BIGINT);

  SELECT * INTO v_user
  FROM public.users
  WHERE LOWER(email) = LOWER(p_email)
  LIMIT 1
  FOR UPDATE;

  SELECT * INTO v_uid_owner
  FROM public.users
  WHERE firebase_uid = p_firebase_uid
  LIMIT 1
  FOR UPDATE;

  IF v_uid_owner.id IS NOT NULL
     AND (v_user.id IS NULL OR v_uid_owner.id <> v_user.id) THEN
    RAISE EXCEPTION 'FIREBASE_UID_LINKED_TO_ANOTHER_ACCOUNT' USING ERRCODE = 'P0001';
  END IF;

  IF v_user.id IS NOT NULL THEN
    IF v_user.firebase_uid IS NOT NULL AND v_user.firebase_uid <> p_firebase_uid THEN
      RAISE EXCEPTION 'EMAIL_LINKED_TO_ANOTHER_FIREBASE_ACCOUNT' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.users
    SET firebase_uid = p_firebase_uid,
        auth_provider = 'firebase_google',
        full_name = COALESCE(NULLIF(BTRIM(full_name), ''), NULLIF(BTRIM(p_full_name), '')),
        phone = COALESCE(phone, NULLIF(BTRIM(p_phone), '')),
        updated_at = NOW()
    WHERE id = v_user.id
    RETURNING * INTO v_user;
  ELSE
    INSERT INTO public.users (email, password_hash, full_name, phone, firebase_uid, auth_provider)
    VALUES (
      LOWER(BTRIM(p_email)), NULL,
      NULLIF(BTRIM(p_full_name), ''),
      NULLIF(BTRIM(p_phone), ''),
      p_firebase_uid, 'firebase_google'
    )
    RETURNING * INTO v_user;
  END IF;

  SELECT c.* INTO v_company
  FROM public.companies c
  JOIN public.company_members cm ON cm.company_id = c.id
  WHERE cm.user_id = v_user.id AND cm.is_active = TRUE
  ORDER BY c.created_at DESC, c.id
  LIMIT 1;

  RETURN QUERY SELECT
    v_user.id, v_user.email, v_user.full_name, v_user.phone,
    v_user.is_platform_admin, v_company.id, v_company.slug,
    v_company.display_name, v_company.tenant_schema_name;
END;
$function$;

REVOKE ALL ON FUNCTION public.register_firebase_google_merchant(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

COMMIT;
