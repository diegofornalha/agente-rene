#!/usr/bin/env python3
"""Cartilha DCF — corrige o exemplo prático da pág. 12 (novo exemplo R$ 200k/mês c/ INSS)."""
import fitz

NAVY = (1/255, 8/255, 96/255)        # #010860 (amostrado do próprio PDF)
CELL = (0x0F/255, 0x0D/255, 0x0A/255)  # #0F0D0A texto regular da tabela
BODY = (0x25/255, 0x20/255, 0x19/255)  # #252019 corpo do texto
WHITE = (1, 1, 1)

REG = "Inter-Regular-static.ttf"
BOLD = "Inter-Bold-static.ttf"

doc = fitz.open("cartilha_src.pdf")
p = doc[11]

freg = fitz.Font(fontfile=REG)
fbold = fitz.Font(fontfile=BOLD)

_pending = []

def cover(rect):
    """Marca redação real (remove o texto da camada) preservando line-art/imagens."""
    _pending.append(fitz.Rect(*rect))

def apply_covers():
    for r in _pending:
        p.add_redact_annot(r, fill=WHITE)
    p.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                       graphics=fitz.PDF_REDACT_LINE_ART_NONE)

def put(x, baseline, segs, size):
    """segs: lista de (texto, 'r'|'b', cor). Retorna x final."""
    for txt, w, col in segs:
        fname = "F1" if w == "r" else "F2"
        ffile = REG if w == "r" else BOLD
        p.insert_text(fitz.Point(x, baseline), txt, fontsize=size,
                      fontname=fname, fontfile=ffile, color=col)
        f = freg if w == "r" else fbold
        x += f.text_length(txt, fontsize=size)
    return x

# ── 1. Título: remover "— Quadro DJ 128/2026" (fica só "Exemplo prático") ──
cover((125.5, 340, 250, 360))

# ── 2. Parágrafo-intro + 3 linhas da tabela: redigir tudo ANTES de escrever ──
cover((44, 356, 552, 386))
for y0, y1 in ((416.5, 435.0), (439.5, 456.0), (460.5, 476.0)):
    cover((48, y0, 551, y1))
apply_covers()

put(45, 368.9, [
    ("Para uma empresa que recolhe em média ", "r", BODY),
    ("R$ 200.000,00 mensais", "b", NAVY),
    (" em tributos federais (PIS, COFINS, IRPJ, CSLL e INSS), com", "r", BODY),
], 8.5)
put(45, 380.9, [
    ("cessão anual de ", "r", BODY),
    ("R$ 2.400.000,00", "b", NAVY),
    (" integralmente extinta por compensação contra crédito judicial transitado:", "r", BODY),
], 8.5)

# ── 3. Tabela — reescrever as 3 linhas (mantendo bordas/fundos originais) ──
rows = [
    # (cover_y0, cover_y1, baseline, [(col_x, texto, peso, cor), ...])
    (416.5, 435.0, 427.8, [
        (52,  "Valor total compensado", "b", NAVY),
        (291, "12 × R$ 200.000,00", "r", CELL),
        (442, "R$ 2.400.000,00", "b", NAVY),
    ]),
    (439.5, 456.0, 448.8, [
        (52,  "Pagamento à Lucro Ativo", "r", CELL),
        (291, "80% × R$ 2.400.000,00", "r", CELL),
        (442, "R$ 1.920.000,00", "r", CELL),
    ]),
    (460.5, 476.0, 470.3, [
        (52,  "Economia líquida do cliente", "b", NAVY),
        (291, "20% × R$ 2.400.000,00", "r", CELL),
        (442, "R$ 480.000,00", "r", CELL),
    ]),
]
for y0, y1, base, cells in rows:
    for cx, txt, w, col in cells:
        put(cx, base, [(txt, w, col)], 8.0)

doc.save("cartilha_fix.pdf", garbage=3, deflate=True)
print("salvo cartilha_fix.pdf")

# render de verificação
d2 = fitz.open("cartilha_fix.pdf")
pix = d2[11].get_pixmap(dpi=130)
pix.save("pag12_depois.png")
print("render ok")
