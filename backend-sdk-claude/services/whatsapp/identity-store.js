// identity-store.js — Cache em memória + I/O do data/contacts.json.
//
// Schema:
//   {
//     persons: { <person_id>: { name, name_source, ...meta } },
//     numbers: { <num_canonico>: { person_id, phone_source, ddd, device, lids[] } }
//   }
//
// Regras (ver plan: princípios 5 e 6):
//   - name_source: "manual" > "unverified" > "push_name" > "unknown"
//   - upsertPushName NUNCA sobrescreve manual nem unverified
//   - canonicalização BR via normalize-br.js (consistente leitura/escrita)

const fs = require('fs');
const path = require('path');
const { normalizeBrPhone, brVariants } = require('./normalize-br');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'contacts.json');

let _store = { persons: {}, numbers: {} };
let _loaded = false;
let _saveTimer = null;

function loadContacts() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    _store = JSON.parse(raw);
    if (!_store.persons) _store.persons = {};
    if (!_store.numbers) _store.numbers = {};
    _loaded = true;
  } catch (e) {
    console.error(`[identity-store] falha carregando ${STORE_PATH}:`, e.message);
    _store = { persons: {}, numbers: {} };
    _loaded = true;
  }
  return _store;
}

function _ensureLoaded() {
  if (!_loaded) loadContacts();
}

function _getNumberEntry(num) {
  _ensureLoaded();
  const norm = normalizeBrPhone(num);
  if (_store.numbers[norm]) return { key: norm, entry: _store.numbers[norm] };
  // tenta variantes (com/sem 9)
  for (const v of brVariants(num)) {
    if (_store.numbers[v]) return { key: v, entry: _store.numbers[v] };
  }
  return null;
}

function getPersonByNumber(num) {
  _ensureLoaded();
  const found = _getNumberEntry(num);
  if (!found) return null;
  const person = _store.persons[found.entry.person_id];
  if (!person) return null;
  return {
    person_id: found.entry.person_id,
    name: person.name,
    name_source: person.name_source,
    role: person.role,
    note: person.note,
    device: found.entry.device,
    ddd: found.entry.ddd,
  };
}

function getNumbersForPerson(personId) {
  _ensureLoaded();
  return Object.entries(_store.numbers)
    .filter(([, v]) => v.person_id === personId)
    .map(([k]) => k);
}

function getAllPersons() {
  _ensureLoaded();
  return _store.persons;
}

function getAllNumbers() {
  _ensureLoaded();
  return _store.numbers;
}

// Sanitiza pushName — rejeita valores que o whatsmeow/Baileys já consideram não-úteis.
function isUsefulPushName(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || t === '-' || t === 'username') return false;
  return true;
}

// Cria entrada nova ou atualiza só se name_source atual for "push_name".
// NUNCA sobrescreve "manual" nem "unverified" — pushName é controlado pela
// pessoa e pode ser trocado/spoofado.
function upsertPushName(num, pushName) {
  _ensureLoaded();
  if (!isUsefulPushName(pushName)) return null;
  const norm = normalizeBrPhone(num);
  if (!norm) return null;
  const pushNameTrim = pushName.trim();

  const found = _getNumberEntry(norm);
  if (found) {
    const person = _store.persons[found.entry.person_id];
    if (person && person.name_source === 'push_name' && person.name !== pushNameTrim) {
      person.name = pushNameTrim;
      _scheduleSave();
      return found.entry.person_id;
    }
    // manual/unverified: não toca. Audit-log do LID já é feito por upsertLidMapping.
    return found.entry.person_id;
  }

  // Sem entrada — cria pessoa nova com person_id derivado do pushName + sufixo.
  const personId = _genPersonId(pushNameTrim);
  _store.persons[personId] = {
    name: pushNameTrim,
    name_source: 'push_name',
    discovered_at: new Date().toISOString(),
  };
  _store.numbers[norm] = {
    person_id: personId,
    phone_source: 'first-message',
    lids: [],
  };
  _scheduleSave();
  return personId;
}

// Adiciona LID ao array de auditoria do número (sem persistir se já está lá).
function upsertLidMapping(num, lid) {
  _ensureLoaded();
  if (!lid) return;
  const norm = normalizeBrPhone(num);
  if (!norm) return;
  const entry = _store.numbers[norm];
  if (!entry) return; // só registra se já tem entry (gerada via pushName ou semente)
  if (!entry.lids) entry.lids = [];
  if (!entry.lids.includes(lid)) {
    entry.lids.push(lid);
    _scheduleSave();
  }
}

function _genPersonId(name) {
  const slug = String(name).toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 30) || 'desconhecido';
  if (!_store.persons[slug]) return slug;
  let i = 2;
  while (_store.persons[`${slug}-${i}`]) i++;
  return `${slug}-${i}`;
}

function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    fs.writeFile(STORE_PATH, JSON.stringify(_store, null, 2) + '\n', (e) => {
      if (e) console.error('[identity-store] save failed:', e.message);
    });
  }, 2000);
}

// Flush síncrono (pra graceful shutdown se necessário)
function saveContactsSync() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(_store, null, 2) + '\n');
  } catch (e) {
    console.error('[identity-store] saveSync failed:', e.message);
  }
}

module.exports = {
  loadContacts,
  getPersonByNumber,
  getNumbersForPerson,
  getAllPersons,
  getAllNumbers,
  upsertPushName,
  upsertLidMapping,
  isUsefulPushName,
  saveContactsSync,
};
