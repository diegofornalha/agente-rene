// Hooks lifecycle — carrega arquivos JS de data/hooks/ e dispara eventos
// nos momentos certos do ciclo de uma task / canal de mensagem.
//
// Convenção do arquivo (cada um exporta funções por evento):
//   module.exports = {
//     onTaskStart:  async ({ task })            => { ... },
//     onTaskStep:   async ({ task, step })      => { ... },
//     onTaskDone:   async ({ task })            => { ... },
//     onTaskError:  async ({ task, error })     => { ... },
//     onMessageIn:  async ({ source, role, text }) => { ... },
//     onMessageOut: async ({ source, role, text }) => { ... },
//   };
//
// Erros num hook são logados mas não interrompem o fluxo.

const fs = require('fs-extra');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', '..', 'data', 'hooks');

let _loaded = [];
let _byEvent = {};
const _failures = []; // ring buffer max 100 — alimenta health-checker.checkRecentHookFailures

function _scan() {
  _loaded = [];
  _byEvent = {};
  if (!fs.existsSync(HOOKS_DIR)) return;

  const files = fs.readdirSync(HOOKS_DIR)
    .filter(f => f.endsWith('.js') && !f.startsWith('_') && !f.endsWith('.disabled'));

  for (const f of files) {
    const fullPath = path.join(HOOKS_DIR, f);
    try {
      delete require.cache[require.resolve(fullPath)];
      const mod = require(fullPath);
      _loaded.push({ file: f, mod });
      for (const event of Object.keys(mod)) {
        if (typeof mod[event] !== 'function') continue;
        (_byEvent[event] ||= []).push({ file: f, fn: mod[event] });
      }
      console.log(`🪝 hook carregado: ${f} (${Object.keys(mod).join(', ')})`);
    } catch (e) {
      console.error(`❌ hook ${f} falhou ao carregar:`, e.message);
    }
  }
}

async function emit(event, payload) {
  const list = _byEvent[event] || [];
  for (const { file, fn } of list) {
    try {
      await fn(payload);
    } catch (e) {
      console.error(`❌ hook ${file}.${event} erro:`, e.message);
      _failures.push({ ts: Date.now(), file, event, message: e.message });
      if (_failures.length > 100) _failures.shift();
    }
  }
}

function list() {
  return _loaded.map(h => ({ file: h.file, events: Object.keys(h.mod) }));
}

function reload() {
  _scan();
  return list();
}

function recentFailures(sinceMs) {
  const cutoff = Date.now() - sinceMs;
  return _failures.filter(f => f.ts > cutoff);
}

// Inicializa eager pra que hooks já estejam disponíveis
fs.ensureDirSync(HOOKS_DIR);
_scan();

module.exports = { emit, list, reload, recentFailures };
