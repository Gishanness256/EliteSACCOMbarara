const { Pool } = require('pg');
require('dotenv').config();

const {
  DATABASE_URL,
  PGHOST = 'localhost',
  PGPORT = '5432',
  PGUSER = 'postgres',
  PGPASSWORD = 'postgres',
  PGDATABASE = 'elitesacco',
  NODE_ENV,
} = process.env;

const connectionString =
  DATABASE_URL ||
  `postgresql://${PGUSER}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`;

const pool = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl:
    NODE_ENV === 'production'
      ? {
          rejectUnauthorized: false,
        }
      : false,
});

pool.on('connect', () => {
  console.log('Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

const query = (text, params) => pool.query(text, params);

module.exports = {
  pool,
  query,
};
