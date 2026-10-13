BEGIN;

ALTER TABLE public.merchant_store_requests
  ADD COLUMN IF NOT EXISTS profile_data JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'merchant_store_requests_profile_data_object_ck'
      AND conrelid = 'public.merchant_store_requests'::regclass
  ) THEN
    ALTER TABLE public.merchant_store_requests
      ADD CONSTRAINT merchant_store_requests_profile_data_object_ck
      CHECK (jsonb_typeof(profile_data) = 'object');
  END IF;
END;
$migration$;

ALTER TABLE public.merchant_store_requests
  DROP CONSTRAINT IF EXISTS merchant_store_requests_status_check;
ALTER TABLE public.merchant_store_requests
  ADD CONSTRAINT merchant_store_requests_status_check
  CHECK (status IN ('draft', 'pending', 'approved', 'rejected'));

CREATE TABLE IF NOT EXISTS public.merchant_store_request_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.merchant_store_requests(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('nationalId', 'commercialRegister', 'propertyContract')),
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  uploaded_by UUID NOT NULL REFERENCES public.users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, document_type)
);
CREATE INDEX IF NOT EXISTS merchant_store_request_documents_request_idx
  ON public.merchant_store_request_documents (request_id);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_store_requests_one_draft_per_user_uq
  ON public.merchant_store_requests (user_id) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS public.merchant_store_request_document_blobs (
  document_id UUID PRIMARY KEY REFERENCES public.merchant_store_request_documents(id) ON DELETE CASCADE,
  file_data BYTEA NOT NULL CHECK (octet_length(file_data) > 0 AND octet_length(file_data) <= 10485760),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.merchant_store_request_document_blobs IS
  'Private KYC document bytes for merchant store applications, retained in Neon until admin approval or request deletion.';

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
  v_document RECORD;
  v_company_document_id UUID;
  v_extension TEXT;
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

  IF LENGTH(BTRIM(COALESCE(v_request.profile_data->>'legalName', ''))) < 2
     OR LENGTH(BTRIM(COALESCE(v_request.profile_data->>'displayName', ''))) < 2
     OR LENGTH(BTRIM(COALESCE(v_request.profile_data->>'email', ''))) < 5
     OR LENGTH(BTRIM(COALESCE(v_request.profile_data->>'commercialRegisterNumber', ''))) < 5
     OR LENGTH(BTRIM(COALESCE(v_request.profile_data->>'taxId', ''))) < 5
     OR COALESCE(v_request.profile_data->'warehouseAddress'->>'governorate', '') <> v_request.governorate
     OR LENGTH(BTRIM(COALESCE(v_request.profile_data->'warehouseAddress'->>'city', ''))) = 0
     OR LENGTH(BTRIM(COALESCE(v_request.profile_data->'warehouseAddress'->>'street', ''))) = 0
     OR COALESCE(v_request.profile_data->>'payoutMethod', '') NOT IN ('vodafone_cash', 'instapay', 'bank')
     OR LENGTH(BTRIM(COALESCE(v_request.profile_data->>'payoutNumber', ''))) = 0
     OR (SELECT COUNT(DISTINCT d.document_type)
         FROM public.merchant_store_request_documents d
         JOIN public.merchant_store_request_document_blobs b ON b.document_id = d.id
         WHERE d.request_id = v_request.id) < 3 THEN
    RAISE EXCEPTION 'STORE_REQUEST_PROFILE_INCOMPLETE' USING ERRCODE = 'P0001';
  END IF;

  SELECT public.create_company_with_owner(
    v_request.company_slug,
    COALESCE(NULLIF(v_request.profile_data->>'legalName', ''), v_request.store_name),
    COALESCE(NULLIF(v_request.profile_data->>'displayName', ''), v_request.store_name),
    v_request.user_id,
    COALESCE(NULLIF(v_request.profile_data->>'email', ''), v_request.email),
    v_request.governorate
  ) INTO v_company_id;

  UPDATE public.companies
  SET legal_name = COALESCE(NULLIF(v_request.profile_data->>'legalName', ''), store_name),
      display_name = COALESCE(NULLIF(v_request.profile_data->>'displayName', ''), store_name),
      email = COALESCE(NULLIF(v_request.profile_data->>'email', ''), v_request.email),
      commercial_register_number = NULLIF(v_request.profile_data->>'commercialRegisterNumber', ''),
      tax_id = NULLIF(v_request.profile_data->>'taxId', ''),
      warehouse_address = COALESCE(v_request.profile_data->'warehouseAddress', '{}'::jsonb),
      payout_method = NULLIF(v_request.profile_data->>'payoutMethod', ''),
      payout_number = NULLIF(v_request.profile_data->>'payoutNumber', ''),
      updated_at = NOW()
  WHERE id = v_company_id;

  FOR v_document IN
    SELECT d.document_type, d.content_type, d.size_bytes, d.uploaded_by,
           b.file_data
    FROM public.merchant_store_request_documents d
    JOIN public.merchant_store_request_document_blobs b ON b.document_id = d.id
    WHERE d.request_id = v_request.id
    ORDER BY d.document_type
  LOOP
    v_extension := CASE v_document.content_type
      WHEN 'application/pdf' THEN 'pdf'
      WHEN 'image/jpeg' THEN 'jpg'
      WHEN 'image/png' THEN 'png'
      ELSE 'bin'
    END;

    INSERT INTO public.company_profile_documents
      (company_id, document_type, storage_key, content_type, size_bytes, uploaded_by, uploaded_at)
    VALUES
      (v_company_id, v_document.document_type,
       v_company_id::TEXT || '/' || v_document.document_type || '/' || gen_random_uuid()::TEXT || '.' || v_extension,
       v_document.content_type, v_document.size_bytes, v_document.uploaded_by, NOW())
    RETURNING id INTO v_company_document_id;

    INSERT INTO public.company_profile_document_blobs (document_id, file_data)
    VALUES (v_company_document_id, v_document.file_data);
  END LOOP;

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

COMMIT;
