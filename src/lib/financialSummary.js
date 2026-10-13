export function roundMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) / 100 : 0;
}

// Keep the same lifetime-sales commission model used by the Mange admin API.
export function calculateCommission(amount, commissionType, commissionValue) {
  const base = Math.max(0, Number(amount) || 0);
  const rate = Math.max(0, Number(commissionValue) || 0);
  if (commissionType === 'percentage') return roundMoney((base * rate) / 100);
  return roundMoney(Math.min(base, rate));
}

export function calculateWalletSummary({ totalSales, commissionType, commissionValue, settledAmount }) {
  const sales = Math.max(0, roundMoney(totalSales));
  const commissionAmount = calculateCommission(sales, commissionType, commissionValue);
  const settled = Math.max(0, roundMoney(settledAmount));
  return {
    totalSales: sales,
    commissionType: commissionType === 'fixed' ? 'fixed' : 'percentage',
    commissionValue: Math.max(0, Number(commissionValue) || 0),
    commissionAmount,
    settledAmount: settled,
    netBalance: roundMoney(sales - commissionAmount - settled),
  };
}
