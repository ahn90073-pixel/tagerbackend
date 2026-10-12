-- Company merchant profile and private KYC document metadata.
-- The actual files are stored only in a private Cloudflare R2 bucket.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS commercial_register_number TEXT,
  ADD COLUMN IF NOT EXISTS tax_id TEXT,
  ADD COLUMN IF NOT EXISTS warehouse_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS payout_method TEXT,
  ADD COLUMN IF NOT EXISTS payout_number TEXT;

CREATE TABLE IF NOT EXISTS public.company_profile_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('nationalId', 'commercialRegister', 'propertyContract')),
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  uploaded_by UUID NOT NULL REFERENCES public.users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, document_type)
);
CREATE INDEX IF NOT EXISTS company_profile_documents_company_idx
  ON public.company_profile_documents (company_id);
