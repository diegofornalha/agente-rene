'use strict';
// memory-shortcuts.js — atalhos de memória do WhatsApp: comandos que gravam/
// consultam MEMORY.md / USER.md direto, sem disparar Claude ("lembre que X",
// "sobre mim: X", "esquece X", "liste skills", "@divida <cnpj>", etc.).

const path = require('path');
const memory = require('../memory/memory-store');
const convHistory = require('../memory/conversation-history');

// Memory shortcuts: "lembre que X" / "anota: X" → MEMORY.md;
// "sobre mim: X" → USER.md; "esquece X" → remove linha que contém X.
// Retorna () => Promise<string> com a resposta pronta, ou null se não é shortcut.
function _memoryShortcut(text) {
  const t = String(text).trim();

  const mRemember = t.match(/^(?:lembre[- ]?(?:te|se)?\s+(?:que|de)|anota[:,]?|memo[:,]?)\s+(.+)/i);
  if (mRemember) {
    const fact = mRemember[1].trim();
    return async () => {
      const r = memory.appendToMd('MEMORY.md', fact);
      return r.ok && !r.dedup
        ? `✅ anotado no MEMORY.md (${r.length}/2200 chars)`
        : r.dedup ? `ℹ️ já estava anotado` : `❌ falha: ${r.reason}`;
    };
  }

  const mUser = t.match(/^(?:sobre\s+mim|meu\s+perfil|user[:,]?)\s*[:,]?\s+(.+)/i);
  if (mUser) {
    const fact = mUser[1].trim();
    return async () => {
      const r = memory.appendToMd('USER.md', fact);
      return r.ok && !r.dedup
        ? `✅ anotado no USER.md (${r.length}/1375 chars)`
        : r.dedup ? `ℹ️ já estava no perfil` : `❌ falha: ${r.reason}`;
    };
  }

  const mForget = t.match(/^(?:esquece|remova?|apaga)\s+(?:que\s+|isso[:,]?\s+)?(.+)/i);
  if (mForget) {
    const substr = mForget[1].trim();
    return async () => {
      const memR = memory.removeLineFromMd('MEMORY.md', substr);
      const usrR = memory.removeLineFromMd('USER.md', substr);
      if (memR.ok || usrR.ok) return `✅ removido (${memR.ok ? 'MEMORY' : 'USER'}.md)`;
      return `❌ não achei nada com "${substr}"`;
    };
  }

  if (/^(o\s+que\s+voc[eê]\s+(?:sabe|lembra)|mostrar?\s+(mem[oó]ria|user)|cat\s+memory)/i.test(t)) {
    return async () => {
      const snap = memory.snapshotMd();
      return [
        snap.user   ? `## USER.md\n${snap.user}`   : '',
        snap.memory ? `## MEMORY.md\n${snap.memory}` : '',
      ].filter(Boolean).join('\n\n') || '(memória vazia)';
    };
  }

  // "liste skills" → lista skills disponíveis em .claude/skills/
  if (/^(liste|mostre|lista)\s+(?:as?\s+)?skills/i.test(t)) {
    return async () => {
      const { glob } = require('fs');
      const { promisify } = require('util');
      const globAsync = promisify(glob);
      const fs2 = require('fs-extra');
      const SKILLS_ROOT = path.join(__dirname, '..', '..', '.claude', 'skills');
      let skills = [];
      try {
        const files = await globAsync('**/*.md', { cwd: SKILLS_ROOT });
        skills = files.map(f => f.replace(/\.md$/, '').replace(/\//g, ' / ')).filter(s => !s.startsWith('_'));
      } catch (_) {}
      if (skills.length === 0) return 'Nenhuma skill local encontrada. Use /skill-name pra ativar.';
      return `📋 Skills disponíveis (${skills.length}):\n` + skills.map(s => `  • ${s}`).join('\n');
    };
  }

  // "o que você sabe sobre X" → busca no MEMORY.md e USER.md por X
  const mKnow = t.match(/^(?:o\s+que\s+(?:voc[eê]|meu)\s+(?:sabe|lembra|conhece|tem)\s+(?:sobre|de|do|da)\s+)(.+)/i);
  if (mKnow && t.length > 5) {
    const query = mKnow[1].trim();
    if (query.length > 2 && !query.includes('skills') && !query.includes('memória')) {
      return async () => {
        const snap = memory.snapshotMd();
        const search = query.toLowerCase();
        const memLines = snap.memory?.split('\n').filter(l => l.toLowerCase().includes(search)) || [];
        const usrLines = snap.user?.split('\n').filter(l => l.toLowerCase().includes(search)) || [];
        if (memLines.length === 0 && usrLines.length === 0) return `🤔 Não encontrei nada sobre "${query}" na memória.`;
        return [`🔍 Memórias sobre "${query}":`, ...memLines.map(l => `  MEM: ${l}`), ...usrLines.map(l => `  USER: ${l}`)].join('\n');
      };
    }
  }

  // "silencia X" → adiciona preferência de silêncio ao USER.md
  const mSilence = t.match(/^(?:silencia|não\s+(?:manda|envia|mostre))\s+(.+)/i);
  if (mSilence) {
    const item = mSilence[1].trim();
    return async () => {
      const r = memory.appendToMd('USER.md', `não mencione: ${item}`);
      return r.ok ? `🔇 silêncio ativado: "${item}"` : `❌ falha: ${r.reason}`;
    };
  }

  // "esquece o último" → undo stack: remove última linha do MEMORY.md
  const mUndo = /^(?:esquece\s+(?:o\s+)?último|undo|desfaz)/i.test(t);
  if (mUndo) {
    return async () => {
      const snap = memory.snapshotMd();
      const memLines = snap.memory?.split('\n').filter(l => l.trim()) || [];
      if (memLines.length === 0) return 'Nada pra desfazer — memória vazia.';
      const last = memLines.pop();
      memory.writeMd('MEMORY.md', memLines.join('\n'));
      return `↩️ desfiz: ${last}`;
    };
  }

  // "@divida <cnpj>" → cria caso de dívida ativa e pede CSV do Regularize
  const mDivida = t.match(/^@divida\s+(\d[\d.\/\-]+)/i);
  if (mDivida) {
    const cnpjRaw = mDivida[1];
    const dividaPipeline = require('../../src/pipelines/divida-ativa');
    return async () => {
      const cnpj = dividaPipeline.normalizeCnpj(cnpjRaw);
      if (!cnpj) return `❌ CNPJ inválido: "${cnpjRaw}" — formato esperado: 14 dígitos (XX.XXX.XXX/XXXX-XX)`;
      const existing = await dividaPipeline.getCase(cnpjRaw);
      if (existing && existing.status === 'aguardando_csv') {
        return `⏳ Caso ${existing.id} (${cnpj}) já existe — aguardando CSV do Regularize.\n\nEnvie o CSV aqui que eu processo automaticamente.`;
      }
      if (existing && existing.status === 'processado') {
        return `✅ Caso ${existing.id} (${cnpj}) já foi processado.\n\n${existing.ledger ? `Consolidado: R$ ${existing.ledger.total_vivo.toLocaleString('pt-BR', {minimumFractionDigits:2})}` : ''}\n\nPra reprocessar, envie um novo CSV.`;
      }
      const caseObj = await dividaPipeline.createCase(cnpjRaw);
      return `📋 Caso ${caseObj.id} criado para CNPJ ${cnpj}\n\nAgora preciso do **CSV do Regularize** (Relatório Consolidado da Dívida Ativa da União e do FGTS).\n\nEnvie o arquivo CSV aqui que eu rodo o pipeline completo: parser → prescrição → transação → DC → judicial → motor econômico → diagnóstico rápido.`;
    };
  }

  // "limpa sessão" → limpa histórico multi-turno da conversa atual
  if (/^(limpa\s+(?:sessão|conversa|contexto)|reset\s+(?:chat|conversation))/i.test(t)) {
    return async () => {
      const snap = convHistory.stats();
      // Não temos remoteJid aqui — user pode pedir antes de receber resposta.
      // Marca undo geral (todas sessões) pedindo confirmação.
      return '🗑️ Use "sim, limpa" pra confirmar limpeza de sessão.';
    };
  }

  return null;
}

module.exports = { _memoryShortcut };
