'use strict';

/**
 * Elite SACCO Mbarara — Settings routes
 *
 * Mounted at /api/v1/settings in server.js:
 *
 *   const { createSettingsRouter } = require('./routes/settings');
 *   app.use('/api/v1/settings', createSettingsRouter({ db, auth, logger }));
 *
 * Endpoints:
 *   GET    /settings/access-levels
 *   GET    /settings/access-levels/:role
 *   PUT    /settings/access-levels/:role
 *
 *   GET    /settings/config
 *   GET    /settings/config/:key
 *   PUT    /settings/config/:key
 *
 *   GET    /settings/rates
 *   GET    /settings/rates/:key
 *   PUT    /settings/rates/:key
 *
 * Notes:
 * - Admin-only for writes.
 * - If required tables are not present yet, the router falls back to a default
 *   in-memory config so the app still starts cleanly.
 */

const express = require('express');
const createError = require('http-errors');

function defaultRoleAccess() {
  return {
    Admin: [
      'manage_users',
      'manage_roles',
      'manage_members',
      'approve_loans',
      'ack_savings',
      'ack_loan_repayments',
      'view_reports',
      'manage_settings',
      'audit_view',
    ],
    Treasurer: [
      'manage_members',
      'view_reports',
      'ack_savings',
      'manage_settings',
      'audit_view',
    ],
    'Credit Supervisor': [
      'manage_members',
      'approve_loans',
      'ack_loan_repayments',
      'view_reports',
      'manage_settings',
    ],
    'Credit Officer': [
      'manage_members',
      'ack_savings',
      'view_reports',
    ],
    Member: [],
  };
}

function defaultSystemConfig() {
  return {
    app_name: 'Elite SACCO Mbarara',
    company_name: 'Elite SACCO Mbarara',
    currency: 'UGX',
    default_timezone: 'Africa/Kampala',
    min_password_length: 8,
    session_timeout_minutes: 120,
    allow_member_self_service: true,
    loan_interest_default: 2.5,
    savings_interest_default: 0.0,
    default_account_prefix: 'ES',
    audit_enabled: true,
  };
}

function defaultRates() {
  return {
    savings_interest_rate: 0.0,
    loan_interest_rate_monthly: 2.5,
    loan_penalty_rate_daily: 0.02,
    minimum_balance: 0,
    max_loan_tenure_months: 60,
    min_loan_amount: 50000,
    max_loan_amount: 50000000,
  };
}

function ensureObject(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return fallback;
}

function normalizeRoleName(role) {
  if (!role) return '';
  return String(role).trim();
}

function normalizeKeyName(key) {
  if (!key) return '';
  return String(key).trim();
}

function createSettingsRouter(deps = {}) {
  const { db, auth, logger } = deps;

  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  const adminOnly = (req, res, next) => {
    try {
      if (req.user && req.user.role === 'Admin') {
        return next();
      }

      if (auth && typeof auth.role === 'function') {
        return auth.role('Admin')(req, res, next);
      }

      return next(createError(403, 'This action requires administrator privileges.'));
    } catch (err) {
      return next(err);
    }
  };

  const tableExists = async (tableName) => {
    if (!db || !db.query) return false;

    try {
      const { rows } = await db.query(
        `
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = $1
          LIMIT 1
        `,
        [tableName],
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch (err) {
      return false;
    }
  };

  const fetchRolePermissions = async () => {
    if (!db || !db.query) return defaultRoleAccess();

    try {
      const exists = await tableExists('role_permissions');
      if (!exists) return defaultRoleAccess();

      const { rows } = await db.query(
        `
          SELECT rp.role, p.code, p.name
          FROM role_permissions rp
          JOIN permissions p ON p.id = rp.permission_id
          ORDER BY rp.role, p.code
        `,
      );

      const result = {};
      for (const row of rows || []) {
        const role = normalizeRoleName(row.role);
        if (!role) continue;
        result[role] = result[role] || [];
        result[role].push(row.code);
      }

      return Object.keys(result).length ? result : defaultRoleAccess();
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('settings: role permissions fallback used', { error: err.message });
      }
      return defaultRoleAccess();
    }
  };

  const fetchSystemConfig = async () => {
    if (!db || !db.query) return defaultSystemConfig();

    try {
      const exists = await tableExists('system_settings');
      if (!exists) return defaultSystemConfig();

      const { rows } = await db.query(
        `SELECT key_name, value FROM system_settings ORDER BY key_name`,
      );

      const config = defaultSystemConfig();
      for (const row of rows || []) {
        if (!row || !row.key_name) continue;
        config[row.key_name] = row.value;
      }

      return config;
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('settings: system config fallback used', { error: err.message });
      }
      return defaultSystemConfig();
    }
  };

  const fetchRates = async () => {
    if (!db || !db.query) return defaultRates();

    try {
      const exists = await tableExists('loan_rates');
      if (!exists) return defaultRates();

      const { rows } = await db.query(
        `SELECT key_name, value FROM loan_rates ORDER BY key_name`,
      );

      const rates = defaultRates();
      for (const row of rows || []) {
        if (!row || !row.key_name) continue;
        rates[row.key_name] = row.value;
      }

      return rates;
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('settings: rates fallback used', { error: err.message });
      }
      return defaultRates();
    }
  };

  // --------------------------------------------------------------------------
  // GET /access-levels
  // Returns the effective role-to-permission map.
  // --------------------------------------------------------------------------
  router.get('/access-levels', async (req, res, next) => {
    try {
      const permissions = await fetchRolePermissions();
      res.json({
        roles: permissions,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // GET /access-levels/:role
  // Returns permissions for a specific role.
  // --------------------------------------------------------------------------
  router.get('/access-levels/:role', async (req, res, next) => {
    try {
      const role = normalizeRoleName(req.params.role);
      const permissions = await fetchRolePermissions();

      const rolePermissions = permissions[role] || [];
      res.json({
        role,
        permissions: rolePermissions,
      });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // PUT /access-levels/:role
  // Body:
  // {
  //   permissions: ['manage_users', 'view_reports']
  // }
  // --------------------------------------------------------------------------
  router.put('/access-levels/:role', adminOnly, async (req, res, next) => {
    try {
      const role = normalizeRoleName(req.params.role);
      const permissions = Array.isArray(req.body && req.body.permissions)
        ? req.body.permissions.map((p) => String(p).trim()).filter(Boolean)
        : [];

      if (!role) {
        throw createError(400, 'Role name is required.');
      }

      if (!db || !db.query) {
        const roles = defaultRoleAccess();
        roles[role] = permissions;
        return res.json({
          role,
          permissions,
          message: 'Settings updated in-memory only (database not configured).',
        });
      }

      const exists = await tableExists('permissions');
      const existsRolePerms = await tableExists('role_permissions');

      if (!exists || !existsRolePerms) {
        const roles = defaultRoleAccess();
        roles[role] = permissions;
        return res.json({
          role,
          permissions,
          message: 'No role_permissions tables found. In-memory update only.',
        });
      }

      await db.withTransaction
        ? await db.withTransaction(req.user && req.user.id, req.sessionId, async (client) => {
            await client.query(
              `DELETE FROM role_permissions WHERE role = $1`,
              [role],
            );

            if (permissions.length) {
              const permissionRows = await client.query(
                `SELECT id, code FROM permissions WHERE code = ANY($1::text[])`,
                [permissions],
              );

              const rows = permissionRows.rows || [];
              const foundCodes = new Set((rows || []).map((r) => r.code));
              const missing = permissions.filter((code) => !foundCodes.has(code));

              if (missing.length) {
                throw createError(400, `Unknown permission(s): ${missing.join(', ')}`);
              }

              for (const permission of permissions) {
                const permRow = rows.find((row) => row.code === permission);
                if (!permRow) continue;

                await client.query(
                  `INSERT INTO role_permissions (role, permission_id) VALUES ($1, $2)`,
                  [role, permRow.id],
                );
              }
            }
          })
        : null;

      res.json({
        role,
        permissions,
        message: 'Role permissions updated successfully.',
      });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // GET /config
  // Returns system config object.
  // --------------------------------------------------------------------------
  router.get('/config', async (req, res, next) => {
    try {
      const config = await fetchSystemConfig();
      res.json({
        config,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // GET /config/:key
  // --------------------------------------------------------------------------
  router.get('/config/:key', async (req, res, next) => {
    try {
      const key = normalizeKeyName(req.params.key);
      const config = await fetchSystemConfig();
      if (!(key in config)) {
        throw createError(404, `Configuration key not found: ${key}`);
      }
      res.json({ key, value: config[key] });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // PUT /config/:key
  // Body: { value: 123 | "string" | true | { ... } }
  // --------------------------------------------------------------------------
  router.put('/config/:key', adminOnly, async (req, res, next) => {
    try {
      const key = normalizeKeyName(req.params.key);
      const value = req.body && 'value' in req.body ? req.body.value : null;

      if (!key) {
        throw createError(400, 'Configuration key is required.');
      }

      if (!db || !db.query) {
        const config = defaultSystemConfig();
        config[key] = value;
        return res.json({
          key,
          value,
          message: 'Configuration updated in-memory only (database not configured).',
        });
      }

      const exists = await tableExists('system_settings');
      if (!exists) {
        const config = defaultSystemConfig();
        config[key] = value;
        return res.json({
          key,
          value,
          message: 'system_settings table not found; in-memory update only.',
        });
      }

      await db.withTransaction
        ? await db.withTransaction(req.user && req.user.id, req.sessionId, async (client) => {
            await client.query(
              `
                INSERT INTO system_settings (key_name, value, updated_by)
                VALUES ($1, $2, $3)
                ON CONFLICT (key_name)
                DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
              `,
              [key, value, req.user && req.user.id],
            );
          })
        : null;

      res.json({ key, value, message: 'Configuration updated successfully.' });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // GET /rates
  // --------------------------------------------------------------------------
  router.get('/rates', async (req, res, next) => {
    try {
      const rates = await fetchRates();
      res.json({
        rates,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // GET /rates/:key
  // --------------------------------------------------------------------------
  router.get('/rates/:key', async (req, res, next) => {
    try {
      const key = normalizeKeyName(req.params.key);
      const rates = await fetchRates();
      if (!(key in rates)) {
        throw createError(404, `Rate key not found: ${key}`);
      }
      res.json({ key, value: rates[key] });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // PUT /rates/:key
  // Body: { value: 2.5 }
  // --------------------------------------------------------------------------
  router.put('/rates/:key', adminOnly, async (req, res, next) => {
    try {
      const key = normalizeKeyName(req.params.key);
      const value = req.body && 'value' in req.body ? req.body.value : null;

      if (!key) {
        throw createError(400, 'Rate key is required.');
      }

      if (!db || !db.query) {
        const rates = defaultRates();
        rates[key] = value;
        return res.json({
          key,
          value,
          message: 'Rate updated in-memory only (database not configured).',
        });
      }

      const exists = await tableExists('loan_rates');
      if (!exists) {
        const rates = defaultRates();
        rates[key] = value;
        return res.json({
          key,
          value,
          message: 'loan_rates table not found; in-memory update only.',
        });
      }

      await db.withTransaction
        ? await db.withTransaction(req.user && req.user.id, req.sessionId, async (client) => {
            await client.query(
              `
                INSERT INTO loan_rates (key_name, value, updated_by)
                VALUES ($1, $2, $3)
                ON CONFLICT (key_name)
                DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
              `,
              [key, value, req.user && req.user.id],
            );
          })
        : null;

      res.json({ key, value, message: 'Rate updated successfully.' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSettingsRouter, defaultRoleAccess, defaultSystemConfig, defaultRates };
