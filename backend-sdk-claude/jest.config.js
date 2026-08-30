// Jest config for hermes-mythos-lucas backend.
//
// Tests are pure / mocked — no real spawn of the Claude CLI, no real Baileys,
// no real SQLite outside the temp directory.

module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/tests/**/*.test.js',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/sandboxes/',
    '/data/',
    '/hermes-agent/',
  ],
  collectCoverageFrom: [
    'config/**/*.js',
    'services/**/*.js',
    'sessionContext.js',
    'claude-query.js',
    '!**/node_modules/**',
    '!**/tests/**',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text-summary', 'lcov'],
  testTimeout: 15000,
  // Each test file gets a fresh module cache — important because session-store
  // and conversation-history have module-level state that we want to reset.
  resetModules: true,
  setupFiles: ['<rootDir>/tests/setup.js'],
  // Detect leaks in development; CI can disable via JEST_DETECT_OPEN=0.
  detectOpenHandles: process.env.JEST_DETECT_OPEN !== '0',
};
