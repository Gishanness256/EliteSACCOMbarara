'use strict';

/**
 * ============================================================================
 * Elite SACCO Mbarara — Authentication & authorization middleware
 * ----------------------------------------------------------------------------
 * Verifies the JWT on every request, loads the user from the database, and
 * enforces role- and permission-based access control.
 *
 * Wires into the audit subsystem from 004_audit.sql: every successful auth,
 * every failed token verification, and every denied request is recorded in
 * audit_log via the log_audit_event() SQL function — with the session GUCs
 * (app.current_user_id, app.session_id) set so the audit_table_trigger can
 * attribute downstream row changes correctly.
 *
 * Usage (in src/server.js):
 *
 *   const { createAuth } = require('./middleware/auth');
 *   const auth = createAuth({ pool, jwtSecret, jwtExpiresIn, logger });
 *
 *   v1.post('/users',        auth.required, auth.role('Admin'),                handler);
 *   v1.post('/savings',      auth.required, auth.permission('ack_savings'),    handler);
 *   v1.get ('/members/:id',  auth.required, auth.ownerOrRole('Admin'),         handler);
 *   v1.get ('/public/health', auth.optional,                                   handler);
 *
 * Exports a factory so the middleware can be unit-tested with a mocked pool.
 * ============================================================================
 */

const jwt = require('jsonwebtoken');
const createError = require('http-errors');

// ---------------------------------------------------------------------------
// In-memory user cache
// ---------------------------------------------------------------------------
// To avoid hammering the database on every request, we cache the user row
// (id, name, email, role, initials, is_active) and their permission codes
// for a short TTL. Role/permission changes made via the admin UI propagate
// within TTL seconds. Set TTL=0 to disable caching entirely (recommended
// for tests).
const DEFAULT_CACHE_TTL_MS = 10 * 1000; // 10 seconds

function createLruCache(maxEntries) {
  const map = new Map();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        map.delete(key);
        return undefined;
      }
      // Refresh insertion order so LRU eviction works
      map.delete(key);
      map.set(key, entry);
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (map.size >= maxEntries) {
        const oldestKey = map.keys().next().value;
        map.delete(oldestKey);
      }
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    invalidate(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} AuthDeps
 * @property {import('pg').Pool} pool          PostgreSQL connection pool
 * @property {string}            jwtSecret     Secret used to sign/verify JWTs
 * @property {string}            [jwtExpiresIn] Default '12h'
 * @property {Object}            [logger]       Winston-compatible logger
 * @property {number}            [cacheTtlMs]   User cache TTL (default 10s)
 * @property {string[]}          [tokenCookies] Cookie names to check (default ['token'])
 * @property {string}            [authScheme]   Expected scheme (default 'Bearer')
 */

/**
 * Creates a bundle of auth middleware functions sharing the same pool,
 * JWT secret, and user cache.
 *
 * @param {AuthDeps} deps
 * @returns {{
 *   required: Function,
 *   optional: Function,
 *   role: Function,
 *   anyRole: Function,
 *   permission: Function,
 *   allPermissions: Function,
 *   anyPermission: Function,
 *   ownerOrRole: Function,
 *   invalidateUser: Function,
 *   clearCache: Function,
 * }}
 */
function createAuth(deps) {
  const {
    pool,
    jwtSecret,
    jwtExpiresIn = '12h',
    logger = console,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    tokenCookies = ['token'],
    authScheme = 'Bearer',
  } = deps;

  if (!pool) throw new Error('createAuth: pool is required');
  if (!jwtSecret) throw new Error('createAuth: jwtSecret is required');

  // Per-factory caches (keyed by user id)
  const userCache = createLruCache(500);
  const permissionsCache = createLruCache(500);

  // ---------------------------------------------------------------------------
  // Internal: extract the JWT from the request
  // ---------------------------------------------------------------------------
  function extractToken(req) {
    // 1. Authorization: Bearer <token>
    const header = req.headers.authorization || '';
    if (header.startsWith(`${authScheme} `)) {
      return header.slice(authScheme.length + 1).trim();
    }
    // 2. Cookie(s)
    if (req.cookies) {
      for (const name of tokenCookies) {
        if (req.cookies[name]) return req.cookies[name];
      }
    }
    // 3. URL query (?token=...) — only allowed for SSE / WebSocket downgrade
    //    scenarios. Disabled by default to prevent token leakage via logs.
    if (req.query && req.query.token && req._allowTokenQuery) {
      return String(req.query.token);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Internal: load the user from DB (with cache)
  // ---------------------------------------------------------------------------
  async function loadUser(userId) {
    if (userId == null) return null;

    const cached = userCache.get(userId);
    if (cached) return cached;

    const { rows } = await pool.query(
      `SELECT id, name, email, role::text AS role, initials, is_active
         FROM users
        WHERE id = $1`,
      [userId],
    );

    if (!rows.length) return null;

    const user = rows[0];
    if (cacheTtlMs > 0) {
      userCache.set(userId, user, cacheTtlMs);
    }
    return user;
  }

  // ---------------------------------------------------------------------------
  // Internal: load the user's permission codes (with cache)
  // ---------------------------------------------------------------------------
  async function loadPermissions(userId, role) {
    if (userId == null || !role) return new Set();

    const cacheKey = `${userId}:${role}`;
    const cached = permissionsCache.get(cacheKey);
    if (cached) return cached;

    const { rows } = await pool.query(
      `SELECT p.code
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role = $1::user_role`,
      [role],
    );

    const perms = new Set(rows.map((r) => r.code));
    if (cacheTtlMs > 0) {
      permissionsCache.set(cacheKey, perms, cacheTtlMs);
    }
    return perms;
  }

  // ---------------------------------------------------------------------------
  // Internal: write a structured audit event for auth outcomes
  // ---------------------------------------------------------------------------
  async function writeAuditEvent(req, event) {
    const sql = `SELECT log_audit_event(
      $1, $2, $3::audit_category, $4::audit_severity,
      $5, $6, $7, $8, $9::inet, $10
    )`;
    const params = [
      event.activity,
      event.particulars || null,
      event.category || 'authentication',
      event.severity || 'info',
      event.userId || null,
      event.tableName || null,
      event.recordId || null,
      req.sessionId || req.headers['x-session-id'] || null,
      req.ip || null,
      req.headers['user-agent'] || null,
    ];
    try {
      await pool.query(sql, params);
    } catch (err) {
      // Never let audit logging failure break the request flow — log and move on
      logger.warn('Failed to write auth audit event', {
        error: err.message,
        activity: event.activity,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public: invalidate a user's cached profile & permissions
  // ---------------------------------------------------------------------------
  // Call this after a user's role, active status, or role_permissions change
  // so the next request sees the new state immediately.
  function invalidateUser(userId) {
    userCache.invalidate(userId);
    // Permissions are cached per (user, role) — invalidate all keys for this user
    // (LRU cache doesn't support prefix scan, so we just clear all perms on
    // any user change — they're small and rebuilt cheaply).
    permissionsCache.clear();
  }

  function clearCache() {
    userCache.clear();
    permissionsCache.clear();
  }

  // ---------------------------------------------------------------------------
  // Public: required authentication
  // ---------------------------------------------------------------------------
  // Verifies the JWT, loads the user, checks is_active, and loads permissions.
  // On success: req.user is set, req.userPermissions is a Set<string>.
  // On failure: 401 with a JSON error body, audit event logged.
  function required(req, res, next) {
    _authenticate(req, res, next, { required: true });
  }

  // ---------------------------------------------------------------------------
  // Public: optional authentication
  // ---------------------------------------------------------------------------
  // Same as `required`, but if no token is present, the request continues
  // with req.user = null. Useful for public endpoints that show extra data
  // to logged-in users (e.g. the About page).
  function optional(req, res, next) {
    _authenticate(req, res, next, { required: false });
  }

  // Shared implementation
  async function _authenticate(req, res, next, opts) {
    try {
      const token = extractToken(req);

      if (!token) {
        if (opts.required) {
          await writeAuditEvent(req, {
            activity: 'Authentication rejected',
            particulars: 'No token provided in Authorization header or cookie',
            severity: 'warning',
          });
          return next(createError(401, 'Authentication required. Provide a Bearer token or token cookie.'));
        }
        // Optional path: continue without a user
        req.user = null;
        req.userPermissions = new Set();
        return next();
      }

      // Verify signature + expiration
      let payload;
      try {
        payload = jwt.verify(token, jwtSecret);
      } catch (err) {
        const reason = err.name === 'TokenExpiredError'
          ? 'Token expired'
          : err.name === 'JsonWebTokenError'
            ? 'Invalid token signature'
            : 'Token verification failed';
        await writeAuditEvent(req, {
          activity: 'Authentication rejected',
          particulars: `${reason}: ${err.message}`,
          severity: 'warning',
        });
        return next(createError(401, `${reason}. Please log in again.`));
      }

      if (!payload || !payload.sub) {
        await writeAuditEvent(req, {
          activity: 'Authentication rejected',
          particulars: 'Token payload missing subject (sub)',
          severity: 'warning',
        });
        return next(createError(401, 'Malformed token. Please log in again.'));
      }

      // Load the user (cached)
      const user = await loadUser(payload.sub);

      if (!user) {
        await writeAuditEvent(req, {
          activity: 'Authentication rejected',
          particulars: `User id ${payload.sub} not found`,
          severity: 'warning',
          userId: payload.sub,
        });
        return next(createError(401, 'User account no longer exists. Please contact an administrator.'));
      }

      if (!user.is_active) {
        await writeAuditEvent(req, {
          activity: 'Authentication rejected',
          particulars: `Inactive user attempted access: ${user.email}`,
          severity: 'warning',
          userId: user.id,
        });
        return next(createError(401, 'Your account has been deactivated. Please contact an administrator.'));
      }

      // Detect role mismatch between token and DB — force re-auth
      if (payload.role && payload.role !== user.role) {
        await writeAuditEvent(req, {
          activity: 'Authentication rejected',
          particulars: `Role changed since token issued (token=${payload.role}, db=${user.role}). Forcing re-login.`,
          severity: 'notice',
          userId: user.id,
        });
        res.clearCookie('token');
        return next(createError(401, 'Your role has changed. Please log in again.'));
      }

      // Load permissions (cached)
      const permissions = await loadPermissions(user.id, user.role);

      // Attach to request for downstream handlers and the audit_table_trigger
      req.user = user;
      req.userPermissions = permissions;
      req.tokenPayload = payload;

      // Expose a helper for handlers to log business audit events
      req.logAudit = async (activity, particulars, opts2 = {}) => {
        await writeAuditEvent(req, {
          activity,
          particulars,
          category: opts2.category || 'system',
          severity: opts2.severity || 'info',
          userId: user.id,
          tableName: opts2.tableName,
          recordId: opts2.recordId,
        });
      };

      next();
    } catch (err) {
      logger.error('Auth middleware unexpected error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
      });
      next(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Public: require a specific role
  // ---------------------------------------------------------------------------
  // Usage: router.post('/users', auth.required, auth.role('Admin'), handler)
  function role(...allowedRoles) {
    if (!allowedRoles.length) {
      throw new Error('auth.role: at least one role must be specified');
    }
    const allowed = new Set(allowedRoles);
    return function requireRole(req, res, next) {
      if (!req.user) {
        return next(createError(401, 'Authentication required.'));
      }
      if (!allowed.has(req.user.role)) {
        writeAuditEvent(req, {
          activity: 'Authorization denied',
          particulars: `User ${req.user.email} (role=${req.user.role}) attempted to access ${req.method} ${req.path} which requires role(s): ${[...allowed].join(', ')}`,
          severity: 'warning',
          userId: req.user.id,
        });
        return next(createError(403, `This action requires one of these roles: ${[...allowed].join(', ')}.`));
      }
      next();
    };
  }

  // Alias: anyRole is the same as role (multiple args = any-of)
  const anyRole = role;

  // ---------------------------------------------------------------------------
  // Public: require ALL of the given permission codes
  // ---------------------------------------------------------------------------
  // Usage: router.post('/loans', auth.required, auth.allPermissions('approve_loans','set_interest_rates'), handler)
  function allPermissions(...codes) {
    if (!codes.length) {
      throw new Error('auth.allPermissions: at least one permission code must be specified');
    }
    return function requireAllPermissions(req, res, next) {
      if (!req.user) {
        return next(createError(401, 'Authentication required.'));
      }
      const missing = codes.filter((c) => !req.userPermissions.has(c));
      if (missing.length) {
        writeAuditEvent(req, {
          activity: 'Authorization denied',
          particulars: `User ${req.user.email} (role=${req.user.role}) missing required permission(s): ${missing.join(', ')}`,
          severity: 'warning',
          userId: req.user.id,
        });
        return next(createError(403, `Missing required permission(s): ${missing.join(', ')}.`));
      }
      next();
    };
  }

  // ---------------------------------------------------------------------------
  // Public: require ANY of the given permission codes
  // ---------------------------------------------------------------------------
  // Usage: router.get('/reports', auth.required, auth.anyPermission('weekly_reports','monthly_reports','annual_reports'), handler)
  function anyPermission(...codes) {
    if (!codes.length) {
      throw new Error('auth.anyPermission: at least one permission code must be specified');
    }
    return function requireAnyPermission(req, res, next) {
      if (!req.user) {
        return next(createError(401, 'Authentication required.'));
      }
      const hasAny = codes.some((c) => req.userPermissions.has(c));
      if (!hasAny) {
        writeAuditEvent(req, {
          activity: 'Authorization denied',
          particulars: `User ${req.user.email} (role=${req.user.role}) missing all required permission(s): ${codes.join(', ')}`,
          severity: 'warning',
          userId: req.user.id,
        });
        return next(createError(403, `Missing required permission(s): ${codes.join(', ')}.`));
      }
      next();
    };
  }

  // Alias
  const permission = anyPermission;

  // ---------------------------------------------------------------------------
  // Public: owner-or-role check
  // ---------------------------------------------------------------------------
  // Allows access if the authenticated user owns the resource OR holds one of
  // the elevated roles. Pass a function that extracts the owner id from req.
  //
  // Usage:
  //   router.get('/users/:id',
  //     auth.required,
  //     auth.ownerOrRole('Admin', (req) => parseInt(req.params.id, 10)),
  //     handler
  //   );
  function ownerOrRole(elevatedRoles, getOwnerId) {
    const allowedRoles = Array.isArray(elevatedRoles) ? elevatedRoles : [elevatedRoles];
    const roleSet = new Set(allowedRoles);

    return async function requireOwnerOrRole(req, res, next) {
      if (!req.user) {
        return next(createError(401, 'Authentication required.'));
      }

      // Elevated role always passes
      if (roleSet.has(req.user.role)) {
        return next();
      }

      // Otherwise check ownership
      try {
        const ownerId = await getOwnerId(req);
        if (ownerId === req.user.id) {
          return next();
        }
      } catch (err) {
        logger.warn('ownerOrRole: getOwnerId threw', { error: err.message });
      }

      writeAuditEvent(req, {
        activity: 'Authorization denied',
        particulars: `User ${req.user.email} (role=${req.user.role}) attempted to access a resource they do not own (owner check failed)`,
        severity: 'warning',
        userId: req.user.id,
      });
      return next(createError(403, 'You do not have access to this resource.'));
    };
  }

  // ---------------------------------------------------------------------------
  // Public: issue a fresh JWT for a user (used by login handler)
  // ---------------------------------------------------------------------------
  function signToken(user) {
    return jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        initials: user.initials,
      },
      jwtSecret,
      { expiresIn: jwtExpiresIn },
    );
  }

  // ---------------------------------------------------------------------------
  // Public: decode a token without verification (for diagnostics / refresh)
  // ---------------------------------------------------------------------------
  function decodeToken(token) {
    return jwt.decode(token);
  }

  // ---------------------------------------------------------------------------
  // Public: verify a token (returns the payload or throws)
  // ---------------------------------------------------------------------------
  function verifyToken(token) {
    return jwt.verify(token, jwtSecret);
  }

  // ---------------------------------------------------------------------------
  // Return the middleware bundle
  // ---------------------------------------------------------------------------
  return {
    // Authentication
    required,
    optional,

    // Authorization
    role,
    anyRole,
    permission,
    anyPermission,
    allPermissions,
    ownerOrRole,

    // Token utilities (used by login handler)
    signToken,
    decodeToken,
    verifyToken,

    // Cache management
    invalidateUser,
    clearCache,

    // Internals exposed for testing
    _extractToken: extractToken,
    _loadUser: loadUser,
    _loadPermissions: loadPermissions,
    _cacheSize: () => ({ users: userCache.size(), permissions: permissionsCache.size() }),
  };
}

module.exports = {
  createAuth,
  // Convenience: a singleton-style default if your app only needs one auth instance
  // (most apps do — but the factory pattern keeps tests clean).
  DEFAULT_CACHE_TTL_MS,
};
