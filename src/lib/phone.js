const EGYPT_MOBILE_LOCAL = /^01\d{9}$/;
const EGYPT_MOBILE_E164 = /^\+201\d{9}$/;

function toAsciiDigits(value) {
  return String(value).replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

/** Normalize Egyptian mobile numbers to E.164 without logging or retaining secrets. */
export function normalizeEgyptPhone(value) {
  if (typeof value !== 'string') return null;
  let phone = toAsciiDigits(value).trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (EGYPT_MOBILE_LOCAL.test(phone)) return `+20${phone.slice(1)}`;
  if (EGYPT_MOBILE_E164.test(phone)) return phone;
  return null;
}

export function isEgyptPhone(value) {
  return normalizeEgyptPhone(value) !== null;
}
