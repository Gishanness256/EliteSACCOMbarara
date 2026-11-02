'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function normalizeUser(row = {}) {
  return {
    id: row.id ?? null,
    name: row.name ?? null,
    email: row.email ?? null,
    role: row.role ?? null,
    initials: row.initials ?? null,
    isActive: row.is_active ?? row.isActive ?? true,
    createdAt: row.created_at ?? row.createdAt ?? null,
    lastLoginAt: row.last_login_at ?? row.lastLoginAt ?? null,
    passwordHash: row.password_hash ?? row.passwordHash ?? null,
  };
}

function createAuthService({
  db,
  logger,
  jwtSecret = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  tokenTtl = process.env.JWT_EXPIRES_IN || '12h',
  bcryptRounds = Number(process.env.BCRYPT_ROUNDS || 12),
} = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('authService: a valid db instance with query() is required');
  }

  const signToken = (user) =>
    jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
      },
      jwtSecret,
      { expiresIn: tokenTtl },
    );

  const log = (message, meta) => {
    if (logger && typeof logger.info === 'function') {
      logger.info(message, meta || {});
    }
  };

  return {
    async findUserByEmail(email) {
      if (!email) return null;

      const normalizedEmail = String(email).trim().toLowerCase();
      const finalEmail = normalizedEmail.includes('@')
        ? normalizedEmail
        : `${normalizedEmail}@elitesacco.co.ug`;

      const { rows } = await db.query(
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
          WHERE LOWER(email) = $1
          LIMIT 1
        `,
        [finalEmail],
      );

      const user = rows && rows[0] ? normalizeUser(rows[0]) : null;
      return user;
    },

    async hashPassword(password) {
      if (!password) {
        throw new Error('Password is required');
      }

      return bcrypt.hash(password, bcryptRounds);
    },

    async comparePassword(password, hash) {
      if (!password || !hash) return false;

      try {
        return await bcrypt.compare(password, hash);
      } catch (err) {
        log('Password comparison failed', { error: err.message });
        return false;
      }
    },

    async verifyCredentials(email, password) {
      const user = await this.findUserByEmail(email);

      if (!user) {
        return {
          ok: false,
          reason: 'invalid_credentials',
          user: null,
        };
      }

      if (!user.isActive) {
        return {
          ok: false,
          reason: 'inactive_account',
          user: null,
        };
      }

      const valid = await this.comparePassword(password, user.passwordHash);
      if (!valid) {
        return {
          ok: false,
          reason: 'invalid_credentials',
          user: null,
        };
      }

      return {
        ok: true,
        reason: null,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          initials: user.initials,
          isActive: user.isActive,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        },
      };
    },

    async login({ email, password }) {
      const result = await this.verifyCredentials(email, password);

      if (!result.ok || !result.user) {
        return {
          ok: false,
          token: null,
          user: null,
          reason: result.reason || 'invalid_credentials',
        };
      }

      const token = signToken(result.user);

      return {
        ok: true,
        token,
        user: result.user,
        reason: null,
      };
    },

    async getUserFromToken(token) {
      if (!token) return null;

      try {
        const payload = jwt.verify(token, jwtSecret);

        const { rows } = await db.query(
          `
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
            WHERE id = $1
            LIMIT 1
          `,
          [payload.sub],
        );

        const user = rows && rows[0] ? normalizeUser(rows[0]) : null;
        if (!user || !user.isActive) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          initials: user.initials,
          isActive: user.isActive,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        };
      } catch (err) {
        log('JWT verification failed', { error: err.message });
        return null;
      }
    },

    async createUser({
      name,
      handle,
      password,
      role = 'Credit Officer',
      initials = null,
    }) {
      if (!name || !handle || !password) {
        throw new Error('name, handle and password are required');
      }

      if (!/^[a-z0-9][a-z0-9._-]*$/.test(handle)) {
        throw new Error('handle may contain only letters, numbers, dots, hyphens and underscores.');
      }

      if (String(password).length < 6) {
        throw new Error('Password must be at least 6 characters.');
      }

      const email = `${String(handle).toLowerCase()}@elitesacco.co.ug`;
      const passwordHash = await this.hashPassword(password);

      const { rows } = await db.query(
        `
          INSERT INTO users (
            name,
            email,
            password_hash,
            role,
            initials
          )
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
          name,
          email,
          passwordHash,
          role,
          (initials || '').toUpperCase() || null,
        ],
      );

      const createdUser = rows && rows[0] ? rows[0] : null;
      if (!createdUser) {
        throw new Error('User could not be created');
      }

      log('User created', {
        userId: createdUser.id,
        email: createdUser.email,
        role: createdUser.role,
      });

      return {
        id: createdUser.id,
        name: createdUser.name,
        email: createdUser.email,
        role: createdUser.role,
        initials: createdUser.initials,
        createdAt: createdUser.created_at,
      };
    },

    async deactivateUser(userId) {
      const { rowCount } = await db.query(
        `
          UPDATE users
             SET is_active = FALSE,
                 updated_at = NOW()
           WHERE id = $1
        `,
        [userId],
      );

      return rowCount > 0;
    },
  };
}

module.exports = createAuthService;
module.exports.createAuthService = createAuthService;
