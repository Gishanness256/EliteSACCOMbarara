'use strict';

/**
 * Reusable PostgreSQL helpers for the Elite SACCO backend.
 *
 * Usage:
 *
 * const {
 *   fetchAll,
 *   fetchOne,
 *   insert,
 *   update,
 *   remove,
 *   withTransaction,
 *   buildPagination,
 *   buildWhereClause,
 * } = require('../utils/dbHelpers');
 */

const db = require('../db/pool');

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Run a raw query using the shared pool.
 *
 * @param {string} sql
 * @param {Array<any>} params
 * @param {object} options
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(sql, params = [], options = {}) {
  return db.query(sql, params, options);
}

/**
 * Return all rows from a query.
 *
 * @param {string} sql
 * @param {Array<any>} params
 * @param {object} options
 * @returns {Promise<Array<object>>}
 */
async function fetchAll(sql, params = [], options = {}) {
  const result = await query(sql, params, options);
  return result.rows || [];
}

/**
 * Return the first row or null.
 *
 * @param {string} sql
 * @param {Array<any>} params
 * @param {object} options
 * @returns {Promise<object|null>}
 */
async function fetchOne(sql, params = [], options = {}) {
  const result = await query(sql, params, options);
  return result.rows[0] || null;
}

/**
 * Return a single scalar value.
 *
 * @param {string} sql
 * @param {Array<any>} params
 * @param {object} options
 * @returns {Promise<any>}
 */
async function fetchValue(sql, params = [], options = {}) {
  const result = await query(sql, params, options);
  if (!result.rows || !result.rows.length) return null;
  const firstRow = result.rows[0];
  const firstValue = Object.values(firstRow)[0];
  return firstValue;
}

/**
 * Insert a row into a table and return the inserted row (or null).
 *
 * Example:
 * const member = await insert('members', {
 *   first_name: 'John',
 *   last_name: 'Doe',
 *   email: 'john@example.com'
 * }, { returning: '*' });
 *
 * @param {string} table
 * @param {object} data
 * @param {object} [opts]
 * @param {string|string[]} [opts.returning='*']
 * @returns {Promise<object|null>}
 */
async function insert(table, data, opts = {}) {
  if (!table || typeof table !== 'string') {
    throw new Error('insert(): table name is required.');
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('insert(): data must be a non-array object.');
  }

  const columns = Object.keys(data);
  const values = Object.values(data);

  if (!columns.length) {
    throw new Error('insert(): data cannot be empty.');
  }

  const returning = opts.returning || '*';
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');

  const sql = `
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${placeholders})
    RETURNING ${returning}
  `;

  const result = await query(sql, values);
  return result.rows[0] || null;
}

/**
 * Update rows in a table.
 *
 * Example:
 * await update('members', { id: 12 }, { is_active: false });
 *
 * @param {string} table
 * @param {object} where
 * @param {object} changes
 * @param {object} [opts]
 * @returns {Promise<number>}
 */
async function update(table, where, changes, opts = {}) {
  if (!table || typeof table !== 'string') {
    throw new Error('update(): table name is required.');
  }

  if (!where || typeof where !== 'object' || Array.isArray(where)) {
    throw new Error('update(): where clause must be an object.');
  }

  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Error('update(): changes must be an object.');
  }

  const whereEntries = Object.entries(where);
  const changeEntries = Object.entries(changes);

  if (!whereEntries.length) {
    throw new Error('update(): where clause cannot be empty.');
  }

  if (!changeEntries.length) {
    throw new Error('update(): changes cannot be empty.');
  }

  const whereSql = whereEntries
    .map(([key], index) => `${key} = $${index + 1}`)
    .join(' AND ');

  const updateSql = changeEntries
    .map(([key], index) => `${key} = $${whereEntries.length + index + 1}`)
    .join(', ');

  const params = [
    ...whereEntries.map(([, value]) => value),
    ...changeEntries.map(([, value]) => value),
  ];

  const sql = `
    UPDATE ${table}
    SET ${updateSql}
    WHERE ${whereSql}
    ${opts.returning ? `RETURNING ${opts.returning}` : ''}
  `;

  const result = await query(sql, params);
  return opts.returning ? (result.rows[0] || null) : result.rowCount || 0;
}

/**
 * Delete rows from a table.
 *
 * @param {string} table
 * @param {object} where
 * @param {object} [opts]
 * @returns {Promise<number|object|null>}
 */
async function remove(table, where, opts = {}) {
  if (!table || typeof table !== 'string') {
    throw new Error('remove(): table name is required.');
  }

  if (!where || typeof where !== 'object' || Array.isArray(where)) {
    throw new Error('remove(): where clause must be an object.');
  }

  const entries = Object.entries(where);
  if (!entries.length) {
    throw new Error('remove(): where clause cannot be empty.');
  }

  const whereSql = entries
    .map(([key], index) => `${key} = $${index + 1}`)
    .join(' AND ');

  const params = entries.map(([, value]) => value);

  const sql = `
    DELETE FROM ${table}
    WHERE ${whereSql}
    ${opts.returning ? `RETURNING ${opts.returning}` : ''}
  `;

  const result = await query(sql, params);
  return opts.returning ? (result.rows[0] || null) : result.rowCount || 0;
}

/**
 * Build a standard pagination object.
 *
 * Example:
 * const pagination = buildPagination({ page: 2, pageSize: 25 });
 * // => { page: 2, pageSize: 25, offset: 25, limit: 25 }
 *
 * @param {object} options
 * @returns {{ page: number, pageSize: number, offset: number, limit: number }}
 */
function buildPagination({ page = 1, pageSize = 20 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(200, Math.max(1, Number(pageSize) || 20));

  return {
    page: safePage,
    pageSize: safePageSize,
    limit: safePageSize,
    offset: (safePage - 1) * safePageSize,
  };
}

/**
 * Build a dynamic WHERE clause from an object.
 *
 * Example:
 * buildWhereClause({ status: 'active', role: 'Admin' })
 *
 * returns:
 * {
 *   sql: 'WHERE status = $1 AND role = $2',
 *   params: ['active', 'Admin']
 * }
 *
 * @param {object} filters
 * @returns {{ sql: string, params: Array<any> }}
 */
function buildWhereClause(filters = {}) {
  const entries = Object.entries(filters || {}).filter(([, value]) => {
    if (value === undefined || value === null || value === '') return false;
    return true;
  });

  if (!entries.length) {
    return { sql: '', params: [] };
  }

  const sql = entries
    .map(([key], index) => `${key} = $${index + 1}`)
    .join(' AND ');

  return {
    sql: `WHERE ${sql}`,
    params: entries.map(([, value]) => value),
  };
}

/**
 * Build an ORDER BY clause safely.
 *
 * @param {string} sortBy
 * @param {string[]} allowedColumns
 * @param {string} defaultColumn
 * @param {string} direction
 * @returns {string}
 */
function buildOrderBy(sortBy, allowedColumns = [], defaultColumn = 'id', direction = 'DESC') {
  const safeSortBy = allowedColumns.includes(sortBy) ? sortBy : defaultColumn;
  const safeDirection = ['ASC', 'DESC'].includes(String(direction).toUpperCase())
    ? String(direction).toUpperCase()
    : 'DESC';

  return `ORDER BY ${safeSortBy} ${safeDirection}`;
}

/**
 * Execute work inside a transaction.
 *
 * Intended for writes and multi-step DB operations.
 *
 * @param {Function} callback
 * @param {object} [context]
 * @param {number|null} [context.userId]
 * @param {string|null} [context.sessionId]
 * @returns {Promise<any>}
 */
async function withTransaction(callback, context = {}) {
  const userId = context.userId ?? null;
  const sessionId = context.sessionId ?? null;

  return db.withTransaction(userId, sessionId, callback);
}

/**
 * Return `true` if the row count is zero.
 *
 * @param {Array|object|null} data
 * @returns {boolean}
 */
function isEmptyResult(data) {
  if (Array.isArray(data)) return data.length === 0;
  if (data === null || data === undefined) return true;
  if (typeof data === 'object') return Object.keys(data).length === 0;
  return false;
}

/**
 * Normalize a list of IDs from strings, numbers, arrays, or objects.
 *
 * @param {any} value
 * @returns {Array<number|string>}
 */
function normalizeIds(value) {
  return toArray(value).filter((item) => item !== undefined && item !== null && item !== '');
}

/**
 * Safely coalesce values for DB writes.
 *
 * Example:
 * coalesceNull({ first_name: 'John', middle_name: null }, 'Unknown');
 *
 * @param {object} row
 * @param {any} fallback
 * @returns {object}
 */
function coalesceNull(row, fallback = null) {
  if (!row || typeof row !== 'object') return row;

  const normalized = { ...row };
  Object.keys(normalized).forEach((key) => {
    if (normalized[key] === null || normalized[key] === undefined) {
      normalized[key] = fallback;
    }
  });

  return normalized;
}

module.exports = {
  query,
  fetchAll,
  fetchOne,
  fetchValue,
  insert,
  update,
  remove,
  buildPagination,
  buildWhereClause,
  buildOrderBy,
  withTransaction,
  isEmptyResult,
  normalizeIds,
  coalesceNull,
};
