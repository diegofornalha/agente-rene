// claude-collect.js — coleta texto final consolidado de um iterator async do Claude CLI.
//
// BUG DE FUNDAÇÃO 2026-05-16: SDK CLI emite o MESMO texto em 2 eventos —
// `type:'assistant'` (streaming partial) + `type:'result'` (final consolidado).
// Antes deste helper, todo consumidor empilhava AMBOS em 1 array de chunks →
// texto duplicado ("Beleza!Beleza!"). Diego (vendedor adicionado ao grupo lucrecia)
// notou em 2 testes seguidos no grupo. Bug afetava 11 lugares do codebase
// (chat-handler.askLucrecia, executor-outlook, executor-nda, content-generate,
// reconcile, + 6 scripts backfill).
//
// Esta função é a ÚNICA forma correta de coletar texto de query() do
// claude-query.js — qualquer outro padrão (chunks.push em loop manual com
// branch separado pra assistant.text e result.result) reintroduz o bug.
//
// Regras:
// - `resultText` (final consolidado) é preferido sobre `assistantText` (streaming)
//   porque contêm a MESMA informação — só usar streaming como fallback se
//   result não chegar (timeout/abort no meio do stream).
// - Erro com texto parcial → devolve o parcial (não throw) pra UX não regrida.
// - Erro sem nenhum texto → throw (não devolve string vazia que vazaria erro
//   silencioso pro grupo WhatsApp).
//
// Plan: ~/.claude/plans/linear-sauteeing-book.md (Fix DEFINITIVO duplicação).

/**
 * Coleta o texto final de um iterator async do Claude CLI.
 * @param {AsyncIterable<object>} asyncIterable — retorno de `query({...})`
 * @returns {Promise<string>} texto final (trim aplicado)
 * @throws {Error} se SDK emitir erro e não houver texto parcial coletado
 */
async function collectClaudeResponse(asyncIterable) {
  let assistantText = '';
  let resultText = '';
  for await (const evt of asyncIterable) {
    if (evt?.is_error || evt?.subtype === 'error') {
      if (!assistantText && !resultText) {
        throw new Error(evt.error || evt.result || 'Claude CLI erro desconhecido');
      }
      break; // tem texto parcial — devolve o que tem em vez de descartar
    }
    if (evt?.type === 'assistant' && evt.message?.content) {
      for (const c of evt.message.content) {
        if (c.type === 'text' && c.text) assistantText += c.text;
      }
    } else if (evt?.type === 'result' && typeof evt.result === 'string' && !evt.is_error) {
      resultText = evt.result;
    }
  }
  return (resultText || assistantText).trim();
}

module.exports = { collectClaudeResponse };
