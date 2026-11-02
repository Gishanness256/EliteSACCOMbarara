'use strict';

/**
 * server/services/loanService.js
 *
 * Reusable service for loan and loan-request workflows.
 *
 * Expected DB contract:
 *   - db.query(sql, params)
 *   - optional db.withTransaction(userId, sessionId, fn)
 *
 * The service mirrors the business rules already implemented in server/server.js
 * but keeps that logic in one place for easier testing and maintenance.
 */

function normalizeLoan(row = {}) {
  if (!row) return null;

  return {
    id: row.id ?? null,
    reference: row.reference ?? null,
    requestId: row.request_id ?? row.requestId ?? null,
    accountNumber: row.account_number ?? row.accountNumber ?? null,
    nonMemberId: row.non_member_id ?? row.nonMemberId ?? null,
    borrowerName: row.borrower_name ?? row.borrowerName ?? null,
    telephone: row.telephone ?? null,
    category: row.category ?? null,
    termMonths: row.term_months ?? row.termMonths ?? null,
    principal: row.principal ?? null,
    rateMonthly: row.rate_monthly ?? row.rateMonthly ?? null,
    disbursedOn: row.disbursed_on ?? row.disbursedOn ?? null,
    dueDate: row.due_date ?? row.dueDate ?? null,
    status: row.status ?? null,
    monthlyInstallment: row.monthly_installment ?? row.monthlyInstallment ?? null,
    totalPayable: row.total_payable ?? row.totalPayable ?? null,
    totalPaid: row.total_paid ?? row.totalPaid ?? null,
    outstandingBalance: row.outstanding_balance ?? row.outstandingBalance ?? null,
    ageingBucket: row.ageing_bucket ?? row.ageingBucket ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    officerId: row.officer_id ?? row.officerId ?? null,
    officerInitials: row.officer_initials ?? row.officerInitials ?? null,
  };
}

function normalizeLoanRequest(row = {}) {
  if (!row) return null;

  return {
    id: row.id ?? null,
    reference: row.reference ?? null,
    requestDate: row.request_date ?? row.requestDate ?? null,
    applicantType: row.applicant_type ?? row.applicantType ?? null,
    accountNumber: row.account_number ?? row.accountNumber ?? null,
    applicantName: row.applicant_name ?? row.applicantName ?? null,
    telephone: row.telephone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    category: row.category ?? null,
    termMonths: row.term_months ?? row.termMonths ?? null,
    principal: row.principal ?? null,
    rateMonthly: row.rate_monthly ?? row.rateMonthly ?? null,
    status: row.status ?? null,
    remark: row.remark ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    requestedBy: row.requested_by ?? row.requestedBy ?? null,
    requestedByInitials: row.requested_by_initials ?? row.requestedByInitials ?? null,
    decidedBy: row.decided_by ?? row.decidedBy ?? null,
    decidedOn: row.decided_on ?? row.decidedOn ?? null,
    requestedByName: row.requested_by_name ?? row.requestedByName ?? null,
  };
}

function normalizeRepayment(row = {}) {
  if (!row) return null;

  return {
    id: row.id ?? null,
    loanId: row.loan_id ?? row.loanId ?? null,
    paymentDate: row.payment_date ?? row.paymentDate ?? null,
    amount: row.amount ?? null,
    paymentType: row.payment_type ?? row.paymentType ?? null,
    officerId: row.officer_id ?? row.officerId ?? null,
    officerInitials: row.officer_initials ?? row.officerInitials ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

function createLoanService({ db, logger } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('loanService: a valid db instance with query() is required');
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

    // Fallback for plain db.query implementations
    // Best effort; this is only used when no transaction helper exists.
    try {
      await db.query('BEGIN');
      const result = await fn({
        query: db.query,
      });
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
    async listLoans({ status, q, limit = 50 } = {}) {
      const params = [];
      const clauses = [];

      if (status) {
        params.push(status);
        clauses.push(`l.status = $${params.length}::loan_lifecycle_status`);
      }

      if (q) {
        const value = `%${String(q).toLowerCase()}%`;
        params.push(value);
        clauses.push(
          `(LOWER(l.borrower_name) LIKE $${params.length} OR LOWER(COALESCE(l.account_number, '')) LIKE $${params.length})`,
        );
      }

      params.push(parseInt(limit, 10) || 50);

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

      const sql = `
        SELECT
          l.id,
          l.reference,
          l.account_number,
          l.borrower_name,
          l.telephone,
          l.category,
          l.term_months,
          l.principal,
          l.rate_monthly,
          l.disbursed_on,
          l.due_date,
          l.status::text AS status,
          l.monthly_installment,
          l.total_payable,
          COALESCE((SELECT SUM(amount) FROM loan_repayments r WHERE r.loan_id = l.id), 0) AS total_paid,
          loan_outstanding_balance(l.id, CURRENT_DATE) AS outstanding_balance,
          l.created_at
        FROM loans l
        ${where}
        ORDER BY l.disbursed_on DESC
        LIMIT $${params.length}
      `;

      const { rows } = await db.query(sql, params);
      return (rows || []).map(normalizeLoan);
    },

    async getLoanById(id) {
      const loanId = parseInt(id, 10);
      if (!Number.isFinite(loanId)) {
        throw new Error('loanId must be a valid number');
      }

      const sql = `
        SELECT
          l.*,
          loan_outstanding_balance(l.id, CURRENT_DATE) AS outstanding_balance,
          loan_ageing_bucket(l.id, CURRENT_DATE) AS ageing_bucket,
          COALESCE((SELECT SUM(amount) FROM loan_repayments r WHERE r.loan_id = l.id), 0) AS total_paid
        FROM loans l
        WHERE l.id = $1
      `;

      const { rows } = await db.query(sql, [loanId]);
      return rows && rows[0] ? normalizeLoan(rows[0]) : null;
    },

    async createRepayment({
      loanId,
      amount,
      paymentDate,
      paymentType = 'Installment',
      officerId,
      officerInitials,
      sessionId = null,
    } = {}) {
      if (!loanId || !amount || Number(amount) <= 0 || !paymentDate) {
        throw new Error('amount (positive) and payment_date are required.');
      }

      const parsedLoanId = parseInt(loanId, 10);
      const parsedAmount = Number(amount);

      return runInTransaction(officerId ?? null, sessionId, async (tx) => {
        const { rows: balanceRows } = await tx.query(
          `
            SELECT
              loan_outstanding_balance(id, $2) AS balance,
              disbursed_on
            FROM loans
            WHERE id = $1
          `,
          [parsedLoanId, paymentDate],
        );

        if (!balanceRows.length) {
          throw new Error('Loan not found.');
        }

        const balance = Number(balanceRows[0].balance || 0);
        if (parsedAmount > balance) {
          throw new Error(`Amount exceeds balance due on ${paymentDate} (${balance}).`);
        }

        const disbursedOn = balanceRows[0].disbursed_on
          ? new Date(balanceRows[0].disbursed_on).toISOString().slice(0, 10)
          : null;

        if (disbursedOn && paymentDate < disbursedOn) {
          throw new Error('Payment date cannot be before the loan disbursement date.');
        }

        const { rows } = await tx.query(
          `
            INSERT INTO loan_repayments (
              loan_id,
              payment_date,
              amount,
              payment_type,
              officer_id,
              officer_initials
            )
            VALUES ($1, $2, $3, $4::payment_type, $5, $6)
            RETURNING *
          `,
          [
            parsedLoanId,
            paymentDate,
            parsedAmount,
            paymentType || 'Installment',
            officerId ?? null,
            officerInitials ?? null,
          ],
        );

        const created = rows[0];
        log('Loan repayment recorded', {
          loanId: parsedLoanId,
          amount: parsedAmount,
          paymentDate,
          officerId,
        });

        return normalizeRepayment(created);
      });
    },

    async listLoanRequests({ status, limit = 50 } = {}) {
      const params = [];
      let where = '';

      if (status) {
        params.push(status);
        where = `WHERE r.status = $1::loan_status`;
      }

      params.push(parseInt(limit, 10) || 50);

      const sql = `
        SELECT
          r.id,
          r.reference,
          r.request_date,
          r.applicant_type::text AS applicant_type,
          r.applicant_name,
          r.telephone,
          r.email,
          r.address,
          r.category,
          r.term_months,
          r.principal,
          r.rate_monthly,
          r.status::text AS status,
          r.remark,
          r.created_at,
          r.requested_by,
          r.requested_by_initials,
          r.decided_by,
          r.decided_on,
          u.name AS requested_by_name
        FROM loan_requests r
        LEFT JOIN users u ON u.id = r.requested_by
        ${where}
        ORDER BY r.request_date DESC
        LIMIT $${params.length}
      `;

      const { rows } = await db.query(sql, params);
      return (rows || []).map(normalizeLoanRequest);
    },

    async getLoanRequestById(id) {
      const requestId = parseInt(id, 10);
      if (!Number.isFinite(requestId)) {
        throw new Error('requestId must be a valid number');
      }

      const sql = `
        SELECT
          r.*,
          u.name AS requested_by_name
        FROM loan_requests r
        LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.id = $1
      `;

      const { rows } = await db.query(sql, [requestId]);
      return rows && rows[0] ? normalizeLoanRequest(rows[0]) : null;
    },

    async createLoanRequest({
      applicantType,
      accountNumber,
      applicantName,
      telephone,
      email,
      address,
      category,
      termMonths,
      principal,
      rateMonthly,
      nin = null,
      officerId,
      officerInitials,
      sessionId = null,
    } = {}) {
      if (!applicantName || !telephone || !category || !termMonths || !principal || !rateMonthly) {
        throw new Error(
          'applicant_name, telephone, category, term_months, principal and rate_monthly are required.',
        );
      }

      const parsedTermMonths = Number(termMonths);
      const parsedPrincipal = Number(principal);
      const parsedRateMonthly = Number(rateMonthly);

      if (parsedTermMonths < 1 || parsedTermMonths > 60) {
        throw new Error('term_months must be between 1 and 60.');
      }

      return runInTransaction(officerId ?? null, sessionId, async (tx) => {
        const { rows: seqRows } = await tx.query(
          `
            SELECT
              COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq
            FROM loan_requests
            WHERE reference LIKE 'LR-%'
          `,
        );

        const reference = `LR-${String(seqRows[0].next_seq).padStart(4, '0')}`;

        const { rows } = await tx.query(
          `
            INSERT INTO loan_requests (
              reference,
              request_date,
              applicant_type,
              account_number,
              applicant_name,
              telephone,
              email,
              address,
              category,
              term_months,
              principal,
              rate_monthly,
              status,
              requested_by,
              requested_by_initials,
              nin
            )
            VALUES (
              $1,
              CURRENT_DATE,
              $2::applicant_type,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10,
              $11,
              'Pending'::loan_status,
              $12,
              $13,
              $14
            )
            RETURNING *
          `,
          [
            reference,
            applicantType || 'm',
            accountNumber || null,
            applicantName,
            telephone,
            email || null,
            address || null,
            category,
            parsedTermMonths,
            parsedPrincipal,
            parsedRateMonthly,
            officerId ?? null,
            officerInitials ?? null,
            nin || null,
          ],
        );

        const createdRequest = rows[0];
        log('Loan request created', {
          requestId: createdRequest.id,
          applicantName,
          category,
          officerId,
        });

        return normalizeLoanRequest(createdRequest);
      });
    },

    async updateLoanRequestStatus({
      id,
      status,
      remark,
      officerId,
      officerInitials,
      sessionId = null,
    } = {}) {
      const requestId = parseInt(id, 10);
      if (!Number.isFinite(requestId)) {
        throw new Error('requestId must be a valid number');
      }

      if (!['Approved', 'Rejected', 'On Hold'].includes(status)) {
        throw new Error('status must be Approved, Rejected or On Hold.');
      }

      return runInTransaction(officerId ?? null, sessionId, async (tx) => {
        const { rows: requestRows } = await tx.query(
          `
            UPDATE loan_requests
               SET status = $2::loan_status,
                   remark = $3,
                   decided_by = $4,
                   decided_on = CURRENT_DATE,
                   updated_at = NOW()
             WHERE id = $1 AND status IN ('Pending', 'On Hold')
             RETURNING *
          `,
          [requestId, status, remark || null, officerId ?? null],
        );

        if (!requestRows.length) {
          throw new Error('Request not found or already decided.');
        }

        const request = requestRows[0];

        if (status === 'Approved') {
          const { rows: loanSeqRows } = await tx.query(
            `
              SELECT
                COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq
              FROM loans
              WHERE reference LIKE 'LN-%'
            `,
          );

          const loanReference = `LN-${String(loanSeqRows[0].next_seq).padStart(4, '0')}`;

          const { rows: loanRows } = await tx.query(
            `
              INSERT INTO loans (
                reference,
                request_id,
                account_number,
                non_member_id,
                borrower_name,
                telephone,
                category,
                term_months,
                principal,
                rate_monthly,
                disbursed_on,
                status,
                officer_id,
                officer_initials
              )
              VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                CURRENT_DATE, 'Active'::loan_lifecycle_status, $11, $12
              )
              RETURNING *
            `,
            [
              loanReference,
              request.id,
              request.account_number,
              request.non_member_id,
              request.applicant_name,
              request.telephone,
              request.category,
              request.term_months,
              request.principal,
              request.rate_monthly,
              officerId ?? null,
              officerInitials ?? null,
            ],
          );

          await tx.query('SELECT generate_loan_schedule($1)', [loanRows[0].id]);

          const createdLoan = normalizeLoan(loanRows[0]);

          log('Loan request approved and loan created', {
            requestId: request.id,
            loanId: createdLoan && createdLoan.id,
            officerId,
          });

          return {
            request: normalizeLoanRequest(request),
            loan: createdLoan,
          };
        }

        return {
          request: normalizeLoanRequest(request),
          loan: null,
        };
      });
    },
  };
}

module.exports = createLoanService;
module.exports.createLoanService = createLoanService;
module.exports.normalizeLoan = normalizeLoan;
module.exports.normalizeLoanRequest = normalizeLoanRequest;
module.exports.normalizeRepayment = normalizeRepayment;
