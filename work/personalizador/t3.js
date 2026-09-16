const fs=require('fs');const {PDFDocument,rgb}=require('pdf-lib');const fontkit=require('@pdf-lib/fontkit');const e=require('/home/hermes/agente-rene/work/personalizador/engine.js');
const B='/home/hermes/agente-rene/work/personalizador/';
const fonts={mBold:fs.readFileSync(B+'fonts/Montserrat-Bold.ttf'),mSemi:fs.readFileSync(B+'fonts/Montserrat-SemiBold.ttf'),iReg:fs.readFileSync(B+'fonts/Inter-Regular.ttf'),iSemi:fs.readFileSync(B+'fonts/Inter-SemiBold.ttf')};
(async()=>{
 const out=await e.personalizar({PDFDocument,rgb},fontkit,{pdfBytes:fs.readFileSync(B+'decks/icms.pdf'),fonts,deck:'icms',
  nome:'Guilherme Valadares',cargo:'Executivo de Negócios',telefone:'(16) 99999-1234',email:'guilherme.valadares@meulucroativo.com.br'});
 fs.writeFileSync('/tmp/new_icms.pdf',out);
 // caso curto
 const o2=await e.personalizar({PDFDocument,rgb},fontkit,{pdfBytes:fs.readFileSync(B+'decks/dcf.pdf'),fonts,deck:'dcf',nome:'Ana Lima',cargo:'',telefone:'(16) 99999-0000',email:''});
 fs.writeFileSync('/tmp/short_dcf.pdf',o2);
 console.log('ok');
})().catch(e=>{console.error(e);process.exit(1)});
