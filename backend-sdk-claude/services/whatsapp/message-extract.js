'use strict';
// message-extract.js — helpers PUROS de extração/normalização de mensagens
// Baileys e texto. Zero estado, zero I/O: recebem msg/texto, devolvem valor.

// contextInfo pode estar em QUALQUER tipo de mensagem — não só texto. Áudio,
// imagem, vídeo etc. carregam menção/reply no próprio nó. Ler só o
// extendedTextMessage fazia a menção em ÁUDIO nunca ser detectada.
function _msgContextInfo(msg) {
  const m = msg.message || {};
  return m.extendedTextMessage?.contextInfo
    || m.audioMessage?.contextInfo
    || m.imageMessage?.contextInfo
    || m.videoMessage?.contextInfo
    || m.documentMessage?.contextInfo
    || null;
}

// Extrai mensagem citada (usuário marcou uma mensagem anterior no WhatsApp).
function _extractQuotedText(msg) {
  try {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) return null;
    return (
      quoted.conversation ||
      quoted.extendedTextMessage?.text ||
      quoted.imageMessage?.caption ||
      '[mensagem de mídia]'
    ).trim() || null;
  } catch {
    return null;
  }
}

function _extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
}

// Extrai URLs http(s) de um texto (dedup, sem pontuação final colada).
// Usado no modo audio_only: links são enviados como texto abaixo do áudio,
// já que URL falado não dá pra clicar.
function _extractLinks(text) {
  const matches = String(text).match(/https?:\/\/[^\s<>"'`)\]}]+/g) || [];
  const cleaned = matches.map(u => u.replace(/[.,;:!?]+$/, ''));
  return [...new Set(cleaned)];
}

// Separa o bloco de dados técnicos: tudo a partir de uma linha que começa com
// "📋 Detalhes:" é considerado texto-para-ler (não falado). O agente é
// instruído (TTS_SYSTEM_PROMPT_AUDIO_ONLY) a pôr números/códigos/IPs/URLs ali.
function _splitDetails(text) {
  const s = String(text);
  const m = s.match(/^[ \t]*📋[ \t]*Detalhes[ \t]*:/m);
  if (!m) return { spoken: s.trim(), details: '' };
  return { spoken: s.slice(0, m.index).trim(), details: s.slice(m.index).trim() };
}

// Extrai "[RESUMO]: ..." da 1ª linha; resto é o body. Fallback se Claude não obedecer.
function _splitSummaryBody(text) {
  const m = String(text).match(/^\s*\[RESUMO\]:\s*(.+?)\n+([\s\S]*)$/);
  if (m && m[1].trim() && m[2].trim()) {
    return { summary: m[1].trim(), body: m[2].trim() };
  }
  // Fallback: pegue até a 1ª quebra ou ~200 chars
  const firstChunk = String(text).split(/\n/)[0].slice(0, 200).trim();
  return { summary: firstChunk || String(text).slice(0, 200), body: String(text) };
}

// Detecta tipo de mídia na quotedMessage.
function _quotedMediaType(quotedMsg) {
  if (!quotedMsg) return null;
  if (quotedMsg.audioMessage) return 'audio';
  if (quotedMsg.videoMessage) return 'video';
  if (quotedMsg.imageMessage) return 'image';
  if (quotedMsg.documentMessage) return 'document';
  return null;
}

// WhatsApp não renderiza `**` como negrito — o asterisco gruda no fim da URL
// (ex.: "…captura-aluguel.html**") e o link deixa de ser clicável (reporte do
// Lucas 2026-07-09). Remove *, ** ou *** envolvendo URLs; resto do texto intacto.
function _stripLinkFormatting(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/\*{1,3}(https?:\/\/[^\s*]+)\*{1,3}/g, '$1');
}

// Extrai a mensagem crua do interlocutor de um prompt montado (wrapper de
// injeção + histórico + "Mensagem atual: <msg>"). Usado como fallback quando
// ctx.rawMessage não existe (zombie tasks rehidratadas de antes do fix
// matryoshka 2026-07-02). Pega a ÚLTIMA ocorrência de "Mensagem atual:" —
// prompts matryoshka antigos podem ter várias aninhadas.
function _extractCurrentMessage(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const marker = 'Mensagem atual: ';
  const idx = prompt.lastIndexOf(marker);
  if (idx === -1) return prompt; // prompt sem wrapper (ex.: task não-WhatsApp) — já é cru
  return prompt.slice(idx + marker.length).trim() || null;
}

module.exports = {
  _msgContextInfo,
  _extractQuotedText,
  _extractText,
  _extractLinks,
  _splitDetails,
  _splitSummaryBody,
  _quotedMediaType,
  _stripLinkFormatting,
  _extractCurrentMessage,
};
