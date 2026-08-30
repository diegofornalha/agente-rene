#!/usr/bin/env python3
"""Gera diego.wagner.seg.br a partir dos .md em coflow-pitch/diego/md/.

Uso: python3 scripts/diego-build.py
Regera todas as páginas + index (sitemap). Rode após editar/adicionar .md.
"""
import html
import re
from pathlib import Path

SITE = Path("/Users/hermes/hermes-mythos-lucas/backend-sdk-claude/coflow-pitch/diego")
SRC = SITE / "md"
UPDATED = "11/07/2026"

PAGES = [
    {"md": "00-README.md", "out": "leia-me.html", "sec": "Início",
     "title": "Leia-me — como usar o pacote", "desc": "Estrutura, ordem de uso, primeiro passo e padrão de Reel."},
    {"md": "estrategia/01-pilares-e-regras.md", "out": "estrategia/01-pilares-e-regras.html", "sec": "Estratégia",
     "title": "Pilares e Regras", "desc": "Os 3 pilares, regras de comunicação e o contexto da jornada."},
    {"md": "estrategia/02-agentes.md", "out": "estrategia/02-agentes.html", "sec": "Estratégia",
     "title": "Funcionários Digitais", "desc": "Organizador, Rota Fiscal, Registro e Criador de Conteúdo — nome + função."},
    {"md": "instagram/03-destaques-instagram.md", "out": "instagram/03-destaques.html", "sec": "Instagram",
     "title": "Destaques do perfil", "desc": "Os 6+1 destaques, conteúdo de cada um e CTA padrão."},
    {"md": "instagram/04-reels-catalogo.md", "out": "instagram/04-reels.html", "sec": "Instagram",
     "title": "Catálogo de Reels", "desc": "33 hooks organizados por destaque + top 10 de prioridade."},
    {"md": "instagram/05-roteiros-gravacao.md", "out": "instagram/05-roteiros.html", "sec": "Instagram",
     "title": "Roteiros de gravação", "desc": "Texto pra falar + dicas de tom, fundo e pausa — top 10 + extras."},
    {"md": "instagram/06-legendas.md", "out": "instagram/06-legendas.html", "sec": "Instagram",
     "title": "Legendas prontas", "desc": "Copiar e colar na hora de postar, com hashtags e CTA."},
    {"md": "instagram/07-checklist-semanas.md", "out": "instagram/07-checklist.html", "sec": "Instagram",
     "title": "Checklist de gravação e postagem", "desc": "Lotes de gravação e calendário das semanas 1–2. Marque aqui mesmo — salva no navegador."},
    {"md": "estudo/08-analogias-livro-de-mormon.md", "out": "estudo/08-analogias.html", "sec": "Estudo",
     "title": "Analogias — Livro de Mórmon × Jornada", "desc": "Mudança de geografia, martírio e continuidade, líderes iníquos, frases-ponte."},
]

CSS = """
:root {
  --bg: #0b0a08; --surface: #14120e; --surface-2: #1b1812;
  --text: #f5f2ea; --text-secondary: #c9c2b2; --text-muted: #8a8172;
  --accent: #f59e0b; --accent-dim: #b45309;
  --border: rgba(255,255,255,0.08); --border-subtle: rgba(255,255,255,0.05);
  --radius-lg: 14px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text);
  line-height: 1.7; padding-top: 56px; -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { font-family: 'Space Grotesk', sans-serif; }
.nav {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: rgba(11,10,8,0.85); backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border-subtle); padding: 0 32px;
}
.nav-inner { max-width: 820px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; height: 56px; }
.nav-brand { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 1.05rem; color: var(--text); text-decoration: none; }
.nav-brand span { color: var(--accent); }
.nav-link { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text-muted); text-decoration: none; }
.nav-link:hover { color: var(--accent); }
.wrap { max-width: 820px; margin: 0 auto; padding: 44px 24px 80px; }
.hero-label {
  display: inline-block; font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem; letter-spacing: 2px; text-transform: uppercase;
  color: var(--accent); border: 1px solid var(--accent-dim);
  border-radius: 999px; padding: 6px 14px; margin-bottom: 18px;
}
h1.hero-title { font-size: clamp(1.5rem, 4vw, 2.2rem); line-height: 1.2; margin-bottom: 12px; }
h1.hero-title em { color: var(--accent); font-style: normal; }
.hero-sub { color: var(--text-secondary); font-size: 1rem; max-width: 680px; }
.meta-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; margin-bottom: 36px; }
.meta-chip {
  font-family: 'JetBrains Mono', monospace; font-size: 0.72rem;
  color: var(--text-muted); background: var(--surface);
  border: 1px solid var(--border-subtle); border-radius: 999px; padding: 5px 12px;
}
article h1 { display: none; }
article h2 {
  font-size: 1.3rem; margin: 42px 0 14px; padding-top: 20px;
  border-top: 1px solid var(--border-subtle);
}
article h3 { font-size: 1.05rem; margin: 26px 0 10px; color: var(--accent); }
article h4 { font-size: 0.95rem; margin: 20px 0 8px; }
article p { margin: 0 0 13px; color: var(--text-secondary); font-size: 0.94rem; }
article b, article strong { color: var(--text); }
article ul, article ol { margin: 0 0 16px 22px; color: var(--text-secondary); font-size: 0.94rem; }
article li { margin-bottom: 6px; }
article hr { border: none; border-top: 1px solid var(--border-subtle); margin: 30px 0; }
article code {
  font-family: 'JetBrains Mono', monospace; font-size: 0.84em;
  background: var(--surface-2); border-radius: 4px; padding: 1px 6px;
}
article pre {
  font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; line-height: 1.55;
  background: var(--surface); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg); padding: 16px 20px; margin: 0 0 16px;
  overflow-x: auto; color: var(--text-secondary);
}
article pre code { background: none; padding: 0; }
article blockquote {
  border-left: 3px solid var(--accent); background: rgba(245,158,11,0.06);
  border-radius: 0 10px 10px 0; padding: 12px 18px; margin: 0 0 16px;
  color: var(--text); font-size: 0.96rem;
}
article blockquote p { color: var(--text); margin-bottom: 6px; }
article blockquote p:last-child { margin-bottom: 0; }
article table {
  width: 100%; border-collapse: collapse; margin: 0 0 18px; font-size: 0.86rem;
}
article th {
  text-align: left; font-family: 'Space Grotesk', sans-serif; font-size: 0.8rem;
  color: var(--accent); border-bottom: 1px solid var(--border);
  padding: 8px 10px; white-space: nowrap;
}
article td { border-bottom: 1px solid var(--border-subtle); padding: 8px 10px; color: var(--text-secondary); vertical-align: top; }
article td b { color: var(--text); }
label.task {
  display: flex; gap: 12px; align-items: flex-start;
  background: var(--surface); border: 1px solid var(--border-subtle);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 8px;
  cursor: pointer; font-size: 0.92rem; color: var(--text-secondary);
}
label.task input[type="checkbox"] {
  appearance: none; -webkit-appearance: none;
  width: 19px; height: 19px; min-width: 19px; margin-top: 2px;
  border: 1.5px solid var(--text-muted); border-radius: 6px;
  cursor: pointer; position: relative; background: transparent;
}
label.task input[type="checkbox"]:checked { background: var(--accent); border-color: var(--accent); }
label.task input[type="checkbox"]:checked::after {
  content: '✓'; position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center;
  color: #0b0a08; font-size: 0.75rem; font-weight: 800;
}
label.task.done { opacity: 0.55; }
label.task.done span { text-decoration: line-through; }
.cards { display: grid; gap: 12px; }
.card {
  display: block; background: var(--surface); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg); padding: 18px 22px; text-decoration: none;
  transition: border-color .15s ease;
}
.card:hover { border-color: var(--accent-dim); }
.card h3 { font-size: 1.02rem; color: var(--text); margin-bottom: 4px; }
.card p { font-size: 0.85rem; color: var(--text-secondary); margin: 0; }
.card .path { font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; color: var(--text-muted); }
.sec-title {
  font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; letter-spacing: 2px;
  text-transform: uppercase; color: var(--accent); margin: 36px 0 12px;
}
.footer-note {
  margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--border-subtle);
  font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; color: var(--text-muted);
}
.footer-note a { color: var(--text-muted); }
"""

HEAD = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>{title} · Diego</title>
<meta name="description" content="{desc}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>{css}</style>
</head>
<body>
<nav class="nav"><div class="nav-inner">
  <a class="nav-brand" href="{home}">Diego <span>· Paraguai</span></a>
  <a class="nav-link" href="{home}">← sitemap</a>
</div></nav>
<div class="wrap">
"""

FOOT = """  <div class="footer-note">Uso pessoal — não indexado · gerado da fonte .md ({md}) · atualizado {updated}</div>
</div>
{script}
</body>
</html>
"""

TASK_SCRIPT = """<script>
(function(){
  var KEY = 'diego-' + location.pathname;
  var state = {};
  try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch(e) {}
  document.querySelectorAll('label.task input').forEach(function(b){
    var k = b.getAttribute('data-k');
    if (state[k]) b.checked = true;
    else if (state[k] === false) b.checked = false;
    b.closest('label').classList.toggle('done', b.checked);
    b.addEventListener('change', function(){
      state[k] = b.checked;
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch(e) {}
      b.closest('label').classList.toggle('done', b.checked);
    });
  });
})();
</script>"""


def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<em>\1</em>", s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
    return s


def md2html(text):
    lines = text.split("\n")
    out, i, taskn = [], 0, 0
    listbuf, listtag = [], None

    def flush_list():
        nonlocal listbuf, listtag
        if listbuf:
            out.append(f"<{listtag}>" + "".join(f"<li>{x}</li>" for x in listbuf) + f"</{listtag}>")
            listbuf, listtag = [], None

    while i < len(lines):
        line = lines[i]
        strip = line.strip()
        if strip.startswith("```"):
            flush_list()
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            out.append("<pre><code>" + html.escape("\n".join(buf)) + "</code></pre>")
            i += 1
            continue
        if not strip:
            flush_list()
            i += 1
            continue
        m = re.match(r"^(#{1,4})\s+(.*)", strip)
        if m:
            flush_list()
            lvl = len(m.group(1))
            out.append(f"<h{lvl}>{inline(m.group(2))}</h{lvl}>")
            i += 1
            continue
        if re.match(r"^-{3,}$", strip):
            flush_list()
            out.append("<hr>")
            i += 1
            continue
        if strip.startswith(">"):
            flush_list()
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(inline(lines[i].strip().lstrip(">").strip()))
                i += 1
            out.append("<blockquote><p>" + "<br>".join(buf) + "</p></blockquote>")
            continue
        if strip.startswith("|"):
            flush_list()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            body_rows = [r for r in rows if not all(re.match(r"^:?-+:?$", c) for c in r)]
            if body_rows:
                thead = "".join(f"<th>{inline(c)}</th>" for c in body_rows[0])
                trs = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body_rows[1:])
                out.append(f"<table><tr>{thead}</tr>{trs}</table>")
            continue
        m = re.match(r"^- \[( |x)\]\s+(.*)", strip)
        if m:
            flush_list()
            taskn += 1
            chk = " checked" if m.group(1) == "x" else ""
            out.append(f'<label class="task"><input type="checkbox" data-k="t{taskn}"{chk}><span>{inline(m.group(2))}</span></label>')
            i += 1
            continue
        m = re.match(r"^[-*]\s+(.*)", strip)
        if m:
            if listtag != "ul":
                flush_list()
                listtag = "ul"
            listbuf.append(inline(m.group(1)))
            i += 1
            continue
        m = re.match(r"^\d+[\.)]\s+(.*)", strip)
        if m:
            if listtag != "ol":
                flush_list()
                listtag = "ol"
            listbuf.append(inline(m.group(1)))
            i += 1
            continue
        flush_list()
        out.append(f"<p>{inline(strip)}</p>")
        i += 1
    flush_list()
    return "\n".join(out), taskn


def build_page(page):
    src = SRC / page["md"]
    if not src.exists():
        return False
    body, tasks = md2html(src.read_text(encoding="utf-8"))
    depth = page["out"].count("/")
    home = "../" * depth + "index.html"
    h = HEAD.format(title=page["title"], desc=page["desc"], css=CSS, home=home)
    h += f'  <div class="hero-label">{page["sec"]}</div>\n'
    h += f'  <h1 class="hero-title">{page["title"]}</h1>\n'
    h += f'  <p class="hero-sub">{page["desc"]}</p>\n'
    h += f'  <div class="meta-row"><span class="meta-chip">atualizado: {UPDATED}</span><span class="meta-chip">fonte: md/{page["md"]}</span></div>\n'
    h += "  <article>\n" + body + "\n  </article>\n"
    h += FOOT.format(md="md/" + page["md"], updated=UPDATED, script=TASK_SCRIPT if tasks else "")
    dest = SITE / page["out"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(h, encoding="utf-8")
    return True


def build_index(built):
    h = HEAD.format(title="Sitemap — Estratégia Paraguai + Conteúdo",
                    desc="Pacote consolidado: Livro de Mórmon, mudança de geografia, funcionários digitais e Instagram.",
                    css=CSS, home="index.html")
    h += '  <div class="hero-label">Sitemap</div>\n'
    h += '  <h1 class="hero-title">Diego — Estratégia <em>Paraguai</em> + Conteúdo</h1>\n'
    h += '  <p class="hero-sub">Pacote consolidado: Livro de Mórmon, mudança de geografia, funcionários digitais (IA) e Instagram. A home é este sitemap; cada caminho abaixo é um documento vivo.</p>\n'
    h += f'  <div class="meta-row"><span class="meta-chip">atualizado: {UPDATED}</span><span class="meta-chip">{sum(built.values())}/{len(PAGES)} páginas no ar</span><span class="meta-chip">uso pessoal — não indexado</span></div>\n'
    for sec in ["Início", "Estratégia", "Instagram", "Estudo"]:
        pages = [p for p in PAGES if p["sec"] == sec]
        if not pages:
            continue
        h += f'  <div class="sec-title">{sec}</div>\n  <div class="cards">\n'
        for p in pages:
            if built[p["out"]]:
                h += (f'    <a class="card" href="{p["out"]}"><div class="path">/{p["out"]}</div>'
                      f'<h3>{p["title"]}</h3><p>{p["desc"]}</p></a>\n')
            else:
                h += (f'    <div class="card" style="opacity:.5"><div class="path">/{p["out"]}</div>'
                      f'<h3>{p["title"]}</h3><p>{p["desc"]} — <b>aguardando conteúdo</b></p></div>\n')
        h += "  </div>\n"
    h += FOOT.format(md="md/*", updated=UPDATED, script="")
    (SITE / "index.html").write_text(h, encoding="utf-8")


built = {}
for page in PAGES:
    built[page["out"]] = build_page(page)
    print(("ok   " if built[page["out"]] else "FALTA") + " " + page["out"])
build_index(built)
print("ok    index.html (sitemap)")
