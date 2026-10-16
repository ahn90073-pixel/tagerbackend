BEGIN;

-- Store only coarse Cloudflare IP-geolocation labels for push-enabled devices.
-- Never persist the source IP address or exact coordinates.
ALTER TABLE public.notification_contacts
  ADD COLUMN IF NOT EXISTS location_city TEXT,
  ADD COLUMN IF NOT EXISTS location_region TEXT,
  ADD COLUMN IF NOT EXISTS location_country TEXT;

COMMIT;
