-- Add Google/Firebase sign-in for merchant accounts while preserving existing
-- email/password accounts. Registration creates the user, owner membership,
-- company row, and tenant schema in one PostgreSQL transaction.
BEGIN;

ALTER TABLE public.users
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS firebase_uid TEXT,
  ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_auth_provider_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_auth_provider_check
      CHECK (auth_provider IN ('password', 'firebase_google'));
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_uq
  ON public.users (firebase_uid)
  WHERE firebase_uid IS NOT NULL;

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
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_uid_owner public.users%ROWTYPE;
  v_company public.companies%ROWTYPE;
  v_company_id UUID;
  v_store_name TEXT := NULLIF(BTRIM(p_store_name), '');
BEGIN
  IF NULLIF(BTRIM(p_firebase_uid), '') IS NULL
     OR NULLIF(BTRIM(p_email), '') IS NULL THEN
    RAISE EXCEPTION 'INVALID_FIREBASE_IDENTITY' USING ERRCODE = 'P0001';
  END IF;

  -- Serialize concurrent sign-ins for the same verified email. The unique
  -- Firebase UID index remains the final guard for cross-email races.
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
    IF v_store_name IS NULL OR LENGTH(v_store_name) < 2 OR LENGTH(v_store_name) > 120 THEN
      RAISE EXCEPTION 'STORE_NAME_REQUIRED' USING ERRCODE = 'P0001';
    END IF;

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

  IF v_company.id IS NULL THEN
    IF v_store_name IS NULL OR LENGTH(v_store_name) < 2 OR LENGTH(v_store_name) > 120 THEN
      RAISE EXCEPTION 'STORE_NAME_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    IF p_company_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       OR LENGTH(p_company_slug) < 3 OR LENGTH(p_company_slug) > 50 THEN
      RAISE EXCEPTION 'INVALID_COMPANY_SLUG' USING ERRCODE = 'P0001';
    END IF;

    SELECT public.create_company_with_owner(
      p_company_slug, v_store_name, v_store_name, v_user.id, v_user.email
    ) INTO v_company_id;

    SELECT * INTO v_company
    FROM public.companies
    WHERE id = v_company_id;
  END IF;

  RETURN QUERY SELECT
    v_user.id, v_user.email, v_user.full_name, v_user.phone,
    v_user.is_platform_admin, v_company.id, v_company.slug,
    v_company.display_name, v_company.tenant_schema_name;
END;
$$;

REVOKE ALL ON FUNCTION public.register_firebase_google_merchant(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

COMMIT;
