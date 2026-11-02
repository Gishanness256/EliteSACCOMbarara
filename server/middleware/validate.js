const { validationResult } = require('express-validator');
const createError = require('http-errors');

function formatValidationErrors(errors) {
  return errors.array().map((error) => ({
    field: error.param || error.path || 'unknown',
    message: error.msg,
    value: error.value ?? null,
    location: error.location || 'body',
  }));
}

function validate(validations = []) {
  return async (req, res, next) => {
    try {
      if (Array.isArray(validations)) {
        await Promise.all(validations.map((validation) => validation.run(req)));
      }

      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return next(
          createError(
            400,
            'Validation failed.',
            {
              details: formatValidationErrors(errors),
            },
          ),
        );
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = validate;
module.exports.validate = validate;
module.exports.formatValidationErrors = formatValidationErrors;
