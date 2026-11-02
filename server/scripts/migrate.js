#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const ENV_FILES = [
  path.join(repoRoot, '.env'),
  path.join(repoRoot, 'server', '.env'),
];

function loadEnvFiles() {
  const env = { ...process.env };

  for (const envFile of ENV_FILES) {
    if (!fs.existsSync(envFile)) continue;

    const raw = fs.readFileSync(envFile, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex === -1) continue;

      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();

      if (!key) continue;

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!(key in env)) {
        env[key] = value;
      }
    }
  }

  return env;
}

function printHelp() {
  console.log(`Elite SACCO Mbarara migration tool

Usage: node scripts/migrate.js <command> [options]

Commands:
  up                Apply all pending migrations
  down              Roll back the most recent migration
  status            Show migration status
  verify            Check migration table and file integrity
  create <name>     Create a new timestamped migration stub
  help              Show this help

Environment:
  DATABASE_URL or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
  Optional: PGSSLMODE

Examples:
  node scripts/migrate.js up
  node scripts/migrate.js status
  node scripts/migrate.js create add_member_indexes
`);
}

function getConnectionConfig(env) {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }

  const host = env.PGHOST || 'localhost';
  const port = env.PGPORT || '5432';
  const database = env.PGDATABASE || 'elite_sacco';
  const user = env.PGUSER || 'sacco';
  const password = env.PGPASSWORD || 'sacco';

  return {
    host,
    port: Number.parseInt(port, 10),
    database,
    user,
    password,
    ssl:
      env.PGSSLMODE && env.PGSSLMODE !== 'disable'
        ? { rejectUnauthorized: false }
        : false,
    application_name: 'elite-sacco-migrate',
  };
}

function resolveMigrationsDir() {
  const candidates = [
    path.join(repoRoot, 'database', 'migrations'),
    path.join(repoRoot, 'server', 'migrations'),
    path.join(repoRoot, 'migrations'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    'No migration directory found. Expected one of: database/migrations, server/migrations, or migrations'
  );
}

function listMigrationFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

async function withClient(command, fn) {
  const env = loadEnvFiles();

  let pg;
  try {
    pg = (await import('pg')).default ?? (await import('pg'));
  } catch (error) {
    console.error(
      'Missing PostgreSQL client dependency. Install dependencies for the server project first.'
    );
    console.error('Try: npm install --prefix server');
    throw error;
  }

  const { Client } = pg;
  const connectionConfig = getConnectionConfig(env);
  const client = new Client(connectionConfig);

  try {
    await client.connect();
    const result = await fn(client, env);
    return result;
  } finally {
    await client.end();
  }
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      migration TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function readSqlFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function checksum(content) {
  return Buffer.from(content).toString('hex');
}

async function migrationStatus() {
  const dir = resolveMigrationsDir();
  const files = listMigrationFiles(dir);

  const rows = await withClient('status', async (client) => {
    await ensureMigrationTable(client);
    const result = await client.query(
      'SELECT migration, checksum, applied_at FROM schema_migrations ORDER BY migration ASC'
    );
    const applied = new Map(result.rows.map((row) => [row.migration, row]));

    return files.map((file) => {
      const sql = readSqlFile(path.join(dir, file));
      const appliedRow = applied.get(file);
      return {
        migration: file,
        applied: Boolean(appliedRow),
        checksum: checksum(sql),
        storedChecksum: appliedRow ? appliedRow.checksum : null,
        appliedAt: appliedRow ? appliedRow.applied_at : null,
      };
    });
  });

  if (!rows.length) {
    console.log('No migration files found.');
    return 0;
  }

  const appliedCount = rows.filter((row) => row.applied).length;
  const pendingCount = rows.length - appliedCount;

  console.log(`Migrations directory: ${dir}`);
  console.log(`Total: ${rows.length} | Applied: ${appliedCount} | Pending: ${pendingCount}`);

  for (const row of rows) {
    const statusText = row.applied ? 'APPLIED' : 'PENDING';
    console.log(`${statusText.padEnd(8)} ${row.migration}`);
  }

  return pendingCount === 0 ? 0 : 1;
}

async function runMigrations() {
  const dir = resolveMigrationsDir();
  const files = listMigrationFiles(dir);

  if (!files.length) {
    console.log('No migration files found.');
    return 0;
  }

  await withClient('up', async (client) => {
    await ensureMigrationTable(client);

    for (const file of files) {
      const fullPath = path.join(dir, file);
      const sql = readSqlFile(fullPath);
      const migrationName = file;

      const exists = await client.query(
        'SELECT 1 FROM schema_migrations WHERE migration = $1',
        [migrationName]
      );

      if (exists.rowCount > 0) continue;

      console.log(`Applying ${migrationName}...`);

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (migration, checksum) VALUES ($1, $2)',
          [migrationName, checksum(sql)]
        );
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError.message);
        }

        console.error(`Migration failed while applying ${migrationName}`);
        console.error(error.message);
        throw error;
      }
    }
  });

  console.log('All pending migrations applied.');
  return 0;
}

async function rollbackLastMigration() {
  const dir = resolveMigrationsDir();
  const files = listMigrationFiles(dir);

  const result = await withClient('down', async (client) => {
    await ensureMigrationTable(client);

    const applied = await client.query(
      'SELECT migration FROM schema_migrations ORDER BY id DESC LIMIT 1'
    );

    if (applied.rowCount === 0) {
      console.log('No migrations have been applied.');
      return 0;
    }

    const migration = applied.rows[0].migration;
    const filePath = path.join(dir, migration);

    if (!fs.existsSync(filePath)) {
      console.warn(`Migration file not found for rollback: ${migration}`);
      console.warn('The migration will remain recorded in schema_migrations.');
      return 1;
    }

    const downFile = filePath.replace(/\.sql$/, '.down.sql');

    if (!fs.existsSync(downFile)) {
      console.log(
        `No rollback SQL found for ${migration}; skipping delete from migration log.`
      );
      return 2;
    }

    console.log(`Rolling back ${migration}...`);

    try {
      await client.query('BEGIN');
      await client.query(readSqlFile(downFile));
      await client.query('DELETE FROM schema_migrations WHERE migration = $1', [
        migration,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError.message);
      }

      console.error(`Rollback failed for ${migration}`);
      console.error(error.message);
      throw error;
    }

    return 0;
  });

  if (result === 2) {
    console.log('Rollback skipped because no .down.sql file exists for the latest migration.');
  }

  return result;
}

async function verifyMigrations() {
  const dir = resolveMigrationsDir();
  const files = listMigrationFiles(dir);

  if (!files.length) {
    console.log('No migration files found.');
    return 0;
  }

  await withClient('verify', async (client) => {
    await ensureMigrationTable(client);

    const stored = await client.query(
      'SELECT migration, checksum FROM schema_migrations ORDER BY migration ASC'
    );
    const storedMap = new Map(stored.rows.map((row) => [row.migration, row.checksum]));

    for (const file of files) {
      const filePath = path.join(dir, file);
      const sql = readSqlFile(filePath);
      const expected = checksum(sql);
      const storedChecksum = storedMap.get(file);

      if (storedChecksum && storedChecksum !== expected) {
        throw new Error(
          `Checksum mismatch for ${file}: database has ${storedChecksum}, file has ${expected}`
        );
      }
    }

    for (const [migration] of storedMap.entries()) {
      if (!files.includes(migration)) {
        throw new Error(
          `Migration ${migration} exists in schema_migrations but no longer has a SQL file.`
        );
      }
    }
  });

  console.log('Migration files and schema_migrations checksums match.');
  return 0;
}

function ensureMigrationTemplate(name) {
  const dir = resolveMigrationsDir();
  const safeName = name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  if (!safeName) {
    throw new Error('Migration name is required and must contain valid characters.');
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

  const fileName = `${timestamp}_${safeName}.sql`;
  const filePath = path.join(dir, fileName);

  if (fs.existsSync(filePath)) {
    throw new Error(`Migration file already exists: ${fileName}`);
  }

  const stub = `-- ${fileName}
-- Description: Add migration here

BEGIN;

-- Write migration SQL here.

COMMIT;
`;

  fs.writeFileSync(filePath, stub, 'utf8');
  console.log(`Created migration: ${filePath}`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'up';

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  if (command === 'create') {
    const name = args[1];
    if (!name) {
      console.error('Usage: node scripts/migrate.js create <migration-name>');
      return 1;
    }

    try {
      return ensureMigrationTemplate(name);
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }

  try {
    switch (command) {
      case 'up':
        return await runMigrations();
      case 'down':
        return await rollbackLastMigration();
      case 'status':
        return await migrationStatus();
      case 'verify':
        return await verifyMigrations();
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        return 1;
    }
  } catch (error) {
    console.error('Migration command failed.');
    console.error(error.message);
    return 1;
  }
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
