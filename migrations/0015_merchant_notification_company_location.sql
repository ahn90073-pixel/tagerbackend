-- Snapshot the verified company name and coarse IP-derived location with merchant push tokens.
-- Raw IP addresses and device GPS coordinates are never stored.
BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE public.notification_contacts
  ADD COLUMN IF NOT EXISTS company_name TEXT,
  ADD COLUMN IF NOT EXISTS location_city TEXT,
  ADD COLUMN IF NOT EXISTS location_region TEXT,
  ADD COLUMN IF NOT EXISTS location_country TEXT,
  ADD COLUMN IF NOT EXISTS location_point geography(Point, 4326);

UPDATE public.notification_contacts AS contact
SET company_name = COALESCE(NULLIF(BTRIM(company.display_name), ''), NULLIF(BTRIM(company.legal_name), '')),
    updated_at = NOW()
FROM public.companies AS company
WHERE contact.audience = 'merchant'
  AND contact.company_id = company.id
  AND (contact.company_name IS NULL OR BTRIM(contact.company_name) = '');

CREATE INDEX IF NOT EXISTS notification_contacts_location_point_gist_idx
  ON public.notification_contacts USING GIST (location_point)
  WHERE audience = 'merchant' AND location_point IS NOT NULL;

COMMIT;
