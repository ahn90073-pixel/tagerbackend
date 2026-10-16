import { fcmInternals } from './fcm.js';

export async function hashNotificationToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return fcmInternals.base64UrlEncode(digest);
}

export async function upsertCustomerDeviceNotificationToken(db, { token, platform, appVersion = null }) {
  const tokenHash = await hashNotificationToken(token);
  const [contact] = await db.query(
    `INSERT INTO public.notification_contacts
      (audience, app_name, company_id, fcm_token, token_hash, platform, app_version, push_enabled, last_seen_at)
     VALUES ('customer', 'online-store', NULL, $1, $2, $3, $4, TRUE, NOW())
     ON CONFLICT (token_hash)
       WHERE audience = 'customer' AND company_id IS NULL AND token_hash IS NOT NULL
     DO UPDATE SET fcm_token = EXCLUDED.fcm_token, platform = EXCLUDED.platform,
                   app_version = EXCLUDED.app_version, push_enabled = TRUE,
                   last_seen_at = NOW(), updated_at = NOW()
     RETURNING id`,
    [token, tokenHash, platform, appVersion],
  );
  return contact;
}

export async function upsertCustomerNotificationContact(db, {
  companyId, phone, token = null, platform = null, appVersion = null, consent = false,
}) {
  if (consent && token) {
    const tokenHash = await hashNotificationToken(token);
    const [contact] = await db.query(
      `INSERT INTO public.notification_contacts
        (audience, app_name, company_id, whatsapp_phone, fcm_token, token_hash, platform, app_version, push_enabled, last_seen_at)
       VALUES ('customer', 'online-store', $1, $2, $3, $4, $5, $6, TRUE, NOW())
       ON CONFLICT (audience, company_id, token_hash)
         WHERE token_hash IS NOT NULL
       DO UPDATE SET whatsapp_phone = EXCLUDED.whatsapp_phone,
                     fcm_token = EXCLUDED.fcm_token, platform = EXCLUDED.platform,
                     app_version = EXCLUDED.app_version, push_enabled = TRUE,
                     last_seen_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [companyId, phone, token, tokenHash, platform, appVersion],
    );
    return contact;
  }

  // An unchecked consent box revokes customer push consent for this store and
  // removes its stored device tokens while retaining the WhatsApp contact.
  await db.query(
    `DELETE FROM public.notification_contacts
      WHERE audience = 'customer' AND company_id = $1 AND whatsapp_phone = $2
        AND token_hash IS NOT NULL`,
    [companyId, phone],
  );
  const [contact] = await db.query(
    `INSERT INTO public.notification_contacts
      (audience, app_name, company_id, whatsapp_phone, push_enabled, last_seen_at)
     VALUES ('customer', 'online-store', $1, $2, FALSE, NOW())
     ON CONFLICT (audience, company_id, whatsapp_phone)
       WHERE token_hash IS NULL AND whatsapp_phone IS NOT NULL
     DO UPDATE SET last_seen_at = NOW(), updated_at = NOW()
     RETURNING id`,
    [companyId, phone],
  );
  return contact;
}

export async function upsertMerchantNotificationToken(db, {
  companyId, userId, phone = null, token, platform, appVersion = null,
  companyName = null, location = {},
}) {
  const tokenHash = await hashNotificationToken(token);
  const [contact] = await db.query(
    `INSERT INTO public.notification_contacts
      (audience, app_name, company_id, user_id, whatsapp_phone, fcm_token, token_hash, platform, app_version,
       company_name, location_city, location_region, location_country, location_point, push_enabled, last_seen_at)
     VALUES ('merchant', 'taget', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       CASE WHEN $12::double precision IS NOT NULL AND $13::double precision IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint($13::double precision, $12::double precision), 4326)::geography
         ELSE NULL END,
       TRUE, NOW())
     ON CONFLICT (audience, company_id, token_hash)
       WHERE token_hash IS NOT NULL
     DO UPDATE SET user_id = EXCLUDED.user_id, whatsapp_phone = EXCLUDED.whatsapp_phone,
                   fcm_token = EXCLUDED.fcm_token, platform = EXCLUDED.platform,
                   app_version = EXCLUDED.app_version, company_name = EXCLUDED.company_name,
                   location_city = COALESCE(EXCLUDED.location_city, notification_contacts.location_city),
                   location_region = COALESCE(EXCLUDED.location_region, notification_contacts.location_region),
                   location_country = COALESCE(EXCLUDED.location_country, notification_contacts.location_country),
                   location_point = COALESCE(EXCLUDED.location_point, notification_contacts.location_point),
                   push_enabled = TRUE,
                   last_seen_at = NOW(), updated_at = NOW()
     RETURNING id, audience, app_name, company_id, user_id, platform, app_version, push_enabled, created_at, updated_at`,
    [companyId, userId, phone, token, tokenHash, platform, appVersion, companyName,
      location.city || null, location.region || null, location.country || null,
      location.latitude ?? null, location.longitude ?? null],
  );
  return contact;
}
