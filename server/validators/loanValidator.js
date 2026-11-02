const { body, param, validationResult } = require('express-validator');

const LOAN_CATEGORIES = [
  'Normal Loan',
  'Special Loan',
  'Secured Business Loan',
  'Agricultural Loan',
  'School Fees Loan',
];

const LOAN_DECISIONS = ['Approved', 'Rejected', 'On Hold'];
const LOAN_PAYMENT_TYPES = ['installment', 'lump', 'full'];

function normalizeString(value) {
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

const createLoanRequestValidationRules = [
  body('applicant_type')
    .optional({ values: 'falsy' })
    .trim()
    .toLowerCase()
    .isIn(['m', 'n', 'member', 'non-member', 'nonmember'])
    .withMessage('Applicant type must be member or non-member.'),

  body('account_number')
    .optional({ values: 'falsy' })
    .trim()
    .notEmpty()
    .withMessage('Account number is required for member applicants.')
    .bail()
    .matches(/^ES-[A-Z]-\d{6}$|^[A-Za-z0-9-]+$/)
    .withMessage('Account number format is invalid.'),

  body('applicant_name')
    .trim()
    .notEmpty()
    .withMessage('Applicant name is required.')
    .isLength({ min: 2, max: 150 })
    .withMessage('Applicant name must be between 2 and 150 characters long.'),

  body('telephone')
    .trim()
    .notEmpty()
    .withMessage('Telephone number is required.')
    .matches(/^[+0-9\s()-]{7,20}$/)
    .withMessage('Please provide a valid telephone number.'),

  body('email')
    .optional({ values: 'falsy' })
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Please provide a valid email address.'),

  body('address')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 250 })
    .withMessage('Address must be 250 characters or fewer.'),

  body('nin')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 6, max: 30 })
    .withMessage('NIN must be between 6 and 30 characters long.'),

  body('category')
    .trim()
    .notEmpty()
    .withMessage('Loan category is required.')
    .isIn(LOAN_CATEGORIES)
    .withMessage(`Loan category must be one of: ${LOAN_CATEGORIES.join(', ')}.`),

  body('term_months')
    .notEmpty()
    .withMessage('Loan term is required.')
    .isInt({ min: 1, max: 60 })
    .withMessage('Loan term must be between 1 and 60 months.'),

  body('principal')
    .notEmpty()
    .withMessage('Loan amount is required.')
    .customSanitizer((value) => {
      if (value === '' || value === null || value === undefined) return value;
      return Number(String(value).replace(/[^0-9.]/g, ''));
    })
    .isFloat({ min: 1 })
    .withMessage('Loan amount must be greater than 0.'),

  body('rate_monthly')
    .notEmpty()
    .withMessage('Interest rate is required.')
    .customSanitizer((value) => {
      if (value === '' || value === null || value === undefined) return value;
      return Number(String(value).replace(/[^0-9.]/g, ''));
    })
    .isFloat({ min: 0.01, max: 30 })
    .withMessage('Interest rate must be between 0.01 and 30 per month.'),

  body('request_date')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value) return true;
      if (!isValidDateString(value)) {
        throw new Error('Request date must be a valid date.');
      }
      return true;
    }),
];

const updateLoanRequestValidationRules = [
  param('id')
    .trim()
    .notEmpty()
    .withMessage('Loan request ID is required.')
    .isInt({ min: 1 })
    .withMessage('Loan request ID must be a positive integer.'),

  body('status')
    .trim()
    .notEmpty()
    .withMessage('Decision status is required.')
    .isIn(LOAN_DECISIONS)
    .withMessage('Decision must be Approved, Rejected or On Hold.'),

  body('remark')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Remark must be 500 characters or fewer.'),
];

const loanReferenceValidationRules = [
  param('ref')
    .trim()
    .notEmpty()
    .withMessage('Loan reference is required.')
    .matches(/^LN-\d+$/i)
    .withMessage('Loan reference must match the format LN-0001.'),
];

const createRepaymentValidationRules = [
  body('amount')
    .notEmpty()
    .withMessage('Repayment amount is required.')
    .customSanitizer((value) => {
      if (value === '' || value === null || value === undefined) return value;
      return Number(String(value).replace(/[^0-9.]/g, ''));
    })
    .isFloat({ min: 0.01 })
    .withMessage('Repayment amount must be greater than 0.'),

  body('payment_date')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value) return true;
      if (!isValidDateString(value)) {
        throw new Error('Payment date must be a valid date.');
      }
      return true;
    }),

  body('payment_type')
    .optional({ values: 'falsy' })
    .trim()
    .toLowerCase()
    .isIn(LOAN_PAYMENT_TYPES)
    .withMessage('Payment type must be installment, lump, or full.'),
];

const loanBalanceValidationRules = [
  param('ref')
    .trim()
    .notEmpty()
    .withMessage('Loan reference is required.')
    .matches(/^LN-\d+$/i)
    .withMessage('Loan reference must match the format LN-0001.'),

  body('asAt')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value) return true;
      if (!isValidDateString(value)) {
        throw new Error('asAt must be a valid date.');
      }
      return true;
    }),
];

module.exports = {
  LOAN_CATEGORIES,
  LOAN_DECISIONS,
  LOAN_PAYMENT_TYPES,

  createLoanRequestValidationRules,
  updateLoanRequestValidationRules,
  loanReferenceValidationRules,
  createRepaymentValidationRules,
  loanBalanceValidationRules,

  validate,
  normalizeString,
  isValidDateString,
};
