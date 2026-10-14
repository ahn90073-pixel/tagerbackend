BEGIN;
-- Customer devices may grant push permission before sharing checkout details.
-- Keep merchant contacts fully linked while allowing customer device-only rows.
ALTER TABLE public.notification_contacts
  ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE public.notification_contacts
  DROP CONSTRAINT IF EXISTS notification_contacts_check;
ALTER TABLE public.notification_contacts
  ADD CONSTRAINT notification_contacts_check CHECK (
    (audience = 'merchant' AND company_id IS NOT NULL AND user_id IS NOT NULL)
    OR (audience = 'customer' AND (company_id IS NULL OR whatsapp_phone IS NOT NULL))
  );
CREATE UNIQUE INDEX IF NOT EXISTS notification_contacts_customer_device_token_uq
  ON public.notification_contacts (token_hash)
  WHERE audience = 'customer' AND company_id IS NULL AND token_hash IS NOT NULL;
COMMIT;
