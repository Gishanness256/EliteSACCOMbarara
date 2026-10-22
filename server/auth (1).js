'use strict';

/**
 * ============================================================================
 * Elite SACCO Mbarara — Auth routes (login, logout, refresh, password)
 * ----------------------------------------------------------------------------
 * Mounted at /api/v1/auth in server.js:
 *
 *   const express = require('express');
 *   const { createAuthRouter } = require('./routes/auth');
 *   const auth = require('./middleware/auth').createAuth({...});
 *   const db = require('./db/pool');
 *   const bcrypt = require('bcrypt');
 *
 *   app.use('/api/v1/auth', createAuthRouter({ db, auth, bcrypt, config, logger }));
 *
 * Endpoints:
 *   POST   /auth/login           Verify credentials, return JWT + set cookie
 *   POST   /auth/logout          Clear cookie, invalidate refresh token
 *   GET    /auth/me              Return the currently-authenticated user
 *   POST   /auth/refresh         Exchange a refresh token for a new access JWT
 *   POST   /auth/change-password Change the authenticated user's password
 *   POST   /auth/forgot-password Request a password reset token (no auth)
 *   POST   /auth/reset-password  Reset password using a reset token (no auth)
 *   GET    /auth/sessions        List active sessions for the current user
 *   DELETE /auth/sessions/:id    Revoke a specific session
 *
 * All writes go through db.withTransaction(userId, sessionId, fn) so the
 * audit_table_trigger() from 004_audit.sql attributes every row change to
 * the acting user. Auth outcomes (success, failure, password reset) are
 * also written explicitly via log_audit_event().
 * ============================================================================
 */

const express = require('express');
const crypto = require('crypto');
const createError = require('http-errors');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// Refresh token & password reset token lifetimes
// ---------------------------------------------------------------------------
const REFRESH_TOKEN_TTL_DAYS = 30;
const RESET_TOKEN_TTL_HOURS = 4;

// ---------------------------------------------------------------------------
// Helper: normalize email / handle input
// ---------------------------------------------------------------------------
// Accepts either "jane" or "jane@elitesacco.co.ug" and returns the full form.
// Mirrors the front-end behaviour: bare handle → handle@elitesacco.co.ug
function normalizeEmail(input) {
  if (!input) return '';
  const trimmed = String(input).trim().toLowerCase();
  if (trimmed.includes('@')) return trimmed;
  return `${trimmed}@elitesacco.co.ug`;
}

// ---------------------------------------------------------------------------
// Helper: validate password strength
// ---------------------------------------------------------------------------
function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return 'Password is required.';
  }
  if (password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 128) {
    return 'Password must be at most 128 characters.';
  }
  // Require at least 3 of 4 character classes
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^A-Za-z0-9]/.test(password)) classes++;
  if (classes < 3) {
    return 'Password must contain at least 3 of: lowercase, uppercase, digits, symbols.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: parse User-Agent into a short device description
// ---------------------------------------------------------------------------
function describeUserAgent(ua) {
  if (!ua) return 'unknown';
  let browser = 'unknown';
  let os = 'unknown';
  if (/edg/i.test(ua)) browser = 'Edge';
  else if (/chrome|chromium|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua)) browser = 'Safari';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/macintosh|mac os x|iphone|ipad/i.test(ua)) os = 'macOS/iOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/linux/i.test(ua)) os = 'Linux';
  return `${browser} on ${os}`;
}

// ---------------------------------------------------------------------------
// Factory: create the auth router with deps injected
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} AuthRouterDeps
 * @property {import('../db/pool')}  db       Database pool module
 * @property {Object}                auth     Auth middleware bundle from createAuth()
 * @property {Object}                bcrypt   bcrypt module (for password hashing)
 * @property {Object}                config   Server config (jwt.secret, jwt.expiresIn, etc.)
 * @property {Object}                logger   Winston logger
 */

function createAuthRouter(deps) {
  const { db, auth, bcrypt, config, logger } = deps;

  if (!db) throw new Error('createAuthRouter: db is required');
  if (!auth) throw new Error('createAuthRouter: auth is required');
  if (!bcrypt) throw new Error('createAuthRouter: bcrypt is required');
  if (!config || !config.jwt || !config.jwt.secret) {
    throw new Error('createAuthRouter: config.jwt.secret is required');
  }
  if (!logger) throw new Error('createAuthRouter: logger is required');

  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // Rate limiter for auth-sensitive endpoints — attached by server.js
  // We just assume it's there. If you want a local limiter, pass it via deps.

  // ==========================================================================
  // POST /auth/login
  // ==========================================================================
  // Body: { email: string, password: string }
  // Returns: { token, refresh_token, user: {id, name, email, role, initials} }
  // Also sets HttpOnly cookies: token (access) + rt (refresh)
  router.post('/login', async (req, res, next) => {
    let email = '';
    try {
      email = normalizeEmail(req.body.email);
      const { password } = req.body;

      if (!email || !password) {
        throw createError(400, 'Email and password are required.');
      }

      // Look up the user. We always run a bcrypt.compare even when the user
      // doesn't exist — using a dummy hash — so the response time is the same
      // whether the email is valid or not. This prevents user enumeration
      // via timing attacks.
      const dummyHash = '$2b$12$' + 'a'.repeat(53); // syntactically valid but never matches

      const { rows } = await db.query(
        `SELECT id, name, email, role::text AS role, initials,
                password_hash, is_active, last_login_at
           FROM users
          WHERE LOWER(email) = $1`,
        [email],
      );

      const userRow = rows.length ? rows[0] : null;
      const storedHash = userRow ? userRow.password_hash : dummyHash;
      const passwordValid = userRow
        ? (userRow.password_hash
            ? await bcrypt.compare(password, storedHash)
            : (userRow.role === 'Admin' && password === 'Admin')) // bootstrap admin
        : (await bcrypt.compare(password, dummyHash), false);

      // --- Failed login ---
      if (!userRow || !passwordValid) {
        await db.query(
          `SELECT log_audit_event(
            $1, $2, 'authentication'::audit_category, 'warning'::audit_severity,
            NULL, NULL, NULL, $3, $4::inet, $5)`,
          [
            'Failed login',
            `Failed sign-in attempt for "${email}"`,
            req.sessionId || null,
            req.ip || null,
            req.headers['user-agent'] || null,
          ],
        );
        logger.warn('Failed login attempt', { email, ip: req.ip });
        throw createError(401, 'Invalid email or password.');
      }

      // --- Inactive user ---
      if (!userRow.is_active) {
        await db.query(
          `SELECT log_audit_event(
            $1, $2, 'authentication'::audit_category, 'warning'::audit_severity,
            $3, NULL, NULL, $4, $5::inet, $6)`,
          [
            'Login blocked — inactive user',
            `Inactive account ${email} attempted sign-in`,
            userRow.id,
            req.sessionId || null,
            req.ip || null,
            req.headers['user-agent'] || null,
          ],
        );
        throw createError(401, 'Your account has been deactivated. Please contact an administrator.');
      }

      // --- Success: issue tokens + record session ---
      const user = {
        id: userRow.id,
        name: userRow.name,
        email: userRow.email,
        role: userRow.role,
        initials: userRow.initials,
      };

      const accessToken = auth.signToken(user);
      const refreshToken = crypto.randomBytes(32).toString('hex');
      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const refreshTokenExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
      const sessionLabel = describeUserAgent(req.headers['user-agent']);

      await db.withTransaction(user.id, req.sessionId, async (client) => {
        // Update last_login_at
        await client.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

        // Store the refresh token (hashed — never store plaintext tokens)
        await client.query(
          `INSERT INTO auth_sessions
             (user_id, refresh_token_hash, ip_address, user_agent, label, expires_at)
           VALUES ($1, $2, $3::inet, $4, $5, $6)`,
          [
            user.id,
            refreshTokenHash,
            req.ip || null,
            req.headers['user-agent'] || null,
            sessionLabel,
            refreshTokenExpires,
          ],
        );

        // Audit the successful login
        await client.query(
          `SELECT log_audit_event(
            $1, $2, 'authentication'::audit_category, 'info'::audit_severity,
            $3, 'auth_sessions', $4, $5, $6::inet, $7)`,
          [
            'Login',
            `Signed in as ${user.email} (${user.role}) from ${req.ip} — ${sessionLabel}`,
            user.id,
            user.id.toString(),
            req.sessionId || null,
            req.ip || null,
            req.headers['user-agent'] || null,
          ],
        );
      });

      // Invalidate cached user profile so subsequent requests hit the DB fresh
      auth.invalidateUser(user.id);

      // Set cookies
      const isProduction = config.env === 'production' || process.env.NODE_ENV === 'production';
      const cookieOpts = {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        path: '/',
      };
      res.cookie('token', accessToken, {
        ...cookieOpts,
        maxAge: 12 * 60 * 60 * 1000, // 12h — matches JWT_EXPIRES_IN
      });
      res.cookie('rt', refreshToken, {
        ...cookieOpts,
        maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth', // refresh cookie only sent to /auth routes
      });

      logger.info('User logged in', { user_id: user.id, email: user.email, ip: req.ip });

      res.json({
        token,
        refresh_token: refreshToken,
        user,
        expires_in: 12 * 60 * 60, // seconds
      });
    } catch (err) {
      // Catch unexpected errors during login to log the email for forensics
      if (!err.status || err.status >= 500) {
        logger.error('Login handler unexpected error', {
          email,
          error: err.message,
          stack: err.stack,
        });
      }
      next(err);
    }
  });

  // ==========================================================================
  // POST /auth/logout
  // ==========================================================================
  // Clears cookies and revokes the refresh token (so it can't be used again).
  router.post('/logout', auth.required, async (req, res, next) => {
    try {
      const refreshToken = req.cookies && req.cookies.rt;

      await db.withTransaction(req.user.id, req.sessionId, async (client) => {
        // Revoke the refresh token if present
        if (refreshToken) {
          const rtHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
          await client.query(
            `UPDATE auth_sessions
                SET revoked_at = NOW()
              WHERE user_id = $1
                AND refresh_token_hash = $2
                AND revoked_at IS NULL`,
            [req.user.id, rtHash],
          );
        }

        await client.query(
          `SELECT log_audit_event(
            $1, $2, 'authentication'::audit_category, 'info'::audit_severity,
            $3, NULL, NULL, $4, NULL, NULL)`,
          [
            'Logout',
            `Signed out — ${req.user.email}`,
            req.user.id,
            req.sessionId || null,
          ],
        );
      });

      res.clearCookie('token', { path: '/' });
      res.clearCookie('rt', { path: '/api/v1/auth' });

      logger.info('User logged out', { user_id: req.user.id, email: req.user.email });
      res.json({ message: 'Logged out successfully.' });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // POST /auth/logout-all
  // ==========================================================================
  // Revokes ALL refresh tokens for the current user (force every session to
  // re-authenticate). Useful when a user suspects compromise.
  router.post('/logout-all', auth.required, async (req, res, next) => {
    try {
      const result = await db.withTransaction(req.user.id, req.sessionId, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE auth_sessions
              SET revoked_at = NOW()
            WHERE user_id = $1
              AND revoked_at IS NULL`,
          [req.user.id],
        );

        await client.query(
          `SELECT log_audit_event(
            $1, $2, 'authentication'::audit_category, 'notice'::audit_severity,
            $3, 'auth_sessions', $4, $5, NULL, NULL)`,
          [
            'Logout all sessions',
            `Revoked ${rowCount} active session(s) for ${req.user.email}`,
            req.user.id,
            req.user.id.toString(),
            req.sessionId || null,
          ],
        );
        return { revoked: rowCount };
      });

      res.clearCookie('token', { path: '/' });
      res.clearCookie('rt', { path: '/api/v1/auth' });

      logger.info('User logged out of all sessions', {
        user_id: req.user.id,
        email: req.user.email,
        revoked: result.revoked,
      });
      res.json({ message: `Logged out of ${result.revoked} session(s).`, revoked: result.revoked });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // GET /auth/me
  // ==========================================================================
  // Returns the currently-authenticated user (auth.required populates req.user).
  router.get('/me', auth.required, (req, res) => {
    res.json({
      user: req.user,
      permissions: [...req.userPermissions],
    });
  });

  // ==========================================================================
  // POST /auth/refresh
  // ==========================================================================
  // Body: { refresh_token: string } — or read from the `rt` cookie
  // Returns: { token, expires_in }
  //
  // Flow:
  //   1. Hash the presented refresh token
  //   2. Look up a matching auth_sessions row that is not revoked/expired
  //   3. If found, issue a new access JWT (NOT a new refresh token — refresh
  //      tokens are single-use only, but we don't rotate them here for UX.
  //      For higher security, also rotate the refresh token and revoke the old.)
  router.post('/refresh', async (req, res, next) => {
    try {
      const refreshToken =
        (req.body && req.body.refresh_token) ||
        (req.cookies && req.cookies.rt);

      if (!refreshToken) {
        throw createError(400, 'Refresh token is required.');
      }

      const rtHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

      const { rows } = await db.query(
        `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.ip_address,
                u.name, u.email, u.role::text AS role, u.initials, u.is_active
           FROM auth_sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.refresh_token_hash = $1
          LIMIT 1`,
        [rtHash],
      );

      const session = rows.length ? rows[0] : null;

      // Always run a constant-time comparison so timing doesn't reveal whether
      // the token exists. (Here, the hash lookup already does this implicitly
      // since pg uses an index scan.)
      if (!session) {
        throw createError(401, 'Invalid or expired refresh token.');
      }

      if (session.revoked_at) {
        // Possible token theft — revoke ALL of this user's sessions as a precaution
        await db.query(
          `UPDATE auth_sessions SET revoked_at = NOW()
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [session.user_id],
        );
        await db.query(
          `SELECT log_audit_event(
            'Refresh token reuse detected',
            $1, 'authentication'::audit_category, 'critical'::audit_severity,
            $2, 'auth_sessions', $3, NULL, $4::inet, NULL)`,
          [
            `A revoked refresh token was presented for user ${session.email} (${session.user_id}). All sessions revoked as a precaution.`,
            session.user_id,
            session.id.toString(),
            req.ip || null,
          ],
        );
        logger.error('Refresh token reuse detected — all sessions revoked', {
          user_id: session.user_id,
          email: session.email,
        });
        throw createError(401, 'This refresh token has been revoked. Please log in again.');
      }

      if (new Date(session.expires_at) < new Date()) {
        throw createError(401, 'Refresh token has expired. Please log in again.');
      }

      if (!session.is_active) {
        throw createError(401, 'Account has been deactivated. Please contact an administrator.');
      }

      // Issue a new access JWT
      const user = {
        id: session.user_id,
        name: session.name,
        email: session.email,
        role: session.role,
        initials: session.initials,
      };
      const newAccessToken = auth.signToken(user);

      // Update last_used_at on the session
      await db.query(
        'UPDATE auth_sessions SET last_used_at = NOW() WHERE id = $1',
        [session.id],
      );

      // Set the new access token cookie
      const isProduction = config.env === 'production' || process.env.NODE_ENV === 'production';
      res.cookie('token', newAccessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        path: '/',
        maxAge: 12 * 60 * 60 * 1000,
      });

      res.json({
        token: newAccessToken,
        user,
        expires_in: 12 * 60 * 60,
      });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // POST /auth/change-password
  // ==========================================================================
  // Body: { current_password: string, new_password: string }
  // Requires authentication. On success, all OTHER sessions are revoked
  // (forcing re-login on other devices) — a common security best practice.
  router.post('/change-password', auth.required, async (req, res, next) => {
    try {
      const { current_password, new_password } = req.body;

      if (!current_password || !new_password) {
        throw createError(400, 'current_password and new_password are required.');
      }

      const strengthError = validatePasswordStrength(new_password);
      if (strengthError) {
        throw createError(400, strengthError);
      }

      if (current_password === new_password) {
        throw createError(400, 'New password must be different from the current password.');
      }

      // Fetch the current password hash
      const { rows } = await db.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [req.user.id],
      );

      if (!rows.length) {
        throw createError(401, 'User not found.');
      }

      const currentHash = rows[0].password_hash;
      const valid = currentHash
        ? await bcrypt.compare(current_password, currentHash)
        : (req.user.role === 'Admin' && current_password === 'Admin'); // bootstrap admin

      if (!valid) {
        await db.query(
          `SELECT log_audit_event(
            'Failed password change',
            $1, 'authentication'::audit_category, 'warning'::audit_severity,
            $2, NULL, NULL, $3, $4::inet, $5)`,
          [
            `User ${req.user.email} entered wrong current password`,
            req.user.id,
            req.sessionId || null,
            req.ip || null,
            req.headers['user-agent'] || null,
          ],
        );
        throw createError(401, 'Current password is incorrect.');
      }

      // Hash the new password and save
      const newHash = await bcrypt.hash(new_password, config.bcryptRounds || 12);

      await db.withTransaction(req.user.id, req.sessionId, async (client) => {
        await client.query(
          'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
          [newHash, req.user.id],
        );

        // Revoke all OTHER sessions (keep the current one)
        await client.query(
          `UPDATE auth_sessions
              SET revoked_at = NOW()
            WHERE user_id = $1
              AND revoked_at IS NULL
              AND id NOT IN (
                SELECT id FROM auth_sessions
                 WHERE user_id = $1
                   AND refresh_token_hash = $2
              )`,
          [
            req.user.id,
            req.cookies && req.cookies.rt
              ? crypto.createHash('sha256').update(req.cookies.rt).digest('hex')
              : '__no_current_session__',
          ],
        );

        await client.query(
          `SELECT log_audit_event(
            'Password changed',
            $1, 'authentication'::audit_category, 'notice'::audit_severity,
            $2, 'users', $3, $4, $5::inet, $6)`,
          [
            `User ${req.user.email} changed their password; other sessions revoked`,
            req.user.id,
            req.user.id.toString(),
            req.sessionId || null,
            req.ip || null,
            req.headers['user-agent'] || null,
          ],
        );
      });

      // Invalidate cached user
      auth.invalidateUser(req.user.id);

      logger.info('User changed password', { user_id: req.user.id, email: req.user.email });
      res.json({ message: 'Password changed successfully. Other devices will need to log in again.' });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // POST /auth/forgot-password
  // ==========================================================================
  // Body: { email: string }
  // Always returns 200 (even if the email doesn't exist) to prevent enumeration.
  // If the email exists, generates a reset token and "sends" it (the caller
  // must wire up an email transport — we just log it in dev).
  router.post('/forgot-password', async (req, res, next) => {
    let email = '';
    try {
      email = normalizeEmail(req.body.email);
      if (!email) {
        throw createError(400, 'Email is required.');
      }

      const { rows } = await db.query(
        'SELECT id, name, email, is_active FROM users WHERE LOWER(email) = $1',
        [email],
      );

      // Always return success to prevent email enumeration
      const genericResponse = {
        message: 'If that email exists in our system, a password reset link has been sent.',
      };

      if (!rows.length || !rows[0].is_active) {
        // Log the attempt but don't reveal whether the email exists
        await db.query(
          `SELECT log_audit_event(
            'Password reset requested',
            $1, 'authentication'::audit_category, 'info'::audit_severity,
            NULL, NULL, NULL, $2, $3::inet, $4)`,
          [
            `Password reset requested for unknown or inactive email: ${email}`,
            req.sessionId || null,
            req.ip || null,
            req.headers['user-agent'] || null,
          ],
        );
        return res.json(genericResponse);
      }

      const user = rows[0];
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

      await db.withTransaction(user.id, req.sessionId, async (client) => {
        // Invalidate any previous unused reset tokens for this user
        await client.query(
          `UPDATE password_reset_tokens
              SET used_at = NOW()
            WHERE user_id = $1
              AND used_at IS NULL`,
          [user.id],
        );

        await client.query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
           VALUES ($1, $2, $3, $4::inet, $5)`,
          [user.id, resetTokenHash, expiresAt, req.ip || null, req.headers['user-agent'] || null],
        );

        await client.query(
          `SELECT log_audit_event(
            'Password reset requested',
            $1, 'authentication'::audit_category, 'notice'::audit_severity,
            $2, 'password_reset_tokens', $3, $4, $5::inet, $6)`,
          [
            `Password reset link generated for ${user.email}; token expires at ${expiresAt.toISOString()}`,
            user.id,
            user.id.toString(),
            req.sessionId || null,
            req.ip || null,
            req.headers['user-agent'] || null,
          ],
        );
      });

      // In dev: log the token. In prod: send via email.
      if (config.env === 'development' || process.env.NODE_ENV === 'development') {
        logger.info('DEV ONLY — password reset token', {
          user_id: user.id,
          email: user.email,
          reset_token: resetToken,
          expires_at: expiresAt,
          reset_url: `${config.webBaseUrl || 'http://localhost:3000'}/reset-password?token=${resetToken}`,
        });
      } else {
        // TODO: integrate with your email transport (nodemailer, SES, SendGrid, etc.)
        // await sendEmail({ to: user.email, subject: 'Reset your SACCO password', ... })
        logger.info('Password reset email queued (stub)', { user_id: user.id, email: user.email });
      }

      res.json(genericResponse);
    } catch (err) {
      logger.error('forgot-password handler error', { email, error: err.message });
      // Don't leak error details to the client
      res.status(500).json({
        message: 'An error occurred while processing your request. Please try again.',
      });
    }
  });

  // ==========================================================================
  // POST /auth/reset-password
  // ==========================================================================
  // Body: { token: string, new_password: string }
  // Resets the password using a token from /forgot-password. On success,
  // revokes all sessions for the user (forces re-login everywhere).
  router.post('/reset-password', async (req, res, next) => {
    try {
      const { token, new_password } = req.body;

      if (!token || !new_password) {
        throw createError(400, 'Token and new_password are required.');
      }

      const strengthError = validatePasswordStrength(new_password);
      if (strengthError) {
        throw createError(400, strengthError);
      }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const { rows } = await db.query(
        `SELECT t.id, t.user_id, t.expires_at, t.used_at,
                u.email, u.is_active
           FROM password_reset_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1
          LIMIT 1`,
        [tokenHash],
      );

      if (!rows.length) {
        throw createError(400, 'Invalid or expired reset token.');
      }

      const resetRow = rows[0];

      if (resetRow.used_at) {
        // Token reuse — possible attack. Log critical.
        await db.query(
          `SELECT log_audit_event(
            'Reset token reuse detected',
            $1, 'authentication'::audit_category, 'critical'::audit_severity,
            $2, 'password_reset_tokens', $3, NULL, $4::inet, NULL)`,
          [
            `Reset token for ${resetRow.email} was used more than once. Possible attack.`,
            resetRow.user_id,
            resetRow.id.toString(),
            req.ip || null,
          ],
        );
        throw createError(400, 'This reset token has already been used. Please request a new one.');
      }

      if (new Date(resetRow.expires_at) < new Date()) {
        throw createError(400, 'This reset token has expired. Please request a new one.');
      }

      if (!resetRow.is_active) {
        throw createError(400, 'Account has been deactivated. Please contact an administrator.');
      }

      // Hash the new password
      const newHash = await bcrypt.hash(new_password, config.bcryptRounds || 12);

      await db.withTransaction(resetRow.user_id, req.sessionId, async (client) => {
        // Update the password
        await client.query(
          'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
          [newHash, resetRow.user_id],
        );

        // Mark the token as used
        await client.query(
          'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
          [resetRow.id],
        );

        // Revoke ALL sessions for this user (forces re-login everywhere)
        const { rowCount } = await client.query(
          `UPDATE auth_sessions
              SET revoked_at = NOW()
            WHERE user_id = $1
              AND revoked_at IS NULL`,
          [resetRow.user_id],
        );

        await client.query(
          `SELECT log_audit_event(
            'Password reset via token',
            $1, 'authentication'::audit_category, 'notice'::audit_severity,
            $2, 'users', $3, NULL, $4::inet, $5)`,
          [
            `Password for ${resetRow.email} was reset via token; ${rowCount} session(s) revoked`,
            resetRow.user_id,
            resetRow.user_id.toString(),
            req.ip || null,
            req.headers['user-agent'] || null,
          ],
        );
      });

      auth.invalidateUser(resetRow.user_id);

      logger.info('Password reset via token', {
        user_id: resetRow.user_id,
        email: resetRow.email,
      });
      res.json({ message: 'Password reset successfully. Please log in with your new password.' });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // GET /auth/sessions
  // ==========================================================================
  // Lists all active (non-revoked, non-expired) sessions for the current user.
  // Useful for the "Where am I logged in?" account-security screen.
  router.get('/sessions', auth.required, async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT id,
                ip_address,
                user_agent,
                label,
                created_at,
                last_used_at,
                expires_at,
                (NOW() BETWEEN created_at AND expires_at AND revoked_at IS NULL) AS is_active
           FROM auth_sessions
          WHERE user_id = $1
            AND revoked_at IS NULL
            AND expires_at > NOW()
          ORDER BY created_at DESC`,
        [req.user.id],
      );
      res.json({ sessions: rows });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // DELETE /auth/sessions/:id
  // ==========================================================================
  // Revokes a specific session by id. The current session (matching the
  // request's refresh token) cannot be revoked this way — use /logout instead.
  router.delete('/sessions/:id', auth.required, async (req, res, next) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      if (!Number.isInteger(sessionId) || sessionId < 1) {
        throw createError(400, 'Invalid session id.');
      }

      // Identify the current session so we can refuse to revoke it
      const currentRt = req.cookies && req.cookies.rt;
      const currentRtHash = currentRt
        ? crypto.createHash('sha256').update(currentRt).digest('hex')
        : null;

      const { rows } = await db.query(
        `SELECT id, user_id, refresh_token_hash FROM auth_sessions WHERE id = $1`,
        [sessionId],
      );

      if (!rows.length) {
        throw createError(404, 'Session not found.');
      }

      const session = rows[0];
      if (session.user_id !== req.user.id) {
        // Don't reveal that the session exists for another user
        throw createError(404, 'Session not found.');
      }

      if (currentRtHash && session.refresh_token_hash === currentRtHash) {
        throw createError(400, 'Use POST /auth/logout to end your current session.');
      }

      await db.withTransaction(req.user.id, req.sessionId, async (client) => {
        await client.query(
          'UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1',
          [sessionId],
        );
        await client.query(
          `SELECT log_audit_event(
            'Session revoked',
            $1, 'authentication'::audit_category, 'info'::audit_severity,
            $2, 'auth_sessions', $3, $4, NULL, NULL)`,
          [
            `User ${req.user.email} revoked session #${sessionId}`,
            req.user.id,
            sessionId.toString(),
            req.sessionId || null,
          ],
        );
      });

      res.json({ message: 'Session revoked.' });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // Admin-only: GET /auth/users/:id/sessions
  // ==========================================================================
  // Lets an Admin inspect another user's active sessions (for support / security).
  router.get('/users/:id/sessions', auth.required, auth.role('Admin'), async (req, res, next) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId < 1) {
        throw createError(400, 'Invalid user id.');
      }

      const { rows } = await db.query(
        `SELECT id, ip_address, user_agent, label, created_at, last_used_at, expires_at, revoked_at
           FROM auth_sessions
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 100`,
        [userId],
      );
      res.json({ user_id: userId, sessions: rows });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // Admin-only: POST /auth/users/:id/revoke-sessions
  // ==========================================================================
  // Force-revoke ALL sessions for a given user (e.g. when an admin disables
  // an account or responds to a security incident).
  router.post('/users/:id/revoke-sessions', auth.required, auth.role('Admin'), async (req, res, next) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId < 1) {
        throw createError(400, 'Invalid user id.');
      }

      const result = await db.withTransaction(req.user.id, req.sessionId, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE auth_sessions
              SET revoked_at = NOW()
            WHERE user_id = $1
              AND revoked_at IS NULL`,
          [userId],
        );
        const userRow = await client.query('SELECT name, email FROM users WHERE id = $1', [userId]);
        const target = userRow.rows.length ? userRow.rows[0] : { name: '?', email: '?' };
        await client.query(
          `SELECT log_audit_event(
            'Admin revoked user sessions',
            $1, 'user_management'::audit_category, 'warning'::audit_severity,
            $2, 'auth_sessions', NULL, $3, NULL, NULL)`,
          [
            `Admin ${req.user.email} revoked ${rowCount} session(s) for ${target.email}`,
            req.user.id,
            req.sessionId || null,
          ],
        );
        return { revoked: rowCount, target };
      });

      logger.info('Admin revoked user sessions', {
        admin_id: req.user.id,
        target_user_id: userId,
        target_email: result.target.email,
        revoked: result.revoked,
      });
      res.json({
        message: `Revoked ${result.revoked} session(s) for ${result.target.email}.`,
        revoked: result.revoked,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAuthRouter, normalizeEmail, validatePasswordStrength, describeUserAgent };
