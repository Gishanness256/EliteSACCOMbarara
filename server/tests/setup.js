process.env.NODE_ENV = 'test';

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

module.exports = {};
