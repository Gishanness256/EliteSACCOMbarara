/**
 * Loan calculator utilities for PMT-based calculations and amortization schedules.
 * CommonJS module intended for use in the Express backend.
 *
 * Example:
 * const { calculatePMT, calculateLoanSummary, buildAmortizationSchedule } =
 *   require('../utils/loanCalculator');
 */

function validatePositiveNumber(value, label) {
  const num = Number(value);

  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${label} must be a valid non-negative number.`);
  }

  return num;
}

function roundCurrency(value) {
  return Number(Math.round((value + Number.EPSILON) * 100) / 100);
}

/**
 * Calculate the monthly payment for a standard amortizing loan.
 *
 * PMT = [r * P] / [1 - (1 + r)^-n]
 * where:
 *  - P = principal
 *  - r = monthly interest rate (annual rate / 12 / 100)
 *  - n = total number of monthly payments
 *
 * @param {number} principal
 * @param {number} annualRatePercent
 * @param {number} totalPayments
 * @returns {number}
 */
function calculatePMT(principal, annualRatePercent, totalPayments) {
  const P = validatePositiveNumber(principal, 'Principal');
  const annualRate = validatePositiveNumber(annualRatePercent, 'Annual rate');
  const n = validatePositiveNumber(totalPayments, 'Total payments');

  if (n === 0) {
    return 0;
  }

  const monthlyRate = annualRate / 12 / 100;

  if (monthlyRate === 0) {
    return roundCurrency(P / n);
  }

  const factor = Math.pow(1 + monthlyRate, n);
  const pmt = (P * monthlyRate * factor) / (factor - 1);

  return roundCurrency(pmt);
}

/**
 * Calculate a full loan summary.
 *
 * @param {Object} options
 * @param {number} options.principal
 * @param {number} options.annualRatePercent
 * @param {number} options.totalPayments
 * @param {number} [options.extraPayment=0]
 * @returns {Object}
 */
function calculateLoanSummary({
  principal,
  annualRatePercent,
  totalPayments,
  extraPayment = 0,
}) {
  const P = validatePositiveNumber(principal, 'Principal');
  const annualRate = validatePositiveNumber(annualRatePercent, 'Annual rate');
  const n = validatePositiveNumber(totalPayments, 'Total payments');
  const extra = validatePositiveNumber(extraPayment, 'Extra payment');

  const monthlyRate = annualRate / 12 / 100;
  const payment = calculatePMT(P, annualRate, n);

  let remainingBalance = P;
  let totalInterest = 0;
  let totalPaid = 0;

  for (let month = 1; month <= n; month += 1) {
    const interest = remainingBalance * monthlyRate;
    const scheduledPrincipal = payment - interest;
    const principalToApply = Math.min(
      remainingBalance,
      scheduledPrincipal + extra,
    );

    const appliedPayment = principalToApply + interest;

    remainingBalance = Math.max(0, remainingBalance - principalToApply);
    totalInterest += interest;
    totalPaid += appliedPayment;

    if (remainingBalance === 0) {
      break;
    }
  }

  return {
    principal: roundCurrency(P),
    annualRatePercent: roundCurrency(annualRate),
    monthlyRate: roundCurrency(monthlyRate * 100), // percentage per month
    totalPayments: Number(n),
    monthlyPayment: roundCurrency(payment),
    extraPayment: roundCurrency(extra),
    totalPaid: roundCurrency(totalPaid),
    totalInterest: roundCurrency(totalInterest),
    remainingBalance: roundCurrency(remainingBalance),
  };
}

/**
 * Build an amortization schedule for the full loan life.
 *
 * @param {Object} options
 * @param {number} options.principal
 * @param {number} options.annualRatePercent
 * @param {number} options.totalPayments
 * @param {number} [options.extraPayment=0]
 * @returns {Array<Object>}
 */
function buildAmortizationSchedule({
  principal,
  annualRatePercent,
  totalPayments,
  extraPayment = 0,
}) {
  const P = validatePositiveNumber(principal, 'Principal');
  const annualRate = validatePositiveNumber(annualRatePercent, 'Annual rate');
  const n = validatePositiveNumber(totalPayments, 'Total payments');
  const extra = validatePositiveNumber(extraPayment, 'Extra payment');

  const monthlyRate = annualRate / 12 / 100;
  const payment = calculatePMT(P, annualRate, n);

  let remainingBalance = P;
  const schedule = [];

  for (let month = 1; month <= n; month += 1) {
    if (remainingBalance <= 0) {
      break;
    }

    const interest = remainingBalance * monthlyRate;
    const scheduledPrincipal = payment - interest;
    const principalToApply = Math.min(
      remainingBalance,
      scheduledPrincipal + extra,
    );

    const totalPayment = interest + principalToApply;

    remainingBalance = Math.max(0, remainingBalance - principalToApply);

    schedule.push({
      month,
      payment: roundCurrency(totalPayment),
      interest: roundCurrency(interest),
      principal: roundCurrency(principalToApply),
      balance: roundCurrency(remainingBalance),
    });
  }

  return schedule;
}

module.exports = {
  calculatePMT,
  calculateLoanSummary,
  buildAmortizationSchedule,
  roundCurrency,
};
