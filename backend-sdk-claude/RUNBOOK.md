# Operations Runbook — `hermes-mythos-lucas/backend-sdk-claude`

> Operational reference for keeping this backend running in production (24/7 WhatsApp).
> If you're new to the project, start at the **Auth** section — it explains why the
> backend uses the Claude Code CLI as a subprocess instead of `ANTHROPIC_API_KEY`.

---

## Auth — why CLI, not API key

The backend never sets `ANTHROPIC_API_KEY`. Every Claude turn is run by spawning
`node_modules/@anthropic-ai/claude-code/cli.js` as a subprocess
(`claude-query.js:121`). The CLI authenticates by reading
`~/.claude/.credentials.json` (OAuth tokens from the **Claude subscription**),
so requests bill against the plan quota — not pay-per-token API credits.

Consequences:

- **Credential is per-user, on disk.** PM2 runs as user `hermes`; the file must
  exist at `/Users/hermes/.claude/.credentials.json` with mode `600`. Preflight
  validates this on boot (`scripts/preflight.sh`).
- **Auth expiry is interactive.** If the OAuth token is revoked or rotated,
  `claude login` must be run on this host. The backend does not — and cannot —
  recover automatically.
- **The CLI must reach `claude.ai` over HTTPS.** No proxy config supported beyond
  what the CLI itself reads.

Rotate the credential:

```sh
claude login                 # interactive — pick "Continue with Claude"
pm2 restart hermes-mythos-lucas
```

---

## Starting & restarting

```sh
cd /Users/hermes/hermes-mythos-lucas/backend-sdk-claude

# Fresh start
pm2 start ecosystem.config.js

# Reload after code change (no env update)
pm2 reload hermes-mythos-lucas

# Reload after .env change
pm2 reload hermes-mythos-lucas --update-env

# Survive reboot
pm2 save
pm2 startup        # prints a sudo command; paste it once

# Stop / kill
pm2 stop hermes-mythos-lucas
pm2 delete hermes-mythos-lucas
```

Preflight (`scripts/preflight.sh`) runs before each boot. Failure → PM2 marks
the app errored. Common failures:

| Output | Fix |
|---|---|
| `node binary 'XYZ' not in PATH` | Check `CLAUDE_NODE_BIN` in `.env` |
| `Claude Code CLI not found` | `npm install` in the backend directory |
| `OAuth credentials missing` | `claude login` |
| `perms=644 (expected 600)` | `chmod 600 ~/.claude/.credentials.json` |

---

## Logs

Two log streams:

1. **PM2 / Pino** — `./logs/pm2-out.log` and `./logs/pm2-err.log` (stdout).
   With `LOG_BACKEND=pino` the lines are NDJSON; otherwise plain text. The Pino
   transport also rolls daily to `./logs/app-YYYY-MM-DD.log` (14-day retention).
2. **WhatsApp conversation log** — `./data/whatsapp-conversas.log`. Append-only
   `<ISO> [<role>]: <text>` format. Rolls on UTC date change OR when it exceeds
   `WHATSAPP_LOG_MAX_BYTES` (default 50 MB). Archives become
   `whatsapp-conversas-YYYY-MM-DD.log` next to the active file. The
   `monitor-whatsapp-backend` skill uses `tail -F` so rotation is transparent.

Common commands:

```sh
pm2 logs hermes-mythos-lucas --lines 100
tail -F logs/app-*.log
tail -F data/whatsapp-conversas.log
```

---

## Session storage

`SESSION_STORE_BACKEND=sqlite` (default after week 1 of hardening) gives a
write-through cache: in-memory Map for reads, SQLite (`data/state.db`) for
persistence. On boot, sessions active in the last 2 h rehydrate so a PM2
restart doesn't drop ongoing conversations.

```sh
# Snapshot the live store
sqlite3 data/state.db 'SELECT scope, COUNT(*) FROM sessions GROUP BY scope'
sqlite3 data/state.db 'SELECT scope, COUNT(*) FROM session_messages GROUP BY scope'

# Reset (drops persisted sessions only — kanban + skill-curator share the file)
sqlite3 data/state.db 'DELETE FROM sessions; DELETE FROM session_messages'
```

To disable persistence and revert to legacy in-memory behavior:
`SESSION_STORE_BACKEND=memory`.

---

## Tool policies (channel-aware allowed tools)

`config/tool-policies.js` constrains what tools the spawned CLI can use per
channel × role. Rollout is gated by `TOOL_POLICY_MODE`:

| Mode | Behavior |
|---|---|
| `permissive` | Resolve only; legacy options untouched |
| `log` *(current default)* | Resolve + log divergences; legacy options untouched |
| `enforce` | Resolve and override `allowedTools` / `permissionMode` |

Policy matrix highlights:

- `whatsapp + user` (default for any sender) → `['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']`, `bypassPermissions`
- `whatsapp + admin` (when `senderId` ∈ `WHATSAPP_ADMIN_NUMBERS`) → unrestricted
- `web` (Socket.IO local UI) → unrestricted
- Any source with `agent: '<name>'` → forced to `['Task']` (subagent dispatch)

To make a number admin:

```dotenv
# digits only; subset of WHATSAPP_ALLOWED_NUMBERS
WHATSAPP_ADMIN_NUMBERS=5511999990000,5511999990001
```

**Rollout plan**: leave `TOOL_POLICY_MODE=log` for 48 h, watch `pm2 logs` for
`[tool-policy:log]` warnings naming channels you didn't anticipate; once silent
(or surfacing only expected divergences), flip to `enforce`.

---

## CWD isolation

`CWD_ISOLATION=off` (default) keeps the shared backend root as `cwd`. Other
values bind each spawned CLI to its own sandbox under `./sandboxes/`:

- `per-sender`: `sandboxes/<source>-<senderId>/` (one dir per WhatsApp number)
- `per-session`: `sandboxes/<source>-<peer>/` (one dir per session anchor)

Sandboxes are created on demand and are NOT auto-cleaned — sweep manually if
you flip this on:

```sh
find sandboxes -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
```

Note: with isolation on, skills/agents that expect to read backend code from
`process.cwd()` will fail. Keep `off` unless you have a specific containment
need; the tool policy above is the primary safeguard.

---

## Pre-bash credential guard

`.claude/helpers/hook-handler.cjs pre-bash` blocks any Bash command that reads
or copies OAuth tokens, SSH private keys, AWS creds, GitHub host config, the
project `.env`, or the WhatsApp auth dir. Anchored regex avoids false positives
like `.sshfoo`. Destructive patterns (rm -rf /, pipe-to-shell, reverse shell,
rc/authorized_keys persistence, sudo) are also blocked and are NOT bypassable.

The handler and the `PreToolUse` registration live versioned in
`.claude/helpers/hook-handler.cjs` and `.claude/settings.json` (gitignore has
explicit exceptions for those two paths; the rest of `.claude/` stays local).
Spec/regression: `tests/hook-prebash.test.js`. It applies to every task whose
workspace is the backend root (the task-runner default). Tasks with a custom
`workspace` outside the backend do NOT inherit project settings — global
coverage would require replicating the hook in `~/.claude/settings.json`
(operator decision; keep the two in sync manually if you do).

Emergency bypass (one-shot, for a legitimate rotation):

```sh
HERMES_BASH_ALLOW_SECRETS=1 pm2 reload hermes-mythos-lucas --update-env
# unset after
unset HERMES_BASH_ALLOW_SECRETS
```

The bypass affects the whole process — not just one command — so unset as soon
as the operation finishes.

---

## CLI healthcheck

`/api/health` now reports a `cli_binary` check that actually runs
`cli.js --version` (timeout `CLI_HEALTH_TIMEOUT_MS`, default 5 s). A
`status: error` here usually means the package install corrupted or `node`
crashed at startup — re-run `npm install` and `pm2 restart`.

```sh
curl -s http://localhost:3457/api/health | jq '.checks.cli_binary'
```

---

## Tests

```sh
npm test                                  # full suite
npx jest tests/tool-policies.test.js      # one file
npx jest --coverage                       # coverage report → coverage/
```

Tests stub `child_process.spawn` and SQLite is redirected to `/tmp/hermes-sst-*`;
nothing in `data/` is touched. Suite runs in ~2 s.

---

## Troubleshooting

**`/api/health` shows `degraded` with `system_memory: warning`** — host RAM > 85 %.
Usually transient. Check `top`/`vm_stat`. If sustained, `MAX_CLAUDE_PROCESSES`
in `.env` is the lever (default 4).

**WhatsApp disconnected** — `pm2 logs hermes-mythos-lucas | grep WhatsApp` shows
the Baileys reason. Common: token rotated on the phone — open WhatsApp on the
phone → Settings → Linked Devices → re-pair (look for the QR in
`/Users/hermes/whatsapp-qr.png` or in the PM2 logs).

**Task hangs forever** — `pm2 logs` shows `Throttle timeout: could not acquire
process slot within 5 minutes`. Either memory is over the throttle threshold
or `MAX_CLAUDE_PROCESSES` slots are all stuck. `pm2 restart` usually clears it.

**`[BLOCKED] Credential exfiltration attempt detected`** — the agent tried to
read a sensitive file via Bash. Decide: was it legitimate (you asked it to
rotate a key) or unintended? If legitimate, set `HERMES_BASH_ALLOW_SECRETS=1`
on the host process briefly, redo, then unset. If unintended, no action needed
— the agent was blocked and you have a log line.

**Lost sessions after restart** — confirm `SESSION_STORE_BACKEND=sqlite` in
`.env` and that `data/state.db` has rows in the `sessions` table.

---

## Dependency policy (2026-08-30)

Kept deliberately, do not "fix" without reading this:

- **`@anthropic-ai/claude-code` 2.1.210 — PINNED.** See the comment in
  `bridge-rene/claude-query.js` for why. Never bump casually.
- **`@whiskeysockets/baileys` 7.0.0-rc12** — production WhatsApp channel;
  upgrade only with a planned re-pair/test window.
- **`express` 4** — v5 changes wildcard/param routing and async handler
  semantics across ~2.4k lines of routes. Re-evaluate after the server.js
  modularization (routes/ + supertest coverage).
- **`html-docx-js`** — its jszip/lodash.merge advisories have no upstream fix.
  Vector does not apply: we only *generate* DOCX from our own HTML
  (`services/doc-converter.js`), never load untrusted zips. Accepted risk;
  future alternative: `html-to-docx`.
- **Node runtime**: production runs `CLAUDE_NODE_BIN` (~/opt/node, v22) while
  the shell default may be newer. `better-sqlite3`'s native binary is built
  for the production ABI — `scripts/preflight.sh` auto-heals a mismatch at
  boot, and `npm test` (via `scripts/run-tests.sh`) always uses the
  production node. If you upgrade the production Node, preflight rebuilds the
  binary on first boot automatically.

After ANY `npm install`/`npm audit fix`, re-run `bash scripts/preflight.sh`
(it resolves the production node from `.env`) to confirm the sqlite binary
still matches, and `npm test` before restarting PM2.
