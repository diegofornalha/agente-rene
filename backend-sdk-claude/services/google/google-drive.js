/**
 * Google Drive — upload de arquivos para pasta específica.
 *
 * Usa o OAuth2 compartilhado de google-auth.js (scope drive.file).
 * Permite upload único ou em lote (batch) para uma pasta do Drive.
 */

const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const { getClient, isAuthenticated } = require('./google-auth');

function _getDrive() {
  const auth = getClient();
  if (!auth) throw new Error('Google auth não configurado');
  if (!isAuthenticated()) throw new Error('Google auth não autenticado — acesse /api/google/auth-url primeiro');
  return google.drive({ version: 'v3', auth });
}

/**
 * Upload de um arquivo local para o Google Drive.
 * @param {string} filePath — caminho absoluto do arquivo local
 * @param {object} opts
 * @param {string} [opts.folderId] — ID da pasta destino no Drive
 * @param {string} [opts.name] — nome no Drive (default: nome original do arquivo)
 * @returns {{ id, name, mimeType, webViewLink }}
 */
async function uploadFile(filePath, opts = {}) {
  const drive = _getDrive();
  const fileName = opts.name || path.basename(filePath);
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';

  const fileMetadata = { name: fileName };
  if (opts.folderId) fileMetadata.parents = [opts.folderId];

  const media = {
    mimeType,
    body: fs.createReadStream(filePath),
  };

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, mimeType, webViewLink',
  });

  return res.data;
}

/**
 * Upload em lote — vários arquivos para a mesma pasta.
 * @param {string[]} filePaths — array de caminhos absolutos
 * @param {object} opts
 * @param {string} [opts.folderId] — ID da pasta destino
 * @returns {Array<{ file, result?, error? }>}
 */
async function uploadBatch(filePaths, opts = {}) {
  const results = [];
  for (const fp of filePaths) {
    try {
      const result = await uploadFile(fp, opts);
      results.push({ file: path.basename(fp), result });
    } catch (err) {
      results.push({ file: path.basename(fp), error: err.message });
    }
  }
  return results;
}

/**
 * Cria uma pasta no Drive.
 * @param {string} name — nome da pasta
 * @param {string} [parentId] — pasta pai (opcional)
 * @returns {{ id, name, webViewLink }}
 */
async function createFolder(name, parentId) {
  const drive = _getDrive();
  const fileMetadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) fileMetadata.parents = [parentId];

  const res = await drive.files.create({
    requestBody: fileMetadata,
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

/**
 * Lista arquivos de uma pasta.
 * @param {string} folderId
 * @param {number} [pageSize=50]
 * @returns {Array<{ id, name, mimeType, webViewLink }>}
 */
async function listFiles(folderId, pageSize = 50) {
  const drive = _getDrive();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    pageSize,
    fields: 'files(id, name, mimeType, webViewLink)',
  });
  return res.data.files || [];
}

/**
 * Busca pasta por nome no Drive.
 * @param {string} name — nome (ou parte) da pasta
 * @param {string} [parentId] — restringir busca a uma pasta pai
 * @returns {Array<{ id, name, webViewLink }>}
 */
async function findFolder(name, parentId) {
  const drive = _getDrive();
  let q = `mimeType = 'application/vnd.google-apps.folder' and name contains '${name.replace(/'/g, "\\'")}' and trashed = false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const res = await drive.files.list({
    q,
    pageSize: 20,
    fields: 'files(id, name, webViewLink)',
  });
  return res.data.files || [];
}

module.exports = { uploadFile, uploadBatch, createFolder, listFiles, findFolder };
