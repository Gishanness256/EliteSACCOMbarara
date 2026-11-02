const { body, query, validationResult } = require('express-validator');

const SAVINGS_DIRECTIONS = ['Deposit', 'Withdrawal'];
const SAVINGS_CHANNELS = [
  'Counter / Cash',
  'Bank Transfer',
  'Mobile Money',
  'ATM',
  'Cheque',
  'Other',
];

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function isValidDateString(value) {
  if (!value || typeof value !== 'string') return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function validate(req, res, next) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: 'Validation failed.',
      errors: errors.array().map((err) => ({
        field: err.path || err.param,
        message: err.msg,
      })),
    });
  }

  return next();
}

const savingsListValidationRules = [
  query('account')
    .optional({ values: 'falsy' })
    .trim()
    .matches(/^ES-[A-Z]\s?\d{6}$/i)
    .withMessage('Account number must match the format ES-M 000001.'),

  query('limit')
    .optional({ values: 'falsy' })
    .customSanitizer((value) => Number(value))
    .isInt({ min: 1, max: 500 })
    .withMessage('Limit must be an integer between 1 and 500.'),
];

const createSavingsValidationRules = [
  body('account_number')
    .trim()
    .notEmpty()
    .withMessage('Account number is required.')
    .matches(/^ES-[A-Z]\s?\d{6}$/i)
    .withMessage('Account number must match the format ES-M 000001.'),

  body('direction')
    .trim()
    .notEmpty()
    .withMessage('Transaction direction is required.')
    .isIn(SAVINGS_DIRECTIONS)
    .withMessage('Direction must be either Deposit or Withdrawal.'),

  body('amount')
    .notEmpty()
    .withMessage('Amount is required.')
    .customSanitizer((value) => {
      if (value === '' || value === null || value === undefined) return value;
      return Number(String(value).replace(/[^0-9.]/g, ''));
    })
    .isFloat({ min: 0.01 })
    .withMessage('Amount must be greater than 0.'),

  body('occurred_at')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value) return true;
      if (!isValidDateString(value)) {
        throw new Error('Transaction date must be a valid date.');
      }
      return true;
    }),

  body('channel')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(SAVINGS_CHANNELS)
    .withMessage(`Channel must be one of: ${SAVINGS_CHANNELS.join(', ')}.`),

  body('slip_number')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 1, max: 80 })
    .withMessage('Slip number must be between 1 and 80 characters long.'),

  body('remarks')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Remarks must be between 1 and 500 characters long.'),
];

module.exports = {
  SAVINGS_DIRECTIONS,
  SAVINGS_CHANNELS,
  savingsListValidationRules,
  createSavingsValidationRules,
  validate,
  normalizeText,
  isValidDateString,
};
