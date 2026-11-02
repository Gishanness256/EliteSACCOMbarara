#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const backupScript = path.join(repoRoot, 'server', 'scripts', 'backup.sh');

function loadEnvFile(filePath, env) {
  if (!filePath || !fs.existsSync(filePath)) return env;

  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key) continue;

    if (!(key in env)) {
      env[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return env;
}

const env = loadEnvFile(path.join(repoRoot, '.env'), { ...process.env });
loadEnvFile(path.join(repoRoot, 'server', '.env'), env);

if (!fs.existsSync(backupScript)) {
  console.error(`Backup script not found: ${backupScript}`);
  console.error('Expected the PostgreSQL backup script under server/scripts/backup.sh.');
  process.exit(1);
}

const result = spawnSync('bash', [backupScript, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error('Failed to start backup script:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
