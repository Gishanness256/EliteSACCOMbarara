'use strict';

/**
 * ============================================================================
 * Elite SACCO Mbarara — API server entry point
 * ----------------------------------------------------------------------------
 * Wires together:
 *   - PostgreSQL connection pool (pg) → tables from 001–004 migrations
 *   - Per-request audit context (sets app.current_user_id / app.session_id
 *     session GUCs so the audit_table_trigger() in 004_audit.sql attributes
 *     every row change to the acting user)
 *   - JWT authentication middleware
 *   - Helmet + CORS + rate-limit hardening
 *   - Winston structured logging
 *   - Health, auth, users, members, savings, loans, regulatory, audit routes
 *   - Graceful shutdown on SIGTERM / SIGINT
 * ============================================================================
 */

// express-async-errors must be required before any route is registered so
// unhandled async rejections are forwarded to Express's error handler.
require('express-async-errors');

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// --- Config --------------------------------------------------------------
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  db: {
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'elite_sacco',
    user: process.env.PGUSER || 'sacco',
    password: process.env.PGPASSWORD || 'sacco',
    ssl: process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable'
      ? { rejectUnauthorized: process.env.PGSSLMODE === 'verify-full' }
      : false,
    max: parseInt(process.env.PGPOOL_MAX || '20', 10),
    idleTimeoutMillis: parseInt(process.env.PGPOOL_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PGPOOL_CONNECTION_TIMEOUT_MS || '5000', 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  cors: {
    origins: (process.env.CORS_ORIGIN || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '300', 10),
  },
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
  uploadDir: process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads'),
};

// Fail fast in production if JWT_SECRET is the dev default
if (config.env === 'production' && config.jwt.secret.startsWith('dev-only-')) {
  console.error('FATAL: JWT_SECRET must be set to a strong random value in production.');
  process.exit(1);
}

// --- Logger --------------------------------------------------------------
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const logDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
  ),
  defaultMeta: { service: 'elite-sacco-api' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) => {
          const { timestamp, level, message, ...meta } = info;
          const metaStr = Object.keys(meta).length && meta.service
            ? ` ${JSON.stringify({ ...meta, service: undefined })}`
            : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        }),
      ),
    }),
    new DailyRotateFile({
      filename: path.join(logDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      zippedArchive: true,
    }),
    new DailyRotateFile({
      level: 'error',
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '90d',
      zippedArchive: true,
    }),
  ],
  exitOnError: false,
});

// --- Database pool -------------------------------------------------------
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: config.db.connectionString,
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  ssl: config.db.ssl,
  max: config.db.max,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message, stack: err.stack });
});

/**
 * Run a function inside a transaction. The callback receives a pg Client
 * with app.current_user_id and app.session_id GUCs set, so every INSERT/
 * UPDATE/DELETE that fires an audit trigger will be attributed correctly.
 */
async function withTransaction(userId, sessionId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId != null) {
      await client.query("SET LOCAL app.current_user_id = $1", [String(userId)]);
    }
    if (sessionId) {
      await client.query("SET LOCAL app.session_id = $1", [sessionId]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Simple query helper for non-transactional reads
function query(text, params) {
  return pool.query(text, params);
}

// --- Express app ---------------------------------------------------------
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const rootDir = path.join(__dirname, '..');
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'elite_sacco.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const db = new sqlite3.Database(dbPath);

function ensureDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          address TEXT NOT NULL,
          phone TEXT NOT NULL UNIQUE,
          email TEXT UNIQUE,
          nin TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) return reject(err);

        const adminEmail = 'admin@elitesacco.co.ug';
        const adminPhone = '+256700000000';
        const adminPassword = 'Admin';
        const adminHash = bcrypt.hashSync(adminPassword, 10);

        db.run(
          `INSERT OR IGNORE INTO users
           (first_name, last_name, address, phone, email, nin, password_hash, role)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ['System', 'Admin', 'Head Office', adminPhone, adminEmail, 'NINADMIN000', adminHash, 'Admin'],
          (insertErr) => {
            if (insertErr) return reject(insertErr);
            resolve();
          }

// Trust the first proxy (so req.ip and X-Forwarded-* are honored behind nginx/LB)
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Security & middleware stack ----------------------------------------
app.use(cors({
  origin(origin, cb) {
    // Allow same-origin / curl (no origin) and any whitelisted origin
    if (!origin || config.cors.origins.includes(origin) || config.cors.origins.includes('*')) {
      cb(null, true);
    } else {
      cb(createError(403, `CORS blocked for origin ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Trace-Id'],
  exposedHeaders: ['X-Request-Id', 'X-Trace-Id'],
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// Ensure upload directory exists
if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

// --- Request ID & correlation -------------------------------------------
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || uuidv4();
  req.traceId = req.headers['x-trace-id'] || req.headers['x-amzn-trace-id'] || req.id;
  req.sessionId = req.headers['x-session-id'] || null;
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('X-Trace-Id', req.traceId);
  next();
});

// --- HTTP request logging (morgan → winston) ----------------------------
const morganStream = {
  write: (line) => {
    try {
      const meta = JSON.parse(line);
      logger.info('HTTP request', meta);
    } catch {
      logger.info(line.trim());
    }
  },
};
morgan.token('request-id', (req) => req.id || '-');
morgan.token('trace-id', (req) => req.traceId || '-');
app.use(morgan(
  JSON.stringify({
    method: ':method',
    url: ':url',
    status: ':status',
    duration_ms: ':response-time',
    ip: ':remote-addr',
    referrer: ':referrer',
    request_id: ':request-id',
    trace_id: ':trace-id',
  }),
  { stream: morganStream, skip: (req) => req.path === '/health' },
));

// --- Rate limiting ------------------------------------------------------
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip + (req.user ? `:${req.user.id}` : ''),
  handler: (req, res) => {
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Too many requests from this IP, please try again later.',
      request_id: req.id,
    });
  },
});
app.use('/api', limiter);

// Stricter limiter for auth endpoints (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'too_many_login_attempts',
      message: 'Too many login attempts. Please try again in 15 minutes.',
      request_id: req.id,
    });
  },
});

// --- Auth middleware ----------------------------------------------------
/**
 * Verifies the JWT in the Authorization header (or `token` cookie).
 * On success, attaches `req.user = { id, name, email, role, initials }`.
 */
async function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const cookieToken = req.cookies && req.cookies.token;
    const token = (header.startsWith('Bearer ') ? header.slice(7) : null) || cookieToken;

    if (!token) {
      throw createError(401, 'Authentication required. Provide a Bearer token or token cookie.');
    }

    const payload = jwt.verify(token, config.jwt.secret);

    // Re-fetch the user so role/name changes take effect immediately
    const { rows } = await query(
      `SELECT id, name, email, role::text AS role, initials, is_active
         FROM users
        WHERE id = $1`,
      [payload.sub],
    );

    if (!rows.length || !rows[0].is_active) {
      throw createError(401, 'User account is inactive or no longer exists.');
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return next(createError(401, 'Invalid or expired token. Please log in again.'));
    }
    next(err);
  }
}

/**
 * Checks that the authenticated user holds one of the allowed roles.
 * Usage: router.post('/users', authRequired, requireRole('Admin'), handler);
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(createError(401, 'Authentication required.'));
    if (!roles.includes(req.user.role)) {
      return next(createError(403, `This action requires one of: ${roles.join(', ')}.`));
    }
    next();
  };
}

/**
 * Checks that the user holds a specific permission code (from the
 * role_permissions table seeded in 001_init.sql).
 */
function requirePermission(code) {
  return async (req, res, next) => {
    if (!req.user) return next(createError(401, 'Authentication required.'));
    try {
      const { rows } = await query(
        `SELECT 1
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role = $1::user_role
            AND p.code = $2
          LIMIT 1`,
        [req.user.role, code],
      );
      if (!rows.length) {
        return next(createError(403, `Missing permission: ${code}`));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// --- Audit helper -------------------------------------------------------
/**
 * Writes a single audit_log entry via the log_audit_event() SQL function.
 * Use this for business events not tied to a single table change
 * (login, report generation, bulk imports, etc.).
 */
async function logAuditEvent(client, event) {
  const sql = `SELECT log_audit_event($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10) AS id`;
  const params = [
    event.activity,
    event.particulars || null,
    event.category || 'system',
    event.severity || 'info',
    event.userId || null,
    event.tableName || null,
    event.recordId || null,
    event.sessionId || req.sessionId || null,
    event.ipAddress || null,
    event.userAgent || null,
  ];
  await client.query(sql, params);
}

// --- Routes =============================================================

// Health check (no auth, no rate limit) ---------------------------------
app.get('/health', async (req, res) => {
  const start = Date.now();
  try {
    const { rows } = await query('SELECT NOW() AS db_now, version() AS db_version');
    res.json({
      status: 'ok',
      service: 'elite-sacco-api',
      env: config.env,
      timestamp: new Date().toISOString(),
      db: {
        connected: true,
        server_time: rows[0].db_now,
        version: rows[0].db_version.split(' ').slice(0, 2).join(' '),
      },
      uptime_seconds: Math.round(process.uptime()),
      response_ms: Date.now() - start,
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      service: 'elite-sacco-api',
      error: err.message,
      timestamp: new Date().toISOString(),
      response_ms: Date.now() - start,
    });
  }
});

// Readiness check — verifies migrations are applied --------------------
app.get('/ready', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('users','members','loans','loan_repayments',
                            'savings_transactions','audit_log','regulatory_config')
       ORDER BY table_name
    `);
    const expected = ['audit_log','loans','loan_repayments','members','regulatory_config','savings_transactions','users'];
    const found = rows.map((r) => r.table_name);
    const missing = expected.filter((t) => !found.includes(t));
    if (missing.length) {
      return res.status(503).json({ status: 'not_ready', missing_tables: missing });
    }
    res.json({ status: 'ready', tables: found });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

// --- API v1 router ------------------------------------------------------
const v1 = express.Router();
app.use('/api/v1', v1);

// --- Auth routes --------------------------------------------------------
v1.post('/auth/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw createError(400, 'Email and password are required.');
    }

    const fullEmail = email.includes('@') ? email.toLowerCase() : `${email.toLowerCase()}@elitesacco.co.ug`;

    const { rows } = await query(
      `SELECT id, name, email, role::text AS role, initials, password_hash, is_active
         FROM users
        WHERE LOWER(email) = $1`,
      [fullEmail],
    );

    // Always run the hash compare to avoid timing-based user enumeration
    const bcrypt = require('bcrypt');
    const dummyHash = '$2b$12$abcdefghijklmnopqrstuv';
    const valid = rows.length
      ? await bcrypt.compare(password, rows[0].password_hash || dummyHash)
      : (await bcrypt.compare(password, dummyHash), false);

    if (!rows.length || !valid || !rows[0].is_active) {
      // Log failed attempt (the audit_table_trigger won't fire since no row changed)
      await withTransaction(null, req.sessionId, async (client) => {
        await client.query(
          `SELECT log_audit_event(
            'Failed login',
            $1,
            'authentication'::audit_category,
            'warning'::audit_severity,
            NULL, NULL, NULL, $2, $3::inet, $4)`,
          [
            `Failed sign-in attempt for "${fullEmail}"`,
            req.sessionId,
            req.ip,
            req.headers['user-agent'] || null,
          ],
        );
      });
      throw createError(401, 'Invalid email or password.');
    }

    const user = rows[0];
    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn },
    );

    await withTransaction(user.id, req.sessionId, async (client) => {
      await client.query(
        `SELECT log_audit_event(
          'Login',
          $1,
          'authentication'::audit_category,
          'info'::audit_severity,
          $2, NULL, NULL, $3, $4::inet, $5)`,
        [
          `Signed in as ${user.email} (${user.role})`,
          user.id,
          req.sessionId,
          req.ip,
          req.headers['user-agent'] || null,
        ],
      );
      await client.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    });

    res.cookie('token', token, {
      httpOnly: true,
      secure: config.env === 'production',
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    });

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, initials: user.initials },
    });
  } catch (err) {
    next(err);
  }
});

v1.post('/auth/logout', authRequired, async (req, res, next) => {
  try {
    await withTransaction(req.user.id, req.sessionId, async (client) => {
      await client.query(
        `SELECT log_audit_event(
          'Logout',
          $1,
          'authentication'::audit_category,
          'info'::audit_severity,
          $2, NULL, NULL, $3, NULL, NULL)`,
        [`Signed out (${req.user.email})`, req.user.id, req.sessionId],
      );
    });
    res.clearCookie('token');
    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
});

v1.get('/auth/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

// --- Users routes -------------------------------------------------------
v1.get('/users', authRequired, requirePermission('manage_users'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role::text AS role, initials, is_active,
              created_at, last_login_at
         FROM users
        ORDER BY name`,
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

v1.post('/users', authRequired, requirePermission('manage_users'), async (req, res, next) => {
  try {
    const { name, handle, role, initials, password } = req.body;
    if (!name || !handle || !password) {
      throw createError(400, 'name, handle and password are required.');
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(handle)) {
      throw createError(400, 'handle may contain only letters, numbers, dots, hyphens and underscores.');
    }
    if (password.length < 6) {
      throw createError(400, 'Password must be at least 6 characters.');
    }

    const bcrypt = require('bcrypt');
    const email = `${handle}@elitesacco.co.ug`;
    const hash = await bcrypt.hash(password, config.bcryptRounds);

    const { rows } = await withTransaction(req.user.id, req.sessionId, async (client) => {
      return client.query(
        `INSERT INTO users (name, email, password_hash, role, initials)
         VALUES ($1, $2, $3, $4::user_role, $5)
         RETURNING id, name, email, role::text AS role, initials, created_at`,
        [name, email, hash, role || 'Credit Officer', (initials || '').toUpperCase() || null],
      );
    });

    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return next(createError(409, 'A user with that email already exists.'));
    }
    next(err);
  }
});

v1.delete('/users/:id', authRequired, requirePermission('manage_users'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) {
      throw createError(400, 'You cannot remove your own account.');
    }
    const { rowCount } = await withTransaction(req.user.id, req.sessionId, async (client) => {
      return client.query('UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    });
    if (!rowCount) throw createError(404, 'User not found.');
    res.json({ message: 'User deactivated.', id });
  } catch (err) {
    next(err);
  }
});

// --- Members routes -----------------------------------------------------
v1.get('/members', authRequired, async (req, res, next) => {
  try {
    const { q } = req.query;
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where = `WHERE LOWER(first_name || ' ' || last_name || ' ' || account_number) LIKE $1`;
    }
    const { rows } = await query(
      `SELECT id, account_number, first_name, last_name, gender::text AS gender,
              date_of_birth, telephone, email, nin, address, is_active, created_at
         FROM members
         ${where}
        ORDER BY account_number
        LIMIT 500`,
      params,
    );
    res.json({ members: rows });
  } catch (err) {
    next(err);
  }
});

v1.post('/members', authRequired, requirePermission('manage_members'), async (req, res, next) => {
  try {
    const { first_name, last_name, gender, date_of_birth, telephone, nin, address, email, photo } = req.body;
    if (!first_name || !last_name || !gender || !telephone || !nin) {
      throw createError(400, 'first_name, last_name, gender, telephone and nin are required.');
    }

    const result = await withTransaction(req.user.id, req.sessionId, async (client) => {
      // Atomically get the next account number sequence
      const { rows: seqRows } = await client.query(
        `SELECT COALESCE(MAX(
                  CAST(SUBSTRING(account_number FROM POSITION(' ' IN account_number) + 1) AS INTEGER
              )), 0) + 1 AS next_seq
           FROM members
          WHERE account_number LIKE 'ES-' || $1 || ' %'`,
        [gender],
      );
      const seq = seqRows[0].next_seq;
      const accountNumber = `ES-${gender} ${String(seq).padStart(6, '0')}`;

      const { rows } = await client.query(
        `INSERT INTO members
            (account_number, first_name, last_name, gender, date_of_birth,
             address, nin, telephone, email, photo, created_by)
         VALUES ($1, $2, $3, $4::member_gender, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          accountNumber, first_name, last_name, gender, date_of_birth || null,
          address || null, nin.toUpperCase(), telephone, email || null, photo || null, req.user.id,
        ],
      );
      return rows[0];
    });

    res.status(201).json({ member: result });
  } catch (err) {
    next(err);
  }
});

v1.get('/members/:account', authRequired, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, account_number, first_name, last_name, gender::text AS gender,
              date_of_birth, telephone, email, nin, address, is_active, created_at
         FROM members
        WHERE account_number = $1`,
      [req.params.account],
    );
    if (!rows.length) throw createError(404, 'Member not found.');
    res.json({ member: rows[0] });
  } catch (err) {
    next(err);
  }
});

// --- Savings routes -----------------------------------------------------
v1.get('/savings', authRequired, async (req, res, next) => {
  try {
    const { account, limit = '50' } = req.query;
    const params = [];
    let where = '';
    if (account) {
      params.push(account);
      where = 'WHERE account_number = $1';
    }
    params.push(parseInt(limit, 10));
    const { rows } = await query(
      `SELECT id, reference, account_number, direction::text AS direction,
              amount, occurred_at, channel::text AS channel, slip_number,
              remarks, officer_initials, created_at
         FROM savings_transactions
         ${where}
        ORDER BY occurred_at DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

v1.post('/savings', authRequired, requirePermission('ack_savings'), async (req, res, next) => {
  try {
    const { account_number, direction, amount, occurred_at, channel, slip_number, remarks } = req.body;
    if (!account_number || !direction || !amount || amount <= 0) {
      throw createError(400, 'account_number, direction (Deposit/Withdrawal) and positive amount are required.');
    }

    const result = await withTransaction(req.user.id, req.sessionId, async (client) => {
      // Check balance for withdrawals
      if (direction === 'Withdrawal') {
        const { rows: balRows } = await client.query(
          `SELECT COALESCE(SUM(CASE direction WHEN 'Deposit' THEN amount ELSE -amount END), 0) AS balance
             FROM savings_transactions
            WHERE account_number = $1`,
          [account_number],
        );
        if (parseFloat(balRows[0].balance) < amount) {
          throw createError(400, `Withdrawal exceeds the savings balance (${balRows[0].balance}).`);
        }
      }

      // Generate next reference SV-NNNNNN
      const { rows: seqRows } = await client.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq
           FROM savings_transactions
          WHERE reference LIKE 'SV-%'`,
      );
      const reference = `SV-${String(seqRows[0].next_seq).padStart(6, '0')}`;

      const { rows } = await client.query(
        `INSERT INTO savings_transactions
            (reference, account_number, direction, amount, occurred_at,
             channel, slip_number, remarks, officer_id, officer_initials)
         VALUES ($1, $2, $3::tx_direction, $4, $5, $6::savings_channel, $7, $8, $9, $10)
         RETURNING *`,
        [
          reference, account_number, direction, amount,
          occurred_at ? new Date(occurred_at) : new Date(),
          channel || 'Counter / Cash', slip_number || null, remarks || null,
          req.user.id, req.user.initials,
        ],
      );
      return rows[0];
    });

    res.status(201).json({ transaction: result });
  } catch (err) {
    next(err);
  }
});

// --- Loans routes -------------------------------------------------------
v1.get('/loans', authRequired, async (req, res, next) => {
  try {
    const { status, q, limit = '50' } = req.query;
    const params = [];
    const clauses = [];
    if (status) {
      params.push(status);
      clauses.push(`l.status = $${params.length}::loan_lifecycle_status`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      clauses.push(`(LOWER(l.borrower_name) LIKE $${params.length} OR LOWER(COALESCE(l.account_number,'')) LIKE $${params.length})`);
    }
    params.push(parseInt(limit, 10));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT l.id, l.reference, l.account_number, l.borrower_name, l.telephone,
              l.category, l.term_months, l.principal, l.rate_monthly,
              l.disbursed_on, l.due_date, l.status::text AS status,
              l.monthly_installment, l.total_payable,
              COALESCE((SELECT SUM(amount) FROM loan_repayments r WHERE r.loan_id = l.id), 0) AS total_paid,
              loan_outstanding_balance(l.id, CURRENT_DATE) AS outstanding_balance,
              l.created_at
         FROM loans l
         ${where}
        ORDER BY l.disbursed_on DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ loans: rows });
  } catch (err) {
    next(err);
  }
});

v1.get('/loans/:id', authRequired, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await query(
      `SELECT l.*,
              loan_outstanding_balance(l.id, CURRENT_DATE) AS outstanding_balance,
              loan_ageing_bucket(l.id, CURRENT_DATE) AS ageing_bucket,
              COALESCE((SELECT SUM(amount) FROM loan_repayments r WHERE r.loan_id = l.id), 0) AS total_paid
         FROM loans l
        WHERE l.id = $1`,
      [id],
    );
    if (!rows.length) throw createError(404, 'Loan not found.');
    res.json({ loan: rows[0] });
  } catch (err) {
    next(err);
  }
});

v1.post('/loans/:id/repayments', authRequired, requirePermission('ack_loan_repayments'), async (req, res, next) => {
  try {
    const loanId = parseInt(req.params.id, 10);
    const { amount, payment_date, payment_type } = req.body;
    if (!amount || amount <= 0 || !payment_date) {
      throw createError(400, 'amount (positive) and payment_date are required.');
    }

    const result = await withTransaction(req.user.id, req.sessionId, async (client) => {
      // Verify the loan exists and the payment doesn't exceed balance
      const { rows: balRows } = await client.query(
        `SELECT loan_outstanding_balance(id, $2) AS balance, disbursed_on
           FROM loans WHERE id = $1`,
        [loanId, payment_date],
      );
      if (!balRows.length) throw createError(404, 'Loan not found.');
      const balance = parseFloat(balRows[0].balance);
      if (amount > balance) {
        throw createError(400, `Amount exceeds balance due on ${payment_date} (${balance}).`);
      }
      if (payment_date < balRows[0].disbursed_on.toISOString().slice(0, 10)) {
        throw createError(400, 'Payment date cannot be before the loan disbursement date.');
      }

      const { rows } = await client.query(
        `INSERT INTO loan_repayments (loan_id, payment_date, amount, payment_type, officer_id, officer_initials)
         VALUES ($1, $2, $3, $4::payment_type, $5, $6)
         RETURNING *`,
        [loanId, payment_date, amount, payment_type || 'Installment', req.user.id, req.user.initials],
      );
      return rows[0];
    });

    res.status(201).json({ repayment: result });
  } catch (err) {
    next(err);
  }
});

// --- Loan requests ------------------------------------------------------
v1.get('/loan-requests', authRequired, async (req, res, next) => {
  try {
    const { status, limit = '50' } = req.query;
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE r.status = $1::loan_status`;
    }
    params.push(parseInt(limit, 10));
    const { rows } = await query(
      `SELECT r.id, r.reference, r.request_date, r.applicant_type::text AS applicant_type,
              r.applicant_name, r.telephone, r.category, r.term_months,
              r.principal, r.rate_monthly, r.status::text AS status, r.remark,
              r.created_at, u.name AS requested_by_name
         FROM loan_requests r
         LEFT JOIN users u ON u.id = r.requested_by
         ${where}
        ORDER BY r.request_date DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ requests: rows });
  } catch (err) {
    next(err);
  }
});

v1.post('/loan-requests', authRequired, async (req, res, next) => {
  try {
    const { applicant_type, account_number, applicant_name, telephone, email, address,
            category, term_months, principal, rate_monthly, nin } = req.body;
    if (!applicant_name || !telephone || !category || !term_months || !principal || !rate_monthly) {
      throw createError(400, 'applicant_name, telephone, category, term_months, principal and rate_monthly are required.');
    }
    if (term_months < 1 || term_months > 60) {
      throw createError(400, 'term_months must be between 1 and 60.');
    }

    const result = await withTransaction(req.user.id, req.sessionId, async (client) => {
      // Generate next reference LR-NNNN
      const { rows: seqRows } = await client.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq
           FROM loan_requests WHERE reference LIKE 'LR-%'`,
      );
      const reference = `LR-${String(seqRows[0].next_seq).padStart(4, '0')}`;

      const { rows } = await client.query(
        `INSERT INTO loan_requests
            (reference, request_date, applicant_type, account_number,
             applicant_name, telephone, email, address, category,
             term_months, principal, rate_monthly, status, requested_by, requested_by_initials)
         VALUES ($1, CURRENT_DATE, $2::applicant_type, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'Pending'::loan_status, $12, $13)
         RETURNING *`,
        [
          reference, applicant_type || 'm', account_number || null,
          applicant_name, telephone, email || null, address || null,
          category, term_months, principal, rate_monthly,
          req.user.id, req.user.initials,
        ],
      );
      return rows[0];
    });

    res.status(201).json({ request: result });
  } catch (err) {
    next(err);
  }
});

v1.patch('/loan-requests/:id', authRequired, requirePermission('approve_loans'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, remark } = req.body;
    if (!['Approved', 'Rejected', 'On Hold'].includes(status)) {
      throw createError(400, 'status must be Approved, Rejected or On Hold.');
    }

    const result = await withTransaction(req.user.id, req.sessionId, async (client) => {
      // Update the request
      const { rows: reqRows } = await client.query(
        `UPDATE loan_requests
            SET status = $2::loan_status,
                remark = $3,
                decided_by = $4,
                decided_on = CURRENT_DATE,
                updated_at = NOW()
          WHERE id = $1 AND status IN ('Pending','On Hold')
          RETURNING *`,
        [id, status, remark || null, req.user.id],
      );
      if (!reqRows.length) throw createError(404, 'Request not found or already decided.');

      const request = reqRows[0];

      // If approved, create the loan
      if (status === 'Approved') {
        const { rows: loanSeqRows } = await client.query(
          `SELECT COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq
             FROM loans WHERE reference LIKE 'LN-%'`,
        );
        const loanRef = `LN-${String(loanSeqRows[0].next_seq).padStart(4, '0')}`;

        const { rows: loanRows } = await client.query(
          `INSERT INTO loans
              (reference, request_id, account_number, non_member_id, borrower_name,
               telephone, category, term_months, principal, rate_monthly,
               disbursed_on, status, officer_id, officer_initials)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   CURRENT_DATE, 'Active'::loan_lifecycle_status, $11, $12)
           RETURNING *`,
          [
            loanRef, request.id, request.account_number, request.non_member_id,
            request.applicant_name, request.telephone, request.category,
            request.term_months, request.principal, request.rate_monthly,
            req.user.id, req.user.initials,
          ],
        );

        // Generate the amortization schedule (from 002_loans.sql)
        await client.query('SELECT generate_loan_schedule($1)', [loanRows[0].id]);

        return { request, loan: loanRows[0] };
      }

      return { request, loan: null };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- Regulatory routes --------------------------------------------------
v1.get('/regulatory/snapshot/:year/:month', authRequired, async (req, res, next) => {
  try {
    const year = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);
    if (month < 1 || month > 12) throw createError(400, 'month must be 1-12.');

    const { rows } = await query(
      'SELECT build_regulatory_snapshot($1, $2) AS snapshot',
      [year, month],
    );
    res.json({ period: `${year}-${String(month).padStart(2, '0')}`, snapshot: rows[0].snapshot });
  } catch (err) {
    next(err);
  }
});

v1.post('/regulatory/persist', authRequired, requireRole('Admin', 'Treasurer', 'Credit Supervisor'), async (req, res, next) => {
  try {
    const { year, month, template_id, basis = 'm', n_months = 1, notes } = req.body;
    if (!year || !month || !template_id) {
      throw createError(400, 'year, month and template_id are required.');
    }
    const { rows } = await query(
      'SELECT persist_regulatory_snapshot($1, $2, $3, $4::reporting_basis, $5, $6, $7) AS snapshot_id',
      [year, month, template_id, basis, n_months, req.user.id, notes || null],
    );
    res.status(201).json({ snapshot_id: rows[0].snapshot_id });
  } catch (err) {
    next(err);
  }
});

v1.get('/regulatory/templates', authRequired, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, short_name, description, is_active, sort_order
         FROM regulatory_return_templates
        WHERE is_active = TRUE
        ORDER BY sort_order`,
    );
    res.json({ templates: rows });
  } catch (err) {
    next(err);
  }
});

// --- Audit routes -------------------------------------------------------
v1.get('/audit/log', authRequired, requireRole('Admin'), async (req, res, next) => {
  try {
    const { category, severity, table_name, officer_id, limit = '100', offset = '0' } = req.query;
    const params = [];
    const clauses = ['is_archived = FALSE'];
    if (category) { params.push(category); clauses.push(`category = $${params.length}::audit_category`); }
    if (severity) { params.push(severity); clauses.push(`severity = $${params.length}::audit_severity`); }
    if (table_name) { params.push(table_name); clauses.push(`table_name = $${params.length}`); }
    if (officer_id) { params.push(officer_id); clauses.push(`officer_id = $${params.length}`); }

    params.push(parseInt(limit, 10), parseInt(offset, 10));
    const { rows } = await query(
      `SELECT id, occurred_at, officer_id, officer_name, officer_initials, officer_role,
              activity, particulars, category::text AS category, severity::text AS severity,
              table_name, operation::text AS operation, record_id, session_id
         FROM audit_log
        WHERE ${clauses.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ events: rows });
  } catch (err) {
    next(err);
  }
});

v1.get('/audit/verify', authRequired, requireRole('Admin'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM verify_audit_chain()');
    res.json({ chain: rows[0] });
  } catch (err) {
    next(err);
  }
});

v1.get('/audit/high-severity', authRequired, requireRole('Admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, occurred_at, officer_name, activity, particulars,
              category::text AS category, severity::text AS severity,
              table_name, operation::text AS operation, record_id
         FROM v_audit_high_severity
         LIMIT 100`,
    );
    res.json({ events: rows });
  } catch (err) {
    next(err);
  }
});

// --- 404 + error handlers ----------------------------------------------
app.use((req, res, next) => {
  next(createError(404, `Route not found: ${req.method} ${req.path}`));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const payload = {
    error: err.code || (status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'internal_error'),
    message: err.expose ? err.message : (status < 500 ? err.message : 'An internal error occurred.'),
    request_id: req.id,
    trace_id: req.traceId,
  };
  if (config.env === 'development' && status >= 500) {
    payload.stack = err.stack;
  }
  if (status >= 500) {
    logger.error('Unhandled server error', {
      error: err.message,
      stack: err.stack,
      request_id: req.id,
      method: req.method,
      path: req.path,
    });
  } else if (status >= 400) {
    logger.warn('Client error', {
      status,
      message: err.message,
      request_id: req.id,
      method: req.method,
      path: req.path,
    });
  }
  res.status(status).json(payload);
});

// --- HTTP server + graceful shutdown -----------------------------------
const server = http.createServer(app);

server.on('error', (err) => {
  logger.error('HTTP server error', { error: err.message, stack: err.stack });
  process.exit(1);
});

// Track in-flight requests so we can drain on shutdown
let activeRequests = 0;
server.on('request', (req, res) => {
  activeRequests++;
  res.on('finish', () => activeRequests--);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`, { active_requests: activeRequests });

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed.');
    try {
      await pool.end();
      logger.info('Database pool closed.');
    } catch (err) {
      logger.error('Error closing database pool', { error: err.message });
    }
    logger.info('Shutdown complete.');
    process.exit(0);
  });

  // Force-exit after 30s if connections won't drain
  setTimeout(() => {
    logger.error('Forcing shutdown after 30s timeout.', { active_requests: activeRequests });
    process.exit(1);
  }, 30000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: reason && reason.message ? reason.message : String(reason) });
  shutdown('unhandledRejection');
});

// --- Start listening ----------------------------------------------------
async function start() {
  try {
    // Verify DB connectivity before listening
    const { rows } = await pool.query('SELECT NOW() AS now');
    logger.info('Connected to PostgreSQL', { server_time: rows[0].now });

    server.listen(config.port, config.host, () => {
      logger.info(`Elite SACCO Mbarara API listening`, {
        url: `http://${config.host}:${config.port}`,
        env: config.env,
        node_version: process.version,
        pid: process.pid,
      });
      logger.info('Available endpoints', {
        health: `GET  /health`,
        ready:  `GET  /ready`,
        auth:   `POST /api/v1/auth/login | /auth/logout | GET /auth/me`,
        users:  `GET  /api/v1/users | POST /api/v1/users | DELETE /api/v1/users/:id`,
        members:`GET  /api/v1/members | POST /api/v1/members | GET /api/v1/members/:account`,
        savings:`GET  /api/v1/savings | POST /api/v1/savings`,
        loans:  `GET  /api/v1/loans | GET /api/v1/loans/:id | POST /api/v1/loans/:id/repayments`,
        requests:`GET /api/v1/loan-requests | POST /api/v1/loan-requests | PATCH /api/v1/loan-requests/:id`,
        reg:    `GET  /api/v1/regulatory/templates | GET /api/v1/regulatory/snapshot/:year/:month | POST /api/v1/regulatory/persist`,
        audit:  `GET  /api/v1/audit/log | GET /api/v1/audit/verify | GET /api/v1/audit/high-severity`,
      });
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// Export for testing
module.exports = { app, server, pool, config, withTransaction, query, start };

// Start only when run directly (not when required by tests)
if (require.main === module) {
  start();
}
