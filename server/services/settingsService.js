'use strict';

/**
 * server/services/settingsService.js
 *
 * Reusable settings service for:
 * - role access matrix
 * - system config values
 * - operational rates
 *
 * Intended to support endpoints like:
 *   GET /api/v1/settings/config
 *   PUT /api/v1/settings/config/:key
 *   GET /api/v1/settings/rates
 *   PUT /api/v1/settings/rates/:key
 */

function defaultRoleAccess() {
  return {
    Admin: {
      access: ['all'],
      description: 'System administrator',
    },
    Treasurer: {
      access: ['all'],
      description: 'Treasury and finance administrator',
    },
    'Credit Supervisor': {
      access: ['loans', 'members', 'reports'],
      description: 'Credit oversight and reporting',
    },
    'Credit Officer': {
      access: ['loans', 'members'],
      description: 'Operational lending and member management',
    },
    Member: {
      access: ['profile', 'savings'],
      description: 'Member access',
    },
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

function normalizeKeyValue(row = {}) {
  if (!row) return null;

  return {
    key: row.key ?? null,
    value: row.value ?? null,
    description: row.description ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
    updatedBy: row.updated_by ?? row.updatedBy ?? null,
  };
}

function createSettingsService({ db, logger } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('settingsService: a valid db instance with query() is required');
  }

  const log = (message, meta) => {
    if (logger && typeof logger.info === 'function') {
      logger.info(message, meta || {});
    }
  };

  const hasTable = async (tableName) => {
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

      return rows && rows.length > 0;
    } catch (err) {
      return false;
    }
  };

  const memory = {
    roleAccess: defaultRoleAccess(),
    systemConfig: defaultSystemConfig(),
    rates: defaultRates(),
  };

  const ensureTableSchema = async () => {
    const tables = ['role_access', 'system_config', 'rates'];

    for (const table of tables) {
      if (!(await hasTable(table))) {
        // keep app resilient even before migration/DB setup is complete
        if (table === 'role_access') memory.roleAccess = defaultRoleAccess();
        if (table === 'system_config') memory.systemConfig = defaultSystemConfig();
        if (table === 'rates') memory.rates = defaultRates();
      }
    }
  };

  return {
    async bootstrap() {
      await ensureTableSchema();
      return {
        roleAccess: memory.roleAccess,
        systemConfig: memory.systemConfig,
        rates: memory.rates,
      };
    },

    async getRoleAccess(role = null) {
      await ensureTableSchema();

      if (role) {
        return memory.roleAccess[role] || null;
      }

      return memory.roleAccess;
    },

    async setRoleAccess(role, payload) {
      if (!role) throw new Error('role is required.');

      const next = ensureObject(payload, {});
      memory.roleAccess[role] = {
        ...(memory.roleAccess[role] || {}),
        ...next,
      };

      log('Role access updated', { role, payload: next });

      return memory.roleAccess[role];
    },

    async getSystemConfig(key = null) {
      await ensureTableSchema();

      if (key) {
        return memory.systemConfig[key] ?? null;
      }

      return memory.systemConfig;
    },

    async setSystemConfig(key, value) {
      if (!key) throw new Error('key is required.');

      memory.systemConfig[key] = value;

      log('System config updated', {
        key,
        value,
      });

      return memory.systemConfig[key];
    },

    async getRates(key = null) {
      await ensureTableSchema();

      if (key) {
        return memory.rates[key] ?? null;
      }

      return memory.rates;
    },

    async setRates(key, value) {
      if (!key) throw new Error('key is required.');

      memory.rates[key] = value;

      log('Rate updated', {
        key,
        value,
      });

      return memory.rates[key];
    },

    async getSettingGroup(groupName) {
      await ensureTableSchema();

      if (groupName === 'role_access') return this.getRoleAccess();
      if (groupName === 'system_config') return this.getSystemConfig();
      if (groupName === 'rates') return this.getRates();

      return null;
    },

    async upsertKeyValue({ table, key, value, description = null, updatedBy = null }) {
      if (!table || !key) {
        throw new Error('table and key are required.');
      }

      // This is a safe in-memory fallback implementation for early bootstrapping.
      // You can later replace it with a real table-backed insert/update if needed.
      if (table === 'system_config') {
        return this.setSystemConfig(key, value);
      }

      if (table === 'rates') {
        return this.setRates(key, value);
      }

      if (table === 'role_access') {
        return this.setRoleAccess(key, value);
      }

      return null;
    },

    async listKeyValues(tableName) {
      await ensureTableSchema();

      if (tableName === 'system_config') return this.getSystemConfig();
      if (tableName === 'rates') return this.getRates();
      if (tableName === 'role_access') return this.getRoleAccess();

      return {};
    },
  };
}

module.exports = createSettingsService;
module.exports.createSettingsService = createSettingsService;
module.exports.defaultRoleAccess = defaultRoleAccess;
module.exports.defaultSystemConfig = defaultSystemConfig;
module.exports.defaultRates = defaultRates;
