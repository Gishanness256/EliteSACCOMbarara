'use strict';

/**
 * server/services/memberService.js
 *
 * Reusable service for member account management.
 *
 * Expected DB contract:
 *   - db.query(sql, params)
 *   - optional db.withTransaction(userId, sessionId, fn)
 *
 * Covers:
 *   - list members (with optional text filter)
 *   - fetch single member by account number
 *   - create member and generate ES-<GENDER> ######
 */

function normalizeMember(row = {}) {
  if (!row) return null;

  return {
    id: row.id ?? null,
    accountNumber: row.account_number ?? row.accountNumber ?? null,
    firstName: row.first_name ?? row.firstName ?? null,
    lastName: row.last_name ?? row.lastName ?? null,
    gender: row.gender ?? null,
    dateOfBirth: row.date_of_birth ?? row.dateOfBirth ?? null,
    telephone: row.telephone ?? null,
    email: row.email ?? null,
    nin: row.nin ?? null,
    address: row.address ?? null,
    photo: row.photo ?? null,
    isActive: row.is_active ?? row.isActive ?? true,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
    createdBy: row.created_by ?? row.createdBy ?? null,
  };
}

function createMemberService({ db, logger } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('memberService: a valid db instance with query() is required');
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

    // Fallback for plain db.query() implementations
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
    async listMembers({ q, limit = 500 } = {}) {
      const params = [];
      let where = '';

      if (q) {
        params.push(`%${String(q).toLowerCase()}%`);
        where = `WHERE LOWER(first_name || ' ' || last_name || ' ' || account_number) LIKE $1`;
      }

      params.push(parseInt(limit, 10) || 500);

      const sql = `
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
          photo,
          is_active,
          created_at,
          updated_at,
          created_by
        FROM members
        ${where}
        ORDER BY account_number
        LIMIT $${params.length}
      `;

      const { rows } = await db.query(sql, params);
      return (rows || []).map(normalizeMember);
    },

    async getMemberById(id) {
      const memberId = parseInt(id, 10);
      if (!Number.isFinite(memberId)) {
        throw new Error('memberId must be a valid number');
      }

      const sql = `
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
          photo,
          is_active,
          created_at,
          updated_at,
          created_by
        FROM members
        WHERE id = $1
        LIMIT 1
      `;

      const { rows } = await db.query(sql, [memberId]);
      return rows && rows[0] ? normalizeMember(rows[0]) : null;
    },

    async getMemberByAccountNumber(accountNumber) {
      if (!accountNumber) return null;

      const sql = `
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
          photo,
          is_active,
          created_at,
          updated_at,
          created_by
        FROM members
        WHERE account_number = $1
        LIMIT 1
      `;

      const { rows } = await db.query(sql, [accountNumber]);
      return rows && rows[0] ? normalizeMember(rows[0]) : null;
    },

    async createMember({
      firstName,
      lastName,
      gender,
      dateOfBirth,
      telephone,
      nin,
      address,
      email,
      photo,
      createdBy,
      sessionId = null,
    } = {}) {
      if (!firstName || !lastName || !gender || !telephone || !nin) {
        throw new Error('first_name, last_name, gender, telephone and nin are required.');
      }

      return runInTransaction(createdBy ?? null, sessionId, async (tx) => {
        // Generate next account number sequentially per gender
        const { rows: seqRows } = await tx.query(
          `
            SELECT
              COALESCE(
                MAX(CAST(SUBSTRING(account_number FROM POSITION(' ' IN account_number) + 1) AS INTEGER)),
                0
              ) + 1 AS next_seq
            FROM members
            WHERE account_number LIKE 'ES-' || $1 || ' %'
          `,
          [gender],
        );

        const seq = Number(seqRows[0].next_seq || 1);
        const accountNumber = `ES-${gender} ${String(seq).padStart(6, '0')}`;

        const { rows } = await tx.query(
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
            VALUES (
              $1,
              $2,
              $3,
              $4::member_gender,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10,
              $11
            )
            RETURNING *
          `,
          [
            accountNumber,
            firstName,
            lastName,
            gender,
            dateOfBirth || null,
            address || null,
            String(nin).toUpperCase(),
            telephone,
            email || null,
            photo || null,
            createdBy ?? null,
          ],
        );

        const createdMember = rows[0];
        log('Member created', {
          memberId: createdMember.id,
          accountNumber,
          createdBy,
          gender,
        });

        return normalizeMember(createdMember);
      });
    },

    async updateMember({
      id,
      firstName,
      lastName,
      gender,
      dateOfBirth,
      telephone,
      nin,
      address,
      email,
      photo,
      updatedBy,
      sessionId = null,
    } = {}) {
      const memberId = parseInt(id, 10);
      if (!Number.isFinite(memberId)) {
        throw new Error('memberId must be a valid number');
      }

      const fields = [];
      const params = [];

      const pushField = (column, value) => {
        if (value === undefined) return;
        fields.push(`${column} = $${params.length + 1}`);
        params.push(value);
      };

      pushField('first_name', firstName);
      pushField('last_name', lastName);
      pushField('gender', gender ? gender : undefined);
      pushField('date_of_birth', dateOfBirth ?? null);
      pushField('telephone', telephone);
      pushField('nin', nin ? String(nin).toUpperCase() : undefined);
      pushField('address', address ?? null);
      pushField('email', email ?? null);
      pushField('photo', photo ?? null);
      pushField('updated_by', updatedBy ?? null);

      if (!fields.length) {
        throw new Error('No member fields to update.');
      }

      params.push(memberId);

      return runInTransaction(updatedBy ?? null, sessionId, async (tx) => {
        const sql = `
          UPDATE members
             SET ${fields.join(', ')},
                 updated_at = NOW()
           WHERE id = $${params.length}
           RETURNING *
        `;

        const { rows } = await tx.query(sql, params);
        if (!rows.length) {
          throw new Error('Member not found.');
        }

        const updatedMember = rows[0];
        log('Member updated', {
          memberId: updatedMember.id,
          updatedBy,
        });

        return normalizeMember(updatedMember);
      });
    },

    async deactivateMember(id, updatedBy, sessionId = null) {
      const memberId = parseInt(id, 10);
      if (!Number.isFinite(memberId)) {
        throw new Error('memberId must be a valid number');
      }

      return runInTransaction(updatedBy ?? null, sessionId, async (tx) => {
        const { rows } = await tx.query(
          `
            UPDATE members
               SET is_active = FALSE,
                   updated_at = NOW(),
                   updated_by = $1
             WHERE id = $2
             RETURNING *
          `,
          [updatedBy ?? null, memberId],
        );

        if (!rows.length) {
          throw new Error('Member not found.');
        }

        log('Member deactivated', {
          memberId,
          updatedBy,
        });

        return normalizeMember(rows[0]);
      });
    },
  };
}

module.exports = createMemberService;
module.exports.createMemberService = createMemberService;
module.exports.normalizeMember = normalizeMember;
