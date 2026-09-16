const fs=require('fs');const {PDFDocument,rgb}=require('pdf-lib');const fontkit=require('@pdf-lib/fontkit');const e=require('./engine.js');
const fonts={mBold:fs.readFileSync('fonts/Montserrat-Bold.ttf'),mSemi:fs.readFileSync('fonts/Montserrat-SemiBold.ttf'),iReg:fs.readFileSync('fonts/Inter-Regular.ttf'),iSemi:fs.readFileSync('fonts/Inter-SemiBold.ttf')};
(async()=>{
 for(const deck of ['dcf','pgfn']){
  const out=await e.personalizar({PDFDocument,rgb},fontkit,{pdfBytes:fs.readFileSync(`decks/${deck}.pdf`),fonts,deck,
   nome:'Maria Aparecida Gonçalves de Albuquerque',cargo:'Executiva Sênior de Negócios Corporativos',telefone:'(16) 3512-0000 / (16) 99999-0000',email:'maria.albuquerque@meulucroativo.com.br'});
  fs.writeFileSync(`/tmp/long_${deck}.pdf`,out);
 }
 const out2=await e.personalizar({PDFDocument,rgb},fontkit,{pdfBytes:fs.readFileSync('decks/dcf.pdf'),fonts,deck:'dcf',nome:'',cargo:'',telefone:'',email:''});
 fs.writeFileSync('/tmp/empty_dcf.pdf',out2);
 console.log('ok');
})().catch(e=>{console.error(e);process.exit(1)});
