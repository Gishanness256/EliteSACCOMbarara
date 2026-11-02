const { body, param, query, validationResult } = require('express-validator');

const REPORT_PERIODS = ['m', 'q', 'y'];
const REGULATORY_MODES = ['m', 'mom', 'yoy'];
const REGULATORY_TEMPLATES = ['sum', 'sfp', 'inc', 'liq', 'cap', 'pqr', 'mem', 'pack'];

const REPORTING_INPUT_KEYS = [
  'cash', 'bank', 'liq', 'oa', 'ol', 'sh', 'rs',
  'fee', 'sint', 'opx',
];

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function isValidMonth(value) {
  if (!value || typeof value !== 'string') return false;
  return /^\d{4}-\d{2}$/.test(value);
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

const memberStatementValidationRules = [
  param('acc')
    .trim()
    .notEmpty()
    .withMessage('Member account is required.')
    .matches(/^ES-[A-Z]\s?\d{6}$/i)
    .withMessage('Member account must match the format ES-M 000001.'),

  query('period')
    .optional({ values: 'falsy' })
    .trim()
    .toLowerCase()
    .isIn(REPORT_PERIODS)
    .withMessage('Period must be one of: m, q, y.'),

  query('month')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value) return true;
      if (!isValidMonth(value)) {
        throw new Error('Month must be in YYYY-MM format.');
      }
      return true;
    }),

  query('quarter')
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: 4 })
    .withMessage('Quarter must be between 1 and 4.'),

  query('year')
    .optional({ values: 'falsy' })
    .isInt({ min: 2000, max: 2100 })
    .withMessage('Year must be a valid 4-digit year.'),

  query('format')
    .optional({ values: 'falsy' })
    .trim()
    .toLowerCase()
    .isIn(['csv', 'xlsx', 'json'])
    .withMessage('Export format must be csv, xlsx, or json.'),
];

const regulatoryTemplateValidationRules = [
  param('tpl')
    .trim()
    .notEmpty()
    .withMessage('Report template is required.')
    .isIn(REGULATORY_TEMPLATES)
    .withMessage('Unknown report template selected.'),
];

const regulatoryPreviewValidationRules = [
  query('mode')
    .optional({ values: 'falsy' })
    .trim()
    .toLowerCase()
    .isIn(REGULATORY_MODES)
    .withMessage('Mode must be m, mom, or yoy.'),

  query('asAt')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value) return true;
      if (!isValidMonth(value)) {
        throw new Error('asAt must be in YYYY-MM format.');
      }
      return true;
    }),

  query('n')
    .optional({ values: 'falsy' })
    .isInt({ min: 3, max: 12 })
    .withMessage('n must be one of 3, 6, or 12 months.'),
];

const regulatoryConfigValidationRules = [
  body('reg')
    .trim()
    .notEmpty()
    .withMessage('Regulator name is required.'),

  body('lic')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 120 })
    .withMessage('Licence number must be 120 characters or fewer.'),

  body('minLiq')
    .optional({ values: 'falsy' })
    .toFloat()
    .isFloat({ min: 0, max: 100 })
    .withMessage('minLiq must be between 0 and 100.'),

  body('minCore')
    .optional({ values: 'falsy' })
    .toFloat()
    .isFloat({ min: 0, max: 100 })
    .withMessage('minCore must be between 0 and 100.'),

  body('minInst')
    .optional({ values: 'falsy' })
    .toFloat()
    .isFloat({ min: 0, max: 100 })
    .withMessage('minInst must be between 0 and 100.'),

  body('maxP30')
    .optional({ values: 'falsy' })
    .toFloat()
    .isFloat({ min: 0, max: 100 })
    .withMessage('maxP30 must be between 0 and 100.'),

  body('maxP90')
    .optional({ values: 'falsy' })
    .toFloat()
    .isFloat({ min: 0, max: 100 })
    .withMessage('maxP90 must be between 0 and 100.'),

  body('pr')
    .exists()
    .withMessage('Provision rates are required.')
    .isArray({ min: 5, max: 5 })
    .withMessage('pr must be an array of 5 percentages.')
    .custom((value) => {
      if (!Array.isArray(value) || value.length !== 5) {
        throw new Error('pr must contain exactly 5 values.');
      }

      for (const item of value) {
        const num = Number(item);
        if (Number.isNaN(num) || num < 0 || num > 100) {
          throw new Error('Each provision rate must be a number between 0 and 100.');
        }
      }

      return true;
    }),
];

const regulatoryInputsValidationRules = [
  param('month')
    .trim()
    .notEmpty()
    .withMessage('Month is required.')
    .matches(/^\\d{4}-\\d{2}$/)
    .withMessage('Month must be in YYYY-MM format.'),

  body()
    .custom((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Request body must be an object with financial input values.');
      }

      const keys = Object.keys(value);
      if (!keys.length) {
        throw new Error('At least one regulatory input must be provided.');
      }

      const allowedSet = new Set(REPORTING_INPUT_KEYS);

      for (const key of keys) {
        if (!allowedSet.has(key)) {
          throw new Error(`Unsupported regulatory input: "${key}".`);
        }

        const num = Number(value[key]);
        if (value[key] === '' || value[key] === null || value[key] === undefined || Number.isNaN(num) || num < 0) {
          throw new Error(`"${key}" must be a non-negative number.`);
        }
      }

      return true;
    }),
];

module.exports = {
  REPORT_PERIODS,
  REGULATORY_MODES,
  REGULATORY_TEMPLATES,
  REPORTING_INPUT_KEYS,

  memberStatementValidationRules,
  regulatoryTemplateValidationRules,
  regulatoryPreviewValidationRules,
  regulatoryConfigValidationRules,
  regulatoryInputsValidationRules,

  validate,
  normalizeText,
  isValidMonth,
  isValidDateString,
};
