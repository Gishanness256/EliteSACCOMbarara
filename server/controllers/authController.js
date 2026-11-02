'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { query } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

function sanitizeUser(user = {}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    initials: user.initials || '',
    isActive: user.is_active ?? true,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

async function login(req, res, next) {
  try {
    const { email, handle, password } = req.body || {};

    if (!password || (!email && !handle)) {
      return res.status(400).json({
        error: 'Email/handle and password are required.',
      });
    }

    const rawIdentifier = (email || handle || '').toString().trim();
    const normalizedEmail = rawIdentifier.includes('@')
      ? rawIdentifier.toLowerCase()
      : `${rawIdentifier.toLowerCase()}@elitesacco.co.ug`;

    const { rows } = await query(
      `
        SELECT
          id,
          name,
          email,
          role::text AS role,
          initials,
          password_hash,
          is_active,
          created_at,
          last_login_at
        FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
      `,
      [normalizedEmail]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash || '');

    if (!isValid || !user.is_active) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    await query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
      [user.id]
    );

    const token = signToken(user);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    });

    return res.json({
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return next(error);
  }
}

async function register(req, res, next) {
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

    const { rows } = await query(
      `
        INSERT INTO users (name, email, password_hash, role, initials)
        VALUES ($1, $2, $3, $4::user_role, $5)
        RETURNING
          id,
          name,
          email,
          role::text AS role,
          initials,
          created_at
      `,
      [
        name.trim(),
        email,
        hash,
        role || 'Credit Officer',
        (initials || '').toUpperCase() || null,
      ]
    );

    const user = rows[0];
    const token = signToken(user);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      token,
      user: sanitizeUser(user),
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

function me(req, res) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  return res.json({
    user: sanitizeUser(req.user),
  });
}

function logout(req, res) {
  res.clearCookie('token');
  return res.json({ message: 'Logged out successfully.' });
}

function createAuthController(authRequired) {
  const router = express.Router();

  router.post('/login', login);
  router.post('/register', register);
  router.get('/me', authRequired, me);
  router.post('/logout', authRequired, logout);

  return router;
}

module.exports = {
  login,
  register,
  me,
  logout,
  createAuthController,
};
