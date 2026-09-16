# -*- coding: utf-8 -*-
# Briefing Sprint — versão docx editável (padrão Lucro Ativo)
import docx
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

W = "/home/hermes/agente-rene/work/briefing_sprint/"
NAVY=RGBColor(0x01,0x08,0x60); NAVY2=RGBColor(0x24,0x3a,0x8f)
GOLD=RGBColor(0xB8,0x89,0x2B); INK=RGBColor(0x1a,0x1f,0x36)
GRAY=RGBColor(0x5a,0x60,0x72); WHITE=RGBColor(0xFF,0xFF,0xFF)
RED=RGBColor(0xA3,0x2A,0x35)
H_NAVY="010860"; H_NAVY2="243a8f"; H_SOFT="EEF1FB"; H_SOFT2="F5F7FE"; H_GOLD="B8892B"; H_RED="A32A35"
BODY="Inter"; HEAD="Montserrat"

doc=Document()
st=doc.styles['Normal']; st.font.name=BODY; st.font.size=Pt(10.5); st.font.color.rgb=INK
st.paragraph_format.space_after=Pt(6); st.paragraph_format.line_spacing=1.28

def _set_font(run,font=BODY,size=10.5,color=INK,bold=False,italic=False):
    run.font.name=font; run.font.size=Pt(size); run.font.color.rgb=color; run.bold=bold; run.italic=italic
    rpr=run._element.get_or_add_rPr()
    rf=rpr.find(qn('w:rFonts'))
    if rf is None:
        rf=OxmlElement('w:rFonts'); rpr.append(rf)
    for a in ('w:ascii','w:hAnsi','w:cs'): rf.set(qn(a),font)

def para(text="",font=BODY,size=10.5,color=INK,bold=False,italic=False,align=AL.LEFT,before=0,after=6,line=1.28):
    p=doc.add_paragraph(); p.alignment=align
    pf=p.paragraph_format; pf.space_before=Pt(before); pf.space_after=Pt(after); pf.line_spacing=line
    if text!="":
        r=p.add_run(text); _set_font(r,font,size,color,bold,italic)
    return p

def runs(p, parts):
    for t,kw in parts:
        r=p.add_run(t); _set_font(r,kw.get('font',BODY),kw.get('size',10.5),kw.get('color',INK),kw.get('bold',False),kw.get('italic',False))
    return p

def rich(parts,after=6,line=1.28,align=AL.LEFT):
    p=doc.add_paragraph(); p.alignment=align
    p.paragraph_format.space_after=Pt(after); p.paragraph_format.line_spacing=line
    runs(p,parts); return p

def _para_border(p,color="243a8f",sz=6,space=4):
    pPr=p._p.get_or_add_pPr(); pbdr=OxmlElement('w:pBdr')
    b=OxmlElement('w:bottom'); b.set(qn('w:val'),'single'); b.set(qn('w:sz'),str(sz)); b.set(qn('w:space'),str(space)); b.set(qn('w:color'),color); pbdr.append(b)
    pPr.append(pbdr)

def h1(text,num=None):
    p=doc.add_paragraph(); p.paragraph_format.space_before=Pt(18); p.paragraph_format.space_after=Pt(2)
    p.paragraph_format.keep_with_next=True
    if num:
        r=p.add_run(num+"  "); _set_font(r,HEAD,17,GOLD,True)
    r=p.add_run(text); _set_font(r,HEAD,17,NAVY,True)
    _para_border(p,color=H_NAVY,sz=14,space=6)
    return p

def h3(text):
    p=doc.add_paragraph(); p.paragraph_format.space_before=Pt(9); p.paragraph_format.space_after=Pt(2)
    p.paragraph_format.keep_with_next=True
    r=p.add_run(text); _set_font(r,HEAD,11,NAVY2,True)
    return p

def bullet(parts,level=0):
    p=doc.add_paragraph(style='List Bullet')
    p.paragraph_format.space_after=Pt(3); p.paragraph_format.line_spacing=1.25
    p.paragraph_format.left_indent=Inches(0.28+level*0.25)
    if isinstance(parts,str):
        r=p.add_run(parts); _set_font(r,BODY,10.5,INK)
    else:
        runs(p,parts)
    return p

def shade(cell,hexfill):
    tcPr=cell._tc.get_or_add_tcPr()
    shd=OxmlElement('w:shd'); shd.set(qn('w:val'),'clear'); shd.set(qn('w:color'),'auto'); shd.set(qn('w:fill'),hexfill)
    tcPr.append(shd)

def valign(cell,where='center'):
    tcPr=cell._tc.get_or_add_tcPr(); v=OxmlElement('w:vAlign'); v.set(qn('w:val'),where); tcPr.append(v)

def cell_text(cell, parts, align=AL.LEFT, size=9.5, color=INK, bold=False, font=BODY):
    cell.text=""
    p=cell.paragraphs[0]; p.alignment=align
    p.paragraph_format.space_after=Pt(2); p.paragraph_format.space_before=Pt(1); p.paragraph_format.line_spacing=1.15
    if isinstance(parts,str):
        r=p.add_run(parts); _set_font(r,font,size,color,bold)
    else:
        runs(p,parts)
    return p

def set_table_borders(table,color="C7CEE8",sz=4):
    tbl=table._tbl; tblPr=tbl.tblPr
    borders=OxmlElement('w:tblBorders')
    for t in ['top','left','bottom','right','insideH','insideV']:
        e=OxmlElement('w:'+t); e.set(qn('w:val'),'single'); e.set(qn('w:sz'),str(sz)); e.set(qn('w:space'),'0'); e.set(qn('w:color'),color); borders.append(e)
    tblPr.append(borders)

def set_col_widths(table,widths_in):
    table.autofit=False; table.allow_autofit=False
    tblPr=table._tbl.tblPr
    lay=OxmlElement('w:tblLayout'); lay.set(qn('w:type'),'fixed'); tblPr.append(lay)
    for row in table.rows:
        for i,w in enumerate(widths_in):
            row.cells[i].width=Inches(w)

def add_table(headers, rows, widths=None):
    ncol=len(headers)
    t=doc.add_table(rows=1, cols=ncol); t.alignment=WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(t)
    hdr=t.rows[0].cells
    for i,htext in enumerate(headers):
        cell_text(hdr[i], htext, size=9.0, color=WHITE, bold=True, font=HEAD)
        shade(hdr[i],H_NAVY); valign(hdr[i])
    for ri,row in enumerate(rows):
        cells=t.add_row().cells
        for ci,val in enumerate(row):
            if isinstance(val,list):
                cell_text(cells[ci], val, size=9.2)
            else:
                cell_text(cells[ci], val, size=9.2)
            if ri%2==1: shade(cells[ci],H_SOFT2)
            valign(cells[ci])
    if widths: set_col_widths(t,widths)
    trPr=t.rows[0]._tr.get_or_add_trPr(); th=OxmlElement('w:tblHeader'); th.set(qn('w:val'),'true'); trPr.append(th)
    doc.add_paragraph().paragraph_format.space_after=Pt(2)
    return t

def callout(title, body_parts, kind="info"):
    cmap={"info":(H_SOFT,H_NAVY2,NAVY2),"atencao":("FBEDEC",H_RED,RED),"controle":("FBF4E6",H_GOLD,GOLD)}
    fill,barcolor,txtcolor=cmap[kind]
    t=doc.add_table(rows=1,cols=1); t.alignment=WD_TABLE_ALIGNMENT.CENTER
    set_col_widths(t,[6.9])
    c=t.rows[0].cells[0]; shade(c,fill)
    tcPr=c._tc.get_or_add_tcPr(); bdr=OxmlElement('w:tcBorders')
    lb=OxmlElement('w:left'); lb.set(qn('w:val'),'single'); lb.set(qn('w:sz'),'26'); lb.set(qn('w:space'),'0'); lb.set(qn('w:color'),barcolor); bdr.append(lb)
    tcPr.append(bdr)
    c.text=""
    p=c.paragraphs[0]; p.paragraph_format.space_after=Pt(3); p.paragraph_format.space_before=Pt(3)
    r=p.add_run(title); _set_font(r,HEAD,10,txtcolor,True)
    p2=c.add_paragraph(); p2.paragraph_format.space_after=Pt(3); p2.paragraph_format.line_spacing=1.25
    runs(p2,body_parts)
    doc.add_paragraph().paragraph_format.space_after=Pt(2)
    return t

B=lambda t:(t,{'bold':True,'color':NAVY})
N=lambda t:(t,{})
V=lambda : (" [PARÂMETRO A VALIDAR] ",{'bold':True,'color':GOLD,'size':9})

# ---------- CAPA (imagem renderizada) ----------
sec=doc.sections[0]
sec.page_height=Inches(11.69); sec.page_width=Inches(8.27)
for m in ('top_margin','bottom_margin','left_margin','right_margin'): setattr(sec,m,Inches(0))
cp=doc.add_paragraph(); cp.alignment=AL.CENTER; cp.paragraph_format.space_after=Pt(0)
cp.add_run().add_picture(W+"cover.png",width=Inches(8.27))

# ---------- SEÇÃO CORPO ----------
s2=doc.add_section(WD_SECTION.NEW_PAGE)
s2.page_height=Inches(11.69); s2.page_width=Inches(8.27)
s2.top_margin=Inches(0.9); s2.bottom_margin=Inches(0.8)
s2.left_margin=Inches(0.85); s2.right_margin=Inches(0.85)

# header/footer
s2.header.is_linked_to_previous=False
hp=s2.header.paragraphs[0]; hp.alignment=AL.RIGHT
r=hp.add_run("LUCRO ATIVO — BRIEFING ESTRATÉGICO · SPRINT · TRÁFEGO PAGO")
_set_font(r,HEAD,7.5,GRAY,True)
s2.footer.is_linked_to_previous=False
fp=s2.footer.paragraphs[0]; fp.alignment=AL.CENTER
r=fp.add_run("Lucro Ativo · @meulucroativo · www.meulucroativo.com.br — Confidencial")
_set_font(r,BODY,8,GRAY)

# ===== 01 QUEM SOMOS =====
h1("Quem é a Lucro Ativo","01")
rich([N("A "),B("Lucro Ativo"),N(" é uma operação de "),B("inteligência e engenharia tributária"),N(" voltada ao segmento corporativo (empresas do "),B("Lucro Real e Lucro Presumido"),N("). Atuamos na compensação, aproveitamento e gestão de créditos tributários e na resolução estratégica de passivos fiscais — unindo expertise contábil, jurídica e negociação.")])
rich([N("Nosso posicionamento é "),B("consultivo e C-level"),N(": falamos com sócios, CEOs, CFOs e contadores de empresas de médio e grande porte. Não vendemos “curso”, “planilha” nem promessa milagrosa — vendemos "),B("reunião técnica com especialista"),N(", que evolui para diagnóstico e contrato.")])
h3("Modelo comercial — onde o tráfego pago se encaixa")
rich([N("A venda é 100% consultiva e ocorre em reunião. O papel do tráfego é "),B("alimentar o topo do funil com leads qualificados"),N(":")])
add_table(["Etapa","O que acontece"],
 [["1 · Anúncio / Copy","Instagram · Meta Ads"],
  ["2 · Lead","Formulário com filtros de qualificação"],
  ["3 · Pré-venda (SDR)","Qualifica e agenda"],
  [[B("4 · Reunião"),N(" — Executivo de Vendas conduz. "),B("É o KPI que importa.")],""],
  ["5 · Diagnóstico → Contrato","Proposta técnica"]],
 widths=[2.6,4.3])
bullet([B("10+ Executivos de Vendas"),N(" dependem de reuniões geradas por este canal.")])
bullet([B("Decisores B2B:"),N(" sócios, CEOs, CFOs e contadores — Lucro Real e Presumido.")])
bullet([B("CRM próprio:"),N(" rastreio ponta a ponta (lead → reunião → contrato) — devolve feedback de qualidade para a otimização da mídia.")])
callout("O que o canal precisa entregar",
 [B("Reunião realizada com o perfil certo"),N(" — não lead barato. A campanha anterior entregou bons resultados por um bom período; na fase final, o comparecimento e a conversão caíram, e pausamos para reestruturar. O sucesso desta nova fase será medido em "),B("reuniões qualificadas realizadas"),N(".")],kind="controle")

# ===== 02 PRODUTOS =====
h1("Produtos foco das campanhas","02")
para("Dois produtos próprios concentram o esforço de mídia. O resumo abaixo é o necessário para copy — o aprofundamento técnico está nos materiais de apoio (decks e FAQ).")
h3("DCF — Direito Creditório Federal (produto próprio)")
rich([B("O que é: "),N("operação estruturada que permite à empresa "),B("quitar tributos federais utilizando direito creditório com deságio"),N(" — pagar a mesma obrigação por menos, com lastro jurídico, seguro-garantia e condução 100% pela equipe Lucro Ativo.")])
bullet([B("Para quem:"),N(" empresas do Lucro Real e Presumido com carga tributária federal relevante (IRPJ, CSLL, PIS/COFINS).")])
bullet([B("Dor que resolve:"),N(" caixa consumido por tributos correntes; empresa paga “preço cheio” todo mês.")])
bullet([B("Ângulo de copy:"),N(" eficiência financeira e preservação de caixa — “sua empresa pode estar pagando mais imposto federal do que precisa”.")])
h3("ICMS-SP — Compensação do ICMS mensal com créditos acumulados (produto próprio)")
rich([B("O que é: "),N("compensação do ICMS mensal a recolher com "),B("créditos acumulados de ICMS transferidos"),N(" por detentores habilitados junto à SEFAZ/SP — o lançamento na apuração (GIA/SPED) "),B("reduz o imposto do mês na fonte"),N(" e o cliente paga pelo crédito utilizado com deságio: economia direta e recorrente. Não é “recuperação” retroativa — é redução do imposto corrente.")])
bullet([B("Para quem:"),N(" contribuintes com ICMS mensal relevante e recorrente — indústrias, distribuidoras, atacadistas, importadoras e varejo — prioridade em São Paulo (há atuação em outras UFs).")])
bullet([B("Dor que resolve:"),N(" o ICMS consome o caixa todo mês e a empresa paga o valor integral, sem crédito próprio para abater.")])
bullet([B("Ângulo de copy:"),N(" pagar o mesmo imposto por menos, todo mês — mecânica prevista no próprio regulamento paulista, sem tese “aventureira”.")])
callout("⚠ Regra inegociável para toda copy",
 [B("Nenhum número (percentual de economia, valor compensado, prazo, “garantido”) pode ir a público sem validação prévia do time jurídico/tributário da Lucro Ativo."),N(" Somos uma operação de natureza jurídico-tributária: promessa de resultado em anúncio é risco regulatório e reputacional. Toda peça passa por aprovação antes de veicular.")],kind="atencao")

# ===== 03 GS + ICP =====
h1("Parceria Grupo Studio & público-alvo","03")
h3("Grupo Studio — força de marca e portfólio ampliado")
rich([N("A Lucro Ativo mantém "),B("parceria estratégica com o Grupo Studio"),N(", uma das maiores redes de soluções tributárias e de gestão do país (grande base histórica de clientes atendidos em âmbito nacional). Na prática:")])
bullet([N("Nosso portfólio vai além dos produtos próprios: oferecemos "),B("soluções complementares do Grupo Studio"),N(" (revisão tributária, energia, folha/previdenciário e outras), sempre com "),B("condução comercial 100% Lucro Ativo"),N(".")])
bullet([N("Em materiais, produtos GS são sinalizados com "),B("selo discreto da marca parceira"),N(" — usamos a força da marca sem diluir a nossa.")])
bullet([N("Para a mídia: a parceria é "),B("argumento de autoridade e escala"),N(" (“estrutura nacional por trás”), não o protagonista. A marca que anuncia é a Lucro Ativo.")])
h3("Perfil de cliente ideal (ICP)")
add_table(["Dimensão","Definição"],
 [["Regime tributário",[N("Lucro Real e Lucro Presumido ("),B("Simples Nacional não é foco"),N(" — principal filtro anti-lead-ruim)")]],
  ["Porte",[N("Médias e grandes empresas; faturamento relevante — faixa exata de corte:"),V(),N("com a diretoria comercial")]],
  ["Segmentos com tração na base real","Indústria, distribuição/atacado, farma e drogarias, supermercados, transporte e logística, agro/alimentos, combustíveis"],
  ["Decisor (persona)","Sócio/CEO, CFO/diretor financeiro, controller e contador (interno ou escritório que influencia a decisão)"],
  ["Geografia","ICMS-SP: prioridade São Paulo · DCF: nacional"]],
 widths=[1.9,5.0])
callout("Anti-persona (o que o filtro precisa barrar)",
 [N("MEI, Simples Nacional, pessoa física buscando “restituição de imposto de renda”, curiosos de “renda extra” e aventureiros de tese milagrosa. "),B("Foi o avanço desse público que pressionou o comparecimento e a conversão na fase final da campanha anterior"),N(" — o formulário e a copy devem desqualificar ativamente.")],kind="controle")

# ===== 04 CENÁRIO =====
h1("Cenário atual — histórico do canal","04")
add_table(["Item","Situação em Agosto/2026"],
 [["Histórico do canal",[N("Tráfego pago na Meta ativo por um "),B("bom período, com ótimos resultados"),N(" de geração de leads e reuniões durante boa parte da veiculação.")]],
  ["Campanhas ativas",[B("Nenhuma no momento."),N(" A veiculação foi "),B("pausada em julho/2026"),N(" para reestruturação do canal.")]],
  ["Motivo da pausa",[N("Nos "),B("últimos 60 dias de veiculação (junho a meados de julho/2026)"),N(", o canal passou a apresentar "),B("alto no-show e baixa conversão em fechamento"),N(" — optamos por pausar e reestruturar antes de reinvestir.")]],
  ["Formato histórico","Campanhas objetivas/simples, direcionando para os perfis de Instagram da Lucro Ativo e do Dr. Lucas — sem landing dedicada por oferta e sem camada forte de qualificação."],
  ["Depoimentos e cases públicos",[B("Não temos hoje"),N(" depoimentos gravados nem cases autorizados para veiculação (ver box abaixo).")]],
  ["Rastreamento",[N("CRM próprio implantado (pipeline lead → reunião → contrato). Instrumentação da ponta de mídia (pixel, eventos, atribuição por campanha) a estruturar em conjunto:"),(" [LEVANTAR COM TI]",{'bold':True,'color':GOLD,'size':9})]]],
 widths=[1.9,5.0])
h3("Leitura da Lucro Ativo — o que evoluir na nova fase")
bullet([B("Bússola de otimização:"),N(" migrar do custo por lead para o custo por "),B("reunião qualificada realizada"),N(".")])
bullet([B("Camada de qualificação:"),N(" copy e formulário devem desqualificar ativamente Simples/PF, protegendo a agenda do SDR e o comparecimento.")])
bullet([B("Destino do clique:"),N(" evoluir do perfil do Instagram para destino dedicado por oferta — com captura estruturada e mensuração fina.")])
callout("Sobre o pedido de “depoimentos, cases e prints”",
 [N("Resposta transparente: "),B("não existem hoje depoimentos e cases prontos e autorizados para uso público."),N(" Existe base real de clientes atendidos e resultados internos — mas transformar isso em prova social exige autorização formal de cada cliente e validação jurídica. Caminho proposto: (1) curto prazo, sustentar a copy em "),B("autoridade técnica + base legal + clareza de processo"),N("; (2) em paralelo, a Lucro Ativo inicia a "),B("coleta estruturada de autorizações e cases anonimizados por segmento"),N(" para abastecer a mídia nas fases seguintes.")],kind="atencao")

# ===== 05 OBJETIVOS =====
h1("Objetivos da nova operação de mídia","05")
callout("Objetivo central",
 [B("Reativar a geração de reuniões comerciais qualificadas em volume suficiente para abastecer a agenda de 10+ Executivos de Vendas"),N(", com comparecimento e conversão que sustentem o contrato — recuperando e superando o patamar da melhor fase do canal.")],kind="controle")
h3("Como mediremos sucesso (proposta de KPIs)")
add_table(["Indicador","Papel"],
 [[[B("Reuniões qualificadas realizadas / mês")],[N("KPI primário — meta numérica a calibrar com a Sprint a partir da capacidade dos executivos"),V()]],
  ["Taxa de qualificação do lead (lead → agenda)","Mede se copy/filtros estão barrando a anti-persona"],
  ["Comparecimento (show rate)",[B("Ponto de atenção prioritário"),N(" — o alto no-show foi o principal sintoma da fase final da campanha anterior")]],
  ["Reunião → proposta → contrato","Fechamento do loop no CRM — devolvemos esse dado à Sprint para otimização por campanha/criativo"],
  ["Custo por reunião qualificada","Métrica de eficiência do investimento (substitui o CPL como bússola)"]],
 widths=[2.7,4.2])
h3("O que a Lucro Ativo espera da Sprint")
bullet([B("Copy e oferta específicas por produto"),N(" (DCF e ICMS-SP), com mecanismo claro de qualificação — é exatamente o escopo que vocês propuseram.")])
bullet([B("Estratégia de destino do clique"),N(" (landing dedicada, formulário qualificador, WhatsApp estruturado — recomendação de vocês, decidimos juntos).")])
bullet([B("Plano de mensuração"),N(" por campanha/criativo, integrado ao nosso funil (lead → reunião → contrato).")])
bullet([B("Cadência de otimização"),N(" com reunião periódica de resultados usando o feedback de qualidade do nosso CRM.")])

# ===== 06 MARCA/COMPLIANCE =====
h1("Diretrizes de marca e compliance","06")
h3("Identidade visual e tom")
bullet([B("Cores:"),N(" navy #010860 dominado por branco, com dourado como acento. Logos vetoriais (navy e branca) fornecidas com o Manual da Marca.")])
bullet([B("Tipografia:"),N(" Montserrat (títulos) + Inter (corpo).")])
bullet([B("Fotografia:"),N(" o Manual "),B("proíbe banco de imagem genérico"),N(" (aperto de mão, pessoas de terno apontando gráficos). Preferimos sistema gráfico próprio de dados ou imagem sob medida no tom da marca.")])
bullet([B("Tom de voz:"),N(" consultivo, sóbrio, técnico-acessível. Autoridade sem arrogância; urgência sem sensacionalismo. Nada de “hack”, “segredo que o governo esconde”, emojis em excesso ou estética de infoproduto.")])
h3("Compliance — leia antes de escrever qualquer copy")
bullet([B("Natureza jurídica da operação:"),N(" parte dos serviços é prestada por sociedade de advocacia. Publicidade nesse contexto tem limites regulatórios (sobriedade, vedação à promessa de resultado e à captação mercantilizada). "),B("Toda copy passa por validação do nosso jurídico antes de veicular.")])
bullet([B("Números públicos:"),N(" percentuais de economia, valores compensados, “garantia” — "),B("proibidos sem validação formal"),N(". Quando aprovados, sempre com contexto e ressalva.")])
bullet([B("Prova social:"),N(" nomes de clientes, prints e depoimentos só com autorização documentada.")])
bullet([B("LGPD:"),N(" formulários de captura com finalidade declarada e consentimento; dados de lead trafegam para nosso CRM sob nossa política de privacidade.")])
h3("Fluxo de aprovação proposto")
para("Sprint cria → Bruno Marinho (Geração de Leads) faz o primeiro crivo → validação jurídica quando houver claim técnico/numérico → aprovação final e veiculação. SLA de resposta do nosso lado a combinar no kickoff.",color=GRAY,size=9.8)

# ===== 07 MATERIAIS =====
h1("Materiais de apoio & próximos passos","07")
h3("O que entregamos junto com este briefing")
add_table(["Material","Uso para a Sprint"],
 [["Manual da Marca + logos vetoriais (SVG/PNG navy e branco)","Base obrigatória de qualquer criativo"],
  ["Apresentação comercial ICMS-SP (PDF)","Linguagem, argumentos e visual do produto"],
  ["Deck comercial DCF (PDF)","Narrativa do produto e provas técnicas"],
  ["Apresentação Transação Tributária PGFN (PDF)","Referência de tom C-level da casa"],
  ["FAQ técnico interno (DCF · ICMS · PGFN)","Fonte segura para copy — base legal e objeções reais"],
  ["Perfis Instagram (Lucro Ativo e Dr. Lucas)","Histórico de conteúdo e presença atual"]],
 widths=[3.5,3.4])
para("Depoimentos, cases e prints de resultado: ainda não disponíveis para uso público — ver seção 04. Entram no roadmap de coleta.",color=GRAY,size=9,italic=True)
h3("Interlocutores")
add_table(["Papel","Quem","Responsabilidade"],
 [["Sponsor","Dr. Lucas (CEO)","Direção estratégica e aprovação final"],
  ["Ponto focal operacional","Bruno Marinho — Geração & Distribuição de Leads","Briefings, aprovações de rotina, feedback de qualidade dos leads"],
  ["Comercial","Cleber Candia (CCO)","Capacidade de agenda dos executivos e retorno de conversão"]],
 widths=[1.7,2.4,2.8])
h3("Próximos passos sugeridos")
bullet([B("1."),N(" Reunião de kickoff: Sprint apresenta leitura deste briefing + primeiras hipóteses de oferta/copy.")])
bullet([B("2."),N(" Definição conjunta de metas numéricas (reuniões/mês, orçamento de mídia) —"),V(),N("antes do kickoff.")])
bullet([B("3."),N(" Estruturação do destino do clique + instrumentação de mensuração com nossa TI.")])
bullet([B("4."),N(" Rodada 1 de campanhas com criativos aprovados → ciclo quinzenal de otimização com dados do CRM.")])
callout("Resumo em uma frase",
 [N("O canal já provou que funciona — teve ótimos resultados por um bom período. Pausamos para reestruturar quando o comparecimento e a conversão caíram; agora ele volta com oferta e copy que "),B("filtram o decisor certo"),N(" (Lucro Real/Presumido), medidos por "),B("reunião qualificada realizada"),N(" — com a marca sóbria e o compliance de uma operação jurídico-tributária.")],kind="controle")

doc.save("/home/hermes/agente-rene/Briefing_Sprint_TrafegoPago_LucroAtivo_v1.docx")
print("docx salvo")
