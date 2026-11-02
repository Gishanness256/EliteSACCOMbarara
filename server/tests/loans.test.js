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

describe('Loans API', () => {
  const authUser = {
    id: 3,
    name: 'Test Officer',
    email: 'officer@elitesacco.co.ug',
    role: 'Credit Officer',
    initials: 'TO',
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

    __pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [authUser] });
      }

      if (sql.includes('FROM loans l')) {
        return Promise.resolve({
          rows: [
            {
              id: 101,
              reference: 'LN-0001',
              account_number: 'ES-M 000001',
              borrower_name: 'Jane Doe',
              telephone: '+256700000001',
              category: 'School Fees',
              term_months: 12,
              principal: '500000',
              rate_monthly: '0.02',
              disbursed_on: '2024-01-01',
              due_date: '2024-02-01',
              status: 'Active',
              monthly_installment: '45000',
              total_payable: '540000',
              total_paid: '120000',
              outstanding_balance: '420000',
            },
          ],
        });
      }

      if (sql.includes('WHERE l.id = $1')) {
        return Promise.resolve({
          rows: [
            {
              id: 101,
              reference: 'LN-0001',
              account_number: 'ES-M 000001',
              borrower_name: 'Jane Doe',
              telephone: '+256700000001',
              category: 'School Fees',
              term_months: 12,
              principal: '500000',
              rate_monthly: '0.02',
              disbursed_on: '2024-01-01',
              due_date: '2024-02-01',
              status: 'Active',
              monthly_installment: '45000',
              total_payable: '540000',
              total_paid: '120000',
              outstanding_balance: '420000',
              ageing_bucket: 'Current',
            },
          ],
        });
      }

      return Promise.resolve({ rows: [] });
    });
  });

  it('returns 401 when no auth token is provided', async () => {
    const res = await request(app).get('/api/v1/loans');

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/authentication required|invalid or expired token/i);
  });

  it('lists loans for an authenticated user', async () => {
    const res = await request(app)
      .get('/api/v1/loans')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(200);
    expect(res.body.loans).toHaveLength(1);
    expect(res.body.loans[0]).toMatchObject({
      id: 101,
      borrower_name: 'Jane Doe',
      status: 'Active',
    });
  });

  it('returns 404 when a loan id does not exist', async () => {
    __pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [authUser] });
      }

      if (sql.includes('WHERE l.id = $1')) {
        return Promise.resolve({ rows: [] });
      }

      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .get('/api/v1/loans/9999')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/loan not found/i);
  });
});
