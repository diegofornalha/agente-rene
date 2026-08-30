/**
 * doc-converter.js
 * Converte HTML de diagnóstico/entregável em PDF + DOCX.
 * Usa WeasyPrint (CLI) pra PDF e html-docx-js pra DOCX.
 *
 * Uso:
 *   const { convertHtml } = require('./doc-converter');
 *   const { pdfPath, docxPath } = await convertHtml('path/to/file.html');
 *
 * CLI:
 *   node services/doc-converter.js path/to/file.html
 */

const fs = require('fs-extra');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Resolvido via PATH por padrão; sobrescreva com WEASYPRINT no .env se preciso.
const WEASYPRINT = process.env.WEASYPRINT || 'weasyprint';

async function convertHtml(htmlPath, opts = {}) {
  const absPath = path.resolve(htmlPath);
  if (!await fs.pathExists(absPath)) {
    throw new Error(`HTML não encontrado: ${absPath}`);
  }

  const dir = path.dirname(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  const pdfPath = opts.pdfPath || path.join(dir, `${base}.pdf`);
  const docxPath = opts.docxPath || path.join(dir, `${base}.docx`);

  // --- PDF via WeasyPrint (CLI) ---
  await execFileAsync(WEASYPRINT, [absPath, pdfPath], { timeout: 60000 });

  // --- DOCX via html-docx-js ---
  const htmlContent = await fs.readFile(absPath, 'utf-8');
  const htmlDocx = require('html-docx-js');
  const docxBuffer = htmlDocx.asBlob(htmlContent);
  await fs.writeFile(docxPath, Buffer.from(await docxBuffer.arrayBuffer()));

  return { pdfPath, docxPath };
}

async function convertDir(dirPath) {
  const absDir = path.resolve(dirPath);
  const files = await fs.readdir(absDir);
  const htmlFiles = files.filter(f => f.endsWith('.html'));
  const results = [];
  for (const f of htmlFiles) {
    const result = await convertHtml(path.join(absDir, f));
    results.push({ html: f, ...result });
  }
  return results;
}

// CLI: node services/doc-converter.js <arquivo.html | diretório>
if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.error('Uso: node services/doc-converter.js <arquivo.html | diretório>');
    process.exit(1);
  }
  const absInput = path.resolve(input);
  fs.stat(absInput).then(async (stat) => {
    if (stat.isDirectory()) {
      const results = await convertDir(absInput);
      for (const r of results) {
        console.log(`${r.html} → PDF: ${r.pdfPath} | DOCX: ${r.docxPath}`);
      }
    } else {
      const { pdfPath, docxPath } = await convertHtml(absInput);
      console.log(`PDF:  ${pdfPath}`);
      console.log(`DOCX: ${docxPath}`);
    }
  }).catch(err => {
    console.error('Erro:', err.message);
    process.exit(1);
  });
}

module.exports = { convertHtml, convertDir };
