// Jest pre-test setup. Runs once per test file, before the test framework
// loads the suite. Use it to neutralise env vars that production reads at
// require-time, so module-level branches behave deterministically.

process.env.NODE_ENV = 'test';

// Pretend we have no admin allowlist, no policy enforcement, no rotation,
// no SQLite. Each suite that needs a non-default value sets it explicitly.
delete process.env.WHATSAPP_ADMIN_NUMBERS;
process.env.TOOL_POLICY_MODE = process.env.TOOL_POLICY_MODE || 'permissive';
process.env.LOG_BACKEND = 'console';
process.env.SESSION_STORE_BACKEND = process.env.SESSION_STORE_BACKEND || 'memory';
process.env.WHATSAPP_ENABLED = 'false';

// Auth-monitor: state + credentials paths point at the OS tmpdir so the
// singleton (loaded at require-time by task-runner/whatsapp-channel) never
// reads or writes the real data/auth-state.json nor ~/.claude/.credentials.json.
const _os = require('os');
const _path = require('path');
process.env.AUTH_STATE_FILE = process.env.AUTH_STATE_FILE
  || _path.join(_os.tmpdir(), `auth-state-test-${process.pid}.json`);
process.env.CLAUDE_CREDENTIALS_FILE = process.env.CLAUDE_CREDENTIALS_FILE
  || _path.join(_os.tmpdir(), `claude-credentials-test-${process.pid}.json`);

// Disable the memory/process throttle in tests so claude-query.acquireSlot()
// resolves immediately regardless of host RAM pressure (otherwise mocked
// spawn tests hang waiting for the polling interval).
process.env.MAX_CLAUDE_PROCESSES = '999';
process.env.MEMORY_THROTTLE_PERCENT = '100';

// Silence console.log/info during tests; surface warn/error.
// Tests that want to assert on log output should spy explicitly.
if (!process.env.JEST_VERBOSE) {
  global._origConsoleLog = console.log;
  console.log = () => {};
}
