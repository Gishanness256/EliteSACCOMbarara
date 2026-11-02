'use strict';

/**
 * server/services/auditService.js
 *
 * Small, reusable audit service for the SACCO backend.
 *
 * Expected DB contract:
 * - db.query(sql, params) => { rows, rowCount }
 * - PostgreSQL functions from the audit migration exist:
 *   - log_audit_event(...)
 *   - verify_audit_chain(...)
 *   - archive_audit_log(...)
 *
 * Usage:
 *   const createAuditService = require('./services/auditService');
 *   const auditService = createAuditService({ db });
 *
 *   await auditService.logEvent({
 *     activity: 'User logged in',
 *     particulars: 'Login succeeded',
 *     category: 'authentication',
 *     severity: 'info',
 *     officerId: 12,
 *     sessionId: req.sessionID,
 *     ipAddress: req.ip,
 *     userAgent: req.headers['user-agent']
 *   });
 */

function normalizeAuditRow(row = {}) {
  return {
    id: row.id ?? null,
    occurredAt: row.occurred_at ?? row.occurredAt ?? null,
    officerId: row.officer_id ?? row.officerId ?? null,
    officerName: row.officer_name ?? row.officerName ?? null,
    officerInitials: row.officer_initials ?? row.officerInitials ?? null,
    officerRole: row.officer_role ?? row.officerRole ?? null,
    activity: row.activity ?? null,
    particulars: row.particulars ?? null,
    category: row.category ?? null,
    severity: row.severity ?? 'info',
    sessionId: row.session_id ?? row.sessionId ?? null,
    requestId: row.request_id ?? row.requestId ?? null,
    traceId: row.trace_id ?? row.traceId ?? null,
    tableName: row.table_name ?? row.tableName ?? null,
    operation: row.operation ?? null,
    recordId: row.record_id ?? row.recordId ?? null,
    rowBefore: row.row_before ?? row.rowBefore ?? null,
    rowAfter: row.row_after ?? row.rowAfter ?? null,
    changedFields: Array.isArray(row.changed_fields)
      ? row.changed_fields
      : Array.isArray(row.changedFields)
        ? row.changedFields
        : [],
    prevHash: row.prev_hash ?? row.prevHash ?? null,
    rowHash: row.row_hash ?? row.rowHash ?? null,
    isArchived: row.is_archived ?? row.isArchived ?? false,
    archivedAt: row.archived_at ?? row.archivedAt ?? null,
    ipAddress: row.ip_address ?? row.ipAddress ?? null,
    userAgent: row.user_agent ?? row.userAgent ?? null,
  };
}

function buildFilters({ category, severity, tableName, officerId, q } = {}) {
  const clauses = [];
  const values = [];

  if (category) {
    values.push(category);
    clauses.push(`category = $${values.length}::audit_category`);
  }

  if (severity) {
    values.push(severity);
    clauses.push(`severity = $${values.length}::audit_severity`);
  }

  if (tableName) {
    values.push(tableName);
    clauses.push(`table_name = $${values.length}`);
  }

  if (officerId) {
    values.push(Number(officerId));
    clauses.push(`officer_id = $${values.length}`);
  }

  if (q) {
    const keyword = `%${String(q).trim()}%`;
    values.push(keyword, keyword, keyword);
    clauses.push(
      `(activity ILIKE $${values.length - 2} OR particulars ILIKE $${values.length - 1} OR officer_name ILIKE $${values.length})`,
    );
  }

  return { clauses, values };
}

function createAuditService({ db, logger } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('auditService: a valid db client with query() is required');
  }

  const log = (message, meta) => {
    if (logger && typeof logger.info === 'function') {
      logger.info(message, meta || {});
    }
  };

  return {
    async listAudit({
      category,
      severity,
      tableName,
      officerId,
      q,
      limit = 100,
      offset = 0,
    } = {}) {
      const { clauses, values } = buildFilters({ category, severity, tableName, officerId, q });
      const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limitValue = Number(limit) > 0 ? Number(limit) : 100;
      const offsetValue = Number(offset) > 0 ? Number(offset) : 0;

      const sql = `
        SELECT
          id,
          occurred_at,
          officer_id,
          officer_name,
          officer_initials,
          officer_role,
          activity,
          particulars,
          category,
          severity,
          session_id,
          request_id,
          trace_id,
          table_name,
          operation,
          record_id,
          row_before,
          row_after,
          changed_fields,
          prev_hash,
          row_hash,
          is_archived,
          archived_at,
          ip_address,
          user_agent
        FROM audit_log
        ${whereClause}
        ORDER BY occurred_at DESC
        LIMIT $${values.length + 1}
        OFFSET $${values.length + 2}
      `;

      const params = [...values, limitValue, offsetValue];
      const result = await db.query(sql, params);

      return (result.rows || []).map(normalizeAuditRow);
    },

    async getAuditById(id) {
      const sql = `
        SELECT
          id,
          occurred_at,
          officer_id,
          officer_name,
          officer_initials,
          officer_role,
          activity,
          particulars,
          category,
          severity,
          session_id,
          request_id,
          trace_id,
          table_name,
          operation,
          record_id,
          row_before,
          row_after,
          changed_fields,
          prev_hash,
          row_hash,
          is_archived,
          archived_at,
          ip_address,
          user_agent
        FROM audit_log
        WHERE id = $1
      `;

      const result = await db.query(sql, [id]);
      const row = result.rows && result.rows[0];
      return row ? normalizeAuditRow(row) : null;
    },

    async logEvent({
      activity,
      particulars = null,
      category = 'system',
      severity = 'info',
      officerId = null,
      tableName = null,
      recordId = null,
      sessionId = null,
      ipAddress = null,
      userAgent = null,
    } = {}) {
      const sql = `
        SELECT log_audit_event(
          $1,
          $2,
          $3::audit_category,
          $4::audit_severity,
          $5,
          $6,
          $7,
          $8,
          $9::inet,
          $10
        ) AS id
      `;

      const params = [
        activity,
        particulars,
        category,
        severity,
        officerId,
        tableName,
        recordId,
        sessionId,
        ipAddress || null,
        userAgent || null,
      ];

      const result = await db.query(sql, params);
      const id = result.rows && result.rows[0] && result.rows[0].id;

      log('Audit event logged', {
        activity,
        category,
        severity,
        officerId,
        tableName,
        recordId,
        sessionId,
      });

      return id ?? null;
    },

    async verifyChain({ startId = null, endId = null } = {}) {
      const sql = `
        SELECT *
        FROM verify_audit_chain($1, $2)
      `;

      const result = await db.query(sql, [startId, endId]);
      const row = result.rows && result.rows[0];
      return row
        ? {
            isValid: !!row.is_valid,
            brokenAtId: row.broken_at_id ?? null,
            brokenAtTime: row.broken_at_time ?? null,
            expectedHash: row.expected_hash ?? null,
            actualHash: row.actual_hash ?? null,
            rowsChecked: row.rows_checked ?? 0,
          }
        : null;
    },

    async archiveAuditLog(beforeDate, archivedBy = null) {
      const sql = `
        SELECT archive_audit_log($1, $2) AS archived_count
      `;

      const result = await db.query(sql, [beforeDate, archivedBy]);
      const row = result.rows && result.rows[0];
      const archivedCount = row ? Number(row.archived_count || 0) : 0;

      log('Audit log archived', {
        beforeDate,
        archivedBy,
        archivedCount,
      });

      return archivedCount;
    },

    async getFilters() {
      const sql = `
        SELECT
          DISTINCT officer_name AS user_name
        FROM audit_log
        WHERE is_archived = FALSE
        ORDER BY officer_name ASC
      `;

      const usersResult = await db.query(sql, []);
      const users = (usersResult.rows || []).map((row) => row.user_name).filter(Boolean);

      const activitiesSql = `
        SELECT
          DISTINCT activity
        FROM audit_log
        WHERE is_archived = FALSE
        ORDER BY activity ASC
      `;

      const activityResult = await db.query(activitiesSql, []);
      const activities = (activityResult.rows || []).map((row) => row.activity).filter(Boolean);

      return { users, activities };
    },

    async exportAudit({
      format = 'json',
      category,
      severity,
      tableName,
      officerId,
      q,
    } = {}) {
      const rows = await this.listAudit({
        category,
        severity,
        tableName,
        officerId,
        q,
      });

      if (format === 'csv') {
        const header = [
          'id',
          'occurred_at',
          'officer_name',
          'activity',
          'particulars',
          'category',
          'severity',
          'table_name',
          'operation',
          'record_id',
        ];

        const csvRows = [
          header.join(','),
          ...rows.map((row) =>
            [
              row.id ?? '',
              row.occurredAt ?? '',
              row.officerName ?? '',
              row.activity ?? '',
              row.particulars ?? '',
              row.category ?? '',
              row.severity ?? '',
              row.tableName ?? '',
              row.operation ?? '',
              row.recordId ?? '',
            ]
              .map((value) => `"${String(value).replace(/"/g, '""')}"`)
              .join(','),
          ),
        ];

        return { format: 'csv', rows, csv: csvRows.join('\n') };
      }

      return { format: 'json', rows };
    },

    async getSummary() {
      const sql = `
        SELECT
          COUNT(*) AS total_rows,
          COUNT(*) FILTER (WHERE is_archived = FALSE) AS active_rows,
          COUNT(*) FILTER (WHERE severity = 'critical') AS critical_rows,
          COUNT(*) FILTER (WHERE severity = 'warning') AS warning_rows
        FROM audit_log
      `;

      const result = await db.query(sql, []);
      const row = result.rows && result.rows[0];

      return row
        ? {
            totalRows: Number(row.total_rows || 0),
            activeRows: Number(row.active_rows || 0),
            criticalRows: Number(row.critical_rows || 0),
            warningRows: Number(row.warning_rows || 0),
          }
        : {
            totalRows: 0,
            activeRows: 0,
            criticalRows: 0,
            warningRows: 0,
          };
    },
  };
}

module.exports = createAuditService;
module.exports.createAuditService = createAuditService;
module.exports.normalizeAuditRow = normalizeAuditRow;
