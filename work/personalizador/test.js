const fs = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const engine = require('./engine.js');

const fonts = {
  mBold: fs.readFileSync('fonts/Montserrat-Bold.ttf'),
  mSemi: fs.readFileSync('fonts/Montserrat-SemiBold.ttf'),
  iReg:  fs.readFileSync('fonts/Inter-Regular.ttf'),
  iSemi: fs.readFileSync('fonts/Inter-SemiBold.ttf'),
};

(async () => {
  for (const deck of ['dcf','icms','pgfn']) {
    const bytes = fs.readFileSync(`decks/${deck}.pdf`);
    const out = await engine.personalizar({PDFDocument, rgb}, fontkit, {
      pdfBytes: bytes, fonts, deck,
      nome: 'Guilherme Valadares',
      cargo: 'Executivo de Negócios',
      telefone: '(16) 99999-0000',
      email: 'guilherme.valadares@meulucroativo.com.br'
    });
    fs.writeFileSync(`/tmp/pers_${deck}.pdf`, out);
    console.log('ok', deck, out.length);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
