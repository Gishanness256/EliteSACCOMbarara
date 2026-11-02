const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

async function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string.');
  }

  return bcrypt.hash(password, SALT_ROUNDS);
}

async function comparePassword(password, hashedPassword) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string.');
  }

  if (!hashedPassword || typeof hashedPassword !== 'string') {
    throw new Error('Hashed password is required.');
  }

  return bcrypt.compare(password, hashedPassword);
}

async function verifyPassword(password, hashedPassword) {
  return comparePassword(password, hashedPassword);
}

module.exports = {
  hashPassword,
  comparePassword,
  verifyPassword,
  SALT_ROUNDS,
};
