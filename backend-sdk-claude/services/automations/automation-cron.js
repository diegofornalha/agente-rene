// Cron manager para as automações de coaching comercial.

const cron = require('node-cron');
const briefing = require('./briefing-pre-reuniao');
const relatorio = require('./relatorio-semanal');
const lembreteFup = require('./lembrete-fup');

let _briefingTask = null;
let _relatorioTask = null;
let _lembreteFupTask = null;

function start() {
  if (_briefingTask) return;

  _briefingTask = cron.schedule('*/30 8-17 * * 1-5', async () => {
    console.log('📋 automation-cron: verificando briefing pré-reunião...');
    try {
      const result = await briefing.run();
      if (result.sent > 0) console.log(`📋 briefing: ${result.sent} enviado(s)`);
      else if (result.skipped) console.log('📋 briefing: pulado (Google não autenticado)');
    } catch (e) {
      console.error('📋 briefing erro:', e.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  _relatorioTask = cron.schedule('0 21 * * 0', async () => {
    console.log('📊 automation-cron: gerando relatório semanal...');
    try {
      const result = await relatorio.run();
      console.log(`📊 relatório: ${result.sent || 0} mensagens enviadas`);
    } catch (e) {
      console.error('📊 relatório erro:', e.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  _lembreteFupTask = cron.schedule('0 9 * * 1-5', async () => {
    console.log('⚠️ automation-cron: verificando deals sem follow-up...');
    try {
      const result = await lembreteFup.run();
      console.log(`⚠️ lembrete-fup: ${result.sent || 0} mensagens, ${result.semFup}/${result.total} sem FUP`);
    } catch (e) {
      console.error('⚠️ lembrete-fup erro:', e.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  console.log('🤖 Automações comerciais ativas:');
  console.log('  • Briefing pré-reunião: a cada 30min (8h-18h, seg-sex)');
  console.log('  • Relatório semanal: domingos às 21h');
  console.log('  • Lembrete follow-up: seg-sex às 9h');
}

function stop() {
  if (_briefingTask) { _briefingTask.stop(); _briefingTask = null; }
  if (_relatorioTask) { _relatorioTask.stop(); _relatorioTask = null; }
  if (_lembreteFupTask) { _lembreteFupTask.stop(); _lembreteFupTask = null; }
}

module.exports = { start, stop };
