'use strict';

/**
 * server/services/reportService.js
 *
 * Reusable service for reporting/regulatory snapshot logic.
 *
 * This service wraps:
 * - retrieving regulatory templates
 * - building a snapshot for a month
 * - persisting a snapshot to the database
 * - retrieving persisted snapshots / history if needed
 */

function normalizeTemplate(row = {}) {
  if (!row) return null;

  return {
    id: row.id ?? null,
    name: row.name ?? null,
    shortName: row.short_name ?? row.shortName ?? null,
    description: row.description ?? null,
    isActive: row.is_active ?? row.isActive ?? true,
    sortOrder: row.sort_order ?? row.sortOrder ?? null,
  };
}

function normalizeSnapshot(row = {}) {
  if (!row) return null;

  return {
    id: row.id ?? null,
    periodMonth: row.period_month ?? row.periodMonth ?? null,
    templateId: row.template_id ?? row.templateId ?? null,
    basis: row.basis ?? null,
    nMonths: row.n_months ?? row.nMonths ?? null,
    comparisonYear: row.comparison_year ?? row.comparisonYear ?? null,
    generatedAt: row.generated_at ?? row.generatedAt ?? null,
    generatedBy: row.generated_by ?? row.generatedBy ?? null,
    generatedByName: row.generated_by_name ?? row.generatedByName ?? null,
    generatedByInitials: row.generated_by_initials ?? row.generatedByInitials ?? null,
    snapshotData: row.snapshot_data ?? row.snapshotData ?? null,
    complianceSummary: row.compliance_summary ?? row.complianceSummary ?? null,
    notes: row.notes ?? null,
    submittedToRegulator: row.submitted_to_regulator ?? row.submittedToRegulator ?? false,
    submittedOn: row.submitted_on ?? row.submittedOn ?? null,
    submissionReference: row.submission_reference ?? row.submissionReference ?? null,
  };
}

function createReportService({ db, logger } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('reportService: a valid db instance with query() is required');
  }

  const log = (message, meta) => {
    if (logger && typeof logger.info === 'function') {
      logger.info(message, meta || {});
    }
  };

  return {
    async getTemplates() {
      const { rows } = await db.query(
        `
          SELECT
            id,
            name,
            short_name,
            description,
            is_active,
            sort_order
          FROM regulatory_return_templates
          WHERE is_active = TRUE
          ORDER BY sort_order
        `,
      );

      return (rows || []).map(normalizeTemplate);
    },

    async buildSnapshot(year, month) {
      const parsedYear = Number(year);
      const parsedMonth = Number(month);

      if (!Number.isInteger(parsedYear) || parsedYear < 2000) {
        throw new Error('Valid year is required.');
      }

      if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
        throw new Error('month must be between 1 and 12.');
      }

      const { rows } = await db.query(
        `
          SELECT build_regulatory_snapshot($1, $2) AS snapshot
        `,
        [parsedYear, parsedMonth],
      );

      const snapshot = rows && rows[0] ? rows[0].snapshot : null;
      return snapshot;
    },

    async persistSnapshot({
      year,
      month,
      templateId,
      basis = 'm',
      nMonths = 1,
      generatedBy = null,
      notes = null,
    } = {}) {
      if (!year || !month || !templateId) {
        throw new Error('year, month and template_id are required.');
      }

      const { rows } = await db.query(
        `
          SELECT persist_regulatory_snapshot(
            $1,
            $2,
            $3,
            $4::reporting_basis,
            $5,
            $6,
            $7
          ) AS snapshot_id
        `,
        [year, month, templateId, basis, nMonths, generatedBy, notes || null],
      );

      const snapshotId = rows && rows[0] ? rows[0].snapshot_id : null;

      log('Regulatory snapshot persisted', {
        year,
        month,
        templateId,
        basis,
        generatedBy,
        snapshotId,
      });

      return snapshotId;
    },

    async listSnapshots({ limit = 20 } = {}) {
      const safeLimit = Number(limit) > 0 ? Number(limit) : 20;

      const { rows } = await db.query(
        `
          SELECT
            id,
            period_month,
            template_id,
            basis,
            n_months,
            comparison_year,
            generated_at,
            generated_by,
            generated_by_name,
            generated_by_initials,
            snapshot_data,
            compliance_summary,
            notes,
            submitted_to_regulator,
            submitted_on,
            submission_reference
          FROM regulatory_snapshots
          ORDER BY generated_at DESC
          LIMIT $1
        `,
        [safeLimit],
      );

      return (rows || []).map(normalizeSnapshot);
    },

    async getLatestSnapshotForTemplate(templateId) {
      if (!templateId) {
        throw new Error('templateId is required.');
      }

      const { rows } = await db.query(
        `
          SELECT DISTINCT ON (s.template_id)
            s.id,
            s.period_month,
            s.template_id,
            s.basis,
            s.n_months,
            s.comparison_year,
            s.generated_at,
            s.generated_by,
            s.generated_by_name,
            s.generated_by_initials,
            s.snapshot_data,
            s.compliance_summary,
            s.notes,
            s.submitted_to_regulator,
            s.submitted_on,
            s.submission_reference
          FROM regulatory_snapshots s
          WHERE s.template_id = $1
          ORDER BY s.template_id, s.period_month DESC, s.generated_at DESC
        `,
        [templateId],
      );

      return rows && rows[0] ? normalizeSnapshot(rows[0]) : null;
    },

    async verifyCompliance({ year, month, templateId, basis = 'm', nMonths = 1 } = {}) {
      const { rows } = await db.query(
        `
          SELECT
            compliance_summary,
            snapshot_data
          FROM regulatory_snapshots
          WHERE period_month = $1
            AND template_id = $2
            AND basis = $3::reporting_basis
            AND n_months = $4
          ORDER BY generated_at DESC
          LIMIT 1
        `,
        [new Date(`${year}-${String(month).padStart(2, '0')}-01`).toISOString(), templateId, basis, nMonths],
      );

      return rows && rows[0] ? rows[0] : null;
    },
  };
}

module.exports = createReportService;
module.exports.createReportService = createReportService;
module.exports.normalizeTemplate = normalizeTemplate;
module.exports.normalizeSnapshot = normalizeSnapshot;
