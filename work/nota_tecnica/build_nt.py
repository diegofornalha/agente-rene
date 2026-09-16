#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Nota Tecnica NT-001/2026 - Marco Temporal e Natureza do Ativo (DCF) - padrao Lucro Ativo."""
import re
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

NAVY = RGBColor(0x01, 0x08, 0x60)
GOLD = RGBColor(0xC9, 0xA2, 0x27)
GOLD_DARK = RGBColor(0x8A, 0x6D, 0x0D)
INK = RGBColor(0x14, 0x14, 0x14)
GREY = RGBColor(0x5A, 0x60, 0x72)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
RED = RGBColor(0xA3, 0x1B, 0x1B)
GREEN = RGBColor(0x1B, 0x5E, 0x3A)

doc = Document()

st = doc.styles['Normal']
st.font.name = 'Inter'; st.font.size = Pt(10); st.font.color.rgb = INK
st.paragraph_format.space_after = Pt(6); st.paragraph_format.line_spacing = 1.22
rf = st.element.rPr.get_or_add_rFonts()
rf.set(qn('w:ascii'), 'Inter'); rf.set(qn('w:hAnsi'), 'Inter')

for name, sz, before, after in (('Heading 1', 14, 16, 6), ('Heading 2', 11.5, 11, 4), ('Heading 3', 10.5, 8, 3)):
    h = doc.styles[name]
    h.font.name = 'Montserrat'; h.font.size = Pt(sz); h.font.bold = True
    h.font.color.rgb = NAVY
    h.paragraph_format.space_before = Pt(before); h.paragraph_format.space_after = Pt(after)
    h.paragraph_format.keep_with_next = True
    r2 = h.element.rPr.get_or_add_rFonts()
    for attr in ('asciiTheme', 'hAnsiTheme', 'cstheme', 'eastAsiaTheme'):
        if r2.get(qn('w:' + attr)) is not None:
            del r2.attrib[qn('w:' + attr)]
    r2.set(qn('w:ascii'), 'Montserrat'); r2.set(qn('w:hAnsi'), 'Montserrat'); r2.set(qn('w:cs'), 'Montserrat')

lb = doc.styles['List Bullet']
lb.font.name = 'Inter'; lb.font.size = Pt(10)
lb.paragraph_format.space_after = Pt(4); lb.paragraph_format.line_spacing = 1.2


def shade(cell, hexcolor):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd'); shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:fill'), hexcolor); tcPr.append(shd)


def no_borders(table):
    borders = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        e = OxmlElement('w:' + edge); e.set(qn('w:val'), 'none'); borders.append(e)
    table._tbl.tblPr.append(borders)


def set_borders(table, color='DDE1EC', sz=4):
    borders = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        e = OxmlElement('w:' + edge); e.set(qn('w:val'), 'single')
        e.set(qn('w:sz'), str(sz)); e.set(qn('w:color'), color); borders.append(e)
    table._tbl.tblPr.append(borders)


def cell_margins(table, top=80, bottom=80, left=110, right=110):
    tblPr = table._tbl.tblPr
    mar = OxmlElement('w:tblCellMar')
    for k, v in (('top', top), ('left', left), ('bottom', bottom), ('right', right)):
        e = OxmlElement('w:' + k); e.set(qn('w:w'), str(v)); e.set(qn('w:type'), 'dxa'); mar.append(e)
    tblPr.append(mar)


def add_runs(p, text, bold_color=NAVY, base_color=None, size=None, font='Inter'):
    for i, part in enumerate(re.split(r'\*\*', text)):
        if not part:
            continue
        r = p.add_run(part)
        r.font.name = font
        if size:
            r.font.size = Pt(size)
        if i % 2 == 1:
            r.font.bold = True
            r.font.color.rgb = bold_color
        elif base_color is not None:
            r.font.color.rgb = base_color
    return p


def para(text, size=10, align=None, space_after=6, color=None, first=False):
    p = doc.add_paragraph()
    add_runs(p, text, size=size, base_color=color)
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.alignment = align or WD_ALIGN_PARAGRAPH.JUSTIFY
    return p


def bullet(text, size=10):
    p = doc.add_paragraph(style='List Bullet')
    add_runs(p, text, size=size)
    p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    return p


def H1(text, num=None):
    p = doc.add_paragraph(style='Heading 1')
    if num:
        r = p.add_run(num + '  ')
        r.font.name = 'Montserrat'; r.font.bold = True; r.font.size = Pt(14); r.font.color.rgb = GOLD_DARK
    r = p.add_run(text)
    r.font.name = 'Montserrat'; r.font.bold = True; r.font.size = Pt(14); r.font.color.rgb = NAVY
    # regua fina dourada abaixo
    pPr = p._p.get_or_add_pPr()
    pbdr = OxmlElement('w:pBdr')
    bt = OxmlElement('w:bottom'); bt.set(qn('w:val'), 'single'); bt.set(qn('w:sz'), '8')
    bt.set(qn('w:space'), '4'); bt.set(qn('w:color'), 'C9A227')
    pbdr.append(bt); pPr.append(pbdr)
    return p


def H2(text):
    p = doc.add_paragraph(style='Heading 2')
    add_runs(p, text, font='Montserrat', size=11.5, bold_color=NAVY, base_color=NAVY)
    return p



def H2_flag(flag, flag_color, text):
    p = doc.add_paragraph(style='Heading 2')
    r = p.add_run(flag + '  ')
    r.font.name = 'Montserrat'; r.font.bold = True; r.font.size = Pt(9); r.font.color.rgb = flag_color
    add_runs(p, text, font='Montserrat', size=11.5, bold_color=NAVY, base_color=NAVY)
    return p


def callout(title, body, fill='F3F5FB', accent=NAVY, title_color=None):
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    t.columns[0].width = Cm(16.4); t.rows[0].cells[0].width = Cm(16.4)
    no_borders(t)
    cell_margins(t, 120, 120, 150, 150)
    c = t.rows[0].cells[0]
    shade(c, fill)
    p0 = c.paragraphs[0]
    r = p0.add_run(title)
    r.font.name = 'Montserrat'; r.font.bold = True; r.font.size = Pt(9)
    r.font.color.rgb = title_color or accent
    p0.paragraph_format.space_after = Pt(3)
    pb = c.add_paragraph()
    add_runs(pb, body, size=9.5)
    pb.paragraph_format.space_after = Pt(0)
    pb.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    # barra lateral de acento
    tcPr = c._tc.get_or_add_tcPr()
    bdr = OxmlElement('w:tcBorders')
    lf = OxmlElement('w:left'); lf.set(qn('w:val'), 'single'); lf.set(qn('w:sz'), '18')
    lf.set(qn('w:color'), 'C9A227' if accent is GOLD_DARK else '010860')
    bdr.append(lf); tcPr.append(bdr)
    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    return t


def quote_legal(body, fonte):
    t = doc.add_table(rows=1, cols=1)
    t.autofit = False
    t.columns[0].width = Cm(16.4); t.rows[0].cells[0].width = Cm(16.4)
    no_borders(t)
    cell_margins(t, 130, 130, 170, 150)
    c = t.rows[0].cells[0]
    shade(c, 'FBF7EA')
    p0 = c.paragraphs[0]
    r = p0.add_run(body)
    r.font.name = 'Inter'; r.font.size = Pt(9.5); r.font.italic = True; r.font.color.rgb = INK
    p0.paragraph_format.space_after = Pt(4)
    p0.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    pf = c.add_paragraph()
    rf2 = pf.add_run(fonte)
    rf2.font.name = 'Montserrat'; rf2.font.size = Pt(8); rf2.font.bold = True; rf2.font.color.rgb = GOLD_DARK
    pf.paragraph_format.space_after = Pt(0)
    tcPr = c._tc.get_or_add_tcPr()
    bdr = OxmlElement('w:tcBorders')
    lf = OxmlElement('w:left'); lf.set(qn('w:val'), 'single'); lf.set(qn('w:sz'), '18'); lf.set(qn('w:color'), 'C9A227')
    bdr.append(lf); tcPr.append(bdr)
    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    return t


# ============================ CAPA ============================
sec = doc.sections[0]
sec.page_width = Cm(21); sec.page_height = Cm(29.7)
for a in ('top_margin', 'bottom_margin', 'left_margin', 'right_margin'):
    setattr(sec, a, Cm(0))

cover = doc.add_table(rows=1, cols=1)
cover.alignment = WD_TABLE_ALIGNMENT.CENTER
cover.autofit = False
cover.columns[0].width = Cm(21); cover.rows[0].cells[0].width = Cm(21)
tr = cover.rows[0]._tr
trPr = tr.get_or_add_trPr()
trH = OxmlElement('w:trHeight'); trH.set(qn('w:val'), str(int(29.55 * 567))); trH.set(qn('w:hRule'), 'exact')
trPr.append(trH)
no_borders(cover)
c = cover.rows[0].cells[0]
shade(c, '010860')
c.paragraphs[0].text = ''
for _ in range(5):
    sp = c.add_paragraph(); sp.paragraph_format.space_after = Pt(18)

plogo = c.add_paragraph(); plogo.paragraph_format.left_indent = Cm(2.4)
plogo.add_run().add_picture('logo_branca.png', width=Cm(6.8))

k = c.add_paragraph(); k.paragraph_format.left_indent = Cm(2.4); k.paragraph_format.space_before = Pt(34)
r = k.add_run('NOTA TÉCNICA  ·  NT-001/2026'); r.font.name = 'Montserrat'; r.font.bold = True
r.font.size = Pt(11); r.font.color.rgb = GOLD

t1 = c.add_paragraph(); t1.paragraph_format.left_indent = Cm(2.4); t1.paragraph_format.space_before = Pt(10)
t1.paragraph_format.space_after = Pt(0)
r = t1.add_run('Marco temporal e natureza do ativo')
r.font.name = 'Montserrat'; r.font.bold = True; r.font.size = Pt(25); r.font.color.rgb = WHITE

t2 = c.add_paragraph(); t2.paragraph_format.left_indent = Cm(2.4); t2.paragraph_format.space_before = Pt(2)
r = t2.add_run('na compensação de tributos federais')
r.font.name = 'Montserrat'; r.font.bold = True; r.font.size = Pt(25); r.font.color.rgb = WHITE

sub = c.add_paragraph(); sub.paragraph_format.left_indent = Cm(2.4); sub.paragraph_format.space_before = Pt(18)
r = sub.add_run('Por que a operação de Direito Creditório Federal não se confunde\ncom a compensação de crédito de terceiro vedada pelo art. 74, §12,\nda Lei nº 9.430/1996')
r.font.name = 'Inter'; r.font.size = Pt(11.5); r.font.color.rgb = RGBColor(0xC7, 0xCC, 0xE8)

rule = c.add_paragraph(); rule.paragraph_format.left_indent = Cm(2.4); rule.paragraph_format.space_before = Pt(26)
rule.paragraph_format.space_after = Pt(0)
r = rule.add_run('________'); r.font.color.rgb = GOLD; r.font.size = Pt(11); r.font.bold = True

for _ in range(6):
    sp = c.add_paragraph(); sp.paragraph_format.space_after = Pt(16)

meta = c.add_paragraph(); meta.paragraph_format.left_indent = Cm(2.4); meta.paragraph_format.space_after = Pt(2)
r = meta.add_run('EMISSÃO'); r.font.name = 'Montserrat'; r.font.bold = True; r.font.size = Pt(8); r.font.color.rgb = GOLD
m2 = c.add_paragraph(); m2.paragraph_format.left_indent = Cm(2.4); m2.paragraph_format.space_after = Pt(12)
r = m2.add_run('Diretoria Jurídica  ·  Lucro Ativo  ·  Setembro de 2026')
r.font.name = 'Inter'; r.font.size = Pt(10.5); r.font.color.rgb = WHITE

meta3 = c.add_paragraph(); meta3.paragraph_format.left_indent = Cm(2.4); meta3.paragraph_format.space_after = Pt(2)
r = meta3.add_run('DESTINAÇÃO'); r.font.name = 'Montserrat'; r.font.bold = True; r.font.size = Pt(8); r.font.color.rgb = GOLD
m4 = c.add_paragraph(); m4.paragraph_format.left_indent = Cm(2.4); m4.paragraph_format.space_after = Pt(0)
r = m4.add_run('Capacitação interna e entrega ao assessor jurídico/contábil do cliente')
r.font.name = 'Inter'; r.font.size = Pt(10.5); r.font.color.rgb = WHITE

for _ in range(3):
    sp = c.add_paragraph(); sp.paragraph_format.space_after = Pt(14)
ft = c.add_paragraph(); ft.paragraph_format.left_indent = Cm(2.4); ft.paragraph_format.space_after = Pt(0)
r = ft.add_run('www.meulucroativo.com.br')
r.font.name = 'Inter'; r.font.size = Pt(9); r.font.color.rgb = RGBColor(0x9A, 0xA3, 0xD0)

# ============================ MIOLO ============================
from docx.enum.section import WD_SECTION
s2 = doc.add_section(WD_SECTION.NEW_PAGE)
s2.page_width = Cm(21); s2.page_height = Cm(29.7)
s2.top_margin = Cm(2.3); s2.bottom_margin = Cm(2.0)
s2.left_margin = Cm(2.3); s2.right_margin = Cm(2.3)
s2.header_distance = Cm(1.1); s2.footer_distance = Cm(1.0)

# cabecalho
hdr = s2.header
hdr.is_linked_to_previous = False
ht = hdr.add_table(rows=1, cols=2, width=Cm(16.4))
ht.autofit = False
ht.columns[0].width = Cm(4.6); ht.columns[1].width = Cm(11.8)
no_borders(ht)
hc = ht.rows[0].cells[0]
hc.paragraphs[0].add_run().add_picture('la_logo_navy.png', width=Cm(3.4))
hc2 = ht.rows[0].cells[1]
ph = hc2.paragraphs[0]
ph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
r = ph.add_run('NOTA TÉCNICA NT-001/2026  ·  DIREITO CREDITÓRIO FEDERAL')
r.font.name = 'Montserrat'; r.font.size = Pt(7.5); r.font.bold = True; r.font.color.rgb = GREY
hp = hdr.paragraphs[0] if hdr.paragraphs else None
if hp is not None:
    hp.paragraph_format.space_after = Pt(0)
prule = hdr.add_paragraph()
prule.paragraph_format.space_before = Pt(2); prule.paragraph_format.space_after = Pt(0)
pPr = prule._p.get_or_add_pPr()
pbdr = OxmlElement('w:pBdr')
bt = OxmlElement('w:bottom'); bt.set(qn('w:val'), 'single'); bt.set(qn('w:sz'), '8')
bt.set(qn('w:space'), '1'); bt.set(qn('w:color'), 'C9A227')
pbdr.append(bt); pPr.append(pbdr)

# rodape com numeracao
ftr = s2.footer
ftr.is_linked_to_previous = False
fp = ftr.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = fp.add_run('www.meulucroativo.com.br   ·   Uso interno e entrega assistida   ·   ')
r.font.name = 'Inter'; r.font.size = Pt(7.5); r.font.color.rgb = GREY
fldChar = OxmlElement('w:fldChar'); fldChar.set(qn('w:fldCharType'), 'begin')
instr = OxmlElement('w:instrText'); instr.set(qn('xml:space'), 'preserve'); instr.text = 'PAGE'
fldEnd = OxmlElement('w:fldChar'); fldEnd.set(qn('w:fldCharType'), 'end')
rp = fp.add_run(); rp.font.name = 'Montserrat'; rp.font.size = Pt(7.5); rp.font.bold = True
rp.font.color.rgb = NAVY
rp._r.append(fldChar); rp._r.append(instr); rp._r.append(fldEnd)


# ---------------- SINTESE CONCLUSIVA ----------------
H1('SÍNTESE CONCLUSIVA')
para('Circula no mercado a afirmação de que "a legislação tributária brasileira não reconhece compensação de impostos com crédito de terceiros" e de que toda consultoria de direito creditório opera em fraude. A premissa está **parcialmente correta** — e é justamente por isso que ela precisa ser respondida com técnica, não com negativa.', space_after=8)
bullet('**É verdade** que a compensação de crédito de terceiro é **vedada no rito do art. 74 da Lei nº 9.430/1996** (§12, II, "a") e que as autuações em curso, com multa isolada e representação penal, atingem quem operou por essa porta.')
bullet('**É falso**, porém, afirmar isso como regra do sistema: a **Emenda Constitucional nº 113/2021** inseriu no art. 100, §11, da Constituição a faculdade expressa de oferta de créditos "**próprios ou adquiridos de terceiros**", reconhecidos por decisão judicial transitada em julgado, para quitação de débitos perante o ente federativo.')
bullet('A distinção decisiva não é de aparência, mas de **natureza do ativo** e de **marco temporal da titularidade**: a operação de Direito Creditório Federal (DCF) utiliza direito creditório de **natureza civil**, com trânsito em julgado, **cedido e habilitado em nome do cliente antes** de qualquer compensação — quando a declaração é transmitida, o crédito **já é próprio**.')
bullet('Consequência prática: a vedação invocada **não alcança** a operação, porque ela pressupõe (i) crédito de natureza tributária e (ii) crédito alheio no momento do uso. Nenhuma das duas premissas se verifica no DCF.')
callout('▸ ADVERTÊNCIA DE USO',
        'Esta nota **não afirma inexistência de risco**. Ela delimita o fundamento da operação e aponta, no item 8, três questões que dependem de parecer conclusivo da Diretoria Jurídica antes de incorporação definitiva ao discurso comercial. Nenhum executivo deve declarar a cliente "operação sem risco" ou "com total segurança jurídica".',
        fill='FBF7EA', accent=GOLD_DARK, title_color=GOLD_DARK)

# ---------------- 1. OBJETO ----------------
H1('OBJETO E DELIMITAÇÃO', '1.')
para('Esta nota técnica responde a uma objeção específica, hoje recorrente em reuniões comerciais e frequentemente trazida pelo assessor contábil ou jurídico do próprio cliente: **"crédito de terceiro não pode ser usado para pagar imposto federal"**.')
para('O objetivo é triplo: (i) reconhecer o que há de correto na objeção; (ii) demonstrar tecnicamente por que ela não alcança a operação conduzida pela Lucro Ativo; e (iii) registrar, com transparência, os pontos que ainda dependem de definição jurídica interna. A nota é peça de **capacitação e de entrega assistida** — pode ser encaminhada ao assessor do cliente, sempre acompanhada de um executivo ou do jurídico.')

# ---------------- 2. LINHA DO TEMPO ----------------
H1('A LINHA DO TEMPO DA OBRIGAÇÃO TRIBUTÁRIA', '2.')
para('A obrigação tributária federal percorre quatro estações, e **o que pode ser utilizado muda em cada uma delas**:')
bullet('**Fato gerador** — nasce a obrigação.')
bullet('**Apuração e escrituração** (EFD-Contribuições, EFD-ICMS/IPI, ECF) — define-se *o quanto* é devido.')
bullet('**Declaração e confissão** — hoje **DCTFWeb com o MIT** (Módulo de Inclusão de Tributos), na forma da IN RFB nº 2.237/2024, alterada pela IN RFB nº 2.248/2025.')
bullet('**Crédito tributário constituído** — somente se extingue pelas hipóteses do **art. 156 do CTN**.')
para('O divisor de águas é a terceira estação. Por força do **art. 5º, §1º, do Decreto-Lei nº 2.124/1984** e da **Súmula 436 do STJ**, a entrega da declaração reconhecendo o débito **constitui o crédito tributário, dispensada qualquer outra providência do Fisco**. Antes disso, o contribuinte está *formando* o valor devido; depois, está *extinguindo* um débito já constituído. São dois regimes jurídicos distintos — e confundi-los é a origem de todo o problema.', space_after=8)
quote_legal('"A entrega de declaração pelo contribuinte, reconhecendo o débito fiscal, constitui o crédito tributário, dispensada qualquer outra providência por parte do Fisco."',
            'Súmula 436 do Superior Tribunal de Justiça')

# ---------------- 3. JANELA A ----------------
H1('JANELA A — ANTES DA CONFISSÃO: CRÉDITO ESCRITURAL PRÓPRIO', '3.')
para('Nesta fase reduz-se a base de cálculo ou abate-se crédito **escritural próprio**, apurado pelo próprio sujeito passivo:')
bullet('**PIS/COFINS não cumulativos** — art. 3º da Lei nº 10.637/2002 e art. 3º da Lei nº 10.833/2003.')
bullet('**IPI** — art. 11 da Lei nº 9.779/1999.')
bullet('**Prejuízo Fiscal e Base de Cálculo Negativa de CSLL** — arts. 15 e 16 da Lei nº 9.065/1995, observada a trava de 30%.')
para('Isto é **apuração, não compensação**. E crédito de terceiro **não tem qualquer ingresso aqui**: o crédito escritural é personalíssimo, vinculado ao sujeito passivo que o apurou. Lançar crédito alheio na escrituração fiscal configura declaração falsa, com tipificação nos arts. 1º e 2º da Lei nº 8.137/1990. **Nenhuma operação da Lucro Ativo opera nesta janela com ativo de terceiro.**')

# ---------------- 4. JANELA B ----------------
H1('JANELA B — DEPOIS DA CONFISSÃO: ONDE O ART. 74 FECHA A PORTA', '4.')
para('Débito já constituído extingue-se apenas pelas hipóteses do art. 156 do CTN, e a compensação depende de **lei específica** (art. 170 do CTN). No âmbito federal, essa lei é o **art. 74 da Lei nº 9.430/1996**, que autoriza o sujeito passivo a utilizar crédito "relativo a tributo ou contribuição administrado pela Secretaria da Receita Federal, passível de restituição ou de ressarcimento", para quitação de **débitos próprios**.')
para('E o **§12, inciso II, alínea "a"**, é expresso: considera-se **não declarada** a compensação em que o crédito **seja de terceiro**. Os efeitos de cair nesse enquadramento são severos:', space_after=8)
bullet('**não extingue** o débito e **não suspende** a exigibilidade;')
bullet('**não cabe** manifestação de inconformidade (§13) — segue direto para cobrança e inscrição;')
bullet('**multa isolada de 50%** sobre o valor indevidamente compensado (§17);')
bullet('caracterizada sonegação, fraude ou conluio, **multa qualificada de 100%** — art. 44, §1º, da Lei nº 9.430/1996, na redação dada pela **Lei nº 14.689/2023**, orientação confirmada pelo **STF no Tema 863 (RE 736.090**, out./2024); os 150% aplicam-se **apenas em reincidência** (§1º-A);')
bullet('**representação fiscal para fins penais** — art. 83 da Lei nº 9.430/1996, combinado com a Lei nº 8.137/1990.')
callout('▸ PONTO DE ATENÇÃO COMERCIAL',
        'É **exatamente aqui** que estão as autuações noticiadas. O modelo autuado toma um crédito de **natureza tributária** pertencente a terceiro e o lança em DCOMP **após a confissão do débito**. É a porta errada — e a Lucro Ativo não a utiliza. Ao executivo: **não relativize esse risco na frente do cliente**. Reconhecê-lo é o que dá credibilidade à distinção que vem a seguir.',
        fill='FDF1F1', accent=NAVY, title_color=RED)

# ---------------- 5. AS TRES CAMADAS ----------------
H1('POR QUE A OPERAÇÃO DE DCF NÃO SE ENQUADRA NA JANELA B', '5.')
H2('5.1  Primeira camada — natureza do ativo: o art. 74 não alcança o que não é tributo')
para('O art. 74 disciplina crédito **relativo a tributo administrado pela RFB**. O ativo utilizado na operação de DCF é **direito creditório de natureza civil contra a União**, reconhecido em decisão judicial **transitada em julgado** — não é indébito tributário, não decorre de pagamento a maior de tributo e não se submete àquele rito. A vedação de "crédito de terceiro" é regra **daquele procedimento específico**, e não princípio geral do ordenamento. Afirmar que "a legislação brasileira não admite crédito de terceiro" é converter uma regra de procedimento em regra de sistema.')

H2('5.2  Segunda camada — autorização constitucional expressa (EC nº 113/2021)')
para('O art. 100, §11, da Constituição, na redação dada pela Emenda Constitucional nº 113/2021, é o fundamento da operação:', space_after=8)
quote_legal('"É facultada ao credor [...] a oferta de créditos líquidos e certos que originalmente lhe são próprios ou adquiridos de terceiros, reconhecidos pelo ente federativo ou por decisão judicial transitada em julgado [...]"',
            'Art. 100, §11, da Constituição Federal — redação da EC nº 113/2021')
para('Três leituras decorrem do texto:')
bullet('o dispositivo **não fala em "precatório"**, e sim em "créditos líquidos e certos" — razão pela qual a terminologia correta da operação é **direito creditório**, e razão pela qual **não há fila nem ordem cronológica** de pagamento;')
bullet('a expressão "**adquiridos de terceiros**" está no texto constitucional, com todas as letras: a aquisição de crédito alheio é **constitucionalmente autorizada** para essa finalidade;')
bullet('trata-se de norma **superior, posterior (2021) e específica** em relação à lei ordinária de 1996. Não há antinomia a resolver: são **dois regimes distintos**, e não um contra o outro.')

H2('5.3  Terceira camada — marco temporal da titularidade')
para('Ainda que se insistisse na aplicação do art. 74, a objeção não se sustentaria: a vedação pressupõe crédito **alheio no momento do uso**. Na operação de DCF, a **cessão civil** (arts. 286 a 298 do Código Civil) e a **habilitação do cessionário** ocorrem **antes** de qualquer compensação. Quando a declaração é transmitida, **o crédito é próprio**. Registre-se, ademais, que a cessão de crédito civil **independe do consentimento do devedor** (art. 286), bastando a notificação para eficácia perante ele (art. 290).')
callout('▸ A FRASE QUE RESOLVE',
        'Na compensação irregular que a Receita combate, **alguém utiliza crédito que não é seu**. Na operação da Lucro Ativo, **o crédito é do cliente antes de ser usado**. Não é uma variação do mesmo modelo — é o seu oposto.',
        fill='F1F6F2', accent=NAVY, title_color=GREEN)

# ---------------- 6. QUADRO COMPARATIVO ----------------
H1('QUADRO COMPARATIVO', '6.')
para('Sete critérios objetivos separam o modelo autuado da operação conduzida pela Lucro Ativo:', space_after=8)

rows = [
    ('Critério', 'Modelo autuado pela RFB', 'Operação Lucro Ativo (DCF)'),
    ('Natureza do ativo', 'Crédito de natureza tributária de terceiro', 'Direito creditório de natureza civil contra a União'),
    ('Maturidade do crédito', 'Laudo e/ou decisão sem trânsito em julgado', 'Decisão judicial transitada em julgado'),
    ('Titularidade no momento do uso', 'De terceiro — o crédito nunca foi do contribuinte', 'Do próprio cliente — cessão e habilitação prévias (CC, arts. 286–298)'),
    ('Fundamento invocado', 'Art. 74 da Lei nº 9.430/1996 — rito vedado ao crédito alheio (§12, II, "a")', 'Art. 100, §11, da CF (EC nº 113/2021) e regulamentação aplicável'),
    ('Papel da escritura pública', 'Aparência de solidez — não valida o crédito', 'Forma e publicidade da cessão — não é o fundamento, é o instrumento'),
    ('Quem conduz', 'Consultoria, com laudo e "decisão favorável"', 'Escritório de advocacia, com parecer de viabilidade caso a caso'),
    ('Desfecho típico', 'Compensação não declarada, multa isolada, multa qualificada e representação penal', 'Compensação declarada e rastreável, com débito extinto na forma da lei'),
]
tb = doc.add_table(rows=len(rows), cols=3)
tb.alignment = WD_TABLE_ALIGNMENT.CENTER
tb.autofit = False
widths = (Cm(3.6), Cm(6.4), Cm(6.4))
for i, w in enumerate(widths):
    tb.columns[i].width = w
set_borders(tb, 'DDE1EC', 4)
cell_margins(tb, 70, 70, 100, 100)
for ri, row in enumerate(rows):
    for ci, txt in enumerate(row):
        cell = tb.rows[ri].cells[ci]
        cell.width = widths[ci]
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.12
        if ri == 0:
            shade(cell, '010860')
            r = p.add_run(txt.upper())
            r.font.name = 'Montserrat'; r.font.bold = True; r.font.size = Pt(8); r.font.color.rgb = WHITE
        else:
            if ri % 2 == 0:
                shade(cell, 'F5F7FC')
            r = p.add_run(txt)
            r.font.name = 'Inter'; r.font.size = Pt(8.5)
            if ci == 0:
                r.font.bold = True; r.font.color.rgb = NAVY
            elif ci == 1:
                r.font.color.rgb = RED
            else:
                r.font.color.rgb = GREEN
doc.add_paragraph().paragraph_format.space_after = Pt(6)

# ---------------- 7. SINTESE PARA USO COMERCIAL ----------------
H1('SÍNTESE PARA USO COMERCIAL', '7.')
para('Quando o cliente ou o seu assessor levantar a objeção, o executivo **não deve desviar do assunto**: quem explica a diferença primeiro conquista a mesa; quem é surpreendido pelo tema parece estar se defendendo. Redação sugerida, alinhada a esta nota:', space_after=8)
quote_legal('"A pergunta não é ‘pode usar crédito de terceiro?’. A pergunta é qual crédito, em que momento e por qual porta. Crédito tributário de terceiro, depois da confissão do débito, pela porta do art. 74 da Lei 9.430 — isso é vedado, e é isso que está sendo autuado. Direito creditório civil, com trânsito em julgado, transferido e habilitado em nome da empresa antes da compensação, com fundamento no art. 100, §11, da Constituição — é outra operação. O que muda não é a aparência: é a natureza do ativo e o marco temporal da titularidade. Se fizer sentido, encaminho a nota técnica com as âncoras normativas para o seu jurídico analisar antes de qualquer decisão."',
            'Roteiro de resposta — uso em reunião')
bullet('**Nunca dizer** "operação sem risco", "risco zero" ou "total segurança jurídica". É a promessa absoluta que caracteriza o discurso que estamos justamente contrapondo.')
bullet('**Nunca citar** o art. 74 da Lei nº 9.430/1996 como fundamento da operação — ele é citado apenas para demonstrar o que a operação **não** é.')
bullet('**Sempre oferecer** esta nota ao assessor do cliente. O convite à análise técnica de terceiro é, em si, um argumento de segurança.')

# ---------------- 8. PONTOS PENDENTES ----------------
H1('PONTOS PENDENTES DE PARECER CONCLUSIVO', '8.')
para('Registram-se, com transparência, três questões que **precisam de posição formal da Diretoria Jurídica** antes de incorporação definitiva ao discurso comercial. Duas delas divergem de afirmações já feitas em capacitação interna.')

H2_flag('8.1  ▪ CRÍTICO', RED, '  as ADIs 7.047 e 7.064 restringiram a autoaplicabilidade do §11')
para('Consta de capacitação interna a afirmação de que "após ADI caiu a expressão que limitava a aplicabilidade" do art. 100, §11. O julgado tem sentido **oposto**: em 30/11/2023 (publicação em 18/12/2023), o STF conferiu **interpretação conforme** ao dispositivo para **excluir a expressão "com autoaplicabilidade para a União"**. O §11 permanece válido e constitucional, mas o seu uso perante a União **passou a depender de regulamentação** — não é automático (vencido o Min. André Mendonça). **Ação:** corrigir o enunciado antes da próxima capacitação. Se o assessor do cliente conhecer o julgado e o executivo estiver sustentando o contrário, a credibilidade da reunião se perde por completo.')

H2_flag('8.2  ▪ CRÍTICO', RED, '  a regulamentação existente alcança dívida ativa, não débito vincendo')
para('Os atos que regulamentam o §11 na esfera federal — **Decreto nº 11.249/2022** e **Portaria PGFN nº 10.826/2022** — tratam de **débitos inscritos em dívida ativa da União**, o que é coerente com a literalidade do inciso I do §11 ("débitos parcelados ou inscritos em dívida ativa [...] e, subsidiariamente, débitos com a administração autárquica e fundacional"). **Não se localizou ato equivalente da RFB para débitos correntes/vincendos** — que constituem o carro-chefe comercial. A operação tem sustentação, mas trata-se de **construção sobre lacuna regulamentar**, e não de rito expressamente normatizado. **Ação:** definir a âncora exata do enquadramento dos débitos vincendos. Até que exista, o material comercial **não pode afirmar** que "está tudo regulamentado".')

H2_flag('8.3  ▪ ATENÇÃO', GOLD_DARK, '  360 dias não produz homologação tácita')
para('O **art. 24 da Lei nº 11.457/2007** concede à administração o prazo de 360 dias para **proferir decisão** em petição, defesa ou recurso do contribuinte. O descumprimento caracteriza mora e autoriza a via do mandado de segurança, mas **não gera deferimento automático**. A homologação tácita de **5 anos** é do art. 74, §5º, da Lei nº 9.430/1996 — precisamente o rito do qual a operação afirma não depender. **Ação:** fixar a redação correta. Sustentar "silêncio equivale a homologação em 360 dias" cria passivo de expectativa perante o cliente.')

callout('▸ NOTA DE REVISÃO DE MATERIAL',
        'Em transcrição de capacitação interna constam as referências "Lei 9.340/95" e "Emenda Constitucional 103", quando o correto é **Lei nº 9.430/1996** e **EC nº 113/2021**. Caso a gravação venha a integrar o acervo de treinamento, os dois pontos exigem legenda de correção.',
        fill='FBF7EA', accent=GOLD_DARK, title_color=GOLD_DARK)

# ---------------- 9. BASE NORMATIVA ----------------
H1('BASE NORMATIVA E JURISPRUDENCIAL DE REFERÊNCIA', '9.')
bullet('**Constituição Federal, art. 100, §11** — redação da EC nº 113/2021: oferta de créditos líquidos e certos, próprios ou adquiridos de terceiros, reconhecidos por decisão judicial transitada em julgado.')
bullet('**STF, ADIs 7.047 e 7.064** (j. 30/11/2023, pub. 18/12/2023) — interpretação conforme ao §11, com exclusão da expressão "com autoaplicabilidade para a União".')
bullet('**Decreto nº 11.249/2022** e **Portaria PGFN nº 10.826/2022** — regulamentação da utilização de créditos para quitação de débitos inscritos em dívida ativa da União.')
bullet('**Código Civil, arts. 286 a 298** — cessão de crédito; dispensa de consentimento do devedor (art. 286) e eficácia mediante notificação (art. 290).')
bullet('**CTN, arts. 156 e 170** — hipóteses de extinção do crédito tributário e exigência de lei específica para a compensação.')
bullet('**Lei nº 9.430/1996, art. 74** — rito federal de compensação; **§12, II, "a"** (compensação não declarada quando o crédito é de terceiro), **§13**, **§17** (multa isolada de 50%) e **§5º** (homologação tácita em 5 anos).')
bullet('**Lei nº 9.430/1996, art. 44, §1º e §1º-A**, na redação da **Lei nº 14.689/2023** — multa qualificada de 100%, elevada a 150% apenas em reincidência; **STF, Tema 863 (RE 736.090)**.')
bullet('**Lei nº 9.430/1996, art. 83**, c/c **Lei nº 8.137/1990, arts. 1º e 2º** — representação fiscal para fins penais.')
bullet('**Decreto-Lei nº 2.124/1984, art. 5º, §1º** e **Súmula 436 do STJ** — a declaração do contribuinte constitui o crédito tributário.')
bullet('**IN RFB nº 2.237/2024**, alterada pela **IN RFB nº 2.248/2025** — DCTFWeb e Módulo de Inclusão de Tributos (MIT).')
bullet('**Lei nº 11.457/2007, art. 24** — prazo de 360 dias para decisão administrativa.')
bullet('**Lei nº 10.637/2002, art. 3º**; **Lei nº 10.833/2003, art. 3º**; **Lei nº 9.779/1999, art. 11**; **Lei nº 9.065/1995, arts. 15 e 16** — regimes de crédito escritural próprio (Janela A).')

# ---------------- ASSINATURA ----------------
doc.add_paragraph().paragraph_format.space_after = Pt(10)
H1('CONCLUSÃO E SUBSCRIÇÃO')
para('Conclui-se que a objeção fundada no art. 74, §12, II, "a", da Lei nº 9.430/1996 **não alcança a operação de Direito Creditório Federal conduzida pela Lucro Ativo**, por duas razões autônomas e suficientes: o ativo utilizado **não é de natureza tributária** e a **titularidade do crédito é do próprio cliente no momento da compensação**, por cessão e habilitação prévias. A operação encontra fundamento no art. 100, §11, da Constituição Federal, na redação da EC nº 113/2021.')
para('Ressalvam-se expressamente os pontos do item 8, cuja definição condiciona o alcance das afirmações desta nota e a redação final do material comercial. A viabilidade de cada operação permanece sujeita a **análise técnica e jurídica individualizada**, formalizada em parecer próprio.')
doc.add_paragraph().paragraph_format.space_after = Pt(16)

sg = doc.add_table(rows=1, cols=2)
sg.autofit = False
sg.columns[0].width = Cm(8.2); sg.columns[1].width = Cm(8.2)
no_borders(sg)
cell_margins(sg, 40, 40, 0, 60)
c1 = sg.rows[0].cells[0]; c1.width = Cm(8.2)
p = c1.paragraphs[0]
pPr = p._p.get_or_add_pPr()
pbdr = OxmlElement('w:pBdr')
bt = OxmlElement('w:top'); bt.set(qn('w:val'), 'single'); bt.set(qn('w:sz'), '6')
bt.set(qn('w:space'), '2'); bt.set(qn('w:color'), '010860')
pbdr.append(bt); pPr.append(pbdr)
p.paragraph_format.space_after = Pt(2)
r = p.add_run('Alexandre Batistello'); r.font.name = 'Montserrat'; r.font.bold = True
r.font.size = Pt(10.5); r.font.color.rgb = NAVY
for line, sz, col in (('Diretor Jurídico (CLO) — Lucro Ativo', 9, INK), ('OAB/____ nº ____________', 8.5, GREY)):
    pp = c1.add_paragraph(); pp.paragraph_format.space_after = Pt(1)
    rr = pp.add_run(line); rr.font.name = 'Inter'; rr.font.size = Pt(sz); rr.font.color.rgb = col

c2 = sg.rows[0].cells[1]; c2.width = Cm(8.2)
p = c2.paragraphs[0]
pPr = p._p.get_or_add_pPr()
pbdr = OxmlElement('w:pBdr')
bt = OxmlElement('w:top'); bt.set(qn('w:val'), 'single'); bt.set(qn('w:sz'), '6')
bt.set(qn('w:space'), '2'); bt.set(qn('w:color'), '010860')
pbdr.append(bt); pPr.append(pbdr)
p.paragraph_format.space_after = Pt(2)
r = p.add_run('Local e data'); r.font.name = 'Montserrat'; r.font.bold = True
r.font.size = Pt(10.5); r.font.color.rgb = NAVY
for line, sz, col in (('Ribeirão Preto/SP, ______ de ____________ de 2026.', 9, INK),
                      ('Documento emitido para os fins do item 1 desta nota.', 8.5, GREY)):
    pp = c2.add_paragraph(); pp.paragraph_format.space_after = Pt(1)
    rr = pp.add_run(line); rr.font.name = 'Inter'; rr.font.size = Pt(sz); rr.font.color.rgb = col

doc.add_paragraph().paragraph_format.space_after = Pt(8)
callout('▸ CONTROLE DO DOCUMENTO',
        'NT-001/2026  ·  versão 1.0  ·  Diretoria Jurídica — Lucro Ativo  ·  Setembro de 2026. Substitui qualquer orientação verbal anterior sobre o tema. Revisão obrigatória a cada **6 meses** ou imediatamente após publicação de novo ato regulamentar da RFB ou da PGFN sobre o art. 100, §11, da Constituição Federal.',
        fill='F3F5FB', accent=NAVY)

doc.save('Nota_Tecnica_NT001_Marco_Temporal_DCF_LucroAtivo_v1.docx')
print('DOCX OK')
