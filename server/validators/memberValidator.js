const { body, param, query, validationResult } = require('express-validator');

const MEMBER_GENDERS = ['M', 'F', 'Male', 'Female', 'Other'];

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

const memberSearchValidationRules = [
  query('q')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Search query must be between 1 and 100 characters long.'),
];

const memberAccountValidationRules = [
  param('account')
    .trim()
    .notEmpty()
    .withMessage('Member account is required.')
    .matches(/^ES-[A-Z]\s?\d{6}$/i)
    .withMessage('Member account must match the format ES-M 000001.'),
];

const createMemberValidationRules = [
  body('first_name')
    .trim()
    .notEmpty()
    .withMessage('First name is required.')
    .isLength({ min: 2, max: 80 })
    .withMessage('First name must be between 2 and 80 characters long.'),

  body('last_name')
    .trim()
    .notEmpty()
    .withMessage('Last name is required.')
    .isLength({ min: 2, max: 80 })
    .withMessage('Last name must be between 2 and 80 characters long.'),

  body('gender')
    .trim()
    .notEmpty()
    .withMessage('Gender is required.')
    .custom((value) => {
      const normalized = String(value).trim().toUpperCase();
      const allowed = MEMBER_GENDERS.map((g) => String(g).trim().toUpperCase());

      if (!allowed.includes(normalized)) {
        throw new Error('Gender must be one of: M, F, Male, Female, or Other.');
      }

      return true;
    }),

  body('date_of_birth')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value) return true;
      if (!isValidDateString(value)) {
        throw new Error('Date of birth must be a valid date.');
      }

      const dob = new Date(value);
      const today = new Date();
      const age = today.getFullYear() - dob.getFullYear();
      const monthDiff = today.getMonth() - dob.getMonth();

      const actualAge = monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())
        ? age - 1
        : age;

      if (actualAge < 16) {
        throw new Error('Member must be at least 16 years old.');
      }

      return true;
    }),

  body('telephone')
    .trim()
    .notEmpty()
    .withMessage('Telephone number is required.')
    .matches(/^[+0-9\s()-]{7,20}$/)
    .withMessage('Please provide a valid telephone number.'),

  body('nin')
    .trim()
    .notEmpty()
    .withMessage('NIN is required.')
    .matches(/^[A-Z0-9-]{6,30}$/i)
    .withMessage('NIN must be 6 to 30 characters long and contain only letters, numbers, or hyphens.'),

  body('address')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 250 })
    .withMessage('Address must be 250 characters or fewer.'),

  body('email')
    .optional({ values: 'falsy' })
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Please provide a valid email address.'),

  body('photo')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Photo URL or reference must be 500 characters or fewer.'),
];

const updateMemberValidationRules = [
  param('account')
    .trim()
    .notEmpty()
    .withMessage('Member account is required.')
    .matches(/^ES-[A-Z]\s?\d{6}$/i)
    .withMessage('Member account must match the format ES-M 000001.'),

  body('first_name')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('First name must be between 2 and 80 characters long.'),

  body('last_name')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('Last name must be between 2 and 80 characters long.'),

  body('gender')
    .optional({ values: 'falsy' })
    .trim()
    .custom((value) => {
      const normalized = String(value).trim().toUpperCase();
      const allowed = MEMBER_GENDERS.map((g) => String(g).trim().toUpperCase());

      if (!allowed.includes(normalized)) {
        throw new Error('Gender must be one of: M, F, Male, Female, or Other.');
      }

      return true;
    }),

  body('date_of_birth')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value) return true;
      if (!isValidDateString(value)) {
        throw new Error('Date of birth must be a valid date.');
      }

      const dob = new Date(value);
      const today = new Date();
      const age = today.getFullYear() - dob.getFullYear();
      const monthDiff = today.getMonth() - dob.getMonth();

      const actualAge = monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())
        ? age - 1
        : age;

      if (actualAge < 16) {
        throw new Error('Member must be at least 16 years old.');
      }

      return true;
    }),

  body('telephone')
    .optional({ values: 'falsy' })
    .trim()
    .matches(/^[+0-9\s()-]{7,20}$/)
    .withMessage('Please provide a valid telephone number.'),

  body('nin')
    .optional({ values: 'falsy' })
    .trim()
    .matches(/^[A-Z0-9-]{6,30}$/i)
    .withMessage('NIN must be 6 to 30 characters long and contain only letters, numbers, or hyphens.'),

  body('address')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 250 })
    .withMessage('Address must be 250 characters or fewer.'),

  body('email')
    .optional({ values: 'falsy' })
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Please provide a valid email address.'),

  body('photo')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Photo URL or reference must be 500 characters or fewer.'),
];

module.exports = {
  MEMBER_GENDERS,
  memberSearchValidationRules,
  memberAccountValidationRules,
  createMemberValidationRules,
  updateMemberValidationRules,
  validate,
  normalizeText,
  isValidDateString,
};
