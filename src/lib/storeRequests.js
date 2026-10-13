import { normalizeGovernorate } from './governorates.js';

export function prepareStoreApplication(body, user) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'بيانات طلب المتجر غير صالحة.' };
  const fullName = String(body.fullName || user?.full_name || user?.fullName || '').trim();
  const phone = String(body.phone || user?.phone || '').trim();
  const storeName = String(body.storeName || '').trim();
  const governorate = normalizeGovernorate(body.governorate);
  const email = String(user?.email || '').trim().toLowerCase();
  if (fullName.length < 2 || fullName.length > 160) return { error: 'اكتب الاسم الكامل للتاجر (من حرفين إلى 160 حرفًا).' };
  if (phone.length < 5 || phone.length > 30) return { error: 'اكتب رقم هاتف صحيحًا.' };
  if (storeName.length < 2 || storeName.length > 120) return { error: 'اسم المتجر يجب أن يكون بين حرفين و120 حرفًا.' };
  if (!governorate) return { error: 'اختر محافظة صحيحة للمتجر.' };
  if (!email) return { error: 'تعذر تحديد البريد المرتبط بالحساب.' };
  return { application: { fullName, phone, storeName, governorate, email } };
}

export function makeStoreSlug(storeName, suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 5)) {
  const base = String(storeName || '').normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/g, '');
  return base ? `${base}-${suffix}` : `merchant-${suffix}`;
}
