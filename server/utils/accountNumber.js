'use strict';

/**
 * Account number helpers for ES-M / ES-F account numbering.
 *
 * Supported patterns:
 *   - ES-M-000001
 *   - ES-F-000001
 *
 * This logic is designed for Elite SACCO account identifiers and can be reused
 * across member accounts, fixed deposit accounts, and related modules.
 *
 * Examples:
 *   generateAccountNumber('M', 1) => 'ES-M-000001'
 *   generateAccountNumber('F', 42) => 'ES-F-000042'
 */

const ACCOUNT_TYPE_MAPPING = {
  M: 'ES-M',
  MEMBER: 'ES-M',
  MEMBER_ACCOUNT: 'ES-M',
  ES_M: 'ES-M',
  F: 'ES-F',
  FIXED: 'ES-F',
  FIXED_DEPOSIT: 'ES-F',
  ES_F: 'ES-F',
};

const ACCOUNT_NUMBER_REGEX = /^ES-(M|F)-(\d{6,})$/i;

function normalizeType(type) {
  if (type === null || type === undefined || type === '') {
    throw new Error('Account type is required. Use "M" (member) or "F" (fixed).');
  }

  const key = String(type).trim().toUpperCase();

  if (!ACCOUNT_TYPE_MAPPING[key]) {
    throw new Error(`Unsupported account type "${type}". Use "M" or "F".`);
  }

  return ACCOUNT_TYPE_MAPPING[key];
}

/**
 * Generate a standard ES account number.
 *
 * @param {string|number} type - "M" or "F", or "member"/"fixed"
 * @param {number|string} sequence - numeric sequence, e.g. 1, 42, 12345
 * @param {object} [options]
 * @param {number} [options.width=6]
 * @returns {string}
 */
function generateAccountNumber(type, sequence, options = {}) {
  const { width = 6 } = options;

  const prefix = normalizeType(type);
  const normalizedSequence = Number(sequence);

  if (!Number.isFinite(normalizedSequence) || normalizedSequence < 0) {
    throw new Error('Account sequence must be a non-negative number.');
  }

  const padded = String(Math.floor(normalizedSequence)).padStart(width, '0');

  return `${prefix}-${padded}`;
}

/**
 * Parse an ES account number.
 *
 * Example:
 * parseAccountNumber('ES-M-000123')
 * => { prefix: 'ES-M', type: 'M', sequence: 123, isValid: true, raw: 'ES-M-000123' }
 *
 * @param {string} accountNumber
 * @returns {object}
 */
function parseAccountNumber(accountNumber) {
  if (!accountNumber || typeof accountNumber !== 'string') {
    return {
      prefix: null,
      type: null,
      sequence: null,
      isValid: false,
      raw: accountNumber || null,
    };
  }

  const match = accountNumber.trim().match(ACCOUNT_NUMBER_REGEX);

  if (!match) {
    return {
      prefix: null,
      type: null,
      sequence: null,
      isValid: false,
      raw: accountNumber,
    };
  }

  const [, typeCode, sequenceString] = match;
  const normalizedType = typeCode.toUpperCase();

  return {
    prefix: `ES-${normalizedType}`,
    type: normalizedType,
    sequence: Number(sequenceString),
    isValid: true,
    raw: accountNumber.trim(),
  };
}

/**
 * Validate whether a given string matches the ES account number format.
 *
 * @param {string} accountNumber
 * @returns {boolean}
 */
function isValidAccountNumber(accountNumber) {
  const parsed = parseAccountNumber(accountNumber);
  return parsed.isValid;
}

/**
 * Build a compact account number for UI display / API payloads without the prefix.
 *
 * Example:
 * sequenceToNumber(42) => '000042'
 *
 * @param {number|string} value
 * @param {number} [width=6]
 * @returns {string}
 */
function sequenceToNumber(value, width = 6) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error('Sequence value must be a non-negative number.');
  }

  return String(Math.floor(numeric)).padStart(width, '0');
}

/**
 * Generate a versioned / tagged account number if you want to support
 * different segments or business-specific account categories later.
 *
 * Example:
 * generateTaggedAccountNumber('M', 10, 'SAVINGS') => 'ES-M-SAVINGS-000010'
 *
 * @param {string|number} type
 * @param {number|string} sequence
 * @param {string} [tag]
 * @param {object} [options]
 * @returns {string}
 */
function generateTaggedAccountNumber(type, sequence, tag = null, options = {}) {
  const prefix = normalizeType(type);
  const value = sequenceToNumber(sequence, options.width || 6);

  if (tag) {
    return `${prefix}-${String(tag).trim().toUpperCase()}-${value}`;
  }

  return `${prefix}-${value}`;
}

/**
 * Derive account type from an account number.
 *
 * @param {string} accountNumber
 * @returns {'M'|'F'|null}
 */
function getAccountType(accountNumber) {
  const parsed = parseAccountNumber(accountNumber);
  return parsed.type || null;
}

module.exports = {
  ACCOUNT_TYPE_MAPPING,
  ACCOUNT_NUMBER_REGEX,
  normalizeType,
  generateAccountNumber,
  parseAccountNumber,
  isValidAccountNumber,
  sequenceToNumber,
  generateTaggedAccountNumber,
  getAccountType,
};
