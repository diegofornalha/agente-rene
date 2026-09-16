/* Personalizador de decks — Lucro Ativo
   Desenha o bloco de contato do executivo no ULTIMO slide do deck.
   Funciona em Node (require) e no browser (script tag -> window.LADeck). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LADeck = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NAVY = { r: 0 / 255, g: 8 / 255, b: 96 / 255 };      // #000860
  var GOLD = { r: 0xc9 / 255, g: 0xa2 / 255, b: 0x27 / 255 }; // #c9a227
  var LILAC = { r: 0xc8 / 255, g: 0xcd / 255, b: 0xf0 / 255 }; // #c8cdf0
  var WHITE = { r: 1, g: 1, b: 1 };
  var DIM = { r: 0x9b / 255, g: 0xa3 / 255, b: 0xd6 / 255 };

  // layouts por deck (coordenadas em pt, origem no topo-esquerdo do slide 960x540)
  var LAYOUTS = {
    dcf: {
      mode: 'left',
      x: 67.5,
      ruleTop: 462, ruleBottom: 519, ruleW: 3,
      textX: 82,
      nome: { y: 479, size: 17 },
      cargo: { y: 497, size: 11.5 },
      contato: { y: 514, size: 11.5 }
    },
    pgfn: {
      mode: 'center',
      cover: [494, 540],
      cx: 480,
      l1: { y: 512, size: 12 },
      l2: { y: 528, size: 9.5 }
    },
    icms: {
      mode: 'center',
      cover: [494, 540],
      cx: 480,
      l1: { y: 512, size: 12 },
      l2: { y: 528, size: 9.5 }
    }
  };

  function clean(s) { return (s || '').trim().replace(/\s+/g, ' '); }

  // desenha uma sequencia de segmentos [{t,font,size,color}] a partir de x (baseline yTop)
  function drawRun(page, H, segs, x, yTop) {
    var cur = x;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s.t) continue;
      page.drawText(s.t, { x: cur, y: H - yTop, size: s.size, font: s.font, color: s.color });
      cur += s.font.widthOfTextAtSize(s.t, s.size);
    }
    return cur - x;
  }

  function runWidth(segs) {
    var w = 0;
    for (var i = 0; i < segs.length; i++) if (segs[i].t) w += segs[i].font.widthOfTextAtSize(segs[i].t, segs[i].size);
    return w;
  }

  function joinSegs(parts, font, size, color, sepColor) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (out.length) out.push({ t: '  ·  ', font: font, size: size, color: sepColor || color });
      out.push({ t: parts[i], font: font, size: size, color: color });
    }
    return out;
  }

  /* pdfLibNS: modulo pdf-lib; fontkitNS: modulo fontkit
     opts: { pdfBytes, fonts:{mBold,mSemi,iReg,iSemi} (Uint8Array), deck:'dcf'|'pgfn'|'icms',
             nome, cargo, telefone, email } */
  async function personalizar(pdfLibNS, fontkitNS, opts) {
    var PDFDocument = pdfLibNS.PDFDocument, rgb = pdfLibNS.rgb;
    var doc = await PDFDocument.load(opts.pdfBytes);
    doc.registerFontkit(fontkitNS);

    var mBold = await doc.embedFont(opts.fonts.mBold, { subset: true });
    var mSemi = await doc.embedFont(opts.fonts.mSemi, { subset: true });
    var iReg = await doc.embedFont(opts.fonts.iReg, { subset: true });
    var iSemi = await doc.embedFont(opts.fonts.iSemi, { subset: true });

    var pages = doc.getPages();
    var page = pages[pages.length - 1];
    var H = page.getHeight();
    var L = LAYOUTS[opts.deck] || LAYOUTS.dcf;

    var nome = clean(opts.nome), cargo = clean(opts.cargo);
    var tel = clean(opts.telefone), mail = clean(opts.email);

    var C = {
      gold: rgb(GOLD.r, GOLD.g, GOLD.b),
      white: rgb(WHITE.r, WHITE.g, WHITE.b),
      lilac: rgb(LILAC.r, LILAC.g, LILAC.b),
      dim: rgb(DIM.r, DIM.g, DIM.b),
      navy: rgb(NAVY.r, NAVY.g, NAVY.b)
    };

    // nada preenchido -> devolve o deck intacto
    if (!nome && !cargo && !tel && !mail) return await doc.save();

    if (L.mode === 'left') {
      // monta so as linhas que existem (colapsa vazias)
      var lines = [];
      if (nome) lines.push({ segs: [{ t: nome, font: mBold, size: L.nome.size, color: C.white }], lead: L.nome.size + 1 });
      if (cargo) lines.push({ segs: [{ t: cargo, font: iSemi, size: L.cargo.size, color: C.gold }], lead: L.cargo.size + 6 });
      var ct = joinSegs([tel, mail], iReg, L.contato.size, C.lilac, C.dim);
      if (ct.length) lines.push({ segs: ct, lead: L.contato.size + 5.5 });

      var y = L.nome.y, last = y;
      for (var li = 0; li < lines.length; li++) {
        if (li > 0) y += lines[li].lead;
        drawRun(page, H, lines[li].segs, L.textX, y);
        last = y;
      }
      // filete dourado acompanha o bloco real
      var top = L.ruleTop, bot = last + 5;
      page.drawRectangle({
        x: L.x, y: H - bot, width: L.ruleW,
        height: bot - top, color: C.gold
      });
    } else {
      // cobre o rodape original e reescreve centralizado
      page.drawRectangle({
        x: 0, y: H - L.cover[1], width: page.getWidth(),
        height: L.cover[1] - L.cover[0], color: C.navy
      });
      var l1 = [];
      if (nome) l1.push({ t: nome.toUpperCase(), font: mSemi, size: L.l1.size, color: C.white });
      if (cargo) {
        if (l1.length) l1.push({ t: '  ·  ', font: iReg, size: L.l1.size - 1.5, color: C.dim });
        l1.push({ t: cargo, font: iReg, size: L.l1.size - 1.5, color: C.lilac });
      }
      if (l1.length) drawRun(page, H, l1, L.cx - runWidth(l1) / 2, L.l1.y);

      var l2 = joinSegs([tel, mail, '@meulucroativo'], iReg, L.l2.size, C.lilac, C.dim);
      if (l2.length) drawRun(page, H, l2, L.cx - runWidth(l2) / 2, L.l2.y);
    }

    return await doc.save();
  }

  return { personalizar: personalizar, LAYOUTS: LAYOUTS };
});
