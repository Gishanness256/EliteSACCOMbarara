'use strict';

const express = require('express');
const { query } = require('../db');

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

async function tableExists(tableName) {
  try {
    const { rows } = await query(
      `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
        LIMIT 1
      `,
      [tableName]
    );

    return Array.isArray(rows) && rows.length > 0;
  } catch (error) {
    return false;
  }
}

async function fetchRolePermissions() {
  try {
    const exists = await tableExists('role_permissions');
    if (!exists) return defaultRoleAccess();

    const { rows } = await query(`
      SELECT rp.role, p.code
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      ORDER BY rp.role, p.code
    `);

    const result = {};
    for (const row of rows || []) {
      const role = String(row.role || '').trim();
      if (!role) continue;
      result[role] = result[role] || [];
      result[role].push(row.code);
    }

    return Object.keys(result).length ? result : defaultRoleAccess();
  } catch (error) {
    return defaultRoleAccess();
  }
}

async function fetchSystemConfig() {
  try {
    const exists = await tableExists('system_settings');
    if (!exists) return defaultSystemConfig();

    const { rows } = await query(
      `SELECT key_name, value FROM system_settings ORDER BY key_name`
    );

    const config = defaultSystemConfig();
    for (const row of rows || []) {
      if (!row || !row.key_name) continue;
      config[row.key_name] = row.value;
    }

    return config;
  } catch (error) {
    return defaultSystemConfig();
  }
}

async function fetchRates() {
  try {
    const exists = await tableExists('loan_rates');
    if (!exists) return defaultRates();

    const { rows } = await query(
      `SELECT key_name, value FROM loan_rates ORDER BY key_name`
    );

    const rates = defaultRates();
    for (const row of rows || []) {
      if (!row || !row.key_name) continue;
      rates[row.key_name] = row.value;
    }

    return rates;
  } catch (error) {
    return defaultRates();
  }
}

function createSettingsController({ authRequired, requireRole }) {
  const router = express.Router();

  router.use(authRequired);

  router.get('/access-levels', async (req, res, next) => {
    try {
      const roles = await fetchRolePermissions();
      return res.json({ roles, updated_at: new Date().toISOString() });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/access-levels/:role', async (req, res, next) => {
    try {
      const role = String(req.params.role || '').trim();
      const roles = await fetchRolePermissions();
      return res.json({
        role,
        permissions: roles[role] || [],
      });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/access-levels/:role', requireRole('Admin'), async (req, res, next) => {
    try {
      const role = String(req.params.role || '').trim();
      const permissions = Array.isArray(req.body?.permissions)
        ? req.body.permissions.map((p) => String(p).trim()).filter(Boolean)
        : [];

      if (!role) {
        return res.status(400).json({ error: 'Role name is required.' });
      }

      const permissionsTableExists = await tableExists('permissions');
      const rolePermissionsTableExists = await tableExists('role_permissions');

      if (!permissionsTableExists || !rolePermissionsTableExists) {
        const roles = defaultRoleAccess();
        roles[role] = permissions;
        return res.json({
          role,
          permissions,
          message: 'No role permission tables found; in-memory update only.',
        });
      }

      const { rows: permissionRows } = await query(
        `SELECT id, code FROM permissions WHERE code = ANY($1::text[])`,
        [permissions]
      );

      const found = new Map((permissionRows || []).map((row) => [row.code, row.id]));
      const missing = permissions.filter((code) => !found.has(code));

      if (missing.length) {
        return res.status(400).json({
          error: `Unknown permission(s): ${missing.join(', ')}`,
        });
      }

      await query(`DELETE FROM role_permissions WHERE role = $1`, [role]);

      for (const permission of permissions) {
        const permissionId = found.get(permission);
        if (!permissionId) continue;

        await query(
          `INSERT INTO role_permissions (role, permission_id) VALUES ($1, $2)`,
          [role, permissionId]
        );
      }

      return res.json({
        role,
        permissions,
        message: 'Role permissions updated successfully.',
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/config', async (req, res, next) => {
    try {
      const config = await fetchSystemConfig();
      return res.json({ config, updated_at: new Date().toISOString() });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/config/:key', async (req, res, next) => {
    try {
      const key = String(req.params.key || '').trim();
      const config = await fetchSystemConfig();

      if (!(key in config)) {
        return res.status(404).json({ error: `Configuration key not found: ${key}` });
      }

      return res.json({ key, value: config[key] });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/config/:key', requireRole('Admin'), async (req, res, next) => {
    try {
      const key = String(req.params.key || '').trim();
      const value = req.body && Object.prototype.hasOwnProperty.call(req.body, 'value')
        ? req.body.value
        : null;

      if (!key) {
        return res.status(400).json({ error: 'Configuration key is required.' });
      }

      const exists = await tableExists('system_settings');
      if (!exists) {
        return res.json({
          key,
          value,
          message: 'system_settings table not found; in-memory update only.',
        });
      }

      await query(
        `
          INSERT INTO system_settings (key_name, value, updated_by)
          VALUES ($1, $2, $3)
          ON CONFLICT (key_name)
          DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
        `,
        [key, value, req.user.id]
      );

      return res.json({ key, value, message: 'Configuration updated successfully.' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/rates', async (req, res, next) => {
    try {
      const rates = await fetchRates();
      return res.json({ rates, updated_at: new Date().toISOString() });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/rates/:key', async (req, res, next) => {
    try {
      const key = String(req.params.key || '').trim();
      const rates = await fetchRates();

      if (!(key in rates)) {
        return res.status(404).json({ error: `Rate key not found: ${key}` });
      }

      return res.json({ key, value: rates[key] });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/rates/:key', requireRole('Admin'), async (req, res, next) => {
    try {
      const key = String(req.params.key || '').trim();
      const value = req.body && Object.prototype.hasOwnProperty.call(req.body, 'value')
        ? req.body.value
        : null;

      if (!key) {
        return res.status(400).json({ error: 'Rate key is required.' });
      }

      const exists = await tableExists('loan_rates');
      if (!exists) {
        return res.json({
          key,
          value,
          message: 'loan_rates table not found; in-memory update only.',
        });
      }

      await query(
        `
          INSERT INTO loan_rates (key_name, value, updated_by)
          VALUES ($1, $2, $3)
          ON CONFLICT (key_name)
          DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
        `,
        [key, value, req.user.id]
      );

      return res.json({ key, value, message: 'Rate updated successfully.' });
    } catch (error) {
      return next(error);
    }
  });

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
      console.error('[settingsController]', error);
    }

    return res.status(status).json(payload);
  });

  return router;
}

module.exports = {
  defaultRoleAccess,
  defaultSystemConfig,
  defaultRates,
  createSettingsController,
};
