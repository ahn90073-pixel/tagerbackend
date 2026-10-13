import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCommission, calculateWalletSummary } from '../src/lib/financialSummary.js';

test('percentage commission and net balance use completed net settlements', () => {
  assert.deepEqual(calculateWalletSummary({
    totalSales: 1000,
    commissionType: 'percentage',
    commissionValue: 10,
    settledAmount: 250,
  }), {
    totalSales: 1000,
    commissionType: 'percentage',
    commissionValue: 10,
    commissionAmount: 100,
    settledAmount: 250,
    netBalance: 650,
  });
});

test('fixed commission is capped at lifetime sales', () => {
  assert.equal(calculateCommission(40, 'fixed', 100), 40);
  assert.deepEqual(calculateWalletSummary({
    totalSales: 500,
    commissionType: 'fixed',
    commissionValue: 35,
    settledAmount: 100,
  }), {
    totalSales: 500,
    commissionType: 'fixed',
    commissionValue: 35,
    commissionAmount: 35,
    settledAmount: 100,
    netBalance: 365,
  });
});

test('invalid/negative inputs are normalized to zero', () => {
  assert.deepEqual(calculateWalletSummary({
    totalSales: -10,
    commissionType: 'unexpected',
    commissionValue: -2,
    settledAmount: Number.NaN,
  }), {
    totalSales: 0,
    commissionType: 'percentage',
    commissionValue: 0,
    commissionAmount: 0,
    settledAmount: 0,
    netBalance: 0,
  });
});
