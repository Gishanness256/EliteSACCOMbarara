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

describe('Members API', () => {
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

    __pool.connect.mockResolvedValue({
      query: jest.fn((sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }

        if (sql.includes('SELECT COALESCE(MAX')) {
          return Promise.resolve({ rows: [{ next_seq: 1 }] });
        }

        if (sql.includes('INSERT INTO members')) {
          return Promise.resolve({
            rows: [
              {
                id: 12,
                account_number: 'ES-F 000001',
                first_name: 'Jane',
                last_name: 'Doe',
                gender: 'F',
                date_of_birth: '1990-01-01',
                telephone: '+256700000001',
                email: 'jane@example.com',
                nin: 'CM123456789AB',
                address: 'Kampala',
                is_active: true,
                created_at: '2024-01-15T00:00:00.000Z',
              },
            ],
          });
        }

        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    });

    __pool.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [authUser] });
      }

      if (sql.includes('FROM role_permissions rp')) {
        return Promise.resolve({ rows: [{ ok: true }] });
      }

      if (sql.includes('FROM members')) {
        return Promise.resolve({
          rows: [
            {
              id: 11,
              account_number: 'ES-F 000001',
              first_name: 'Jane',
              last_name: 'Doe',
              gender: 'F',
              date_of_birth: '1990-01-01',
              telephone: '+256700000001',
              email: 'jane@example.com',
              nin: 'CM123456789AB',
              address: 'Kampala',
              is_active: true,
              created_at: '2024-01-15T00:00:00.000Z',
            },
          ],
        });
      }

      return Promise.resolve({ rows: [] });
    });
  });

  it('returns 401 when no auth token is provided', async () => {
    const res = await request(app).get('/api/v1/members');

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/authentication required|invalid or expired token/i);
  });

  it('lists members for an authenticated user', async () => {
    const res = await request(app)
      .get('/api/v1/members')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0]).toMatchObject({
      id: 11,
      first_name: 'Jane',
      account_number: 'ES-F 000001',
    });
  });

  it('returns 400 when required member fields are missing', async () => {
    const res = await request(app)
      .post('/api/v1/members')
      .set('Authorization', 'Bearer valid-token')
      .send({
        first_name: 'Jane',
        last_name: 'Doe',
        gender: 'F',
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/first_name, last_name, gender, telephone and nin are required/i);
  });

  it('creates a new member when valid data is provided', async () => {
    const payload = {
      first_name: 'Jane',
      last_name: 'Doe',
      gender: 'F',
      date_of_birth: '1990-01-01',
      telephone: '+256700000001',
      nin: 'CM123456789AB',
      address: 'Kampala',
      email: 'jane@example.com',
    };

    const res = await request(app)
      .post('/api/v1/members')
      .set('Authorization', 'Bearer valid-token')
      .send(payload);

    expect(res.statusCode).toBe(201);
    expect(res.body.member).toMatchObject({
      account_number: 'ES-F 000001',
      first_name: 'Jane',
      last_name: 'Doe',
      gender: 'F',
      telephone: '+256700000001',
    });
  });
});
