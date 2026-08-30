// Per-channel tool policies for the Claude Code CLI spawn.
//
// The CLI accepts two knobs to constrain what the agent can do:
//   * `allowedTools`     — whitelist; if absent the agent can use everything.
//   * `permissionMode`   — bypassPermissions | default | acceptEdits | plan
//
// This module centralises the decision: given a *channel* (where the request
// came from) and a *senderRole*, what tools and permission mode should the
// spawned CLI receive?
//
// Three rollout modes via env `TOOL_POLICY_MODE`:
//   * permissive (default) — policy is resolved but NOT applied; callers keep
//                            their legacy values. Safest for first deploy.
//   * log                  — policy resolved + divergences logged; legacy
//                            values still applied. Use this in production for
//                            48 h before flipping to enforce, to confirm no
//                            channel is missing from the matrix.
//   * enforce              — policy resolved and actively applied; legacy
//                            values overridden when they differ.
//
// All call sites should treat the returned policy as advisory and call
// `applyPolicy(currentOptions, channel, ctx)` which respects the rollout mode.

const MODE = (process.env.TOOL_POLICY_MODE || 'permissive').toLowerCase();

// Read-only tool set safe for unattended chat without a human approver.
const SAFE_READONLY = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

// Tool set that lets the agent run Tasks (subagent dispatch). Elevated.
const AGENT_DISPATCH = ['Task'];

// channel → role → { allowedTools?, permissionMode }
// allowedTools=null means "no restriction" (let the agent use everything).
// undefined means "inherit from caller".
const MATRIX = {
  'whatsapp': {
    user:  { allowedTools: SAFE_READONLY, permissionMode: 'bypassPermissions' },
    admin: { allowedTools: null,          permissionMode: 'bypassPermissions' },
  },
  'telegram': {
    user:  { allowedTools: SAFE_READONLY, permissionMode: 'bypassPermissions' },
    admin: { allowedTools: null,          permissionMode: 'bypassPermissions' },
  },
  'web': {
    // Socket.IO local UI — trusted host, full powers.
    user:  { allowedTools: null, permissionMode: 'bypassPermissions' },
    admin: { allowedTools: null, permissionMode: 'bypassPermissions' },
  },
  'api': {
    // /api/tasks and /api/whatsapp/say etc — guarded by API_BEARER_SECRET.
    user:  { allowedTools: null, permissionMode: 'bypassPermissions' },
    admin: { allowedTools: null, permissionMode: 'bypassPermissions' },
  },
  'cron': {
    // Scheduled / autonomous — no human, full powers but supposed to be benign.
    user:  { allowedTools: null, permissionMode: 'bypassPermissions' },
    admin: { allowedTools: null, permissionMode: 'bypassPermissions' },
  },
  'kanban': {
    user:  { allowedTools: null, permissionMode: 'bypassPermissions' },
    admin: { allowedTools: null, permissionMode: 'bypassPermissions' },
  },
};

// Channel-independent override: when the caller is invoking a *named subagent*
// via the Task tool, we restrict to ['Task'] regardless of who they are.
function _agentOverride(allowedTools) {
  return { allowedTools: AGENT_DISPATCH, permissionMode: 'bypassPermissions' };
}

// Resolve the channel from the task's `source` plus context.
function classifyChannel(source) {
  const s = (source || 'api').toLowerCase();
  if (s === 'whatsapp' || s === 'wa') return 'whatsapp';
  if (s === 'telegram' || s === 'tg') return 'telegram';
  if (s === 'web' || s === 'socket' || s === 'socket.io') return 'web';
  if (s === 'cron' || s === 'scheduled') return 'cron';
  if (s === 'kanban') return 'kanban';
  return 'api';
}

// Resolve role. Sender id is a normalised jid/number/uuid; admin allowlist
// comes from `WHATSAPP_ADMIN_NUMBERS` (subset of WHATSAPP_ALLOWED_NUMBERS).
function _adminSet() {
  const csv = process.env.WHATSAPP_ADMIN_NUMBERS || '';
  return new Set(csv.split(',').map(s => s.trim()).filter(Boolean));
}

function classifyRole({ channel, senderId, isAdmin }) {
  if (isAdmin === true) return 'admin';
  if (isAdmin === false) return 'user';
  if (!senderId) return 'user';
  if (channel === 'whatsapp' || channel === 'telegram') {
    const norm = String(senderId).replace(/\D/g, '');
    return _adminSet().has(norm) ? 'admin' : 'user';
  }
  return 'user';
}

// Returns { allowedTools, permissionMode, channel, role, source }.
function resolvePolicy({ source, senderId, isAdmin, agent }) {
  const channel = classifyChannel(source);
  const role    = classifyRole({ channel, senderId, isAdmin });
  let base = (MATRIX[channel] && MATRIX[channel][role]) || MATRIX.api.user;
  if (agent) base = _agentOverride(base.allowedTools);
  return {
    channel,
    role,
    source: source || 'api',
    allowedTools: base.allowedTools,         // null = unrestricted, [] = nothing
    permissionMode: base.permissionMode,
  };
}

// Apply the policy to an existing queryOptions object, honouring the rollout
// mode. Returns a new options object — never mutates the input — plus a
// `diff` description for telemetry.
function applyPolicy(queryOptions, ctx) {
  const policy = resolvePolicy(ctx);
  const out = { ...queryOptions };

  // Compute what would change
  const currentTools = queryOptions.allowedTools;
  const targetTools  = policy.allowedTools;
  const currentMode  = queryOptions.permissionMode;
  const targetMode   = policy.permissionMode;

  const toolsDiffer = !_sameArray(currentTools, targetTools);
  const modeDiffer  = currentMode !== targetMode;

  const diff = {
    mode: MODE,
    channel: policy.channel,
    role: policy.role,
    source: policy.source,
    allowedTools: { from: currentTools, to: targetTools, changed: toolsDiffer },
    permissionMode: { from: currentMode, to: targetMode, changed: modeDiffer },
    applied: false,
  };

  if (MODE === 'enforce') {
    if (targetTools === null) {
      delete out.allowedTools;             // unrestricted
    } else {
      out.allowedTools = targetTools;
    }
    out.permissionMode = targetMode;
    diff.applied = true;
  }
  // 'log' and 'permissive' leave queryOptions untouched.

  return { options: out, policy, diff };
}

function _sameArray(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// Logs a divergence in 'log' mode. Idempotent: if the policy matches current,
// nothing is logged.
function logIfDiverged(diff, logger = console) {
  if (MODE !== 'log') return;
  if (!diff.allowedTools.changed && !diff.permissionMode.changed) return;
  const log = logger.warn || logger.info || console.warn;
  log.call(logger, `[tool-policy:log] ${diff.source}/${diff.channel}/${diff.role} would change:`, {
    allowedTools: diff.allowedTools.changed
      ? `${JSON.stringify(diff.allowedTools.from)} → ${JSON.stringify(diff.allowedTools.to)}`
      : 'same',
    permissionMode: diff.permissionMode.changed
      ? `${diff.permissionMode.from} → ${diff.permissionMode.to}`
      : 'same',
  });
}

module.exports = {
  MODE,
  MATRIX,
  classifyChannel,
  classifyRole,
  resolvePolicy,
  applyPolicy,
  logIfDiverged,
  // exposed for tests
  _sameArray,
};
