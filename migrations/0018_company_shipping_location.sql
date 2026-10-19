BEGIN;
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS shipping_location_latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS shipping_location_longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS shipping_location_consent_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'companies_shipping_location_latitude_range'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_shipping_location_latitude_range
      CHECK (shipping_location_latitude IS NULL OR shipping_location_latitude BETWEEN -90 AND 90);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'companies_shipping_location_longitude_range'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_shipping_location_longitude_range
      CHECK (shipping_location_longitude IS NULL OR shipping_location_longitude BETWEEN -180 AND 180);
  END IF;
END $$;
COMMIT;
