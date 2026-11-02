const { body, validationResult } = require('express-validator');

function normalizeUserIdentifier(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

const loginValidationRules = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email or username is required.')
    .custom((value) => {
      const normalized = normalizeUserIdentifier(value);

      if (!normalized) {
        throw new Error('Email or username is required.');
      }

      // Accept either:
      // - bare username: jane
      // - full email: jane@elitesacco.co.ug
      if (normalized.includes('@')) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalized)) {
          throw new Error('Please provide a valid email address.');
        }
        return true;
      }

      if (!/^[a-z0-9._-]+$/i.test(normalized)) {
        throw new Error('Username may only contain letters, numbers, dots, underscores, and hyphens.');
      }

      return true;
    }),

  body('password')
    .notEmpty()
    .withMessage('Password is required.')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long.')
    .custom((value) => {
      if (/\s/.test(value)) {
        throw new Error('Password cannot contain spaces.');
      }
      return true;
    }),
];

const registerValidationRules = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Full name is required.')
    .isLength({ min: 2, max: 120 })
    .withMessage('Name must be between 2 and 120 characters.'),

  body('handle')
    .trim()
    .notEmpty()
    .withMessage('Handle is required.')
    .matches(/^[a-z0-9][a-z0-9._-]*$/i)
    .withMessage('Handle may only contain letters, numbers, dots, underscores, and hyphens.'),

  body('email')
    .optional({ values: 'falsy' })
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Please provide a valid email address.'),

  body('password')
    .notEmpty()
    .withMessage('Password is required.')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long.')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter.')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter.')
    .matches(/\d/)
    .withMessage('Password must contain at least one number.'),

  body('role')
    .optional()
    .isIn(['Admin', 'Treasurer', 'Credit Officer', 'Member'])
    .withMessage('Invalid role selected.'),
];

const forgotPasswordValidationRules = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required.')
    .custom((value) => {
      const normalized = normalizeUserIdentifier(value);

      if (!normalized) {
        throw new Error('Email is required.');
      }

      if (normalized.includes('@')) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalized)) {
          throw new Error('Please provide a valid email address.');
        }
        return true;
      }

      if (!/^[a-z0-9._-]+$/i.test(normalized)) {
        throw new Error('Please provide a valid email or username.');
      }

      return true;
    }),
];

const resetPasswordValidationRules = [
  body('token')
    .notEmpty()
    .withMessage('Reset token is required.'),

  body('new_password')
    .notEmpty()
    .withMessage('New password is required.')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long.')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter.')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter.')
    .matches(/\d/)
    .withMessage('Password must contain at least one number.')
    .custom((value) => {
      if (/\s/.test(value)) {
        throw new Error('Password cannot contain spaces.');
      }
      return true;
    }),
];

const changePasswordValidationRules = [
  body('current_password')
    .notEmpty()
    .withMessage('Current password is required.'),

  body('new_password')
    .notEmpty()
    .withMessage('New password is required.')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long.')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter.')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter.')
    .matches(/\d/)
    .withMessage('Password must contain at least one number.')
    .custom((value, { req }) => {
      if (value === req.body.current_password) {
        throw new Error('New password must be different from the current password.');
      }
      if (/\s/.test(value)) {
        throw new Error('Password cannot contain spaces.');
      }
      return true;
    }),
];

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

module.exports = {
  normalizeUserIdentifier,
  loginValidationRules,
  registerValidationRules,
  forgotPasswordValidationRules,
  resetPasswordValidationRules,
  changePasswordValidationRules,
  validate,
};
