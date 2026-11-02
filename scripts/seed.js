#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const repoRoot = path.resolve(__dirname, '..');
const envFiles = [
  path.join(repoRoot, '.env'),
  path.join(repoRoot, 'server', '.env'),
];

function loadEnvFiles() {
  const env = { ...process.env };

  for (const file of envFiles) {
    if (!fs.existsSync(file)) continue;

    const content = fs.readFileSync(file, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const idx = line.indexOf('=');
      if (idx === -1) continue;

      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      env[key] ??= value;
    }
  }

  return env;
}

function getPoolConfig() {
  const env = loadEnvFiles();

  if (env.DATABASE_URL) {
    return {
      connectionString: env.DATABASE_URL,
      ssl:
        env.PGSSLMODE && env.PGSSLMODE !== 'disable'
          ? { rejectUnauthorized: false }
          : false,
      application_name: 'elite-sacco-seed',
    };
  }

  return {
    host: env.PGHOST || 'localhost',
    port: Number.parseInt(env.PGPORT || '5432', 10),
    database: env.PGDATABASE || 'elite_sacco',
    user: env.PGUSER || 'sacco',
    password: env.PGPASSWORD || 'sacco',
    ssl:
      env.PGSSLMODE && env.PGSSLMODE !== 'disable'
        ? { rejectUnauthorized: false }
        : false,
    application_name: 'elite-sacco-seed',
  };
}

async function tableExists(pool, tableName) {
  const result = await pool.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
    `,
    [tableName]
  );

  return result.rowCount > 0;
}

async function ensureAdminUser(pool) {
  const adminEmail = 'admin@elitesacco.co.ug';
  const adminUsername = 'admin';

  const tables = ['users', 'user_accounts', 'staff', 'account_users'];

  for (const table of tables) {
    if (!(await tableExists(pool, table))) continue;

    const current = await pool.query(
      `SELECT id FROM ${table} WHERE email = $1 OR username = $2 LIMIT 1`,
      [adminEmail, adminUsername]
    );

    if (current.rowCount > 0) {
      console.log(`Seed: admin user already exists in ${table}.`);
      return;
    }

    const passwordHash = bcrypt.hashSync('Admin123!', 10);
    const createdAt = new Date().toISOString();

    try {
      await pool.query(
        `
          INSERT INTO ${table} (
            username,
            email,
            password_hash,
            password,
            role,
            is_active,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          adminUsername,
          adminEmail,
          passwordHash,
          passwordHash,
          'admin',
          true,
          createdAt,
        ]
      );

      console.log(`Seed: admin account inserted into ${table}.`);
      return;
    } catch (error) {
      // Some schemas use different column names or a different auth model.
      // Try the common password field variations below.
      try {
        await pool.query(
          `
            INSERT INTO ${table} (
              username,
              email,
              password_hash,
              role,
              status,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            adminUsername,
            adminEmail,
            passwordHash,
            'admin',
            'active',
            createdAt,
          ]
        );

        console.log(`Seed: admin account inserted into ${table}.`);
        return;
      } catch (innerError) {
        // Keep iterating to other candidate tables; do not fail hard here.
        console.warn(
          `Seed: could not insert admin into ${table}: ${innerError.message}`
        );
      }
    }
  }

  console.log(
    'Seed: no supported user table found. Skipped admin seed. ' +
      'This is expected if the schema is not yet created.'
  );
}

async function ensureDefaultBranch(pool) {
  const tables = ['branches', 'branch_offices', 'locations'];

  for (const table of tables) {
    if (!(await tableExists(pool, table))) continue;

    const row = await pool.query(
      `SELECT id FROM ${table} WHERE name = $1 LIMIT 1`,
      ['Head Office']
    );

    if (row.rowCount > 0) {
      console.log(`Seed: default branch already exists in ${table}.`);
      return;
    }

    try {
      await pool.query(
        `
          INSERT INTO ${table} (
            name,
            code,
            is_active,
            created_at
          )
          VALUES ($1, $2, $3, $4)
        `,
        ['Head Office', 'HO', true, new Date().toISOString()]
      );

      console.log(`Seed: default branch inserted into ${table}.`);
      return;
    } catch (error) {
      try {
        await pool.query(
          `
            INSERT INTO ${table} (
              name,
              code,
              created_at
            )
            VALUES ($1, $2, $3)
          `,
          ['Head Office', 'HO', new Date().toISOString()]
        );

        console.log(`Seed: default branch inserted into ${table}.`);
        return;
      } catch (innerError) {
        console.warn(
          `Seed: could not insert default branch into ${table}: ${innerError.message}`
        );
      }
    }
  }

  console.log('Seed: no supported branch table found. Skipped branch seed.');
}

async function ensureSettings(pool) {
  const tables = ['settings', 'system_settings', 'sacco_settings', 'config'];

  for (const table of tables) {
    if (!(await tableExists(pool, table))) continue;

    const row = await pool.query(
      `SELECT id FROM ${table} WHERE key_name = $1 OR key = $1 LIMIT 1`,
      ['company_name']
    );

    if (row.rowCount > 0) {
      console.log(`Seed: default settings already exist in ${table}.`);
      return;
    }

    try {
      await pool.query(
        `
          INSERT INTO ${table} (
            key_name,
            value,
            created_at
          )
          VALUES ($1, $2, $3)
        `,
        ['company_name', 'Elite SACCO Mbarara', new Date().toISOString()]
      );

      console.log(`Seed: default settings inserted into ${table}.`);
      return;
    } catch (error) {
      try {
        await pool.query(
          `
            INSERT INTO ${table} (
              key,
              value,
              created_at
            )
            VALUES ($1, $2, $3)
          `,
          ['company_name', 'Elite SACCO Mbarara', new Date().toISOString()]
        );

        console.log(`Seed: default settings inserted into ${table}.`);
        return;
      } catch (innerError) {
        console.warn(
          `Seed: could not insert default settings into ${table}: ${innerError.message}`
        );
      }
    }
  }

  console.log('Seed: no supported settings table found. Skipped settings seed.');
}

async function main() {
  const pool = new Pool(getPoolConfig());

  try {
    console.log('Seed: connecting to database...');

    await pool.query('SELECT 1');
    console.log('Seed: database connection ok.');

    await ensureAdminUser(pool);
    await ensureDefaultBranch(pool);
    await ensureSettings(pool);

    console.log('Seed: completed successfully.');
  } catch (error) {
    console.error('Seed failed.');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
