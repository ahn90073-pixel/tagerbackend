BEGIN;

-- Store only the normalized Egyptian governorate supplied by the checkout form;
-- no address details or device/GPS location are derived from this field.
ALTER TABLE public.notification_contacts
  ADD COLUMN IF NOT EXISTS governorate TEXT;

CREATE INDEX IF NOT EXISTS notification_contacts_governorate_idx
  ON public.notification_contacts (audience, governorate)
  WHERE governorate IS NOT NULL;

ALTER TABLE IF EXISTS app.device_tokens
  ADD COLUMN IF NOT EXISTS governorate TEXT;

DO $$
BEGIN
  IF to_regclass('app.device_tokens') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS device_tokens_governorate_idx
      ON app.device_tokens (governorate)
      WHERE governorate IS NOT NULL;
  END IF;
END $$;

COMMIT;
