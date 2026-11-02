'use strict';

const express = require('express');
const { query } = require('../db');

function createReportController({ authRequired, requireRole }) {
  const router = express.Router();

  router.use(authRequired);

  router.get('/templates', async (req, res, next) => {
    try {
      const { rows } = await query(`
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
      `);

      return res.json({ templates: rows });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/snapshot/:year/:month', async (req, res, next) => {
    try {
      const year = Number(req.params.year);
      const month = Number(req.params.month);

      if (!Number.isInteger(year) || year < 2000) {
        return res.status(400).json({ error: 'Valid year is required.' });
      }

      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ error: 'month must be between 1 and 12.' });
      }

      const { rows } = await query(
        'SELECT build_regulatory_snapshot($1, $2) AS snapshot',
        [year, month]
      );

      return res.json({
        period: `${year}-${String(month).padStart(2, '0')}`,
        snapshot: rows[0]?.snapshot || null,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/persist', requireRole('Admin', 'Treasurer', 'Credit Supervisor'), async (req, res, next) => {
    try {
      const {
        year,
        month,
        template_id,
        basis = 'm',
        n_months = 1,
        notes,
      } = req.body || {};

      if (!year || !month || !template_id) {
        return res.status(400).json({
          error: 'year, month and template_id are required.',
        });
      }

      const numericYear = Number(year);
      const numericMonth = Number(month);

      if (!Number.isInteger(numericYear) || numericYear < 2000) {
        return res.status(400).json({ error: 'Valid year is required.' });
      }

      if (!Number.isInteger(numericMonth) || numericMonth < 1 || numericMonth > 12) {
        return res.status(400).json({ error: 'month must be between 1 and 12.' });
      }

      const { rows } = await query(
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
        [
          numericYear,
          numericMonth,
          template_id,
          basis || 'm',
          Number(n_months) || 1,
          req.user.id,
          notes || null,
        ]
      );

      return res.status(201).json({
        snapshot_id: rows[0]?.snapshot_id || null,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, req, res, next) => {
    // eslint-disable-line no-unused-vars
    const status = error.status || error.statusCode || 500;
    const payload = {
      error:
        error.code ||
        (status === 404
          ? 'not_found'
          : status === 401
            ? 'unauthorized'
            : status === 403
              ? 'forbidden'
              : 'internal_error'),
      message:
        error.expose ? error.message : status < 500 ? error.message : 'An internal error occurred.',
    };

    if (status >= 500) {
      console.error('[reportController]', error);
    }

    return res.status(status).json(payload);
  });

  return router;
}

module.exports = {
  createReportController,
};
