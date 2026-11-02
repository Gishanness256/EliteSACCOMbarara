'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, pool } = require('../db');

function sanitizeUser(user = {}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    initials: user.initials || '',
    is_active: user.is_active ?? true,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
  };
}

async function withTransaction(fn) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listUsers(req, res, next) {
  try {
    const { rows } = await query(`
      SELECT
        id,
        name,
        email,
        role::text AS role,
        initials,
        is_active,
        created_at,
        last_login_at
      FROM users
      ORDER BY name
    `);

    return res.json({
      users: rows.map(sanitizeUser),
    });
  } catch (error) {
    return next(error);
  }
}

async function createUser(req, res, next) {
  try {
    const { name, handle, password, role, initials } = req.body || {};

    if (!name || !handle || !password) {
      return res.status(400).json({
        error: 'name, handle and password are required.',
      });
    }

    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(handle)) {
      return res.status(400).json({
        error: 'handle may contain only letters, numbers, dots, hyphens and underscores.',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters long.',
      });
    }

    const email = `${handle.toLowerCase()}@elitesacco.co.ug`;
    const hash = await bcrypt.hash(password, 12);

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `
          INSERT INTO users (name, email, password_hash, role, initials)
          VALUES ($1, $2, $3, $4::user_role, $5)
          RETURNING
            id,
            name,
            email,
            role::text AS role,
            initials,
            is_active,
            created_at,
            last_login_at
        `,
        [
          String(name).trim(),
          email,
          hash,
          role || 'Credit Officer',
          (initials || '').toUpperCase() || null,
        ]
      );

      return rows[0];
    });

    return res.status(201).json({
      user: sanitizeUser(result),
    });
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(409).json({
        error: 'A user with that email already exists.',
      });
    }

    return next(error);
  }
}

async function deleteUser(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Valid user id is required.' });
    }

    if (id === req.user.id) {
      return res.status(400).json({
        error: 'You cannot remove your own account.',
      });
    }

    const { rows } = await query(
      `
        UPDATE users
        SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          email,
          role::text AS role,
          initials,
          is_active
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.json({
      message: 'User deactivated.',
      id,
      user: sanitizeUser(rows[0]),
    });
  } catch (error) {
    return next(error);
  }
}

function createUserController({ authRequired, requirePermission }) {
  const router = express.Router();

  router.use(authRequired);

  router.get('/', requirePermission('manage_users'), listUsers);
  router.post('/', requirePermission('manage_users'), createUser);
  router.delete('/:id', requirePermission('manage_users'), deleteUser);

  router.use((error, req, res, next) => {
    // eslint-disable-line no-unused-vars
    const status = error.status || error.statusCode || 500;
    const payload = {
      error:
        error.code ||
        (status === 404
          ? 'not_found'
          : status === 401
            ? 'unauthorized'
            : status === 403
              ? 'forbidden'
              : 'internal_error'),
      message:
        error.expose ? error.message : status < 500 ? error.message : 'An internal error occurred.',
    };

    if (status >= 500) {
      console.error('[userController]', error);
    }

    return res.status(status).json(payload);
  });

  return router;
}

module.exports = {
  listUsers,
  createUser,
  deleteUser,
  createUserController,
};
