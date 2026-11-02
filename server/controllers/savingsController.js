'use strict';

const express = require('express');
const { query, pool } = require('../db');

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listSavings(req, res, next) {
  try {
    const { account, limit = '50', offset = '0' } = req.query;
    const params = [];
    let whereClause = '';

    if (account) {
      params.push(account);
      whereClause = 'WHERE account_number = $1';
    }

    const pageLimit = Math.min(Math.max(toNumber(limit, 50), 1), 500);
    const pageOffset = Math.max(toNumber(offset, 0), 0);

    params.push(pageLimit, pageOffset);

    const { rows } = await query(
      `
        SELECT
          id,
          reference,
          account_number,
          direction::text AS direction,
          amount,
          occurred_at,
          channel::text AS channel,
          slip_number,
          remarks,
          officer_id,
          officer_initials,
          created_at
        FROM savings_transactions
        ${whereClause}
        ORDER BY occurred_at DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params
    );

    return res.json({ transactions: rows });
  } catch (error) {
    return next(error);
  }
}

async function getSavingsByAccount(req, res, next) {
  try {
    const account = String(req.params.account || '').trim();

    if (!account) {
      return res.status(400).json({ error: 'Account number is required.' });
    }

    const { rows } = await query(
      `
        SELECT
          id,
          reference,
          account_number,
          direction::text AS direction,
          amount,
          occurred_at,
          channel::text AS channel,
          slip_number,
          remarks,
          officer_id,
          officer_initials,
          created_at
        FROM savings_transactions
        WHERE account_number = $1
        ORDER BY occurred_at DESC
      `,
      [account]
    );

    return res.json({ transactions: rows });
  } catch (error) {
    return next(error);
  }
}

async function createSavingsTransaction(req, res, next) {
  try {
    const {
      account_number,
      direction,
      amount,
      occurred_at,
      channel,
      slip_number,
      remarks,
    } = req.body || {};

    if (!account_number || !direction || !amount || Number(amount) <= 0) {
      return res.status(400).json({
        error: 'account_number, direction, and positive amount are required.',
      });
    }

    const normalizedDirection = String(direction).trim();
    if (!['Deposit', 'Withdrawal'].includes(normalizedDirection)) {
      return res.status(400).json({
        error: 'direction must be either Deposit or Withdrawal.',
      });
    }

    const txnAmount = Number(amount);

    const result = await withTransaction(async (client) => {
      if (normalizedDirection === 'Withdrawal') {
        const { rows: balanceRows } = await client.query(
          `
            SELECT
              COALESCE(
                SUM(CASE WHEN direction = 'Deposit' THEN amount ELSE -amount END),
                0
              ) AS balance
            FROM savings_transactions
            WHERE account_number = $1
          `,
          [account_number]
        );

        const balance = Number(balanceRows[0]?.balance || 0);

        if (balance < txnAmount) {
          throw Object.assign(
            new Error(`Withdrawal exceeds savings balance (${balance}).`),
            { status: 400 }
          );
        }
      }

      const { rows: seqRows } = await client.query(
        `
          SELECT
            COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq
          FROM savings_transactions
          WHERE reference LIKE 'SV-%'
        `
      );

      const reference = `SV-${String(seqRows[0].next_seq).padStart(6, '0')}`;

      const { rows } = await client.query(
        `
          INSERT INTO savings_transactions (
            reference,
            account_number,
            direction,
            amount,
            occurred_at,
            channel,
            slip_number,
            remarks,
            officer_id,
            officer_initials
          )
          VALUES ($1, $2, $3::tx_direction, $4, $5, $6::savings_channel, $7, $8, $9, $10)
          RETURNING *
        `,
        [
          reference,
          account_number,
          normalizedDirection,
          txnAmount,
          occurred_at ? new Date(occurred_at) : new Date(),
          channel || 'Counter / Cash',
          slip_number || null,
          remarks || null,
          req.user.id,
          req.user.initials || '',
        ]
      );

      return rows[0];
    });

    return res.status(201).json({ transaction: result });
  } catch (error) {
    return next(error);
  }
}

async function importSavingsTransactions(req, res, next) {
  try {
    const input = Array.isArray(req.body?.rows) ? req.body.rows : Array.isArray(req.body) ? req.body : [];

    if (!input.length) {
      return res.status(400).json({ error: 'No rows provided for import.' });
    }

    if (input.length > 5000) {
      return res.status(400).json({
        error: 'Import is limited to 5000 rows per request.',
      });
    }

    const ordered = input
      .map((row, index) => ({ row, index, timestamp: new Date(row.date || row.occurred_at || 0).getTime() || 0 }))
      .sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);

    let runningBalance = {};
    const good = [];
    const skipped = [];

    for (const { row, index } of ordered) {
      try {
        const payload = {
          account_number: row.account_number || row.acc || row.account || null,
          direction: row.direction || row.type || null,
          amount: row.amount || row.amt || null,
          occurred_at: row.date || row.occurred_at || new Date().toISOString(),
          channel: row.channel || 'Counter / Cash',
          slip_number: row.slip_number || row.slip || null,
          remarks: row.remarks || row.note || null,
        };

        if (!payload.account_number || !payload.direction || !payload.amount) {
          throw new Error('Missing account_number, direction, or amount.');
        }

        const localDirection = String(payload.direction).trim();
        if (!['Deposit', 'Withdrawal'].includes(localDirection)) {
          throw new Error('direction must be Deposit or Withdrawal.');
        }

        const amount = Number(payload.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error('amount must be a positive number.');
        }

        const balanceKey = payload.account_number;
        const balance = Number(runningBalance[balanceKey] || 0);

        if (localDirection === 'Withdrawal' && balance < amount) {
          throw new Error(`Withdrawal exceeds running balance for ${payload.account_number}.`);
        }

        // Update running balance for chronological validation.
        runningBalance[balanceKey] =
          localDirection === 'Deposit'
            ? balance + amount
            : balance - amount;

        good.push({
          reference: null,
          account_number: payload.account_number,
          direction: localDirection,
          amount,
          occurred_at: payload.occurred_at,
          channel: payload.channel,
          slip_number: payload.slip_number,
          remarks: payload.remarks,
        });
      } catch (error) {
        skipped.push({
          row: index + 1,
          error: error.message,
        });
      }
    }

    if (good.length) {
      await withTransaction(async (client) => {
        for (const item of good) {
          const { rows: seqRows } = await client.query(
            `
              SELECT
                COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq
              FROM savings_transactions
              WHERE reference LIKE 'SV-%'
            `
          );

          const reference = `SV-${String(seqRows[0].next_seq).padStart(6, '0')}`;

          await client.query(
            `
              INSERT INTO savings_transactions (
                reference,
                account_number,
                direction,
                amount,
                occurred_at,
                channel,
                slip_number,
                remarks,
                officer_id,
                officer_initials
              )
              VALUES ($1, $2, $3::tx_direction, $4, $5, $6::savings_channel, $7, $8, $9, $10)
            `,
            [
              reference,
              item.account_number,
              item.direction,
              item.amount,
              item.occurred_at,
              item.channel,
              item.slip_number,
              item.remarks,
              req.user.id,
              req.user.initials || '',
            ]
          );
        }
      });
    }

    return res.status(good.length ? 201 : 400).json({
      imported: good.length,
      skipped: skipped.length,
      errors: skipped.slice(0, 100),
    });
  } catch (error) {
    return next(error);
  }
}

function createSavingsController({ authRequired, requirePermission }) {
  const router = express.Router();

  router.use(authRequired);

  router.get('/', listSavings);
  router.get('/:account', getSavingsByAccount);
  router.post('/', requirePermission('ack_savings'), createSavingsTransaction);
  router.post('/import', requirePermission('ack_savings'), importSavingsTransactions);

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
      console.error('[savingsController]', error);
    }

    return res.status(status).json(payload);
  });

  return router;
}

module.exports = {
  listSavings,
  getSavingsByAccount,
  createSavingsTransaction,
  importSavingsTransactions,
  createSavingsController,
};
