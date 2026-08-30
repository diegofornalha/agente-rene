// Pluggable logger — backward-compatible with the previous inline logger object
// in server.js (debug/info/warn/error variadic).
//
// LOG_BACKEND=console (default)  → console.log/warn/error, with credential redaction.
// LOG_BACKEND=pino               → Pino NDJSON + daily file rotation to ./logs/
// LOG_LEVEL                       → debug|info|warn|error (default: info, debug in dev)
// LOG_DIR                         → override directory (default: <repo>/logs)
// LOG_ROLL_SIZE                   → rotate when file exceeds this (default: 50m)
// LOG_ROLL_RETAIN                 → days to keep (default: 14)
// LOG_REDACT_DISABLE=1            → escape hatch: turn off credential redaction
//
// Structured logging convention (Pino-native):
//   logger.error({ err: e }, 'flush failed')       → mergingObject + msg
//   logger.error('flush failed', e)                 → trailing Error auto-serialized as { err }
//   logger.info('hello world')                      → plain message
//   logger.info('user', user, 'logged in')          → variadic still works (string concat)
//
// Credential redaction: every string that passes through the logger is scanned
// for Bearer/Basic tokens, sk-/ghp_/xox/AKIA keys, JWTs, JSON-ish secret fields,
// and Cookie headers. Motivation: MCP responses (Adobe/GitHub/etc.) frequently
// contain credentials that would otherwise reach the NDJSON file AND become
// context for the next agent turn.
//
// Flip in production with: LOG_BACKEND=pino pm2 reload hermes-mythos-lucas --update-env

const path = require('path');
const fs = require('fs');

const BACKEND = process.env.LOG_BACKEND || 'console';
const IS_DEV = process.env.NODE_ENV === 'development';
const LEVEL = process.env.LOG_LEVEL || (IS_DEV ? 'debug' : 'info');
const REDACT_DISABLED = process.env.LOG_REDACT_DISABLE === '1';

// ── Credential redaction ────────────────────────────────────────────────────
// Order matters: longer/more specific patterns first.
const REDACTORS = [
  // Bearer / Basic auth headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{16,}/gi, '$1 [REDACTED]'],
  // OpenAI / Anthropic / Stripe-style keys (sk-..., sk-ant-...)
  [/\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}/g, 'sk-[REDACTED]'],
  // GitHub PATs / OAuth tokens
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '$1_[REDACTED]'],
  // Slack tokens
  [/\bxox[abprsu]-[A-Za-z0-9\-]{8,}/gi, 'xoxX-[REDACTED]'],
  // AWS access key id
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-AKIA]'],
  // JWT: 3 base64url segments separated by '.'
  [/\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, '[REDACTED-JWT]'],
  // JSON: "api_key":"...", "token":"...", "authorization":"..."
  [/"(api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret|cookie|x[_-]api[_-]key)"\s*:\s*"[^"]*"/gi,
    '"$1":"[REDACTED]"'],
  // key=value / key: value (loose)
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|x[_-]api[_-]key)\s*[:=]\s*[^\s,;}'"]+/gi,
    '$1=[REDACTED]'],
  // Cookie header
  [/\bCookie\s*:\s*[^\r\n]+/gi, 'Cookie: [REDACTED]'],
];

function redactString(s) {
  if (REDACT_DISABLED) return s;
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = s;
  for (const [re, repl] of REDACTORS) out = out.replace(re, repl);
  return out;
}

function redactValue(v) {
  if (REDACT_DISABLED) return v;
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = redactValue(v[k]);
    return out;
  }
  return v;
}

function serializeErr(e) {
  return {
    message: e.message,
    code: e.code,
    name: e.name,
    stack: e.stack,
  };
}

// fmt: convert variadic args into { merging, msg } pair following Pino convention.
//   - Leading object → mergingObject
//   - Leading Error → { err: <serialized> }
//   - Trailing Error → { err: <serialized> }, rest stays as msg
//   - Everything else → string-concatenated msg
function fmt(args) {
  let merging;
  let parts = args;

  if (parts.length >= 1) {
    const first = parts[0];
    if (first instanceof Error) {
      merging = { err: serializeErr(first) };
      parts = parts.slice(1);
    } else if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      // If { err: <Error> } convention, serialize the embedded Error
      if (first.err instanceof Error) {
        merging = { ...first, err: serializeErr(first.err) };
      } else {
        merging = first;
      }
      parts = parts.slice(1);
    }
  }
  if (!merging && parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last instanceof Error) {
      merging = { err: serializeErr(last) };
      parts = parts.slice(0, -1);
    }
  }

  const msg = parts
    .map(a => {
      if (a === null || a === undefined) return String(a);
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .map(redactString)
    .join(' ');

  return {
    merging: merging !== undefined ? redactValue(merging) : undefined,
    msg,
  };
}

function makeConsoleLogger() {
  const emit = (kind) => (...args) => {
    const { merging, msg } = fmt(args);
    if (merging !== undefined) {
      console[kind](msg, merging);
    } else {
      console[kind](msg);
    }
  };
  return {
    debug: (...args) => { if (IS_DEV) emit('log')(...args); },
    info:  emit('log'),
    warn:  emit('warn'),
    error: emit('error'),
  };
}

function makePinoLogger() {
  const pino = require('pino');

  const logsDir = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const targets = [];

  // stdout target — pretty in dev, raw NDJSON in prod (PM2 captures it to pm2-out.log)
  if (IS_DEV) {
    targets.push({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', singleLine: false },
      level: LEVEL,
    });
  } else {
    targets.push({ target: 'pino/file', options: { destination: 1 }, level: LEVEL });
  }

  // File rotation — only when pino-roll is available (graceful skip if not installed)
  try {
    require.resolve('pino-roll');
    targets.push({
      target: 'pino-roll',
      options: {
        file: path.join(logsDir, 'app'),
        frequency: 'daily',
        size: process.env.LOG_ROLL_SIZE || '50m',
        mkdir: true,
        extension: '.log',
        dateFormat: 'yyyy-MM-dd',
        limit: { count: parseInt(process.env.LOG_ROLL_RETAIN || '14', 10) },
      },
      level: LEVEL,
    });
  } catch (_) {
    // pino-roll missing → stdout-only. Emit once on boot so the operator notices.
    console.warn('[logger] pino-roll not installed — file rotation disabled, stdout only');
  }

  const transport = pino.transport({ targets });
  const p = pino({ level: LEVEL }, transport);

  const emit = (kind) => (...args) => {
    const { merging, msg } = fmt(args);
    if (merging !== undefined) p[kind](merging, msg);
    else p[kind](msg);
  };

  return {
    debug: emit('debug'),
    info:  emit('info'),
    warn:  emit('warn'),
    error: emit('error'),
    raw: p,
  };
}

const logger = BACKEND === 'pino' ? makePinoLogger() : makeConsoleLogger();
logger.backend = BACKEND;
logger.level = LEVEL;
logger.redact = redactString;       // exposed for one-off use (e.g. raw log lines)
logger._fmt = fmt;                  // exposed for tests
module.exports = logger;
