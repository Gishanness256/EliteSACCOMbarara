const jwt = require('jsonwebtoken');

const DEFAULT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

function getJwtSecret(customSecret) {
  const secret = customSecret || process.env.JWT_SECRET;

  if (!secret || String(secret).trim() === '') {
    throw new Error('JWT_SECRET is not configured. Set it in the environment.');
  }

  return secret;
}

/**
 * Create a JWT for a user.
 * This matches the payload shape used by server/middleware/auth.js:
 *   { sub, email, role, name, initials }
 */
function signToken(payload, options = {}) {
  const secret = getJwtSecret(options.secret);
  const expiresIn = options.expiresIn || DEFAULT_EXPIRES_IN;

  return jwt.sign(payload, secret, {
    expiresIn,
    ...(options.jwtOptions || {}),
  });
}

/**
 * Verify and decode a JWT.
 */
function verifyToken(token, options = {}) {
  const secret = getJwtSecret(options.secret);

  if (!token || typeof token !== 'string') {
    throw new Error('JWT token is required.');
  }

  return jwt.verify(token, secret, options.verifyOptions || {});
}

/**
 * Decode a JWT without verifying the signature.
 * Useful for debugging or checking payload structure.
 */
function decodeToken(token, options = {}) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  return jwt.decode(token, options.decodeOptions || {});
}

/**
 * Build the standard auth payload used by the app.
 */
function createAuthPayload(user) {
  if (!user || !user.id) {
    throw new Error('User payload is required to create JWT claims.');
  }

  return {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    initials: user.initials || null,
  };
}

module.exports = {
  getJwtSecret,
  signToken,
  verifyToken,
  decodeToken,
  createAuthPayload,
};
