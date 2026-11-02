'use strict';

/**
 * server/services/savingsService.js
 *
 * Reusable service for savings transactions.
 *
 * Expected DB contract:
 *   - db.query(sql, params)
 *   - optional db.withTransaction(userId, sessionId, fn)
 *
 * Covers:
 *   - listing savings transactions
 *   - fetching a transaction by id
 *   - creating deposit/withdrawal entries
 *   - checking savings balance
 */

function normalizeSavingsTransaction(row = {}) {
  if (!row) return null;

  return {
    id: row.id ?? null,
    reference: row.reference ?? null,
    accountNumber: row.account_number ?? row.accountNumber ?? null,
    direction: row.direction ?? null,
    amount: row.amount ?? null,
    occurredAt: row.occurred_at ?? row.occurredAt ?? null,
    channel: row.channel ?? null,
    slipNumber: row.slip_number ?? row.slipNumber ?? null,
    remarks: row.remarks ?? null,
    officerId: row.officer_id ?? row.officerId ?? null,
    officerInitials: row.officer_initials ?? row.officerInitials ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

function createSavingsService({ db, logger } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('savingsService: a valid db instance with query() is required');
  }

  const log = (message, meta) => {
    if (logger && typeof logger.info === 'function') {
      logger.info(message, meta || {});
    }
  };

  const runInTransaction = async (userId, sessionId, fn) => {
    if (typeof db.withTransaction === 'function') {
      return db.withTransaction(userId ?? null, sessionId ?? null, fn);
    }

    try {
      await db.query('BEGIN');
      const result = await fn({ query: db.query });
      await db.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await db.query('ROLLBACK');
      } catch (_) {
        // ignore rollback errors
      }
      throw err;
    }
  };

  return {
    async listTransactions({ account, limit = 50 } = {}) {
      const params = [];
      let where = '';

      if (account) {
        params.push(account);
        where = 'WHERE account_number = $1';
      }

      params.push(parseInt(limit, 10) || 50);

      const sql = `
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
        ${where}
        ORDER BY occurred_at DESC
        LIMIT $${params.length}
      `;

      const { rows } = await db.query(sql, params);
      return (rows || []).map(normalizeSavingsTransaction);
    },

    async getTransactionById(id) {
      const transactionId = parseInt(id, 10);
      if (!Number.isFinite(transactionId)) {
        throw new Error('transactionId must be a valid number');
      }

      const sql = `
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
        WHERE id = $1
      `;

      const { rows } = await db.query(sql, [transactionId]);
      return rows && rows[0] ? normalizeSavingsTransaction(rows[0]) : null;
    },

    async getBalance(accountNumber) {
      if (!accountNumber) {
        throw new Error('accountNumber is required.');
      }

      const { rows } = await db.query(
        `
          SELECT
            COALESCE(
              SUM(CASE direction WHEN 'Deposit' THEN amount ELSE -amount END),
              0
            ) AS balance
          FROM savings_transactions
          WHERE account_number = $1
        `,
        [accountNumber],
      );

      const balance = rows && rows[0] ? Number(rows[0].balance || 0) : 0;
      return balance;
    },

    async createTransaction({
      accountNumber,
      direction,
      amount,
      occurredAt,
      channel = 'Counter / Cash',
      slipNumber = null,
      remarks = null,
      officerId,
      officerInitials,
      sessionId = null,
    } = {}) {
      if (!accountNumber || !direction || !amount || Number(amount) <= 0) {
        throw new Error('account_number, direction (Deposit/Withdrawal) and positive amount are required.');
      }

      const parsedAmount = Number(amount);
      const normalizedDirection = String(direction).trim();

      if (!['Deposit', 'Withdrawal'].includes(normalizedDirection)) {
        throw new Error('direction must be either Deposit or Withdrawal.');
      }

      return runInTransaction(officerId ?? null, sessionId, async (tx) => {
        if (normalizedDirection === 'Withdrawal') {
          const { rows: balRows } = await tx.query(
            `
              SELECT
                COALESCE(
                  SUM(CASE direction WHEN 'Deposit' THEN amount ELSE -amount END),
                  0
                ) AS balance
              FROM savings_transactions
              WHERE account_number = $1
            `,
            [accountNumber],
          );

          const currentBalance = Number(balRows[0]?.balance || 0);
          if (currentBalance < parsedAmount) {
            throw new Error(`Withdrawal exceeds the savings balance (${currentBalance}).`);
          }
        }

        const { rows: seqRows } = await tx.query(
          `
            SELECT
              COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq
            FROM savings_transactions
            WHERE reference LIKE 'SV-%'
          `,
        );

        const reference = `SV-${String(seqRows[0].next_seq).padStart(6, '0')}`;

        const { rows } = await tx.query(
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
            VALUES (
              $1,
              $2,
              $3::tx_direction,
              $4,
              $5,
              $6::savings_channel,
              $7,
              $8,
              $9,
              $10
            )
            RETURNING *
          `,
          [
            reference,
            accountNumber,
            normalizedDirection,
            parsedAmount,
            occurredAt ? new Date(occurredAt) : new Date(),
            channel || 'Counter / Cash',
            slipNumber || null,
            remarks || null,
            officerId ?? null,
            officerInitials ?? null,
          ],
        );

        const created = rows[0];
        log('Savings transaction created', {
          accountNumber,
          direction: normalizedDirection,
          amount: parsedAmount,
          officerId,
          reference,
        });

        return normalizeSavingsTransaction(created);
      });
    },
  };
}

module.exports = createSavingsService;
module.exports.createSavingsService = createSavingsService;
module.exports.normalizeSavingsTransaction = normalizeSavingsTransaction;
