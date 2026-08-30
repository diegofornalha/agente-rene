// Plugin Loader (esqueleto F4.17) — carrega plugins de ~/.hermes-mythos/plugins/
// e do diretório local data/plugins/. Cada plugin é um arquivo .js que pode
// registrar hooks (via services/hooks.js) e/ou tools custom.
//
// Estrutura mínima de um plugin:
//   module.exports = {
//     name: 'meu-plugin',
//     version: '0.1.0',
//     async setup({ hooks, taskRunner, app, io }) { ... },
//   };

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const DIRS = [
  path.join(__dirname, '..', '..', 'data', 'plugins'),
  path.join(os.homedir(), '.hermes-mythos', 'plugins'),
];

const _loaded = [];

async function start(ctx) {
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.disabled'));
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const mod = require(full);
        if (typeof mod.setup === 'function') {
          await mod.setup(ctx);
        }
        _loaded.push({ name: mod.name || f, version: mod.version || '?', path: full });
        console.log(`🧩 plugin carregado: ${mod.name || f}`);
      } catch (e) {
        console.error(`❌ plugin ${f} falhou:`, e.message);
      }
    }
  }
  if (_loaded.length === 0) {
    console.log('🧩 Plugins: nenhum carregado');
  }
}

function list() { return _loaded; }

module.exports = { start, list };
