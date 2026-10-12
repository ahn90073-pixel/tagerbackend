-- Store-level Egyptian governorate, selected during merchant onboarding.
-- Additive and safe to re-run; existing stores remain NULL until an owner completes setup.
BEGIN;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS governorate TEXT;
CREATE INDEX IF NOT EXISTS companies_governorate_idx
  ON public.companies (governorate);

CREATE OR REPLACE FUNCTION public.create_company_with_owner(
  p_slug TEXT,
  p_legal_name TEXT,
  p_display_name TEXT,
  p_owner_user_id UUID,
  p_email TEXT,
  p_governorate TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_company_id UUID := gen_random_uuid();
  v_schema TEXT;
  v_governorates TEXT[] := ARRAY[
    'القاهرة','الجيزة','الإسكندرية','الدقهلية','البحر الأحمر','البحيرة','الفيوم',
    'الغربية','الإسماعيلية','المنوفية','المنيا','القليوبية','الوادي الجديد','السويس',
    'أسوان','أسيوط','بني سويف','بورسعيد','دمياط','الشرقية','جنوب سيناء','كفر الشيخ',
    'مطروح','الأقصر','قنا','شمال سيناء','سوهاج'
  ]::TEXT[];
BEGIN
  IF p_governorate IS NULL OR NOT (p_governorate = ANY(v_governorates)) THEN
    RAISE EXCEPTION 'INVALID_COMPANY_GOVERNORATE' USING ERRCODE = 'P0001';
  END IF;

  v_schema := public.company_tenant_schema_name(p_slug, p_display_name, v_company_id);

  INSERT INTO public.companies (id, slug, legal_name, display_name, email, tenant_schema_name, governorate)
  VALUES (v_company_id, p_slug, p_legal_name, p_display_name, p_email, v_schema, p_governorate);

  INSERT INTO public.company_members (company_id, user_id, role, is_active)
  VALUES (v_company_id, p_owner_user_id, 'owner', TRUE);

  PERFORM public.provision_company_schema(v_company_id);
  RETURN v_company_id;
END
$function$;

REVOKE ALL ON FUNCTION public.create_company_with_owner(TEXT, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;

COMMIT;
