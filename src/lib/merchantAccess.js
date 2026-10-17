export const ARCHIVED_MERCHANT_MESSAGE = 'تم إيقاف المتجر وأرشفته من الإدارة. بياناتك محفوظة؛ تواصل مع الإدارة لإعادة التفعيل.'

export async function findSuspendedCompany(db, userId) {
  const [company] = await db`
    SELECT c.id, c.display_name
    FROM public.companies c
    JOIN public.company_members cm ON cm.company_id = c.id
    WHERE cm.user_id = ${userId}
      AND cm.is_active = TRUE
      AND c.status = 'suspended'
    ORDER BY c.created_at DESC
    LIMIT 1
  `
  return company || null
}
