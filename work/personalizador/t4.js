const fs=require('fs');const {PDFDocument,rgb}=require('pdf-lib');const fontkit=require('@pdf-lib/fontkit');const e=require('./engine.js');
const fonts={mBold:fs.readFileSync('fonts/Montserrat-Bold.ttf'),mSemi:fs.readFileSync('fonts/Montserrat-SemiBold.ttf'),iReg:fs.readFileSync('fonts/Inter-Regular.ttf'),iSemi:fs.readFileSync('fonts/Inter-SemiBold.ttf')};
const cases={
 full:{nome:'Guilherme Valadares',cargo:'Executivo de Negócios',telefone:'(16) 99999-1234',email:'guilherme.valadares@meulucroativo.com.br'},
 short:{nome:'Ana Lima',cargo:'',telefone:'(16) 99999-0000',email:''},
 sonome:{nome:'Ana Lima',cargo:'',telefone:'',email:''},
 vazio:{nome:'',cargo:'',telefone:'',email:''},
};
(async()=>{
 for(const [k,v] of Object.entries(cases)){
  for(const deck of ['dcf','icms']){
   const out=await e.personalizar({PDFDocument,rgb},fontkit,{pdfBytes:fs.readFileSync(`decks/${deck}.pdf`),fonts,deck,...v});
   fs.writeFileSync(`/tmp/c_${k}_${deck}.pdf`,out);
  }
 }
 console.log('ok');
})().catch(e=>{console.error(e);process.exit(1)});
