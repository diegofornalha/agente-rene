/**
 * jest.e2e.config.js — Config separado pros tests E2E (Wave T1/T2/T3 — 2026-05-27).
 *
 * POR QUE SEPARADO?
 * - Tests unitários em `tests/*.test.js` rodam rápido (<5s) e cobrem unidades isoladas
 * - Tests E2E em `tests/e2e/*.e2e.test.js` orquestram cadeias completas (orquestrador
 *   Tábula end-to-end, pipeline de geração de templates HTML→DOCX, fluxo de fatura
 *   parse→Drive→Zoho). Demoram mais (~30s no total) e precisam de mocks rigorosos
 *   pras dependências externas (Twenty/Zoho/wuzapi/BCB/Drive).
 *
 * EXECUÇÃO:
 *   npx jest --config jest.e2e.config.js
 *   npx jest --config jest.e2e.config.js --testNamePattern='happy path'
 *
 * RESTRIÇÕES:
 *  - maxWorkers=1: tests E2E mexem em env vars, fs tmp, dedup state. Paralelo introduz
 *    flakiness — sequencial é ~30s no total, aceitável.
 *  - testTimeout=30000: alguns tests rodam helpers Python (templates render), processo
 *    PFX (criptografia), gerenciamento de child process (mythos local).
 *
 * SAFETY:
 *  - Tests NUNCA enviam pra wuzapi/Zoho/Twenty real. Helpers de mock interceptam HTTP.
 *  - dirOverride pra tmpdir garante zero write em data/ do projeto.
 *  - Fixtures com segredos vão em .gitignore (tests/e2e/fixtures/*.local.json).
 */

'use strict';

module.exports = {
  testMatch: ['<rootDir>/tests/e2e/**/*.e2e.test.js'],
  testTimeout: 30000,
  maxWorkers: 1,
  // Mostra qual teste tá rodando — útil quando 1 trava de 30s
  verbose: true,
  // Setup global pós-framework — registra afterEach() de cleanup pra todos os tests
  // (nock, jest mocks, env vars temporárias). Belt-and-suspenders sem cada arquivo lembrar.
  setupFilesAfterEnv: ['<rootDir>/tests/e2e/helpers/cleanup.js'],
  // Bail no primeiro erro pra logs ficarem legíveis (E2E é onde toda falha importa)
  bail: false,
  testPathIgnorePatterns: ['/node_modules/'],
  // Cobertura quando flag --coverage for passada — só dos módulos JS envolvidos.
  // NOTA: T2 (templates) roda script Python — cobertura desses templates é
  // confirmada pela execução real (7 templates render OK em <3s) e não pela
  // ferramenta JS coverage. T3 (fatura) exercita skill em ~/.claude/skills/,
  // fora da árvore do bridge-lucrecia — sem coverage automático JS.
  collectCoverageFrom: [
    'services/tabula/orquestrador.js',
    'services/tabula/lib/execucao-store.js',
    'services/tabula/handlers/fase1-ingestao.js',
  ],
  coverageDirectory: '<rootDir>/coverage-e2e',
};
