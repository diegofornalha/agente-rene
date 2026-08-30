// identity-resolver.js — Resolve (jid, sock, msg) → { phone, lid, name, name_source }
// em 2 etapas separadas:
//   1. LID → número canônico via sock.signalRepository.lidMapping.getPNForLID (Baileys 7)
//   2. número → pessoa via identity-store (data/contacts.json)
//
// Fallbacks (ordem):
//   manual > unverified > push_name > "Desconhecido (...)"
//
// Cache em memória LID→número (TTL curto, 5min) pra reduzir chamadas no Baileys
// quando o mesmo LID manda várias mensagens em sequência.

const { normalizeBrPhone } = require('./normalize-br');
const store = require('./identity-store');

const _lidCache = new Map(); // lid → { phone, expiresAt }
const LID_CACHE_TTL_MS = 5 * 60 * 1000;

function _cacheGet(lid) {
  const v = _lidCache.get(lid);
  if (!v) return undefined;
  if (Date.now() > v.expiresAt) { _lidCache.delete(lid); return undefined; }
  return v.phone;
}

function _cacheSet(lid, phone) {
  _lidCache.set(lid, { phone, expiresAt: Date.now() + LID_CACHE_TTL_MS });
}

// Resolve qualquer JID pra número canônico. Retorna null se não conseguir.
async function resolveLidToNumber({ jid, sock }) {
  if (!jid) return null;
  const [id, domain] = String(jid).split('@');
  if (!id) return null;
  if (domain === 's.whatsapp.net') return normalizeBrPhone(id);
  if (domain === 'lid') {
    const cached = _cacheGet(id);
    if (cached !== undefined) return cached;
    try {
      // Baileys exige LID completo "<user>@lid" — passar só o user
      // faz isLidUser() retornar false silenciosamente (lid-mapping.js:235).
      const fullLid = `${id}@lid`;
      const pnJid = await sock?.signalRepository?.lidMapping?.getPNForLID?.(fullLid);
      // Retorno é "5511999990000:0@s.whatsapp.net" (com device suffix). Extrai
      // só o número, descartando :device e @domain.
      const rawPn = pnJid ? String(pnJid).split('@')[0].split(':')[0] : null;
      const normalized = rawPn ? normalizeBrPhone(rawPn) : null;
      if (!normalized) {
        console.log(`[lid-resolve] LID não mapeado pelo Baileys: ${id}`);
      }
      _cacheSet(id, normalized);
      return normalized;
    } catch (e) {
      console.log(`[lid-resolve] lid=${id} ERROR: ${e.message}`);
      _cacheSet(id, null);
      return null;
    }
  }
  return null;
}

// Resolve identidade completa pra uso no prompt/peer.
// Retorna { phone, lid, name, name_source }.
async function resolveIdentity({ jid, sock, msg }) {
  if (!jid) {
    return { phone: null, lid: null, name: 'Desconhecido', name_source: 'unknown' };
  }
  const [id, domain] = String(jid).split('@');
  const lid = domain === 'lid' ? id : null;

  const phone = await resolveLidToNumber({ jid, sock });

  if (phone) {
    // 1. Audit-log do LID no number (sem custo se já estava)
    if (lid) store.upsertLidMapping(phone, lid);

    // 2. Lookup em contacts.json
    const person = store.getPersonByNumber(phone);
    if (person) {
      return {
        phone,
        lid,
        name: person.name,
        name_source: person.name_source,
        person_id: person.person_id,
        device: person.device,
      };
    }

    // 3. Sem entry — tenta pushName (cria entrada nova se útil)
    const pushName = msg?.pushName;
    if (store.isUsefulPushName(pushName)) {
      const personId = store.upsertPushName(phone, pushName);
      return {
        phone,
        lid,
        name: pushName.trim(),
        name_source: 'push_name',
        person_id: personId,
      };
    }

    // 4. Fallback honesto
    return {
      phone,
      lid,
      name: `Desconhecido (+${phone})`,
      name_source: 'unknown',
    };
  }

  // LID não resolveu no Baileys — não tem como saber número
  return {
    phone: null,
    lid,
    name: lid ? `Desconhecido (LID ${lid})` : 'Desconhecido',
    name_source: 'unknown',
  };
}

module.exports = {
  resolveLidToNumber,
  resolveIdentity,
};
