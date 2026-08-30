// PM2 process definition for hermes-mythos-lucas backend.
// Boot validation lives in scripts/preflight.sh — PM2 marks the app as errored
// if preflight exits non-zero, instead of looping a broken process.
//
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup        (persist across reboot)
//   pm2 logs hermes-mythos-lucas    (tail logs)
//   pm2 reload hermes-mythos-lucas  (zero-downtime, ignored in fork mode)
//   pm2 restart hermes-mythos-lucas
//
// wait_ready is OFF because server.js does not currently call process.send('ready').
// Flip it on after server.js signals ready when Socket.IO is listening.

module.exports = {
  apps: [{
    name: 'hermes-mythos-lucas',
    script: 'scripts/start.sh',
    interpreter: 'bash',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '30s',
    max_memory_restart: '1500M',
    kill_timeout: 10000,
    listen_timeout: 15000,
    wait_ready: false,
    env: {
      NODE_ENV: 'production',
      CLAUDE_NODE_BIN: '/home/hermes/opt/node/bin/node',
    },
    env_development: {
      NODE_ENV: 'development',
    },
    out_file: './logs/pm2-out.log',
    error_file: './logs/pm2-err.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    time: true,
  }],
};
