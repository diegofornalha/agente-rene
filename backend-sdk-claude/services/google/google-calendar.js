/**
 * Google Calendar — CRUD de eventos + paleta de cores do Lucas.
 *
 * Paleta (colorId do Google Calendar API):
 *   1  Lavanda     → não usado
 *   2  Sage        → não usado
 *   3  Uva         → Reuniões com equipe (roxo)       — mapeado de "equipe"
 *   4  Flamingo    → não usado
 *   5  Banana      → Prazos e obrigações (amarelo)    — mapeado de "prazo"
 *   6  Tangerina   → não usado
 *   7  Pavão       → Pessoal (ciano)                  — mapeado de "pessoal"
 *   8  Grafite     → não usado
 *   9  Mirtilo     → Clientes / prospects (azul)      — mapeado de "cliente"
 *  10  Manjericão  → Escritório / interno (verde)     — mapeado de "interno"
 *  11  Tomate      → Urgente / alerta (vermelho)      — mapeado de "urgente"
 */

const { google } = require('googleapis');
const googleAuth = require('./google-auth');

const COLOR_MAP = {
  cliente:  '9',   // Mirtilo (azul escuro)
  prospect: '9',
  equipe:   '3',   // Uva (roxo)
  interno:  '10',  // Manjericão (verde)
  prazo:    '5',   // Banana (amarelo)
  pessoal:  '7',   // Pavão (ciano)
  urgente:  '11',  // Tomate (vermelho)
};

function _api() {
  const auth = googleAuth.getClient();
  if (!auth || !googleAuth.isAuthenticated()) {
    throw new Error('Google Calendar não autenticado. Acesse /api/google/auth-url primeiro.');
  }
  return google.calendar({ version: 'v3', auth });
}

/**
 * Lista eventos do calendário.
 * @param {Object} opts
 * @param {string} [opts.calendarId='primary']
 * @param {string} [opts.timeMin] ISO — default: agora
 * @param {string} [opts.timeMax] ISO — default: +7 dias
 * @param {number} [opts.maxResults=50]
 */
async function listEvents(opts = {}) {
  const cal = _api();
  const now = new Date();
  const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const res = await cal.events.list({
    calendarId: opts.calendarId || 'primary',
    timeMin: opts.timeMin || now.toISOString(),
    timeMax: opts.timeMax || weekLater.toISOString(),
    maxResults: opts.maxResults || 50,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return res.data.items || [];
}

/**
 * Cria um evento.
 * @param {Object} event
 * @param {string} event.summary - Título
 * @param {string} [event.description]
 * @param {string} event.start - ISO datetime ou date (all-day)
 * @param {string} event.end - ISO datetime ou date
 * @param {string} [event.category] - chave da COLOR_MAP
 * @param {string} [event.location]
 * @param {string[]} [event.attendees] - emails
 * @param {Object} [event.reminders] - {useDefault: false, overrides: [{method, minutes}]}
 */
async function createEvent(event) {
  const cal = _api();

  const isAllDay = event.start && event.start.length === 10; // YYYY-MM-DD

  const body = {
    summary: event.summary,
    description: event.description || '',
    location: event.location || '',
    start: isAllDay ? { date: event.start } : { dateTime: event.start, timeZone: 'America/Sao_Paulo' },
    end: isAllDay ? { date: event.end } : { dateTime: event.end, timeZone: 'America/Sao_Paulo' },
  };

  if (event.category && COLOR_MAP[event.category]) {
    body.colorId = COLOR_MAP[event.category];
  }

  if (event.attendees?.length) {
    body.attendees = event.attendees.map(email => ({ email }));
  }

  if (event.reminders) {
    body.reminders = event.reminders;
  } else {
    body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] };
  }

  const res = await cal.events.insert({
    calendarId: event.calendarId || 'primary',
    resource: body,
    sendUpdates: event.attendees?.length ? 'all' : 'none',
  });

  return res.data;
}

/**
 * Atualiza um evento existente.
 */
async function updateEvent(eventId, updates, calendarId = 'primary') {
  const cal = _api();

  const body = {};
  if (updates.summary) body.summary = updates.summary;
  if (updates.description !== undefined) body.description = updates.description;
  if (updates.location !== undefined) body.location = updates.location;
  if (updates.start) {
    const isAllDay = updates.start.length === 10;
    body.start = isAllDay ? { date: updates.start } : { dateTime: updates.start, timeZone: 'America/Sao_Paulo' };
  }
  if (updates.end) {
    const isAllDay = updates.end.length === 10;
    body.end = isAllDay ? { date: updates.end } : { dateTime: updates.end, timeZone: 'America/Sao_Paulo' };
  }
  if (updates.category && COLOR_MAP[updates.category]) {
    body.colorId = COLOR_MAP[updates.category];
  }

  const res = await cal.events.patch({
    calendarId,
    eventId,
    resource: body,
  });

  return res.data;
}

/**
 * Deleta um evento.
 */
async function deleteEvent(eventId, calendarId = 'primary') {
  const cal = _api();
  await cal.events.delete({ calendarId, eventId });
  return { deleted: true, eventId };
}

/**
 * Busca eventos por texto.
 */
async function searchEvents(query, opts = {}) {
  const cal = _api();
  const now = new Date();
  const sixMonths = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

  const res = await cal.events.list({
    calendarId: opts.calendarId || 'primary',
    q: query,
    timeMin: opts.timeMin || now.toISOString(),
    timeMax: opts.timeMax || sixMonths.toISOString(),
    maxResults: opts.maxResults || 20,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return res.data.items || [];
}

/**
 * Retorna agenda do dia formatada.
 */
async function todayAgenda(calendarId = 'primary') {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const events = await listEvents({
    calendarId,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    maxResults: 30,
  });

  return events.map(e => ({
    id: e.id,
    summary: e.summary,
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date,
    location: e.location || null,
    colorId: e.colorId || null,
    status: e.status,
  }));
}

module.exports = {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  searchEvents,
  todayAgenda,
  COLOR_MAP,
};
