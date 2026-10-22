'use strict';

/**
 * ============================================================================
 * Elite SACCO Mbarara — PostgreSQL connection pool
 * ----------------------------------------------------------------------------
 * Single, shared pg.Pool instance for the entire application.
 *
 * Responsibilities:
 *   - Build the connection config from DATABASE_URL or individual PG* env vars
 *   - Tune pool size, idle / connection timeouts, statement_timeout
 *   - Emit structured log lines for pool errors, slow queries, connection
 *     exhaustion (so we can spot DB pressure before it becomes an outage)
 *   - Provide a `query()` helper for one-shot reads
 *   - Provide a `withTransaction()` helper that:
 *       * acquires a client from the pool
 *       * BEGINs
 *       * sets the app.current_user_id and app.session_id session GUCs so the
 *         audit_table_trigger() from 004_audit.sql attributes every row change
 *         to the acting user
 *       * COMMITs on success / ROLLBACKs on error
 *       * always releases the client
 *   - Provide a `withClient()` helper for multi-statement reads outside a
 *     transaction (shares a single connection)
 *   - Health-check helper for /health and k8s readiness probes
 *   - Graceful drain for SIGTERM / SIGINT
 *
 * Usage:
 *   const db = require('./db/pool');
 *   const { rows } = await db.query('SELECT NOW()');
 *   const result = await db.withTransaction(userId, sessionId, async (client) => {
 *     const { rows } = await client.query('INSERT INTO ... RETURNING *', [...]);
 *     return rows[0];
 *   });
 *   const ok = await db.ping();
 *   await db.drain();
 * ============================================================================
 */

const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Load env (server.js also loads dotenv, but we want this module to be
// self-sufficient when imported in isolation — e.g. by migration scripts).
// ---------------------------------------------------------------------------
try {
  require('dotenv').config();
} catch {
  // dotenv not installed (e.g. in tests) — assume env is already set
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
// Use winston if available (server.js provides one), otherwise fall back to
// console so this module works standalone in scripts and tests.
let logger;
try {
  logger = require('winston').createLogger({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    format: require('winston').format.combine(
      require('winston').format.timestamp(),
      require('winston').format.errors({ stack: true }),
      require('winston').format.splat(),
      require('winston').format.json(),
    ),
    defaultMeta: { service: 'elite-sacco-db' },
    transports: [new (require('winston').transports.Console)()],
  });
} catch {
  // Minimal console fallback
  const lvl = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const shouldLog = (l) => ['error','warn','info','debug'].indexOf(lvl) >= ['error','warn','info','debug'].indexOf(l);
  logger = {
    error: (msg, meta) => shouldLog('error') && console.error('[db:ERROR]', msg, meta || ''),
    warn:  (msg, meta) => shouldLog('warn')  && console.warn('[db:WARN] ', msg, meta || ''),
    info:  (msg, meta) => shouldLog('info')  && console.log('[db:INFO] ', msg, meta || ''),
    debug: (msg, meta) => shouldLog('debug') && console.log('[db:DBG]  ', msg, meta || ''),
  };
}

// ---------------------------------------------------------------------------
// Build the pg connection config
// ---------------------------------------------------------------------------
function buildConfig() {
  const connectionString = process.env.DATABASE_URL || null;

  // If DATABASE_URL is provided, it takes precedence. Individual PG* vars
  // are still honored for SSL and pool tuning.
  const base = connectionString
    ? { connectionString }
    : {
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5432', 10),
        database: process.env.PGDATABASE || 'elite_sacco',
        user: process.env.PGUSER || 'sacco',
        password: process.env.PGPASSWORD || 'sacco',
      };

  // SSL — driven by PGSSLMODE (matches libpq convention)
  //   disable         → no SSL
  //   prefer          → SSL if available (we map to: try SSL, fall back)
  //   require         → SSL, don't verify cert
  //   verify-ca       → SSL, verify cert
  //   verify-full     → SSL, verify cert + hostname
  const sslmode = (process.env.PGSSLMODE || 'disable').toLowerCase();
  let ssl = false;
  if (sslmode === 'require') ssl = { rejectUnauthorized: false };
  else if (sslmode === 'verify-ca') ssl = { rejectUnauthorized: true };
  else if (sslmode === 'verify-full') ssl = { rejectUnauthorized: true, ca: process.env.PGSSLROOTCERT || undefined };
  else if (sslmode === 'prefer') ssl = { rejectUnauthorized: false };
  // disable or unknown → false

  return {
    ...base,
    ssl,
    // Pool tuning
    max: parseInt(process.env.PGPOOL_MAX || '20', 10),
    idleTimeoutMillis: parseInt(process.env.PGPOOL_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PGPOOL_CONNECTION_TIMEOUT_MS || '5000', 10),
    // pg default is no statement timeout — we set one to prevent runaway
    // queries from holding pool connections indefinitely. Override via env.
    statement_timeout: parseInt(process.env.PGSTATEMENT_TIMEOUT_MS || '30000', 10),
    query_timeout: parseInt(process.env.PGQUERY_TIMEOUT_MS || '30000', 10),
    // Keep frequently-used prepared statements across connections
    // (saves ~1ms per query, but disables pgBouncer transaction mode —
    // leave at default true for direct connections).
    prepare: process.env.PGPREPARE !== 'false',
    application_name: process.env.PGAPPNAME || 'elite-sacco-api',
  };
}

const config = buildConfig();

logger.info('PostgreSQL pool config', {
  host: config.host || '(from DATABASE_URL)',
  port: config.port || 5432,
  database: config.database || '(from DATABASE_URL)',
  user: config.user || '(from DATABASE_URL)',
  ssl: config.ssl ? `mode=${process.env.PGSSLMODE}` : 'disabled',
  pool_max: config.max,
  idle_timeout_ms: config.idleTimeoutMillis,
  connection_timeout_ms: config.connectionTimeoutMillis,
  statement_timeout_ms: config.statement_timeout,
});

// ---------------------------------------------------------------------------
// Create the pool
// ---------------------------------------------------------------------------
const pool = new Pool(config);

// Track pool stats for observability
const stats = {
  totalQueries: 0,
  slowQueries: 0,
  errors: 0,
  transactions: 0,
  transactionsRolledBack: 0,
  startedAt: new Date(),
};

// ---------------------------------------------------------------------------
// Pool event handlers
// ---------------------------------------------------------------------------
pool.on('error', (err, client) => {
  // Fired when an idle client in the pool emits an error — typically a
  // network drop or the server killing the connection.
  stats.errors++;
  logger.error('Idle PostgreSQL client error', {
    error: err.message,
    code: err.code,
    stack: err.stack,
  });
  // The pool will internally destroy this client and create a new one.
  // No action needed, but we surface the event for monitoring.
});

pool.on('connect', (client) => {
  // New client connected to the pool
  logger.debug('New pool client connected', {
    total_count: pool.totalCount,
    idle_count: pool.idleCount,
    waiting_count: pool.waitingCount,
  });
});

pool.on('acquire', (client) => {
  // Existing client checked out of the pool for a query
  logger.debug('Pool client acquired', {
    total_count: pool.totalCount,
    idle_count: pool.idleCount,
    waiting_count: pool.waitingCount,
  });
});

pool.on('release', (client) => {
  // Client returned to the pool
  logger.debug('Pool client released', {
    total_count: pool.totalCount,
    idle_count: pool.idleCount,
    waiting_count: pool.waitingCount,
  });
});

pool.on('remove', (client) => {
  // Client removed from the pool (will be replaced)
  logger.debug('Pool client removed', {
    total_count: pool.totalCount,
  });
});

// ---------------------------------------------------------------------------
// query() — one-shot helper for reads / parameterized statements
// ---------------------------------------------------------------------------
// Mirrors the standard pg pool.query API, but adds:
//   - query count + slow-query detection
//   - structured error logging with the SQL (truncated) for debugging
//
// For INSERT/UPDATE/DELETE that should be audited, use withTransaction()
// instead so the audit_table_trigger has the session GUCs set.
async function query(text, params = [], options = {}) {
  const start = Date.now();
  const slowThreshold = parseInt(process.env.PG_SLOW_QUERY_MS || '500', 10);
  stats.totalQueries++;

  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (duration > slowThreshold) {
      stats.slowQueries++;
      logger.warn('Slow query', {
        duration_ms: duration,
        threshold_ms: slowThreshold,
        sql: text.length > 200 ? text.slice(0, 200) + '...' : text,
        param_count: Array.isArray(params) ? params.length : 0,
        row_count: result.rowCount,
      });
    } else {
      logger.debug('Query OK', {
        duration_ms: duration,
        sql: text.length > 100 ? text.slice(0, 100) + '...' : text,
        row_count: result.rowCount,
      });
    }

    return result;
  } catch (err) {
    stats.errors++;
    const duration = Date.now() - start;
    logger.error('Query failed', {
      duration_ms: duration,
      error: err.message,
      code: err.code,
      detail: err.detail,
      constraint: err.constraint,
      sql: text.length > 300 ? text.slice(0, 300) + '...' : text,
      param_count: Array.isArray(params) ? params.length : 0,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// withClient() — borrow a single client for multiple sequential reads
// ---------------------------------------------------------------------------
// Use this when you need to run several SELECTs and want to share a
// connection (saving pool checkout overhead) but don't need a transaction.
//
//   const rows = await db.withClient(async (client) => {
//     const a = await client.query('SELECT ...');
//     const b = await client.query('SELECT ...');
//     return { a: a.rows, b: b.rows };
//   });
//
async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// withTransaction() — BEGIN / COMMIT / ROLLBACK with audit GUCs
// ---------------------------------------------------------------------------
// Sets app.current_user_id and app.session_id session GUCs on the client
// BEFORE BEGIN so every INSERT/UPDATE/DELETE that fires an audit trigger
// (from 004_audit.sql) is attributed to the acting user.
//
//   const result = await db.withTransaction(req.user.id, req.sessionId, async (client) => {
//     const { rows } = await client.query(
//       'INSERT INTO members (...) VALUES (...) RETURNING *',
//       [...]
//     );
//     return rows[0];
//   });
//
async function withTransaction(userId, sessionId, fn) {
  const client = await pool.connect();
  let committed = false;
  stats.transactions++;

  try {
    // Set session GUCs BEFORE BEGIN so they apply to the whole transaction
    // and any triggers that fire within it. Using SET LOCAL keeps the
    // settings scoped to this transaction only — they revert on COMMIT/ROLLBACK.
    if (userId != null) {
      await client.query('SET LOCAL app.current_user_id = $1', [String(userId)]);
    } else {
      await client.query("SET LOCAL app.current_user_id = ''");
    }
    if (sessionId) {
      await client.query('SET LOCAL app.session_id = $1', [sessionId]);
    } else {
      await client.query("SET LOCAL app.session_id = ''");
    }

    await client.query('BEGIN');

    const result = await fn(client);

    await client.query('COMMIT');
    committed = true;

    return result;
  } catch (err) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('ROLLBACK failed', {
          original_error: err.message,
          rollback_error: rollbackErr.message,
        });
      }
      stats.transactionsRolledBack++;
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// ping() — lightweight health check
// ---------------------------------------------------------------------------
// Returns true if the pool can successfully SELECT 1 from the server.
// Used by /health and k8s readiness probes.
async function ping() {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return rows.length === 1 && rows[0].ok === 1;
  } catch (err) {
    logger.warn('DB ping failed', { error: err.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// healthCheck() — detailed health info
// ---------------------------------------------------------------------------
// Returns connection pool metrics + DB server info for /health endpoint.
async function healthCheck() {
  const start = Date.now();
  try {
    const { rows } = await pool.query('SELECT NOW() AS now, version() AS version');
    return {
      connected: true,
      server_time: rows[0].now,
      server_version: rows[0].version.split(' ').slice(0, 2).join(' '),
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: config.max,
      },
      stats: {
        ...stats,
        uptime_ms: Date.now() - stats.startedAt.getTime(),
      },
      response_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
      code: err.code,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: config.max,
      },
      stats: {
        ...stats,
        uptime_ms: Date.now() - stats.startedAt.getTime(),
      },
      response_ms: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// drain() — graceful shutdown
// ---------------------------------------------------------------------------
// Stops accepting new queries, waits for in-flight queries to finish,
// then closes all pool connections. Call this on SIGTERM / SIGINT.
// Returns after the pool is fully closed.
async function drain(timeoutMs = 30000) {
  logger.info('Draining PostgreSQL pool', {
    total_count: pool.totalCount,
    idle_count: pool.idleCount,
    waiting_count: pool.waitingCount,
    timeout_ms: timeoutMs,
  });

  // Force-close after the timeout — pool.end() can hang if a client is stuck
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    logger.error('Pool drain timed out, forcing close', { timeout_ms: timeoutMs });
    // pg Pool doesn't expose a force-kill, but calling end() again is safe
    pool.end().catch(() => {});
  }, timeoutMs);

  try {
    await pool.end();
  } finally {
    clearTimeout(timer);
  }

  logger.info('PostgreSQL pool drained', { timed_out: timedOut });
}

// ---------------------------------------------------------------------------
// getStats() — return a snapshot of pool stats
// ---------------------------------------------------------------------------
function getStats() {
  return {
    ...stats,
    pool_total: pool.totalCount,
    pool_idle: pool.idleCount,
    pool_waiting: pool.waitingCount,
    pool_max: config.max,
    uptime_ms: Date.now() - stats.startedAt.getTime(),
  };
}

// ---------------------------------------------------------------------------
// getConfig() — return the (redacted) config for debugging
// ---------------------------------------------------------------------------
function getConfig() {
  return {
    host: config.host || '(from DATABASE_URL)',
    port: config.port || 5432,
    database: config.database || '(from DATABASE_URL)',
    user: config.user || '(from DATABASE_URL)',
    password: '***redacted***',
    ssl: config.ssl ? 'enabled' : 'disabled',
    pool_max: config.max,
    idle_timeout_ms: config.idleTimeoutMillis,
    connection_timeout_ms: config.connectionTimeoutMillis,
    statement_timeout_ms: config.statement_timeout,
    query_timeout_ms: config.query_timeout,
    prepare: config.prepare,
    application_name: config.application_name,
  };
}

// ---------------------------------------------------------------------------
// Reset stats (useful for tests)
// ---------------------------------------------------------------------------
function resetStats() {
  stats.totalQueries = 0;
  stats.slowQueries = 0;
  stats.errors = 0;
  stats.transactions = 0;
  stats.transactionsRolledBack = 0;
  stats.startedAt = new Date();
}

// ---------------------------------------------------------------------------
// Export the module API
// ---------------------------------------------------------------------------
module.exports = {
  // The raw pool — exposed for advanced use cases (e.g. pg-native direct access).
  // Prefer using query() / withClient() / withTransaction() instead.
  pool,

  // Query helpers
  query,
  withClient,
  withTransaction,

  // Health & stats
  ping,
  healthCheck,
  getStats,
  getConfig,
  resetStats,

  // Lifecycle
  drain,

  // Config (for tests / inspection)
  _config: config,
  _logger: logger,
};
