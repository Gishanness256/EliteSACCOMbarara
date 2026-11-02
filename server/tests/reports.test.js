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

const { app } = require('../server.js');
const { __pool } = require('pg');

describe('Reports / Regulatory API', () => {
  const authUser = {
    id: 4,
    name: 'Treasurer User',
    email: 'treasurer@elitesacco.co.ug',
    role: 'Treasurer',
    initials: 'TU',
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

    __pool.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [authUser] });
      }

      if (sql.includes('FROM regulatory_return_templates')) {
        return Promise.resolve({
          rows: [
            {
              id: 1,
              name: 'Monthly Savings Report',
              short_name: 'MSR',
              description: 'Savings movement report',
              is_active: true,
              sort_order: 1,
            },
            {
              id: 2,
              name: 'Loan Portfolio Snapshot',
              short_name: 'LPS',
              description: 'Loan portfolio health overview',
              is_active: true,
              sort_order: 2,
            },
          ],
        });
      }

      if (sql.includes('build_regulatory_snapshot')) {
        return Promise.resolve({
          rows: [
            {
              snapshot: {
                year: 2024,
                month: 1,
                total_members: 120,
                total_savings: 2500000,
                total_loans: 1800000,
              },
            },
          ],
        });
      }

      if (sql.includes('persist_regulatory_snapshot')) {
        return Promise.resolve({
          rows: [{ snapshot_id: 77 }],
        });
      }

      return Promise.resolve({ rows: [] });
    });
  });

  it('returns 401 when no auth token is provided for regulatory templates', async () => {
    const res = await request(app).get('/api/v1/regulatory/templates');

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/authentication required|invalid or expired token/i);
  });

  it('lists regulatory templates for an authenticated user', async () => {
    const res = await request(app)
      .get('/api/v1/regulatory/templates')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(200);
    expect(res.body.templates).toHaveLength(2);
    expect(res.body.templates[0]).toMatchObject({
      id: 1,
      name: 'Monthly Savings Report',
      short_name: 'MSR',
    });
  });

  it('returns 400 when month is not valid', async () => {
    const res = await request(app)
      .get('/api/v1/regulatory/snapshot/2024/13')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/month must be 1-12/i);
  });

  it('returns a snapshot for a valid period', async () => {
    const res = await request(app)
      .get('/api/v1/regulatory/snapshot/2024/1')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      period: '2024-01',
      snapshot: {
        year: 2024,
        month: 1,
      },
    });
  });

  it('persists a regulatory snapshot when the user is authorized', async () => {
    const res = await request(app)
      .post('/api/v1/regulatory/persist')
      .set('Authorization', 'Bearer valid-token')
      .send({
        year: 2024,
        month: 1,
        template_id: 5,
        basis: 'm',
        n_months: 1,
        notes: 'Quarterly regulatory snapshot',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({
      snapshot_id: 77,
    });
  });

  it('returns 403 when a non-authorized role tries to persist a report', async () => {
    authUser.role = 'Member';

    const res = await request(app)
      .post('/api/v1/regulatory/persist')
      .set('Authorization', 'Bearer valid-token')
      .send({
        year: 2024,
        month: 1,
        template_id: 5,
      });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/requires one of:/i);
  });
});
