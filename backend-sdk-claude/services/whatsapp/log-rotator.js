// Rotating append-only writer for the WhatsApp conversation log.
//
// Preserves the exact line format produced by `whatsapp-channel.js:_appendConv`
// (`<ISO> [<role>]: <text>\n`) so external tailers — notably the
// `monitor-whatsapp-backend` skill which runs `tail -F` on the active path —
// keep working without changes.
//
// Rotation triggers (whichever comes first):
//   * the UTC calendar date of the active file changes (boundary at 00:00 UTC), or
//   * the active file exceeds WHATSAPP_LOG_MAX_BYTES (default 50 MB).
//
// On rotation the active file is renamed to `<base>-YYYY-MM-DD[-N]<ext>` (N is
// only used if a same-day archive already exists), and a new empty active file
// is implicitly created by the next append. `tail -F` reopens automatically.
//
// All writes are serialized through an in-process queue so a slow rename can't
// race with a concurrent append.

const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

const DEFAULT_MAX_BYTES = parseInt(
  process.env.WHATSAPP_LOG_MAX_BYTES || String(50 * 1024 * 1024),
  10
);

function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildArchivePath(activePath, dateStr) {
  const dir = path.dirname(activePath);
  const ext = path.extname(activePath) || '.log';
  const base = path.basename(activePath, ext);
  const primary = path.join(dir, `${base}-${dateStr}${ext}`);
  if (!fs.existsSync(primary)) return primary;
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${base}-${dateStr}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${dateStr}-overflow${ext}`);
}

function createRotator(activePath, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const onRotate = opts.onRotate || null;
  const clock = opts.clock || (() => new Date()); // injectable for tests

  let queue = Promise.resolve();
  let activeDate = null;
  let knownSize = -1;

  async function initFromDisk() {
    try {
      const st = await fsp.stat(activePath);
      knownSize = st.size;
      activeDate = utcDateString(st.mtime);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      knownSize = 0;
      activeDate = utcDateString(clock());
    }
  }

  async function maybeRotate(nowDate) {
    if (knownSize < 0) await initFromDisk();
    const sizeExceeded = knownSize >= maxBytes;
    const dateChanged = activeDate && activeDate !== nowDate;
    if (!sizeExceeded && !dateChanged) return null;

    const archivePath = buildArchivePath(activePath, activeDate || nowDate);
    try {
      await fsp.rename(activePath, archivePath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const event = {
      from: activePath, to: archivePath,
      size: knownSize, fromDate: activeDate, toDate: nowDate,
      reason: sizeExceeded ? 'size' : 'date',
    };
    knownSize = 0;
    activeDate = nowDate;
    if (onRotate) { try { onRotate(event); } catch (_) {} }
    return event;
  }

  async function append(line) {
    const nowDate = utcDateString(clock());
    await maybeRotate(nowDate);
    await fsp.appendFile(activePath, line);
    knownSize += Buffer.byteLength(line, 'utf8');
  }

  function write(line) {
    queue = queue.then(() => append(line)).catch(e => {
      console.error('whatsapp conv log write failed:', e.message);
    });
    return queue;
  }

  // Force a flush of the in-flight queue. Useful in tests / shutdown.
  function drain() { return queue; }

  // Introspection — NOT part of the production contract.
  function _state() { return { activePath, knownSize, activeDate, maxBytes }; }

  return { write, drain, _state, _maybeRotate: maybeRotate };
}

module.exports = { createRotator, buildArchivePath, utcDateString, DEFAULT_MAX_BYTES };
