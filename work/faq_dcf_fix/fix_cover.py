#!/usr/bin/env python3
"""Corrige a capa embutida do FAQ:
- chip "Recuperação de ICMS-SP" -> "Compensação de ICMS-SP"
- "Versão 1" -> "Versão 1.3"
- "Agosto de 2026" -> "Setembro de 2026"
Calibra tamanho de fonte medindo o texto existente na própria imagem."""
from PIL import Image, ImageDraw, ImageFont
import numpy as np

SRC = '/tmp/faqmedia/word/media/image1.png'
OUT = '/tmp/faqmedia/cover_fixed.png'
im = Image.open(SRC).convert('RGB')
a = np.asarray(im).astype(int)
draw = ImageDraw.Draw(im)

INTER = '/home/hermes/.local/share/fonts/Inter-Regular.ttf'


def load(size, style):
    f = ImageFont.truetype(INTER, size)
    try:
        f.set_variation_by_name(style)
    except Exception:
        pass
    return f


def text_bbox(y0, y1, x0, x1, thr=110):
    """bbox de pixels claros (texto) numa faixa."""
    reg = a[y0:y1, x0:x1]
    bright = reg.sum(axis=2) > thr * 3
    ys, xs = np.where(bright)
    assert len(xs), 'faixa sem texto'
    return x0 + xs.min(), y0 + ys.min(), x0 + xs.max(), y0 + ys.max()


def fit_size(text, target_w, style, lo=16, hi=60):
    best = lo
    for s in range(lo, hi):
        f = load(s, style)
        w = draw.textlength(text, font=f)
        if w <= target_w:
            best = s
        else:
            break
    return best


BG = tuple(a[1965, 1700])          # navy de fundo (área plana à direita da linha de versão)
print('bg:', BG)

# ---------- 1. chip 2 ----------
# borda dourada do chip: localizar pela faixa y ~1746..1822, x ~700..1260
bx0, by0, bx1, by1 = text_bbox(1750, 1815, 740, 1225)   # bbox do TEXTO branco do chip
print('chip text bbox:', bx0, by0, bx1, by1)
old_w = bx1 - bx0
cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
chip_fill = tuple(a[by0 - 18, bx0])  # interior do chip acima do texto
# cobre o texto antigo com folga (sem tocar a borda dourada: margem interna)
draw.rectangle([bx0 - 14, by0 - 10, bx1 + 14, by1 + 10], fill=chip_fill)
NEW = 'Compensação de ICMS-SP'
size = fit_size(NEW, old_w + 8, 'SemiBold')
f = load(size, 'SemiBold')
w = draw.textlength(NEW, font=f)
asc, desc = f.getmetrics()
draw.text((cx - w / 2, cy - (asc + desc) / 2 + 1), NEW, font=f, fill=(255, 255, 255))
print('chip: size', size, 'w', w, 'old_w', old_w)

# ---------- 2. linha "Versão 1 · Edição..." ----------
vx0, vy0, vx1, vy1 = text_bbox(1940, 2000, 150, 1800)
print('versao bbox:', vx0, vy0, vx1, vy1)
line_h = vy1 - vy0
OLD_LINE = 'Versão 1 · Edição de Capacitação — para validação técnica/jurídica'
# cores: bold branco; regular = amostra num pixel do miolo do texto regular
REG_COLOR = (201, 205, 232)
BOLD_COLOR = (255, 255, 255)
size_v = fit_size(OLD_LINE, (vx1 - vx0) + 6, 'Regular')
draw.rectangle([vx0 - 6, vy0 - 8, vx1 + 200, vy1 + 8], fill=BG)
fb = load(size_v, 'SemiBold')
fr = load(size_v, 'Regular')
x = vx0
seg1 = 'Versão 1.3'
draw.text((x, vy0 - 4), seg1, font=fb, fill=BOLD_COLOR)
x += draw.textlength(seg1, font=fb)
draw.text((x, vy0 - 4), ' · Edição de Capacitação — para validação técnica/jurídica', font=fr, fill=REG_COLOR)
print('versao: size', size_v)

# ---------- 3. linha "Data de Publicação: Agosto de 2026" ----------
dx0, dy0, dx1, dy1 = text_bbox(2060, 2120, 150, 1400)
print('data bbox:', dx0, dy0, dx1, dy1)
OLD_D = 'Data de Publicação: Agosto de 2026'
size_d = fit_size(OLD_D, (dx1 - dx0) + 6, 'Regular')
draw.rectangle([dx0 - 6, dy0 - 8, dx1 + 260, dy1 + 8], fill=BG)
fb = load(size_d, 'SemiBold')
fr = load(size_d, 'Regular')
x = dx0
seg1 = 'Data de Publicação: '
draw.text((x, dy0 - 4), seg1, font=fr, fill=REG_COLOR)
x += draw.textlength(seg1, font=fr)
draw.text((x, dy0 - 4), 'Setembro de 2026', font=fb, fill=BOLD_COLOR)
print('data: size', size_d)

im.save(OUT)
print('salvo', OUT)

# crop de conferência
im.crop((100, 1700, 2400, 2160)).save('/tmp/faqmedia/cover_check.png')
