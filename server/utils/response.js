/**
 * Standard API response helpers.
 * Usage:
 *   const { success, error } = require('../utils/response');
 *
 *   res.status(200).json(success(...));
 *   res.status(400).json(error(...));
 */

function buildResponse(statusCode, payload = {}) {
  const isSuccess = statusCode >= 200 && statusCode < 300;

  return {
    success: isSuccess,
    message: payload.message || (isSuccess ? 'Request successful' : 'Request failed'),
    data: payload.data ?? null,
    meta: payload.meta ?? null,
    ...(payload.errors ? { errors: payload.errors } : {}),
    ...(payload.pagination ? { pagination: payload.pagination } : {}),
  };
}

function success(res, statusCode = 200, message = 'Request successful', data = null, meta = null) {
  return res.status(statusCode).json(
    buildResponse(statusCode, {
      message,
      data,
      meta,
    }),
  );
}

function error(res, statusCode = 500, message = 'Something went wrong', errors = null, data = null, meta = null) {
  return res.status(statusCode).json(
    buildResponse(statusCode, {
      message,
      errors,
      data,
      meta,
    }),
  );
}

function notFound(res, message = 'Resource not found', data = null) {
  return error(res, 404, message, null, data);
}

function validationError(res, message = 'Validation failed', errors = [], data = null) {
  return error(res, 400, message, errors, data);
}

function unauthorized(res, message = 'Unauthorized', data = null) {
  return error(res, 401, message, null, data);
}

function forbidden(res, message = 'Forbidden', data = null) {
  return error(res, 403, message, null, data);
}

module.exports = {
  success,
  error,
  notFound,
  validationError,
  unauthorized,
  forbidden,
  buildResponse,
};
