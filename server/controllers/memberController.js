'use strict';

const express = require('express');
const { query, pool } = require('../db');

function normalizePhone(value) {
  if (!value) return '';
  const v = String(value).trim().replace(/[\s\-().]/g, '');
  if (!v) return '';
  return v.replace(/^\+?256/, '').replace(/^0/, '').startsWith('7') ? `0${v.replace(/^\+?256/, '').replace(/^0/, '')}` : v;
}

function validNumber(value, fallback = 0) {
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

async function listMembers(req, res, next) {
  try {
    const { q, limit = '500', offset = '0' } = req.query;
    const params = [];
    const clauses = [];

    if (q) {
      params.push(`%${String(q).toLowerCase()}%`);
      clauses.push(
        `LOWER(first_name || ' ' || last_name || ' ' || account_number) LIKE $${params.length}`
      );
    }

    const pageLimit = Math.min(Math.max(validNumber(limit, 500), 1), 1000);
    const pageOffset = Math.max(validNumber(offset, 0), 0);

    params.push(pageLimit, pageOffset);

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await query(
      `
        SELECT
          id,
          account_number,
          first_name,
          last_name,
          gender::text AS gender,
          date_of_birth,
          telephone,
          email,
          nin,
          address,
          is_active,
          created_at
        FROM members
        ${whereClause}
        ORDER BY account_number
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params
    );

    return res.json({ members: rows });
  } catch (error) {
    return next(error);
  }
}

async function getMemberByAccount(req, res, next) {
  try {
    const account = String(req.params.account || '').trim();

    if (!account) {
      return res.status(400).json({ error: 'Account number is required.' });
    }

    const { rows } = await query(
      `
        SELECT
          id,
          account_number,
          first_name,
          last_name,
          gender::text AS gender,
          date_of_birth,
          telephone,
          email,
          nin,
          address,
          is_active,
          created_at
        FROM members
        WHERE account_number = $1
      `,
      [account]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    return res.json({ member: rows[0] });
  } catch (error) {
    return next(error);
  }
}

async function createMember(req, res, next) {
  try {
    const {
      first_name,
      last_name,
      gender,
      date_of_birth,
      telephone,
      nin,
      address,
      email,
      photo,
    } = req.body || {};

    if (!first_name || !last_name || !gender || !telephone || !nin) {
      return res.status(400).json({
        error: 'first_name, last_name, gender, telephone and nin are required.',
      });
    }

    const safeGender = String(gender).trim().toUpperCase();
    if (!['M', 'F'].includes(safeGender)) {
      return res.status(400).json({ error: 'gender must be M or F.' });
    }

    const cleanPhone = normalizePhone(telephone);
    if (!cleanPhone) {
      return res.status(400).json({ error: 'Invalid telephone number.' });
    }

    const cleanNin = String(nin).trim().toUpperCase();
    if (!cleanNin) {
      return res.status(400).json({ error: 'NIN is required.' });
    }

    const result = await withTransaction(async (client) => {
      const { rows: seqRows } = await client.query(
        `
          SELECT COALESCE(
            MAX(CAST(SUBSTRING(account_number FROM POSITION(' ' IN account_number) + 1) AS INTEGER)),
            0
          ) + 1 AS next_seq
          FROM members
          WHERE account_number LIKE 'ES-' || $1 || ' %'
        `,
        [safeGender]
      );

      const sequence = Number(seqRows[0].next_seq || 1);
      const accountNumber = `ES-${safeGender} ${String(sequence).padStart(6, '0')}`;

      const { rows } = await client.query(
        `
          INSERT INTO members (
            account_number,
            first_name,
            last_name,
            gender,
            date_of_birth,
            address,
            nin,
            telephone,
            email,
            photo,
            created_by
          )
          VALUES ($1, $2, $3, $4::member_gender, $5, $6, $7, $8, $9, $10, $11)
          RETURNING *
        `,
        [
          accountNumber,
          first_name.trim(),
          last_name.trim(),
          safeGender,
          date_of_birth || null,
          address || null,
          cleanNin,
          cleanPhone,
          email || null,
          photo || null,
          req.user.id,
        ]
      );

      return rows[0];
    });

    return res.status(201).json({ member: result });
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(409).json({
        error: 'A member with that NIN or phone number already exists.',
      });
    }
    return next(error);
  }
}

async function updateMember(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Valid member id is required.' });
    }

    const { first_name, last_name, gender, date_of_birth, telephone, nin, address, email, photo, is_active } =
      req.body || {};

    const updates = [];
    const params = [];

    if (first_name !== undefined) {
      updates.push(`first_name = $${params.length + 1}`);
      params.push(String(first_name).trim());
    }

    if (last_name !== undefined) {
      updates.push(`last_name = $${params.length + 1}`);
      params.push(String(last_name).trim());
    }

    if (gender !== undefined) {
      const safeGender = String(gender).trim().toUpperCase();
      if (!['M', 'F'].includes(safeGender)) {
        return res.status(400).json({ error: 'gender must be M or F.' });
      }
      updates.push(`gender = $${params.length + 1}::member_gender`);
      params.push(safeGender);
    }

    if (date_of_birth !== undefined) {
      updates.push(`date_of_birth = $${params.length + 1}`);
      params.push(date_of_birth || null);
    }

    if (telephone !== undefined) {
      const cleanPhone = normalizePhone(telephone);
      if (!cleanPhone) {
        return res.status(400).json({ error: 'Invalid telephone number.' });
      }
      updates.push(`telephone = $${params.length + 1}`);
      params.push(cleanPhone);
    }

    if (nin !== undefined) {
      const cleanNin = String(nin).trim().toUpperCase();
      if (!cleanNin) {
        return res.status(400).json({ error: 'NIN is required.' });
      }
      updates.push(`nin = $${params.length + 1}`);
      params.push(cleanNin);
    }

    if (address !== undefined) {
      updates.push(`address = $${params.length + 1}`);
      params.push(address || null);
    }

    if (email !== undefined) {
      updates.push(`email = $${params.length + 1}`);
      params.push(email || null);
    }

    if (photo !== undefined) {
      updates.push(`photo = $${params.length + 1}`);
      params.push(photo || null);
    }

    if (is_active !== undefined) {
      updates.push(`is_active = $${params.length + 1}`);
      params.push(Boolean(is_active));
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No member fields provided for update.' });
    }

    params.push(id);

    const { rows } = await query(
      `
        UPDATE members
        SET ${updates.join(', ')}
        WHERE id = $${params.length}
        RETURNING *
      `,
      params
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    return res.json({ member: rows[0] });
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(409).json({
        error: 'A member with that NIN or phone number already exists.',
      });
    }
    return next(error);
  }
}

async function deactivateMember(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Valid member id is required.' });
    }

    const { rows } = await query(
      `
        UPDATE members
        SET is_active = FALSE
        WHERE id = $1
        RETURNING *
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    return res.json({ message: 'Member deactivated.', member: rows[0] });
  } catch (error) {
    return next(error);
  }
}

function createMemberController({ authRequired, requirePermission }) {
  const router = express.Router();

  router.use(authRequired);

  router.get('/', listMembers);
  router.get('/:account', getMemberByAccount);
  router.post('/', requirePermission('manage_members'), createMember);
  router.patch('/:id', requirePermission('manage_members'), updateMember);
  router.delete('/:id', requirePermission('manage_members'), deactivateMember);

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
      console.error('[memberController]', error);
    }

    return res.status(status).json(payload);
  });

  return router;
}

module.exports = {
  listMembers,
  getMemberByAccount,
  createMember,
  updateMember,
  deactivateMember,
  createMemberController,
};
