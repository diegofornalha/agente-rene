// normalize-br.js — Canonicalização do 9º dígito BR.
// Usado tanto na escrita (persistência de pushName) quanto na leitura (resolver),
// pra evitar entradas duplicadas pro mesmo contato.
//
// Regra: pra +55 móvel, garante 9 dígitos no local (DDD + 9XXXXXXXX).
//   '5511987654321' → '5511987654321' (já tem 9)
//   '551187654321'  → '5511987654321' (adiciona o 9)
// Não-BR ou fixo: retorna como veio (só limpa não-dígitos).

function _digits(s) {
  return String(s || '').replace(/\D/g, '');
}

function normalizeBrPhone(num) {
  const d = _digits(num);
  if (!d) return d;
  // BR: começa com 55, próximos 2 são DDD (10..99), depois 8 ou 9 dígitos
  if (d.length === 12 && d.startsWith('55')) {
    // 5511 + 87654321 → adiciona 9 se o local começa com 6,7,8,9 (móvel)
    const ddd = d.slice(2, 4);
    const local = d.slice(4);
    if (/^[6-9]/.test(local)) return `55${ddd}9${local}`;
  }
  return d;
}

// Variantes pra busca tolerante (com e sem o 9).
function brVariants(num) {
  const d = normalizeBrPhone(num);
  const out = new Set([d]);
  if (d.length === 13 && d.startsWith('55')) {
    const ddd = d.slice(2, 4);
    const local = d.slice(4);
    if (local[0] === '9' && local.length === 9) {
      out.add(`55${ddd}${local.slice(1)}`); // remove o 9
    }
  }
  return [...out];
}

module.exports = { normalizeBrPhone, brVariants };
