/**
 * Google OAuth2 — shared auth para Calendar + Gmail.
 *
 * Fluxo:
 *   1. GET /api/google/auth-url  → redireciona o user pro consent screen
 *   2. GET /api/google/callback  → recebe code, troca por tokens, persiste
 *   3. Tokens em data/google-tokens.json (refresh automático)
 *
 * Requer GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET no .env
 * (ou data/google-credentials.json baixado do console).
 */

const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, '..', '..', 'data', 'google-tokens.json');
const CREDENTIALS_PATH = path.join(__dirname, '..', '..', 'data', 'google-credentials.json');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
];

let _oauth2Client = null;

function _getCredentials() {
  // Tenta env vars primeiro, depois arquivo
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return {
      clientId,
      clientSecret,
      redirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://api-rene.databutton.com.br/api/google/callback',
    };
  }

  if (fs.existsSync(CREDENTIALS_PATH)) {
    const raw = fs.readJsonSync(CREDENTIALS_PATH);
    const creds = raw.installed || raw.web;
    return {
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      redirectUri: creds.redirect_uris?.[0] || 'http://localhost:3457/api/google/callback',
    };
  }

  return null;
}

function getClient() {
  if (_oauth2Client) return _oauth2Client;

  const creds = _getCredentials();
  if (!creds) return null;

  _oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);

  // Carrega tokens salvos
  if (fs.existsSync(TOKENS_PATH)) {
    const tokens = fs.readJsonSync(TOKENS_PATH);
    _oauth2Client.setCredentials(tokens);
  }

  // Auto-refresh: persiste tokens atualizados
  _oauth2Client.on('tokens', (tokens) => {
    const existing = fs.existsSync(TOKENS_PATH) ? fs.readJsonSync(TOKENS_PATH) : {};
    const merged = { ...existing, ...tokens };
    fs.writeJsonSync(TOKENS_PATH, merged, { spaces: 2 });
    console.log('🔑 Google tokens atualizados');
  });

  return _oauth2Client;
}

function getAuthUrl() {
  const client = getClient();
  if (!client) return null;

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

async function handleCallback(code) {
  const client = getClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.writeJsonSync(TOKENS_PATH, tokens, { spaces: 2 });
  return tokens;
}

function isAuthenticated() {
  const client = getClient();
  return client && client.credentials && client.credentials.access_token;
}

module.exports = { getClient, getAuthUrl, handleCallback, isAuthenticated, TOKENS_PATH };
