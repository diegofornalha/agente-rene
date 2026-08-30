// services/health/health-checker.js — focus on the new checkCliBinary path
// added in 2.4. Hits the real CLI binary (lightweight: just --version);
// integration-ish but reliable and self-contained.

const path = require('path');
const fs = require('fs');

const HEALTH_PATH = path.join(__dirname, '..', 'services', 'health', 'health-checker.js');
const HealthChecker = require(HEALTH_PATH);

describe('checkCliBinary', () => {
  test('healthy when real CLI is present', async () => {
    const hc = new HealthChecker();
    const out = await hc.checkCliBinary();
    expect(out.name).toBe('CLI Binary');
    expect(out.status).toBe('healthy');
    expect(out.version).toMatch(/Claude Code/);
  }, 10000);

  test('error when CLAUDE_NODE_BIN points to a non-existent binary', async () => {
    const hc = new HealthChecker();
    const orig = process.env.CLAUDE_NODE_BIN;
    process.env.CLAUDE_NODE_BIN = '/nonexistent/path/to/node';
    try {
      const out = await hc.checkCliBinary();
      expect(out.status).toBe('error');
      expect(out.error).toBeDefined();
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_NODE_BIN;
      else process.env.CLAUDE_NODE_BIN = orig;
    }
  });

  // Timeout path skipped — exercising err.killed reliably from userland on macOS
  // requires either a hanging binary (PATH-dependent) or jest fake timers
  // around execFile (brittle). The branch is short and visually obvious
  // in services/health/health-checker.js:checkCliBinary.
});
