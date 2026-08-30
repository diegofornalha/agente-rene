'use strict';
// services/db/sqlite.js — abertura unificada de bancos better-sqlite3.
//
// - require lazy: o binário nativo só é carregado no primeiro openDb(), nunca
//   em require-time do módulo consumidor (testes e scripts podem importar
//   serviços sem tocar SQLite).
// - nativeBinding explícito: bypassa o pacote `bindings` (resolução por stack
//   trace, frágil sob test runners) e produz erro de ABI legível na hora certa.
//   Override via SQLITE_NATIVE_BINDING pra apontar outro build se preciso.
// - pragmas padronizados (WAL + synchronous NORMAL) pra todos os bancos.
//
// ATENÇÃO ABI: o binário em node_modules é compilado pro Node da PRODUÇÃO
// (CLAUDE_NODE_BIN, hoje ~/opt/node = v22/ABI 127). Rodar com outro Node dá
// ERR_DLOPEN_FAILED — use scripts/run-tests.sh (testes) e scripts/start.sh
// (produção), que resolvem o Node certo; scripts/preflight.sh rebuilda se a
// ABI divergir.

const path = require('path');

function _nativeBinding() {
  if (process.env.SQLITE_NATIVE_BINDING) return process.env.SQLITE_NATIVE_BINDING;
  return path.join(
    path.dirname(require.resolve('better-sqlite3/package.json')),
    'build', 'Release', 'better_sqlite3.node'
  );
}

function openDb(dbFile, opts = {}) {
  const Database = require('better-sqlite3');
  const db = new Database(dbFile, { nativeBinding: _nativeBinding(), ...opts });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

module.exports = { openDb };
