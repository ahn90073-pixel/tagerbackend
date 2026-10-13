import { normalizeGovernorate } from './governorates.js';
import { validateCompanyProfile } from './companyProfile.js';

const payoutMethods = new Set(['vodafone_cash', 'instapay', 'bank']);

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

export function prepareCompleteStoreApplication(body, user) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'بيانات طلب المتجر غير صالحة.' };
  const fullName = String(body.fullName || user?.full_name || user?.fullName || '').trim();
  const phone = String(body.phone || user?.phone || '').trim();
  const accountEmail = String(user?.email || '').trim().toLowerCase();
  const profileInput = body.profileData;
  if (!profileInput || typeof profileInput !== 'object' || Array.isArray(profileInput)) {
    return { error: 'أكمل بيانات ملف الشركة قبل إرسال طلب المتجر.' };
  }
  if (fullName.length < 2 || fullName.length > 160) return { error: 'اكتب الاسم الكامل للتاجر (من حرفين إلى 160 حرفًا).' };
  if (phone.length < 5 || phone.length > 30) return { error: 'اكتب رقم هاتف صحيحًا.' };
  if (!accountEmail) return { error: 'تعذر تحديد البريد المرتبط بحساب التاجر.' };

  const validation = validateCompanyProfile(profileInput);
  if (!validation.valid) return { error: 'راجع بيانات ملف الشركة وتأكد من صحة جميع القيم.' };
  const profileData = validation.value;
  const governorate = normalizeGovernorate(profileData.warehouseAddress.governorate);
  if (!profileData.legalName || !profileData.displayName) return { error: 'أدخل الاسم القانوني واسم المتجر الظاهر.' };
  if (!profileData.email) return { error: 'أدخل البريد الإلكتروني للشركة.' };
  if (!profileData.commercialRegisterNumber || profileData.commercialRegisterNumber.length < 5) return { error: 'أدخل رقم السجل التجاري (خمسة أحرف أو أرقام على الأقل).' };
  if (!profileData.taxId || profileData.taxId.length < 5) return { error: 'أدخل رقم البطاقة الضريبية (خمسة أحرف أو أرقام على الأقل).' };
  if (!governorate || !profileData.warehouseAddress.city || !profileData.warehouseAddress.street) {
    return { error: 'أكمل المحافظة والمدينة والعنوان التفصيلي للمستودع.' };
  }
  if (!profileData.payoutMethod || !payoutMethods.has(profileData.payoutMethod) || !profileData.payoutNumber) {
    return { error: 'اختر وسيلة التحويل وأدخل رقم الحساب أو المحفظة.' };
  }
  profileData.warehouseAddress.governorate = governorate;

  return {
    application: {
      fullName,
      phone,
      storeName: profileData.displayName,
      governorate,
      email: accountEmail,
      profileData,
    },
  };
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
