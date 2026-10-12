-- Durable private document bytes in Neon, linked to the company-scoped metadata row.
-- Cloudflare KV remains an optional mirror; the Neon record is the source of truth.
CREATE TABLE IF NOT EXISTS public.company_profile_document_blobs (
  document_id UUID PRIMARY KEY
    REFERENCES public.company_profile_documents(id) ON DELETE CASCADE,
  file_data BYTEA NOT NULL
    CHECK (octet_length(file_data) > 0 AND octet_length(file_data) <= 10485760),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.company_profile_document_blobs IS
  'Private company KYC document bytes retained in Neon; document_id links each blob to its company-owned metadata record.';
