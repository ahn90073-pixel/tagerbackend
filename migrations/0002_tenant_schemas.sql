-- Provision an isolated PostgreSQL namespace for every company.
-- Canonical data remains in the existing public tables and is still protected
-- by company_id authorization. The tenant namespace exposes company-filtered views.
BEGIN;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS tenant_schema_name TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS companies_tenant_schema_name_uq
  ON public.companies (tenant_schema_name);

CREATE OR REPLACE FUNCTION public.company_tenant_schema_name(
  p_slug TEXT,
  p_display_name TEXT,
  p_company_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_source TEXT;
  v_slug TEXT;
  v_pair RECORD;
BEGIN
  v_source := coalesce(nullif(p_slug, ''), nullif(p_display_name, ''), 'company');

  -- The current UI slugger uses merchant-<random> when the company name is
  -- Arabic-only. In that case derive a readable ASCII form from the display name.
  IF v_source ~ '^merchant-[a-z0-9]{5}$' AND coalesce(p_display_name, '') <> '' THEN
    v_source := p_display_name;
  END IF;

  FOR v_pair IN
    SELECT * FROM (VALUES
      ('أ', 'a'), ('إ', 'i'), ('آ', 'a'), ('ٱ', 'a'), ('ا', 'a'),
      ('ب', 'b'), ('ت', 't'), ('ث', 'th'), ('ج', 'j'), ('ح', 'h'), ('خ', 'kh'),
      ('د', 'd'), ('ذ', 'dh'), ('ر', 'r'), ('ز', 'z'), ('س', 's'), ('ش', 'sh'),
      ('ص', 's'), ('ض', 'd'), ('ط', 't'), ('ظ', 'z'), ('ع', 'a'), ('غ', 'gh'),
      ('ف', 'f'), ('ق', 'q'), ('ك', 'k'), ('ل', 'l'), ('م', 'm'), ('ن', 'n'),
      ('ه', 'h'), ('و', 'w'), ('ي', 'y'), ('ى', 'a'), ('ة', 'h'), ('ؤ', 'w'),
      ('ئ', 'y'), ('ء', 'a')
    ) AS letters(source_char, target_text)
  LOOP
    v_source := replace(v_source, v_pair.source_char, v_pair.target_text);
  END LOOP;

  v_slug := trim(both '_' FROM regexp_replace(lower(v_source), '[^a-z0-9]+', '_', 'g'));
  IF v_slug = '' THEN
    v_slug := 'company';
  END IF;

  -- Prefix + at most 45 ASCII slug chars + underscore + 8 hex chars <= 61 bytes.
  RETURN 'tenant_' || left(v_slug, 45) || '_' || left(replace(p_company_id::TEXT, '-', ''), 8);
END;
$$;

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
BEGIN
  SELECT slug, display_name, tenant_schema_name
    INTO v_slug, v_display_name, v_existing_schema
    FROM public.companies
    WHERE id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company % not found', p_company_id USING ERRCODE = 'P0002';
  END IF;

  -- Preserve an existing namespace name; otherwise derive a safe SQL identifier
  -- from the company slug supplied by the registration UI and add a unique suffix.
  v_schema := v_existing_schema;
  IF v_schema IS NULL THEN
    v_schema := public.company_tenant_schema_name(v_slug, v_display_name, p_company_id);
  END IF;

  IF to_regnamespace(v_schema) IS NOT NULL THEN
    RETURN v_schema;
  END IF;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema);
  EXECUTE format(
    'CREATE OR REPLACE VIEW %I.categories AS SELECT * FROM public.categories WHERE company_id = %L::uuid',
    v_schema, p_company_id
  );
  EXECUTE format(
    'CREATE OR REPLACE VIEW %I.products AS SELECT * FROM public.products WHERE company_id = %L::uuid',
    v_schema, p_company_id
  );

  UPDATE public.companies
    SET tenant_schema_name = v_schema
    WHERE id = p_company_id AND tenant_schema_name IS DISTINCT FROM v_schema;

  RETURN v_schema;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_company_with_owner(
  p_slug TEXT,
  p_legal_name TEXT,
  p_display_name TEXT,
  p_owner_user_id UUID,
  p_email TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company_id UUID := gen_random_uuid();
  v_schema TEXT;
BEGIN
  v_schema := public.company_tenant_schema_name(p_slug, p_display_name, v_company_id);

  INSERT INTO public.companies (id, slug, legal_name, display_name, email, tenant_schema_name)
  VALUES (v_company_id, p_slug, p_legal_name, p_display_name, p_email, v_schema);

  INSERT INTO public.company_members (company_id, user_id, role, is_active)
  VALUES (v_company_id, p_owner_user_id, 'owner', TRUE);

  PERFORM public.provision_company_schema(v_company_id);
  RETURN v_company_id;
END;
$$;

-- Backfill existing companies once; the provisioning function is idempotent.
DO $$
DECLARE
  v_company RECORD;
BEGIN
  FOR v_company IN SELECT id FROM public.companies ORDER BY created_at, id LOOP
    PERFORM public.provision_company_schema(v_company.id);
  END LOOP;
END;
$$;

ALTER TABLE public.companies
  ALTER COLUMN tenant_schema_name SET NOT NULL;

-- Only the application database role (function owner) should invoke these
-- SECURITY DEFINER functions through authenticated API routes.
REVOKE ALL ON FUNCTION public.provision_company_schema(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_company_with_owner(TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_tenant_schema_name(TEXT, TEXT, UUID) FROM PUBLIC;

COMMIT;
