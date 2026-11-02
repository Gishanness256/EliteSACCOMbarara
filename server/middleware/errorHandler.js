function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  const payload = {
    error:
      err.code ||
      (status === 404
        ? 'not_found'
        : status === 401
          ? 'unauthorized'
          : status === 403
            ? 'forbidden'
            : 'internal_error'),
    message: err.expose
      ? err.message
      : status < 500
        ? err.message
        : 'An internal error occurred.',
    request_id: req.id || null,
    trace_id: req.traceId || null,
  };

  if (process.env.NODE_ENV === 'development' && status >= 500) {
    payload.stack = err.stack;
  }

  if (status >= 500) {
    console.error('Unhandled server error', {
      error: err.message,
      stack: err.stack,
      request_id: req.id || null,
      trace_id: req.traceId || null,
      method: req.method,
      path: req.path,
    });
  } else if (status >= 400) {
    console.warn('Client error', {
      status,
      message: err.message,
      request_id: req.id || null,
      trace_id: req.traceId || null,
      method: req.method,
      path: req.path,
    });
  }

  return res.status(status).json(payload);
}

module.exports = errorHandler;
