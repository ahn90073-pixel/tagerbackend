CREATE EXTENSION IF NOT EXISTS postgis;

BEGIN;

-- Store coarse Cloudflare IP-geolocation labels and its approximate city-level point.
-- Never persist the source IP address or GPS coordinates.
ALTER TABLE public.notification_contacts
  ADD COLUMN IF NOT EXISTS location_city TEXT,
  ADD COLUMN IF NOT EXISTS location_region TEXT,
  ADD COLUMN IF NOT EXISTS location_country TEXT,
  ADD COLUMN IF NOT EXISTS location_point geography(Point, 4326);

CREATE INDEX IF NOT EXISTS notification_contacts_location_point_gist_idx
  ON public.notification_contacts USING GIST (location_point);

COMMIT;
