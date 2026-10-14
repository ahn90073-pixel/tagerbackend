-- Notification contacts are intentionally central: merchant and storefront clients
-- can be addressed across the public and tenant namespaces.
BEGIN;

CREATE TABLE IF NOT EXISTS public.notification_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience TEXT NOT NULL CHECK (audience IN ('merchant', 'customer')),
  app_name TEXT NOT NULL CHECK (app_name IN ('taget', 'online-store')),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  whatsapp_phone TEXT,
  fcm_token TEXT,
  token_hash TEXT,
  platform TEXT CHECK (platform IS NULL OR platform IN ('android', 'ios', 'web')),
  app_version TEXT,
  push_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (audience = 'merchant' AND company_id IS NOT NULL AND user_id IS NOT NULL)
    OR (audience = 'customer' AND company_id IS NOT NULL AND whatsapp_phone IS NOT NULL)
  ),
  CHECK (
    (fcm_token IS NULL AND token_hash IS NULL AND platform IS NULL)
    OR (fcm_token IS NOT NULL AND token_hash IS NOT NULL AND platform IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_contacts_token_uq
  ON public.notification_contacts (audience, company_id, token_hash)
  WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notification_contacts_phone_uq
  ON public.notification_contacts (audience, company_id, whatsapp_phone)
  WHERE token_hash IS NULL AND whatsapp_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_contacts_push_enabled_idx
  ON public.notification_contacts (audience, company_id)
  WHERE push_enabled = TRUE AND fcm_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_contacts_whatsapp_idx
  ON public.notification_contacts (audience, company_id, whatsapp_phone)
  WHERE whatsapp_phone IS NOT NULL;

-- Existing active tenant schemas at migration time.
ALTER TABLE IF EXISTS tenant_ahmd_mhmd_7e4bfbc2.shipments
  DROP CONSTRAINT IF EXISTS shipments_status_check;
ALTER TABLE IF EXISTS tenant_ahmd_mhmd_7e4bfbc2.shipments
  ADD CONSTRAINT shipments_status_check CHECK (status IN ('pending', 'ready', 'label_created', 'picked_up', 'in_transit', 'delivered', 'failed', 'returned'));

ALTER TABLE IF EXISTS tenant_ai_a878a_c40323ad.shipments
  DROP CONSTRAINT IF EXISTS shipments_status_check;
ALTER TABLE IF EXISTS tenant_ai_a878a_c40323ad.shipments
  ADD CONSTRAINT shipments_status_check CHECK (status IN ('pending', 'ready', 'label_created', 'picked_up', 'in_transit', 'delivered', 'failed', 'returned'));

ALTER TABLE IF EXISTS tenant_swq_awnlayn_7e03e2e1.shipments
  DROP CONSTRAINT IF EXISTS shipments_status_check;
ALTER TABLE IF EXISTS tenant_swq_awnlayn_7e03e2e1.shipments
  ADD CONSTRAINT shipments_status_check CHECK (status IN ('pending', 'ready', 'label_created', 'picked_up', 'in_transit', 'delivered', 'failed', 'returned'));

ALTER TABLE IF EXISTS tenant_tbnrw_92bebe3f.shipments
  DROP CONSTRAINT IF EXISTS shipments_status_check;
ALTER TABLE IF EXISTS tenant_tbnrw_92bebe3f.shipments
  ADD CONSTRAINT shipments_status_check CHECK (status IN ('pending', 'ready', 'label_created', 'picked_up', 'in_transit', 'delivered', 'failed', 'returned'));

COMMIT;
