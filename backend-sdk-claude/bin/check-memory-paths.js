#!/usr/bin/env node
// Verifica se os paths absolutos citados em data/memory/**/*.md ainda existem
// no filesystem. Pegadinha que motivou: quando lucro-ativo-pitch/ foi movido
// pra dentro de backend-sdk-claude/, MEMORY.md continuou apontando pro caminho
// antigo e o bot falhou silenciosamente em achar os HTMLs do Rota Fiscal.
//
// Uso: node bin/check-memory-paths.js
// Exit: 0 se todos os paths existem, 1 se algum quebrou.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MEMORY_DIR = path.join(ROOT, 'data', 'memory');
const HOME = os.homedir();
const PATH_RE = /\/Users\/[^\s)`"'<>]+/g;

function walkMd(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMd(full, acc);
    else if (ent.isFile() && ent.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

function stripTrailing(p) {
  // Remove pontuação final comum em prosa markdown: "...em path/X." → "path/X"
  return p.replace(/[.,;:!?]+$/, '');
}

function main() {
  if (!fs.existsSync(MEMORY_DIR)) {
    console.error(`memory dir não existe: ${MEMORY_DIR}`);
    process.exit(2);
  }

  const files = walkMd(MEMORY_DIR);
  let checked = 0;
  let stale = 0;

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('<!--')) continue;
      const matches = line.match(PATH_RE);
      if (!matches) continue;
      for (const raw of matches) {
        const p = stripTrailing(raw);
        if (!p) continue;
        // So checamos paths sob o home do usuario atual. Paths sob outros
        // /Users/<outro>/ sao referencias externas (ex.: a contraparte
        // picoclaw em outro host) e nao deveriam disparar erro aqui.
        if (!p.startsWith(HOME + '/') && p !== HOME) continue;
        checked++;
        if (!fs.existsSync(p)) {
          stale++;
          console.log(`STALE: ${rel}:${i + 1} → ${p}`);
        }
      }
    }
  }

  console.log(`OK ${checked} paths checked, ${stale} stale`);
  process.exit(stale > 0 ? 1 : 0);
}

main();
