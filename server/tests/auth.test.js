'use strict';

const request = require('supertest');
const bcrypt = require('bcrypt');

jest.mock('bcrypt', () => ({
  __esModule: false,
  compare: jest.fn(),
  hashSync: jest.fn((value) => `hashed-${value}`),
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

const { app } = require('../server/server');
const { __pool } = require('pg');

describe('Auth API', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    __pool.query.mockResolvedValue({ rows: [] });

    __pool.connect.mockResolvedValue({
      query: jest.fn((sql) => {
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql === 'ROLLBACK') return Promise.resolve();

        if (sql.includes('SELECT log_audit_event')) {
          return Promise.resolve({ rows: [{ id: 1 }] });
        }

        if (sql.includes('UPDATE users SET last_login_at = NOW() WHERE id = $1')) {
          return Promise.resolve({ rowCount: 1 });
        }

        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    });
  });

  it('returns 400 when email or password is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@elitesacco.co.ug' });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/email and password/i);
  });

  it('returns 401 when credentials are invalid', async () => {
    __pool.query.mockImplementation((sql) => {
      if (sql.includes('WHERE LOWER(email) = $1')) {
        return Promise.resolve({
          rows: [],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    bcrypt.compare.mockResolvedValue(false);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'admin@elitesacco.co.ug',
        password: 'wrong-password',
      });

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });

  it('logs in successfully and returns a JWT token', async () => {
    const user = {
      id: 7,
      name: 'Jane Doe',
      email: 'jane@elitesacco.co.ug',
      role: 'Credit Officer',
      initials: 'JD',
      is_active: true,
      password_hash: '$2a$12$abcdefghijklmnopqrstuv',
    };

    __pool.query.mockImplementation((sql) => {
      if (sql.includes('WHERE LOWER(email) = $1')) {
        return Promise.resolve({ rows: [user] });
      }

      return Promise.resolve({ rows: [] });
    });

    bcrypt.compare.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'jane@elitesacco.co.ug',
        password: 'password123',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({
      id: 7,
      email: 'jane@elitesacco.co.ug',
      role: 'Credit Officer',
    });
  });

  it('returns 401 if the request is not authenticated', async () => {
    const res = await request(app).get('/api/v1/auth/me');

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/authentication required|invalid or expired token/i);
  });
});
