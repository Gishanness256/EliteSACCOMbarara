'use strict';

/**
 * Elite SACCO Mbarara — System users CRUD
 *
 * Typical mount in server.js:
 *
 *   const { createUsersRouter } = require('./routes/users');
 *   app.use('/api/v1/users', createUsersRouter({ db, auth, bcrypt, logger }));
 *
 * Routes:
 *   GET    /api/v1/users
 *   GET    /api/v1/users/:id
 *   POST   /api/v1/users
 *   PATCH  /api/v1/users/:id
 *   DELETE /api/v1/users/:id
 *
 * Notes:
 * - Admin-only for creates/updates/deletes
 * - Deletes are soft-deletes via is_active = false
 * - Passwords are bcrypt-hashed
 * - Audit records are written by the calling transaction when available
 */

const express = require('express');
const createError = require('http-errors');

function normalizeEmail(input) {
  if (!input) return '';
  const value = String(input).trim().toLowerCase();
  if (!value) return '';
  if (value.includes('@')) return value;
  return `${value}@elitesacco.co.ug`;
}

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

  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;

  if (classes < 3) {
    return 'Password must contain at least 3 of: lowercase, uppercase, digits, symbols.';
  }

  return null;
}

function sanitizeUserRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    initials: row.initials,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at || null,
  };
}

function createUsersRouter(deps = {}) {
  const { db, auth, bcrypt, logger } = deps;

  if (!db || !db.query) {
    throw new Error('createUsersRouter: db is required');
  }

  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  const requireAuth = auth && typeof auth.required === 'function'
    ? auth.required
    : (req, res, next) => {
        if (!req.user) return next(createError(401, 'Authentication required.'));
        next();
      };

  const requireAdmin = auth && typeof auth.role === 'function'
    ? auth.role('Admin')
    : (req, res, next) => {
        if (!req.user) return next(createError(401, 'Authentication required.'));
        if (req.user.role !== 'Admin') {
          return next(createError(403, 'This action requires administrator privileges.'));
        }
        next();
      };

  async function getUserById(userId) {
    const { rows } = await db.query(
      `
        SELECT id, name, email, role::text AS role, initials, is_active,
               created_at, updated_at, last_login_at
        FROM users
        WHERE id = $1
      `,
      [userId],
    );

    return rows && rows.length ? sanitizeUserRow(rows[0]) : null;
  }

  // -------------------------------------------------------------------------
  // GET /users
  // List users (admin only or allow any authenticated user depending on your policy)
  // -------------------------------------------------------------------------
  router.get('/', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `
          SELECT id, name, email, role::text AS role, initials, is_active,
                 created_at, updated_at, last_login_at
          FROM users
          ORDER BY name ASC
        `,
      );

      const users = (rows || []).map(sanitizeUserRow);

      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /users/:id
  // -------------------------------------------------------------------------
  router.get('/:id', requireAuth, async (req, res, next) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId < 1) {
        throw createError(400, 'Invalid user id.');
      }

      const user = await getUserById(userId);
      if (!user) {
        throw createError(404, 'User not found.');
      }

      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /users
  // Create user
  // Body:
  // {
  //   name: 'Jane Doe',
  //   email: 'jane',
  //   role: 'Credit Officer',
  //   initials: 'JD',
  //   password: 'StrongPass123!',
  //   is_active: true
  // }
  // -------------------------------------------------------------------------
  router.post('/', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const { name, email, role, initials, password, is_active = true } = req.body || {};

      if (!name || !String(name).trim()) {
        throw createError(400, 'name is required.');
      }

      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail) {
        throw createError(400, 'email is required.');
      }

      const safeRole = role && String(role).trim()
        ? String(role).trim()
        : 'Member';

      const passwordError = validatePasswordStrength(password);
      if (passwordError) {
        throw createError(400, passwordError);
      }

      const finalInitials = initials && String(initials).trim()
        ? String(initials).trim().slice(0, 3).toUpperCase()
        : null;

      const hashedPassword = await bcrypt.hash(password, 12);

      const createUser = async (client) => {
        const { rows } = await client.query(
          `
            INSERT INTO users (
              name,
              email,
              role,
              initials,
              password_hash,
              is_active,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3::user_role, $4, $5, $6, NOW(), NOW())
            RETURNING
              id,
              name,
              email,
              role::text AS role,
              initials,
              is_active,
              created_at,
              updated_at
          `,
          [
            String(name).trim(),
            normalizedEmail,
            safeRole,
            finalInitials,
            hashedPassword,
            Boolean(is_active),
          ],
        );

        return sanitizeUserRow(rows[0]);
      };

      let result;
      if (db.withTransaction) {
        result = await db.withTransaction(req.user.id, req.sessionId, createUser);
      } else {
        result = await createUser(await db.connect());
      }

      res.status(201).json({
        message: 'User created successfully.',
        user: result,
      });
    } catch (err) {
      if (err && err.code === '23505') {
        return next(createError(409, 'A user with that email already exists.'));
      }
      if (err && err.status === 400) {
        return next(err);
      }
      if (logger && typeof logger.error === 'function') {
        logger.error('users:create failed', {
          error: err.message,
          stack: err.stack,
          actor_id: req.user && req.user.id,
        });
      }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /users/:id
  // Update user details
  // Body:
  // { name, email, role, initials, is_active, password }
  // -------------------------------------------------------------------------
  router.patch('/:id', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId < 1) {
        throw createError(400, 'Invalid user id.');
      }

      if (userId === req.user.id) {
        throw createError(400, 'You cannot modify your own account through this route.');
      }

      const { name, email, role, initials, is_active, password } = req.body || {};
      const updates = [];
      const values = [];

      if (name !== undefined) {
        if (!String(name).trim()) {
          throw createError(400, 'name cannot be empty.');
        }
        updates.push('name = $' + (values.length + 1));
        values.push(String(name).trim());
      }

      if (email !== undefined) {
        const normalizedEmail = normalizeEmail(email);
        if (!normalizedEmail) {
          throw createError(400, 'email cannot be empty.');
        }
        updates.push('email = $' + (values.length + 1));
        values.push(normalizedEmail);
      }

      if (role !== undefined) {
        const safeRole = String(role).trim();
        if (!safeRole) {
          throw createError(400, 'role cannot be empty.');
        }
        updates.push('role = $' + (values.length + 1) + '::user_role');
        values.push(safeRole);
      }

      if (initials !== undefined) {
        const value = String(initials).trim();
        updates.push('initials = $' + (values.length + 1));
        values.push(value ? value.slice(0, 3).toUpperCase() : null);
      }

      if (is_active !== undefined) {
        updates.push('is_active = $' + (values.length + 1));
        values.push(Boolean(is_active));
      }

      if (password !== undefined) {
        const passwordError = validatePasswordStrength(password);
        if (passwordError) {
          throw createError(400, passwordError);
        }
        updates.push('password_hash = $' + (values.length + 1));
        values.push(await bcrypt.hash(password, 12));
      }

      if (!updates.length) {
        throw createError(400, 'No user fields were provided to update.');
      }

      updates.push('updated_at = NOW()');

      const updateUser = async (client) => {
        const result = await client.query(
          `
            UPDATE users
            SET ${updates.join(', ')}
            WHERE id = $2
            RETURNING
              id,
              name,
              email,
              role::text AS role,
              initials,
              is_active,
              created_at,
              updated_at,
              last_login_at
          `,
          [...values, userId],
        );

        if (!result.rows.length) {
          throw createError(404, 'User not found.');
        }

        return sanitizeUserRow(result.rows[0]);
      };

      let result;
      if (db.withTransaction) {
        result = await db.withTransaction(req.user.id, req.sessionId, updateUser);
      } else {
        result = await updateUser(await db.connect());
      }

      res.json({
        message: 'User updated successfully.',
        user: result,
      });
    } catch (err) {
      if (err && err.code === '23505') {
        return next(createError(409, 'A user with that email already exists.'));
      }
      if (err && err.status === 400) {
        return next(err);
      }
      if (logger && typeof logger.error === 'function') {
        logger.error('users:update failed', {
          error: err.message,
          stack: err.stack,
          actor_id: req.user && req.user.id,
          target_id: req.params.id,
        });
      }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /users/:id
  // Soft delete: sets is_active = false
  // -------------------------------------------------------------------------
  router.delete('/:id', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId < 1) {
        throw createError(400, 'Invalid user id.');
      }

      if (userId === req.user.id) {
        throw createError(400, 'You cannot delete your own account.');
      }

      const deleteUser = async (client) => {
        const { rowCount } = await client.query(
          `
            UPDATE users
            SET is_active = FALSE,
                updated_at = NOW()
            WHERE id = $1
          `,
          [userId],
        );

        if (!rowCount) {
          throw createError(404, 'User not found.');
        }

        return { id: userId, is_active: false };
      };

      if (db.withTransaction) {
        await db.withTransaction(req.user.id, req.sessionId, deleteUser);
      } else {
        await deleteUser(await db.connect());
      }

      res.json({
        message: 'User deleted successfully.',
        id: userId,
      });
    } catch (err) {
      if (err && err.status === 400) {
        return next(err);
      }
      if (logger && typeof logger.error === 'function') {
        logger.error('users:delete failed', {
          error: err.message,
          stack: err.stack,
          actor_id: req.user && req.user.id,
          target_id: req.params.id,
        });
      }
      next(err);
    }
  });

  return router;
}

module.exports = {
  createUsersRouter,
  normalizeEmail,
  validatePasswordStrength,
};
