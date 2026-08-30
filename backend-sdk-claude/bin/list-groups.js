#!/usr/bin/env node
// Lista todos os grupos WhatsApp em que o bot participa.
// Usa a mesma auth do Baileys em data/whatsapp-auth/.

const path = require('path');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const AUTH_DIR = path.join(__dirname, '..', 'data', 'whatsapp-auth');

(async () => {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Hermes-ListGroups', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'open') {
      try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups);
        console.log(`\nTotal de grupos: ${list.length}\n`);
        for (const g of list) {
          const members = g.participants?.length || 0;
          const admins = (g.participants || []).filter(p => p.admin).length;
          console.log(`  • ${g.subject}  (${members} membros, ${admins} admins)  [${g.id}]`);
        }
        console.log('');
      } catch (e) {
        console.error('Erro ao listar grupos:', e.message);
      }
      process.exit(0);
    }
    if (connection === 'close') {
      console.error('Conexão fechou antes de listar. Verifique a auth.');
      process.exit(1);
    }
  });
})();
