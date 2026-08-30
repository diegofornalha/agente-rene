'use strict';
/**
 * services/media/tts-sanitizer.js — Sanitiza texto antes de enviar pro TTS.
 *
 * Regras (feedback Diego 2026-06-11):
 * - Números convertidos pra extenso em PT-BR (ex: 60000 → "sessenta mil")
 * - R$ valores convertidos (ex: R$ 60.000,00 → "sessenta mil reais")
 * - Percentuais convertidos (ex: 15% → "quinze por cento")
 * - URLs removidas
 * - IDs técnicos removidos (JIDs, LIDs, UUIDs, hashes)
 * - Markdown removido
 */

const UNITS = ['','um','dois','três','quatro','cinco','seis','sete','oito','nove'];
const TEENS = ['dez','onze','doze','treze','quatorze','quinze','dezesseis','dezessete','dezoito','dezenove'];
const TENS  = ['','','vinte','trinta','quarenta','cinquenta','sessenta','setenta','oitenta','noventa'];
const HUNDREDS = ['','cento','duzentos','trezentos','quatrocentos','quinhentos','seiscentos','setecentos','oitocentos','novecentos'];

function numberToWords(n) {
  if (n < 0) return 'menos ' + numberToWords(-n);
  if (n === 0) return 'zero';
  if (n === 100) return 'cem';
  const parts = [];
  if (n >= 1_000_000_000) {
    const b = Math.floor(n / 1_000_000_000);
    parts.push(b === 1 ? 'um bilhão' : numberToWords(b) + ' bilhões');
    n %= 1_000_000_000;
  }
  if (n >= 1_000_000) {
    const m = Math.floor(n / 1_000_000);
    parts.push(m === 1 ? 'um milhão' : numberToWords(m) + ' milhões');
    n %= 1_000_000;
  }
  if (n >= 1000) {
    const t = Math.floor(n / 1000);
    parts.push(t === 1 ? 'mil' : numberToWords(t) + ' mil');
    n %= 1000;
  }
  if (n >= 100) {
    if (n === 100) { parts.push('cem'); n = 0; }
    else { parts.push(HUNDREDS[Math.floor(n / 100)]); n %= 100; }
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)]);
    n %= 10;
  }
  if (n >= 10) { parts.push(TEENS[n - 10]); n = 0; }
  if (n >= 1) parts.push(UNITS[n]);
  return parts.join(' e ');
}

function prepareTextForTTS(text) {
  let t = String(text);
  // Remove URLs
  t = t.replace(/https?:\/\/\S+/gi, '');
  // Remove IDs técnicos (JIDs, LIDs, UUIDs, hashes longos)
  t = t.replace(/\b[a-f0-9]{8,}(?:[-@][a-z0-9.]+)*\b/gi, '');
  // Remove emojis markdown-style
  t = t.replace(/:[a-z_]+:/g, '');
  // Converte R$ valores (ex: R$ 60.000,00 → sessenta mil reais)
  t = t.replace(/R\$\s*([\d.,]+)/g, (_m, val) => {
    const clean = val.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(clean);
    if (isNaN(num)) return '';
    const intPart = Math.floor(num);
    const cents = Math.round((num - intPart) * 100);
    let r = numberToWords(intPart) + (intPart === 1 ? ' real' : ' reais');
    if (cents > 0) r += ' e ' + numberToWords(cents) + (cents === 1 ? ' centavo' : ' centavos');
    return r;
  });
  // Converte percentuais (ex: 15% → quinze por cento)
  t = t.replace(/(\d+)%/g, (_m, d) => numberToWords(parseInt(d, 10)) + ' por cento');
  // Converte números restantes (inteiros e decimais)
  t = t.replace(/\b(\d{1,15}(?:[.,]\d+)?)\b/g, (_m, numStr) => {
    const clean = numStr.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(clean);
    if (isNaN(num) || num > 999_999_999_999) return numStr;
    if (Number.isInteger(num)) return numberToWords(num);
    const [intP, decP] = clean.split('.');
    return numberToWords(parseInt(intP, 10)) + ' vírgula ' + numberToWords(parseInt(decP, 10));
  });
  // Remove markdown (**, __, `, #, etc)
  t = t.replace(/[*_`#~|>\[\]()]/g, '');
  // Normaliza espaços
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

module.exports = { prepareTextForTTS, numberToWords };
