/**
 * Gmail — leitura, envio e busca de emails.
 * Usa OAuth2 compartilhado via google-auth.js.
 */

const { google } = require('googleapis');
const googleAuth = require('./google-auth');

function _api() {
  const auth = googleAuth.getClient();
  if (!auth || !googleAuth.isAuthenticated()) {
    throw new Error('Gmail não autenticado. Acesse /api/google/auth-url primeiro.');
  }
  return google.gmail({ version: 'v1', auth });
}

/**
 * Lista mensagens recentes.
 * @param {Object} opts
 * @param {string} [opts.query] - Gmail search query (ex: "is:unread", "from:contato@")
 * @param {number} [opts.maxResults=20]
 * @param {string[]} [opts.labelIds] - ex: ['INBOX', 'UNREAD']
 */
async function listMessages(opts = {}) {
  const gmail = _api();

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: opts.query || '',
    maxResults: opts.maxResults || 20,
    labelIds: opts.labelIds || undefined,
  });

  if (!res.data.messages?.length) return [];

  // Busca detalhes em paralelo (headers + snippet)
  const details = await Promise.all(
    res.data.messages.map(m =>
      gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      }).then(r => r.data)
    )
  );

  return details.map(m => {
    const headers = {};
    (m.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });
    return {
      id: m.id,
      threadId: m.threadId,
      snippet: m.snippet,
      from: headers.from || '',
      to: headers.to || '',
      subject: headers.subject || '',
      date: headers.date || '',
      labelIds: m.labelIds || [],
      isUnread: (m.labelIds || []).includes('UNREAD'),
    };
  });
}

/**
 * Lê o corpo completo de uma mensagem.
 */
async function getMessage(messageId) {
  const gmail = _api();

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const msg = res.data;
  const headers = {};
  (msg.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });

  // Extrai body (text/plain preferred, fallback to text/html)
  let body = '';
  function extractBody(part) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      body = Buffer.from(part.body.data, 'base64').toString('utf-8');
    } else if (!body && part.mimeType === 'text/html' && part.body?.data) {
      body = Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (part.parts) part.parts.forEach(extractBody);
  }
  extractBody(msg.payload);

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: headers.from || '',
    to: headers.to || '',
    subject: headers.subject || '',
    date: headers.date || '',
    body,
    labelIds: msg.labelIds || [],
  };
}

/**
 * Envia email.
 * @param {Object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.body - texto plano
 * @param {string} [opts.cc]
 * @param {string} [opts.bcc]
 * @param {string} [opts.replyTo] - messageId pra reply
 */
async function sendEmail(opts) {
  const gmail = _api();

  const from = 'lucas@lucasjuridico.com';
  const lines = [
    `From: ${from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (opts.cc) lines.splice(2, 0, `Cc: ${opts.cc}`);
  if (opts.bcc) lines.splice(2, 0, `Bcc: ${opts.bcc}`);

  lines.push('', opts.body);

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  const params = { userId: 'me', requestBody: { raw } };
  if (opts.replyTo) params.requestBody.threadId = opts.replyTo;

  const res = await gmail.users.messages.send(params);
  return { id: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds };
}

/**
 * Marca mensagem como lida.
 */
async function markAsRead(messageId) {
  const gmail = _api();
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
  return { messageId, markedRead: true };
}

/**
 * Busca emails por query.
 */
async function searchEmails(query, maxResults = 20) {
  return listMessages({ query, maxResults });
}

/**
 * Conta emails não lidos.
 */
async function unreadCount() {
  const gmail = _api();
  const res = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
  return {
    total: res.data.messagesTotal,
    unread: res.data.messagesUnread,
    threadsTotal: res.data.threadsTotal,
    threadsUnread: res.data.threadsUnread,
  };
}

module.exports = {
  listMessages,
  getMessage,
  sendEmail,
  markAsRead,
  searchEmails,
  unreadCount,
};
