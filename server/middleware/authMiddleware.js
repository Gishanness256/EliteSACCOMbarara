const jwt = require('jsonwebtoken');
const createError = require('http-errors');

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  const cookieToken = req.cookies && req.cookies.token;

  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  return cookieToken || null;
}

async function authRequired(req, res, next) {
  try {
    const token = getTokenFromRequest(req);

    if (!token) {
      return next(createError(401, 'Authentication required. Provide a Bearer token or token cookie.'));
    }

    const secret = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
    const payload = jwt.verify(token, secret);

    const pool = req.app.locals?.pool || global.pool;
    if (!pool || typeof pool.query !== 'function') {
      return next(createError(500, 'Database connection not available.'));
    }

    const { rows } = await pool.query(
      `
        SELECT
          id,
          name,
          email,
          role,
          initials,
          is_active
        FROM users
        WHERE id = $1
      `,
      [payload.sub || payload.userId],
    );

    if (!rows.length || rows[0].is_active === false) {
      return next(createError(401, 'User account is inactive or no longer exists.'));
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return next(createError(401, 'Invalid or expired token. Please log in again.'));
    }

    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(createError(401, 'Authentication required.'));
    }

    if (!roles.includes(req.user.role)) {
      return next(
        createError(403, `This action requires one of: ${roles.join(', ')}.`),
      );
    }

    next();
  };
}

function requirePermission(permissionCode) {
  return async (req, res, next) => {
    if (!req.user) {
      return next(createError(401, 'Authentication required.'));
    }

    try {
      const pool = req.app.locals?.pool || global.pool;
      if (!pool || typeof pool.query !== 'function') {
        return next(createError(500, 'Database connection not available.'));
      }

      const { rows } = await pool.query(
        `
          SELECT 1
          FROM role_permissions rp
          JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role = $1
            AND p.code = $2
          LIMIT 1
        `,
        [req.user.role, permissionCode],
      );

      if (!rows.length) {
        return next(createError(403, `Missing permission: ${permissionCode}`));
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  authRequired,
  requireRole,
  requirePermission,
};
