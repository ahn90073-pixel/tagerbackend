export const COMPANY_PROFILE_DOCUMENT_TYPES = Object.freeze([
  'nationalId',
  'commercialRegister',
  'propertyContract',
]);

const payoutMethods = new Set(['vodafone_cash', 'instapay', 'bank']);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function mergeCompanyProfile(existing = {}, body = {}) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const address = existing.warehouse_address && typeof existing.warehouse_address === 'object'
    ? existing.warehouse_address
    : {};
  const suppliedAddress = input.warehouseAddress;
  const mergedAddress = Object.hasOwn(input, 'warehouseAddress') && suppliedAddress && typeof suppliedAddress === 'object' && !Array.isArray(suppliedAddress)
    ? { ...address, ...suppliedAddress }
    : Object.hasOwn(input, 'warehouseAddress') ? suppliedAddress : address;
  return {
    legalName: Object.hasOwn(input, 'legalName') ? input.legalName : existing.legal_name,
    displayName: Object.hasOwn(input, 'displayName') ? input.displayName : existing.display_name,
    email: Object.hasOwn(input, 'email') ? input.email : existing.email,
    commercialRegisterNumber: Object.hasOwn(input, 'commercialRegisterNumber') ? input.commercialRegisterNumber : existing.commercial_register_number,
    taxId: Object.hasOwn(input, 'taxId') ? input.taxId : existing.tax_id,
    warehouseAddress: mergedAddress,
    payoutMethod: Object.hasOwn(input, 'payoutMethod') ? input.payoutMethod : existing.payout_method,
    payoutNumber: Object.hasOwn(input, 'payoutNumber')
      ? input.payoutNumber
      : Object.hasOwn(input, 'payoutMethod') && input.payoutMethod !== existing.payout_method
        ? ''
        : existing.payout_number,
  };
}

export function validateCompanyProfile(body) {
  const errors = [];
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const result = {};

  const requiredText = (field, label, maxLength) => {
    const value = cleanString(input[field]);
    if (value.length < 2 || value.length > maxLength) {
      errors.push({ field, message: `${label} must be between 2 and ${maxLength} characters` });
    }
    result[field] = value;
  };
  const optionalText = (field, label, maxLength) => {
    const value = cleanString(input[field]);
    if (value.length > maxLength) errors.push({ field, message: `${label} must be at most ${maxLength} characters` });
    result[field] = value || null;
  };

  requiredText('legalName', 'Legal name', 160);
  requiredText('displayName', 'Display name', 120);
  const email = cleanString(input.email);
  if (email && (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    errors.push({ field: 'email', message: 'A valid email address is required' });
  }
  result.email = email || null;
  optionalText('commercialRegisterNumber', 'Commercial register number', 100);
  optionalText('taxId', 'Tax ID', 100);

  const address = input.warehouseAddress;
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    errors.push({ field: 'warehouseAddress', message: 'Warehouse address must be an object' });
    result.warehouseAddress = { governorate: '', city: '', street: '' };
  } else {
    result.warehouseAddress = {};
    for (const field of ['governorate', 'city', 'street']) {
      const value = cleanString(address[field]);
      if (value.length > 240) errors.push({ field: `warehouseAddress.${field}`, message: 'Address fields must be at most 240 characters' });
      result.warehouseAddress[field] = value;
    }
  }

  const payoutMethod = cleanString(input.payoutMethod);
  if (payoutMethod && !payoutMethods.has(payoutMethod)) {
    errors.push({ field: 'payoutMethod', message: 'Choose a supported payout method' });
  }
  result.payoutMethod = payoutMethod || null;
  const payoutNumber = cleanString(input.payoutNumber);
  if (payoutNumber.length > 100) errors.push({ field: 'payoutNumber', message: 'Payout account must be at most 100 characters' });
  result.payoutNumber = payoutNumber || null;

  return { valid: errors.length === 0, errors, value: result };
}

export function getCompanyProfileCompletion(company = {}, documents = []) {
  const documentTypes = new Set(documents.map((document) => document.document_type || document.documentType));
  const address = company.warehouse_address || company.warehouseAddress || {};
  const checks = [
    {
      key: 'companyDetails',
      label: 'بيانات الشركة الأساسية',
      complete: Boolean(cleanString(company.legal_name || company.legalName)
        && cleanString(company.display_name || company.displayName)
        && cleanString(company.email)),
    },
    {
      key: 'commercialRegisterNumber',
      label: 'رقم السجل التجاري',
      complete: cleanString(company.commercial_register_number || company.commercialRegisterNumber).length >= 5,
    },
    { key: 'taxId', label: 'رقم البطاقة الضريبية', complete: cleanString(company.tax_id || company.taxId).length >= 5 },
    {
      key: 'warehouseAddress',
      label: 'عنوان المستودع',
      complete: Boolean(cleanString(address.governorate) && cleanString(address.city) && cleanString(address.street)),
    },
    { key: 'nationalId', label: 'صورة البطاقة الشخصية', complete: documentTypes.has('nationalId') },
    { key: 'commercialRegister', label: 'صورة السجل التجاري', complete: documentTypes.has('commercialRegister') },
    { key: 'propertyContract', label: 'عقد أو بوليصة إثبات العنوان', complete: documentTypes.has('propertyContract') },
    {
      key: 'payout',
      label: 'وسيلة التحويل المالي',
      complete: payoutMethods.has(cleanString(company.payout_method || company.payoutMethod))
        && Boolean(cleanString(company.payout_number || company.payoutNumber)),
    },
  ];
  const completedCount = checks.filter((check) => check.complete).length;
  return {
    completedCount,
    totalCount: checks.length,
    percentage: Math.round((completedCount / checks.length) * 100),
    isComplete: completedCount === checks.length,
    checks,
  };
}

export function detectCompanyDocumentType(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length >= 5 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46 && data[4] === 0x2d) {
    return { contentType: 'application/pdf', extension: 'pdf' };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return { contentType: 'image/png', extension: 'png' };
  }
  return null;
}
