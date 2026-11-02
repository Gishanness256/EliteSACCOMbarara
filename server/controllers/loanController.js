'use strict';

const express = require('express');
const { query, pool } = require('../db');

function validNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDateInput(value, fallback = new Date()) {
  const date = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
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

async function listLoans(req, res, next) {
  try {
    const { status, q, limit = '50', offset = '0' } = req.query;
    const params = [];
    const clauses = [];

    if (status) {
      params.push(status);
      clauses.push(`l.status = $${params.length}::loan_lifecycle_status`);
    }

    if (q) {
      params.push(`%${String(q).toLowerCase()}%`);
      clauses.push(
        `(LOWER(l.borrower_name) LIKE $${params.length} OR LOWER(COALESCE(l.account_number, '')) LIKE $${params.length})`
      );
    }

    const pageLimit = Math.min(Math.max(validNumber(limit, 50), 1), 200);
    const pageOffset = Math.max(validNumber(offset, 0), 0);

    params.push(pageLimit, pageOffset);

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await query(
      `
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
        ${whereClause}
        ORDER BY l.disbursed_on DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params
    );

    return res.json({ loans: rows });
  } catch (error) {
    return next(error);
  }
}

async function getLoanById(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Valid loan id is required.' });
    }

    const { rows } = await query(
      `
        SELECT
          l.*,
          loan_outstanding_balance(l.id, CURRENT_DATE) AS outstanding_balance,
          loan_ageing_bucket(l.id, CURRENT_DATE) AS ageing_bucket,
          COALESCE((SELECT SUM(amount) FROM loan_repayments r WHERE r.loan_id = l.id), 0) AS total_paid
        FROM loans l
        WHERE l.id = $1
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Loan not found.' });
    }

    return res.json({ loan: rows[0] });
  } catch (error) {
    return next(error);
  }
}

async function createLoanRepayment(req, res, next) {
  try {
    const loanId = Number(req.params.id);
    const { amount, payment_date, payment_type } = req.body || {};

    if (!Number.isInteger(loanId) || loanId <= 0) {
      return res.status(400).json({ error: 'Valid loan id is required.' });
    }

    if (!amount || Number(amount) <= 0 || !payment_date) {
      return res.status(400).json({
        error: 'amount (positive) and payment_date are required.',
      });
    }

    const repaymentAmount = Number(amount);
    const paymentDate = String(payment_date);

    const result = await withTransaction(async (client) => {
      const { rows: loanRows } = await client.query(
        `
          SELECT loan_outstanding_balance(id, $2::date) AS balance, disbursed_on
          FROM loans
          WHERE id = $1
        `,
        [loanId, paymentDate]
      );

      if (!loanRows.length) {
        throw Object.assign(new Error('Loan not found.'), { status: 404 });
      }

      const balance = Number(loanRows[0].balance || 0);
      if (repaymentAmount > balance) {
        throw Object.assign(
          new Error(`Amount exceeds outstanding balance on ${paymentDate} (${balance}).`),
          { status: 400 }
        );
      }

      const disbursedOn = new Date(loanRows[0].disbursed_on);
      const enteredDate = new Date(paymentDate);
      if (enteredDate < disbursedOn) {
        throw Object.assign(new Error('Payment date cannot be before the loan disbursement date.'), {
          status: 400,
        });
      }

      const { rows } = await client.query(
        `
          INSERT INTO loan_repayments (
            loan_id,
            payment_date,
            amount,
            payment_type,
            officer_id,
            officer_initials
          )
          VALUES ($1, $2::date, $3, $4::payment_type, $5, $6)
          RETURNING *
        `,
        [
          loanId,
          paymentDate,
          repaymentAmount,
          payment_type || 'Installment',
          req.user.id,
          req.user.initials || '',
        ]
      );

      return rows[0];
    });

    return res.status(201).json({ repayment: result });
  } catch (error) {
    return next(error);
  }
}

async function listLoanRequests(req, res, next) {
  try {
    const { status, limit = '50', offset = '0' } = req.query;
    const params = [];
    const clauses = [];

    if (status) {
      params.push(status);
      clauses.push(`r.status = $${params.length}::loan_status`);
    }

    const pageLimit = Math.min(Math.max(validNumber(limit, 50), 1), 200);
    const pageOffset = Math.max(validNumber(offset, 0), 0);

    params.push(pageLimit, pageOffset);

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await query(
      `
        SELECT
          r.id,
          r.reference,
          r.request_date,
          r.applicant_type::text AS applicant_type,
          r.applicant_name,
          r.telephone,
          r.category,
          r.term_months,
          r.principal,
          r.rate_monthly,
          r.status::text AS status,
          r.remark,
          r.created_at,
          u.name AS requested_by_name
        FROM loan_requests r
        LEFT JOIN users u ON u.id = r.requested_by
        ${whereClause}
        ORDER BY r.request_date DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params
    );

    return res.json({ requests: rows });
  } catch (error) {
    return next(error);
  }
}

async function createLoanRequest(req, res, next) {
  try {
    const {
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
      nin,
    } = req.body || {};

    if (!applicant_name || !telephone || !category || !term_months || !principal || !rate_monthly) {
      return res.status(400).json({
        error:
          'applicant_name, telephone, category, term_months, principal and rate_monthly are required.',
      });
    }

    const termMonths = Number(term_months);
    if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 60) {
      return res.status(400).json({
        error: 'term_months must be between 1 and 60.',
      });
    }

    const result = await withTransaction(async (client) => {
      const { rows: seqRows } = await client.query(
        `
          SELECT COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq
          FROM loan_requests
          WHERE reference LIKE 'LR-%'
        `
      );

      const reference = `LR-${String(seqRows[0].next_seq).padStart(4, '0')}`;

      const { rows } = await client.query(
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
          applicant_type || 'm',
          account_number || null,
          applicant_name,
          telephone,
          email || null,
          address || null,
          category,
          termMonths,
          Number(principal),
          Number(rate_monthly),
          req.user.id,
          req.user.initials || '',
          nin || null,
        ]
      );

      return rows[0];
    });

    return res.status(201).json({ request: result });
  } catch (error) {
    return next(error);
  }
}

async function updateLoanRequest(req, res,`*

