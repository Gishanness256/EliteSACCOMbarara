'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mocked-jwt-token'),
  verify: jest.fn(),
}));

jest.mock('pg', () => {
  const pool = {
    query: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
  };

  return {
    Pool: jest.fn(() => pool),
    __pool: pool,
  };
});

const { app } = require('../server');
const { __pool } = require('pg');

describe('Savings API', () => {
  const authUser = {
    id: 5,
    name: 'Savings Officer',
    email: 'savings@elitesacco.co.ug',
    role: 'Treasurer',
    initials: 'SO',
    is_active: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    jwt.verify.mockImplementation((token) => {
      if (token === 'valid-token') {
        return {
          sub: authUser.id,
          email: authUser.email,
          role: authUser.role,
        };
      }
      throw new Error('invalid token');
    });

    __pool.connect.mockResolvedValue({
      query: jest.fn((sql) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }

        if (sql.includes('SELECT COALESCE(SUM')) {
          return Promise.resolve({
            rows: [{ balance: '500000' }],
          });
        }

        if (sql.includes('SELECT COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1 AS next_seq')) {
          return Promise.resolve({
            rows: [{ next_seq: 1 }],
          });
        }

        if (sql.includes('INSERT INTO savings_transactions')) {
          return Promise.resolve({
            rows: [
              {
                id: 22,
                reference: 'SV-000002',
                account_number: 'ES-M 000001',
                direction: 'Deposit',
                amount: '150000',
                occurred_at: '2024-01-10T00:00:00.000Z',
                channel: 'Bank Transfer',
                slip_number: 'B001',
                remarks: 'Monthly savings',
                officer_initials: 'SO',
              },
            ],
          });
        }

        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    });

    __pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [authUser] });
      }

      if (sql.includes('FROM role_permissions rp')) {
        return Promise.resolve({ rows: [{ ok: true }] });
      }

      if (sql.includes('FROM savings_transactions')) {
        return Promise.resolve({
          rows: [
            {
              id: 21,
              reference: 'SV-000001',
              account_number: 'ES-M 000001',
              direction: 'Deposit',
              amount: '250000',
              occurred_at: '2024-01-05T00:00:00.000Z',
              channel: 'Counter / Cash',
              slip_number: 'SLIP-001',
              remarks: 'Initial deposit',
              officer_initials: 'SO',
            },
          ],
        });
      }

      return Promise.resolve({ rows: [] });
    });
  });

  it('returns 401 when no auth token is provided', async () => {
    const res = await request(app).get('/api/v1/savings');

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/authentication required|invalid or expired token/i);
  });

  it('lists savings transactions for an authenticated user', async () => {
    const res = await request(app)
      .get('/api/v1/savings')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0]).toMatchObject({
      id: 21,
      reference: 'SV-000001',
      account_number: 'ES-M 000001',
      direction: 'Deposit',
    });
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/v1/savings')
      .set('Authorization', 'Bearer valid-token')
      .send({
        account_number: 'ES-M 000001',
        direction: 'Deposit',
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/account_number, direction .* positive amount are required/i);
  });

  it('creates a new savings transaction when the payload is valid', async () => {
    const res = await request(app)
      .post('/api/v1/savings')
      .set('Authorization', 'Bearer valid-token')
      .send({
        account_number: 'ES-M 000001',
        direction: 'Deposit',
        amount: 150000,
        occurred_at: '2024-01-10',
        channel: 'Bank Transfer',
        slip_number: 'B001',
        remarks: 'Monthly savings',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.transaction).toMatchObject({
      reference: 'SV-000002',
      account_number: 'ES-M 000001',
      direction: 'Deposit',
      amount: '150000',
    });
  });

  it('rejects a withdrawal that exceeds the available balance', async () => {
    __pool.connect.mockResolvedValue({
      query: jest.fn((sql) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }

        if (sql.includes('SELECT COALESCE(SUM')) {
          return Promise.resolve({
            rows: [{ balance: '100000' }],
          });
        }

        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    });

    const res = await request(app)
      .post('/api/v1/savings')
      .set('Authorization', 'Bearer valid-token')
      .send({
        account_number: 'ES-M 000001',
        direction: 'Withdrawal',
        amount: 200000,
        occurred_at: '2024-01-12',
        channel: 'Counter / Cash',
        slip_number: 'W001',
        remarks: 'Large withdrawal',
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/exceeds the savings balance/i);
  });
});
