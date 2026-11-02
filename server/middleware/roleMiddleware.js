const createError = require('http-errors');

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function requireRole(...allowedRoles) {
  const normalizedRoles = allowedRoles
    .flatMap((role) => String(role).split(','))
    .map((role) => normalizeRole(role))
    .filter(Boolean);

  return (req, res, next) => {
    if (!req.user) {
      return next(createError(401, 'Authentication required.'));
    }

    const userRole = normalizeRole(req.user.role);

    if (!normalizedRoles.includes(userRole)) {
      return next(
        createError(
          403,
          `Access denied. Required role: ${allowedRoles.join(', ')}`,
        ),
      );
    }

    return next();
  };
}

function requireAnyRole(...allowedRoles) {
  return requireRole(...allowedRoles);
}

module.exports = {
  requireRole,
  requireAnyRole,
};
