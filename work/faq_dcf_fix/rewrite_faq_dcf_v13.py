#!/usr/bin/env python3
"""FAQ v1.3 — reescreve o Capítulo 1 (DCF) conforme a Cartilha Técnica:
a operação é ENCONTRO DE CONTAS via PER/DCOMP (Lei 9.430/96, art. 74), com cessão de
fração do crédito judicial transitado + habilitação do cliente no polo ativo.
Sai o desenho antigo (oferta de créditos à PGFN via art. 100 §11 + PF/BCN)."""
import copy
import re
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn

SRC = '/home/hermes/agente-rene/work/faq_dcf_fix/FAQ_Capacitacao_Comercial_LucroAtivo_v1.2.docx'
OUT = '/home/hermes/agente-rene/work/faq_dcf_fix/FAQ_Capacitacao_Comercial_LucroAtivo_v1.3.docx'

doc = Document(SRC)
body = doc.element.body
B = list(body.iterchildren())


def ptext(el):
    return ''.join(t.text or '' for t in el.iter() if t.tag.endswith('}t'))


# ---------- localizar limites ----------
cap1 = next(i for i, el in enumerate(B) if el.tag.endswith('}p') and ptext(el).strip().startswith('Capítulo 1'))
cap2 = next(i for i, el in enumerate(B) if el.tag.endswith('}p') and ptext(el).strip().startswith('Capítulo 2'))
assert cap1 == 14 and cap2 == 122, (cap1, cap2)

# ---------- templates ----------
TPL = {
    'section': copy.deepcopy(B[18]),   # Heading1 "BLOCO 1 — CONCEITO"
    'question': copy.deepcopy(B[19]),  # "▸  1. ..."
    'bodyp': copy.deepcopy(B[20]),     # corpo reg+bold
    'bullet': copy.deepcopy(B[43]),    # ListBullet bold-lead + reg
    'box': copy.deepcopy(B[5]),        # caixa 1x1 (regra de ouro)
    'comptbl': copy.deepcopy(B[60]),   # tabela 3 colunas
    'exbox': copy.deepcopy(B[87]),     # caixa exemplo 1x1
}
q_runs = Paragraph(TPL['question'], doc).runs
b_runs = Paragraph(TPL['bodyp'], doc).runs
reg_run = next(r for r in b_runs if not r.bold)
bold_run = next(r for r in b_runs if r.bold)
bl_runs = Paragraph(TPL['bullet'], doc).runs
bl_bold = next(r for r in bl_runs if r.bold)
bl_reg = next(r for r in bl_runs if not r.bold)
RT = {
    'q_marker': copy.deepcopy(q_runs[0]._element),
    'q_text': copy.deepcopy(q_runs[1]._element),
    'body_reg': copy.deepcopy(reg_run._element),
    'body_bold': copy.deepcopy(bold_run._element),
    'bl_reg': copy.deepcopy(bl_reg._element),
    'bl_bold': copy.deepcopy(bl_bold._element),
}


def set_run_text(rel, text):
    for t in rel.findall(qn('w:t')):
        rel.remove(t)
    t = rel.makeelement(qn('w:t'), {})
    t.set(qn('xml:space'), 'preserve')
    t.text = text
    rel.append(t)
    return rel


def clear_runs(pel):
    for r in pel.findall(qn('w:r')):
        pel.remove(r)


def make_p(template_key, runs_spec, rmap):
    el = copy.deepcopy(TPL[template_key])
    clear_runs(el)
    for is_bold, text in runs_spec:
        r = copy.deepcopy(RT[rmap[1] if is_bold else rmap[0]])
        set_run_text(r, text)
        el.append(r)
    return el


def question(num, text):
    marker = ptext(RT['q_marker'])
    el = copy.deepcopy(TPL['question'])
    clear_runs(el)
    r1 = copy.deepcopy(RT['q_marker']); set_run_text(r1, marker); el.append(r1)
    r2 = copy.deepcopy(RT['q_text']); set_run_text(r2, f'{num}. {text}'); el.append(r2)
    return el


def bodyp(spec):
    # spec: list of (text, bold_flag)
    return make_p('bodyp', [(b, t) for t, b in spec], ('body_reg', 'body_bold'))


def bullet(spec):
    return make_p('bullet', [(b, t) for t, b in spec], ('bl_reg', 'bl_bold'))


def section(title):
    el = copy.deepcopy(TPL['section'])
    runs = el.findall(qn('w:r'))
    keep = runs[0]
    for r in runs[1:]:
        el.remove(r)
    set_run_text(keep, title)
    return el


def set_para_text(p, text):
    if not p.runs:
        p.add_run(text)
        return
    p.runs[0].text = text
    for r in p.runs[1:]:
        r.text = ''


def fill_box(tbl_el, title, body_text):
    t = Table(tbl_el, doc)
    cell = t.rows[0].cells[0]
    paras = cell.paragraphs
    set_para_text(paras[0], title)
    if len(paras) > 1:
        set_para_text(paras[1], body_text)
        for p in paras[2:]:
            p._element.getparent().remove(p._element)
    else:
        # única parágrafo: título + corpo juntos
        set_para_text(paras[0], title + '\n' + body_text)
    return tbl_el


def set_cell(cell, text):
    paras = cell.paragraphs
    set_para_text(paras[0], text)
    for p in paras[1:]:
        p._element.getparent().remove(p._element)


# ---------- subtítulo do capítulo ----------
p15 = Paragraph(B[15], doc)
set_para_text(p15, 'PRODUTO: ENCONTRO DE CONTAS TRIBUTÁRIO FEDERAL — COMPENSAÇÃO MENSAL DOS DÉBITOS VINCENDOS COM CRÉDITO JUDICIAL TRANSITADO EM JULGADO')

# ---------- caixa "ponto sensível" ----------
box_sensivel = fill_box(
    copy.deepcopy(TPL['box']),
    '⬧ O PONTO MAIS SENSÍVEL DO PRODUTO — LEIA DUAS VEZES',
    'O DCF NÃO é "compensação com crédito de terceiro". Antes de qualquer PER/DCOMP, o cliente é '
    'habilitado no polo ativo do processo de origem como titular de fração do crédito, por cessão formal '
    '(CC, arts. 286–298) e petição de habilitação. É essa habilitação prévia que separa a operação das '
    'ofertas irregulares de "créditos de terceiros" contra as quais a Receita Federal alerta. O executivo '
    'nunca improvisa nesse ponto: se o cliente aprofundar, envolva a área técnica — há rito de defesa e '
    'precedentes específicos (Tema 736/STF; decisões TRF3/TRF4/TRF5, 2024–2026).')

# ---------- tabela "institutos vizinhos" ----------
comp = copy.deepcopy(TPL['comptbl'])
ct = Table(comp, doc)
# 6 linhas -> header + 4
while len(ct.rows) > 5:
    ct._tbl.remove(ct.rows[-1]._tr)
hdr = ct.rows[0].cells
set_cell(hdr[0], 'Instituto vizinho')
set_cell(hdr[1], 'Como funciona')
set_cell(hdr[2], 'Por que o DCF não é isso')
ROWS = [
    ('Precatório (recebimento em espécie)',
     'Requisição de pagamento expedida pela Justiça (CF, art. 100); o credor aguarda a ordem cronológica para receber da União.',
     'No DCF a União não emite ordem de pagamento a ninguém: o efeito é a extinção do débito do cliente por compensação administrativa (CTN, art. 156, II).'),
    ('Oferta de créditos à Fazenda (CF, art. 100, §11)',
     'Uso de crédito judicial para quitar débitos parcelados ou inscritos em Dívida Ativa (Decreto 11.249/2022; Portaria PGFN 10.826/2022).',
     'Caminho constitucional válido para cenários específicos, mas NÃO é a base operacional do DCF — o DCF corre na RFB, sobre débitos vincendos, via PER/DCOMP.'),
    ('"Compra de crédito de terceiro" para compensar',
     'Prática irregular: compensar pelo art. 74 crédito alheio, sem habilitação — alvo de alertas públicos da RFB.',
     'No DCF o cliente é habilitado no polo ativo como titular de fração do crédito (cessão formal + petição no juízo de origem) antes de qualquer Dcomp.'),
    ('Planejamento agressivo / elisão abusiva',
     'Estruturas artificiais, simulação ou dissimulação para suprimir tributo.',
     'O DCF exerce direito previsto em lei (CTN, art. 170; Lei 9.430/96, art. 74), com crédito transitado em julgado e escrituração aceita pelo juízo — sem simulação. O Tema 736/STF protege o exercício do direito creditório.'),
]
for ri, row in enumerate(ROWS, start=1):
    for ci in range(3):
        set_cell(ct.rows[ri].cells[ci], row[ci])
# impede quebra de linha da tabela no meio (split feio entre páginas)
for r in ct.rows:
    trPr = r._tr.get_or_add_trPr()
    if trPr.find(qn('w:cantSplit')) is None:
        trPr.append(trPr.makeelement(qn('w:cantSplit'), {}))

# ---------- caixa exemplo 80/20 ----------
exbox = fill_box(
    copy.deepcopy(TPL['exbox']),
    '⬧ EXEMPLO ILUSTRATIVO — não usar como proposta',
    'Números do material-base da operação — didáticos, (PARÂMETRO A VALIDAR) em cada caso concreto. '
    'Parcelamento federal ativo de R$ 2.067.498,30, em 21 parcelas mensais de R$ 98.452,30, integralmente '
    'extinto por compensação contra o crédito judicial: o cliente paga à operação 80% (R$ 1.653.998,64), na '
    'medida em que cada compensação mensal se efetiva, e retém 20% (R$ 413.499,66) como economia direta e '
    'líquida de caixa. Não há saída de caixa para a União sobre o tributo compensado na competência. A '
    'atualização SELIC do crédito durante o processamento administrativo é apropriada pela operação.')

# ---------- NOVO CAPÍTULO 1 ----------
N = []
A = N.append

A(section('BLOCO 1 — CONCEITO'))
A(question(1, 'O que é, em uma frase, o DCF da Lucro Ativo?'))
A(bodyp([('É um ', 0), ('encontro de contas tributário', 1),
         (': a compensação administrativa, ', 0), ('mensal e recorrente', 1),
         (', dos débitos federais vincendos do cliente (PIS, COFINS, IRPJ, CSLL e demais tributos administrados pela RFB) contra ', 0),
         ('fração de um crédito judicial transitado em julgado', 1),
         (', na qual o cliente é habilitado no polo ativo da ação de origem. O cliente paga 80% do valor de face de cada tributo compensado e retém ', 0),
         ('20% como economia direta de caixa', 1),
         (' — percentuais do material-base, (PARÂMETRO A VALIDAR).', 0)]))
A(question(2, 'O que é o "direito creditório federal" da operação?'))
A(bodyp([('É o crédito tributário federal ', 0), ('líquido e certo', 1),
         (', decorrente de decisão judicial ', 0), ('transitada em julgado', 1),
         (', com ', 0), ('escrituração formal aceita pelo juízo de origem', 1),
         (' — o que cumpre integralmente o art. 170-A do CTN e o torna apto à compensação administrativa. O crédito ', 0),
         ('já existe e é anterior ao cliente', 1),
         (': a operação não depende de o cliente ter crédito próprio nem ação judicial em curso.', 0)]))
A(question(3, 'De quem é o crédito? Qual o papel do cliente e o da Lucro Ativo?'))
A(bodyp([('O crédito pertence à ', 0), ('estrutura cedente da operação', 1),
         (' (fornecedor do crédito, homologado pela Lucro Ativo — a identificação institucional do cedente é informação interna e ', 0),
         ('não é citada em material de cliente', 1),
         ('). O cliente é incluído como ', 0), ('titular de fração do crédito', 1),
         (' por cessão formal (CC, arts. 286–298) e petição de habilitação no processo de origem — é isso que lhe confere legitimidade processual e administrativa para usar o crédito perante a RFB. A ', 0),
         ('Lucro Ativo conduz a operação de ponta a ponta', 1),
         (', com apoio de escritório contábil parceiro: diagnóstico, cessão, habilitação, protocolo do pedido-mãe, Dcomps mensais e defesa administrativa/judicial quando necessária.', 0)]))
A(question(4, 'Direito creditório é o mesmo que precatório?'))
A(bodyp([('Não — e é só para marcar essa diferença que o precatório aparece neste FAQ.', 1),
         (' No precatório, a União emite ordem de pagamento e o credor espera a fila. No DCF ', 0),
         ('não há ordem de pagamento nem fila', 1),
         (': o efeito é a extinção do débito tributário do cliente por compensação administrativa (CTN, art. 156, II). Na reunião, cite o precatório apenas de forma pontual e superficial, para explicar o que a operação ', 0),
         ('não é', 1), ('. Aprofundamento é da área técnica.', 0)]))
A(question(5, 'É a via do art. 100, §11, da CF (oferta de créditos para Dívida Ativa)?'))
A(bodyp([('Não.', 1),
         (' Esse caminho constitucional existe e é válido para cenários específicos (parcelamentos, Dívida Ativa), mas ', 0),
         ('não constitui a base operacional do DCF', 1),
         ('. A base do DCF é a ', 0), ('compensação administrativa da Lei 9.430/96, art. 74', 1),
         (', via PER/DCOMP, dentro da Receita Federal, sobre ', 0), ('débitos vincendos', 1),
         (' — com o cliente já habilitado como titular de fração do crédito.', 0)]))
A(question(6, 'Então é "compensação com crédito de terceiro"? Isso não é vedado?'))
A(bodyp([('Essa é a pergunta que define o produto — e a resposta é não.', 1),
         (' A vedação do art. 74, §12, alcança a tentativa de compensar crédito ', 0), ('alheio', 1),
         ('. No DCF, antes de qualquer declaração de compensação, o cliente é formalmente habilitado no polo ativo do processo de origem como ', 0),
         ('titular de fração do crédito', 1),
         (' — ele compensa crédito do qual é titular por habilitação. A operação é o exercício de direito legalmente previsto (CTN, arts. 156, II, 170 e 170-A; Lei 9.430/96, art. 74), em procedimento administrativo regular.', 0)]))
A(box_sensivel)
A(bodyp([('Síntese das distinções — a tabela abaixo resume o que a operação NÃO é:', 1)]))
A(comp)

A(section('BLOCO 2 — BASE LEGAL'))
A(question(7, 'Quais âncoras legais o executivo cita (sem detalhar o rito)?'))
A(bullet([('Código Civil, arts. 286–298', 1), (' — cessão de crédito: a matriz civil da habilitação do cliente na cadeia do crédito; arts. 368–369 — a compensação como instituto.', 0)]))
A(bullet([('CTN, arts. 156, II, 170 e 170-A', 1), (' — extinção do crédito tributário pela compensação; compensação de crédito líquido e certo; exigência do trânsito em julgado (integralmente cumprida na operação).', 0)]))
A(bullet([('Lei 9.430/96, art. 74', 1), (' — o veículo administrativo: PER/DCOMP para compensar débitos de quaisquer tributos administrados pela RFB; §5º — prazo de até 1 ano e homologação tácita.', 0)]))
A(bullet([('IN RFB 2.055/2021', 1), (' — o procedimento de restituição, ressarcimento e compensação perante a RFB.', 0)]))
A(bullet([('Lei 9.250/95, art. 39, §4º', 1), (' — atualização SELIC do crédito durante o processamento administrativo.', 0)]))
A(bullet([('CF/88, arts. 150, §6º e 195', 1), (' — legalidade tributária e materialidade dos tributos compensáveis; art. 100, §11 (EC 113/2021) — via complementar para parcelados/Dívida Ativa (não é a base do DCF).', 0)]))
A(question(8, 'E a jurisprudência — o que blinda a operação?'))
A(bullet([('Tema 736/STF', 1), (' — é inconstitucional a multa de 50% sobre a declaração de compensação não homologada, sem demonstração de má-fé. Precedente vinculante que protege o exercício do direito creditório.', 0)]))
A(bullet([('Tema 237/STJ', 1), (' — contribuinte que oferece garantia tem direito à Certidão Positiva com Efeitos de Negativa (CPD-EN); aplicado por analogia aos créditos judiciais transitados.', 0)]))
A(bullet([('Súmula 461/STJ', 1), (' — "O contribuinte pode optar por receber, por meio de precatório ou por compensação, o indébito tributário certificado por sentença declaratória transitada em julgado."', 0)]))
A(bullet([('Jurisprudência sobre denúncia espontânea', 1), (' — delimita o alcance do instituto e é um dos motivos de a operação se restringir a débitos vincendos.', 0)]))
A(question(9, 'Por que a operação foca débitos VINCENDOS (e não os atrasados)?'))
A(bodyp([('Por desenho jurídico: o encontro de contas mensal extingue o ', 0), ('débito da competência, antes do vencimento', 1),
         (' — o que mantém a CND do cliente e evita as discussões próprias de débito vencido. Débitos ', 0), ('pretéritos', 1),
         (' não estão descartados, mas seguem tratamento próprio (CPD-EN com garantia — Tema 237/STJ; inclusão de parcelados/Dívida Ativa admitida em decisão judicial de operação idêntica), sempre com avaliação da área técnica, caso a caso.', 0)]))

A(section('BLOCO 3 — COMO A OPERAÇÃO FUNCIONA'))
A(question(10, 'Quais são as seis etapas administrativas, passo a passo?'))
A(bullet([('1 · Habilitação', 1), (' — cessão formal de fração do crédito (CC, arts. 286–298) + petição de habilitação do cliente no polo ativo do processo de origem.', 0)]))
A(bullet([('2 · Pedido-mãe', 1), (' — protocolo, no COMPROT, do pedido de restituição/ressarcimento lastreado no valor escriturado do crédito judicial. É dentro dele que "vivem" os encontros de contas mensais.', 0)]))
A(bullet([('3 · Dcomps mensais', 1), (' — a cada competência, PER/DCOMP indicando o crédito habilitado e o débito federal vincendo a quitar. Cada Dcomp gera número de protocolo individualizado.', 0)]))
A(bullet([('4 · Prazo legal', 1), (' — a RFB tem até 1 ano para examinar o pedido de ressarcimento (Lei 9.430/96, art. 74, §5º). Durante o prazo, o crédito segue atualizado pela SELIC.', 0)]))
A(bullet([('5 · Homologação tácita', 1), (' — transcorrido 1 ano sem questionamento, a compensação considera-se homologada. O que está sob análise é o pedido-mãe, não cada Dcomp isoladamente.', 0)]))
A(bullet([('6 · Acessórios', 1), (' — CND mantida para os débitos compensados na competência; CPD-EN para pretéritos com garantia; mandado de segurança preventivo quando necessário (certidões, vedação de multa).', 0)]))
A(question(11, 'O que é o "pedido-mãe"?'))
A(bodyp([('É o pedido administrativo de ', 0), ('restituição/ressarcimento', 1),
         (' protocolado no ', 0), ('COMPROT', 1),
         (' (sistema de processos administrativos da Fazenda), lastreado no crédito judicial escriturado. Ele abre o processo dentro do qual as compensações mensais são declaradas — e é sobre ele que corre o prazo de 1 ano da RFB.', 0)]))
A(question(12, 'O que acontece durante os 12 meses de análise da RFB?'))
A(bodyp([('A operação segue normalmente: as Dcomps mensais extinguem os débitos na competência (CTN, art. 156, II) e o cliente ', 0),
         ('mantém a CND', 1),
         (' sobre esses débitos. O crédito permanece ', 0), ('atualizado pela SELIC', 1),
         (' (Lei 9.250/95, art. 39, §4º), preservando o valor real do ativo. Não havendo questionamento no prazo, opera-se a ', 0),
         ('homologação tácita', 1), ('.', 0)]))
A(question(13, 'Qual o cronograma típico de implantação (90 dias)?'))
A(bullet([('Dia 1–30 · Diagnóstico', 1), (' — coleta de DCTFs, EFD-Contribuições e DARFs; média mensal de recolhimento federal; identificação de débitos elegíveis. Entregável: Mapa de Recolhimento.', 0)]))
A(bullet([('Dia 30–60 · Estruturação jurídica', 1), (' — parecer + memória de cálculo; termo e procuração; cessão de fração; habilitação no processo de origem; protocolo do pedido-mãe no COMPROT.', 0)]))
A(bullet([('Dia 60–90 · Primeira compensação', 1), (' — primeira parcela mensal compensada. A primeira compensação pode ocorrer nessa janela a partir da formalização — prazo típico, (PARÂMETRO A VALIDAR).', 0)]))
A(bullet([('Dia 90+ · Recorrência', 1), (' — Dcomps mensais até esgotar a fração habilitada da operação.', 0)]))

A(section('BLOCO 4 — QUEM SE QUALIFICA'))
A(question(14, 'Qual é o perfil de cliente ideal?'))
A(bullet([('Recolhimento federal mensal relevante e recorrente', 1), (' — PIS, COFINS, IRPJ, CSLL e demais tributos administrados pela RFB; é sobre esse fluxo que a economia mensal acontece.', 0)]))
A(bullet([('Apuração organizada e situação regular', 1), (' — DCTFs, EFD-Contribuições e DARFs em dia permitem o diagnóstico rápido (Mapa de Recolhimento).', 0)]))
A(bullet([('Parcelamentos federais ativos', 1), (' — também endereçáveis: há decisão judicial reconhecendo a compensação com débitos parcelados e em Dívida Ativa, em operação idêntica; enquadramento pela área técnica, caso a caso.', 0)]))
A(bullet([('Não é pré-requisito ter crédito próprio', 1), (' — o crédito da operação já existe; o cliente só se habilita a uma fração.', 0)]))
A(question(15, 'Que documentos o cliente precisa entregar para começar?'))
A(bullet([('Contrato social', 1), (' — versão consolidada e vigente.', 0)]))
A(bullet([('Certidões dos sócios administradores', 1), (' — emitidas em até 90 dias.', 0)]))
A(bullet([('RG ou CNH', 1), (' — dos sócios/administradores que assinarão procuração e contrato.', 0)]))
A(bullet([('Procuração eletrônica no e-CAC', 1), (' — em nome das pessoas jurídicas indicadas pela operação.', 0)]))
A(bullet([('Complementares (na Análise Jurídica)', 1), (' — DCTFs, EFD, ECD/ECF e demais obrigações acessórias, conforme o perfil tributário identificado.', 0)]))

A(section('BLOCO 5 — REMUNERAÇÃO (MODELO 80/20)'))
A(question(16, 'Como o cliente paga? Existe honorário, adesão ou mensalidade?'))
A(bodyp([('Modelo único e 100% atrelado a resultado, (PARÂMETRO A VALIDAR):', 1),
         (' o cliente paga ', 0), ('80% do valor de face de cada tributo efetivamente compensado', 1),
         (', na medida em que cada compensação mensal se efetiva — sem pagamento antecipado, sem adesão, sem mensalidade e sem honorários à parte (tudo embutido). Os ', 0),
         ('20% restantes são a economia direta e líquida', 1),
         (' do cliente em cada competência. A atualização SELIC do crédito durante o processamento é apropriada pela operação. Eventual defesa administrativa ou judicial relacionada é conduzida ', 0),
         ('sem custo adicional', 1),
         ('. Atenção de postura: não use a palavra "garantido" — apresente como condição do modelo, validada em proposta.', 0)]))
A(question(17, 'Tem um exemplo numérico para eu visualizar?'))
A(exbox)

A(section('BLOCO 6 — SEGURANÇA JURÍDICA E CONTINGÊNCIAS'))
A(question(18, 'Quais os riscos mapeados e a blindagem de cada um?'))
A(bullet([('Não homologação do PER/DCOMP', 1), (' — crédito com trânsito em julgado e escrituração formal (art. 170-A CTN cumprido); defesa administrativa imediata e MS quando necessário; Tema 736/STF protege o exercício do direito creditório.', 0)]))
A(bullet([('Multa sobre compensação não homologada', 1), (' — Tema 736/STF: inconstitucional sem prova de má-fé; decisão de TRF (mar/2026) determinou abstenção expressa da RFB em caso idêntico.', 0)]))
A(bullet([('RFB não conclui a análise em 12 meses', 1), (' — homologação tácita ao fim do prazo (art. 74, §5º); crédito atualizado pela SELIC; cabível MS para forçar instauração — decisão de TRF (abr/2026) fixou 15 dias sob multa diária.', 0)]))
A(bullet([('Certidões / CADIN / SERASA', 1), (' — débitos vincendos compensados mantêm CND; pretéritos com garantia têm CPD-EN (Tema 237/STJ); MS preventivo afasta CADIN/SERASA — teses consolidadas em TRF3 e TRF4 (2024–2026).', 0)]))
A(bullet([('Responsabilização de administradores (art. 135 CTN)', 1), (' — exige dolo, fraude ou excesso de poderes demonstrados; exercício de direito legal não configura infração; MS (mar/2026) vedou expressamente a responsabilização.', 0)]))
A(bullet([('Alegação de "elisão abusiva"', 1), (' — a operação exerce direito previsto em lei (CTN, art. 170; Lei 9.430/96, art. 74), com crédito judicial; não há simulação, dissimulação ou fraude.', 0)]))
A(question(19, 'Existem decisões judiciais em operações idênticas?'))
A(bodyp([('Sim — quatro decisões favoráveis (TRF3, TRF4 e TRF5, dez/2024 a abr/2026), anonimizadas no material-base:', 1),
         (' (i) apelação provida reconhecendo a compensação de créditos habilitados com débitos parcelados e em Dívida Ativa; (ii) MS com abstenção de multa qualificada, vedação de responsabilização de sócios e garantia de CND/CPD-EN; (iii) liminar suspendendo alerta de autorregularização da RFB após PER/DCOMP com crédito cedido (R$ 1.183.621,94), reconhecendo a legitimidade da cessão; (iv) tutela determinando a instauração do processo administrativo em 15 dias sob multa diária, com suspensão de parcelas vincendas e emissão de CPD-EN. ', 0),
         ('As íntegras ficam arquivadas na operação e são disponibilizadas sob pedido, para análise técnica, preservada a confidencialidade dos casos.', 1)]))

A(section('BLOCO 7 — OBJEÇÕES DO CLIENTE'))
A(question(20, '"Isso é legal?"'))
A(bodyp([('Sim.', 1),
         (' É o exercício de direito expressamente previsto em lei — CTN, arts. 156, II, 170 e 170-A; Lei 9.430/96, art. 74 — com crédito judicial transitado em julgado, em procedimento 100% administrativo dentro da Receita Federal. Cada compensação gera protocolo individualizado; tudo é registrado e rastreável.', 0)]))
A(question(21, '"E se a Receita questionar ou não homologar?"'))
A(bodyp([('A RFB tem 1 ano para se manifestar; sem questionamento, a compensação é ', 0),
         ('tacitamente homologada', 1),
         ('. Se houver questionamento, toda a defesa administrativa e judicial é conduzida pela operação, ', 0),
         ('sem custo adicional', 1),
         (' — com blindagem jurisprudencial específica (Tema 736/STF; decisões de TRFs em casos idênticos, incluindo abstenção de multa e de responsabilização de sócios).', 0)]))
A(question(22, '"Por que não simplesmente parcelar?"'))
A(bodyp([('Parcelamento dilui, não reduz: paga-se o valor cheio + SELIC ao longo do tempo, consumindo caixa. No DCF, o débito da competência é ', 0),
         ('extinto por compensação', 1),
         (' e o cliente desembolsa 80% do valor de face — economia direta de 20% ao mês, sem antecipação e sem litígio, (PARÂMETRO A VALIDAR).', 0)]))
A(question(23, '"Parece bom demais para ser verdade."'))
A(bodyp([('A economia tem lógica de mercado, não de milagre: o crédito judicial consolidado é um ativo de ', 0),
         ('baixa liquidez', 1),
         (' — o titular prefere monetizá-lo com desconto a esperar. O cliente acessa uma fração desse crédito com deságio e a lei define o rito (art. 74; PER/DCOMP; homologação). Tudo com protocolo, escrituração e registro — e precedentes judiciais em operações idênticas.', 0)]))
A(question(24, '"Em quanto tempo vejo a primeira economia?"'))
A(bodyp([('O cronograma típico coloca a ', 0), ('primeira compensação entre 60 e 90 dias', 1),
         (' da formalização (diagnóstico → estruturação → primeira Dcomp), e depois a economia é mensal e recorrente. Prazo típico do material-base, (PARÂMETRO A VALIDAR) — não prometa data em contrato.', 0)]))

A(section('BLOCO 8 — LIMITES, RISCOS E POSTURA'))
A(question(25, 'O que o produto NÃO faz — e o que o executivo nunca deve fazer?'))
A(bullet([('Não é venda de "papel"', 1), (' — o cliente não compra crédito para compensar por conta própria: sem cessão formal + habilitação no polo ativo, não há operação.', 0)]))
A(bullet([('Não é a via do art. 100, §11', 1), (' — não misture os ritos na frente do cliente: o DCF corre na RFB (PER/DCOMP), não na oferta de créditos à Fazenda para Dívida Ativa.', 0)]))
A(bullet([('Não prometa homologação nem data', 1), (' — o prazo legal é da RFB; a homologação tácita é efeito do decurso do prazo, não promessa comercial.', 0)]))
A(bullet([('Não use "garantido"', 1), (' — percentuais, prazos e condições são do material-base e (PARÂMETRO A VALIDAR) em proposta individual.', 0)]))
A(bullet([('Foco em débitos vincendos', 1), (' — pretéritos, parcelados e Dívida Ativa só com avaliação da área técnica (CPD-EN/garantia; decisão judicial favorável existe, mas o enquadramento é caso a caso).', 0)]))
A(bullet([('Alerta ou intimação da RFB ao cliente', 1), (' — acione imediatamente a área técnica: há rito de defesa e precedente específico (liminar suspendendo alerta de autorregularização em caso idêntico). Nunca oriente o cliente por conta própria.', 0)]))

A(section('GLOSSÁRIO'))
GLOSS = [
    ('Direito Creditório Federal (DCF)', 'crédito tributário federal, líquido e certo, decorrente de decisão judicial transitada em julgado, hábil à compensação administrativa.'),
    ('Encontro de contas', 'sinônimo prático de compensação bilateral — no DCF, a operação mensal entre o crédito habilitado e o débito federal vincendo do cliente.'),
    ('Compensação tributária', 'modalidade de extinção do crédito tributário (CTN, art. 156, II) pela qual créditos e débitos se extinguem até onde se compensarem.'),
    ('Cessão de crédito', 'negócio jurídico dos arts. 286–298 do CC; no DCF, viabiliza a habilitação do cliente no polo ativo da ação de origem.'),
    ('Habilitação no polo ativo', 'reconhecimento, no processo de origem, da titularidade do cliente sobre fração do crédito — pré-requisito do uso administrativo.'),
    ('PER/DCOMP (Dcomp)', 'Pedido Eletrônico de Restituição, Ressarcimento ou Reembolso e Declaração de Compensação — o veículo administrativo do art. 74 da Lei 9.430/96.'),
    ('Pedido-mãe (restituição/ressarcimento)', 'pedido administrativo protocolado no COMPROT, lastreado no crédito judicial, que abriga os Dcomps mensais.'),
    ('COMPROT', 'sistema de controle de processos administrativos da Fazenda, onde se protocola o pedido-mãe.'),
    ('Homologação tácita', 'efeito do decurso do prazo de 1 ano sem manifestação da RFB sobre o pedido (Lei 9.430/96, art. 74, §5º).'),
    ('Crédito líquido e certo', 'crédito de valor determinado, com origem e titularidade incontroversas — requisito do art. 170 do CTN.'),
    ('Trânsito em julgado', 'estado da decisão que não admite mais recurso; marco a partir do qual o crédito é apto à compensação (CTN, art. 170-A).'),
    ('Deságio', 'diferença entre o valor de face e o valor pago; no DCF, os 20% que ficam com o cliente como economia direta.'),
    ('SELIC', 'taxa que atualiza os créditos tributários da União em favor do contribuinte (Lei 9.250/95, art. 39, §4º).'),
    ('CND', 'Certidão Negativa de Débitos — atesta regularidade fiscal; exigida em licitações, financiamentos e operações societárias.'),
    ('CPD-EN', 'Certidão Positiva com Efeitos de Negativa — emitida com débitos suspensos ou garantidos; mesmos efeitos práticos da CND (Tema 237/STJ).'),
    ('CADIN', 'cadastro federal de créditos não quitados; a inclusão gera restrição em órgãos federais — a operação tem rito preventivo contra inclusão indevida.'),
    ('Precatório', 'requisição judicial de pagamento contra a Fazenda (CF, art. 100). Citado neste FAQ apenas para diferenciação — não é o instrumento da operação.'),
]
for term, desc in GLOSS:
    A(bullet([(term + ': ', 1), (desc, 0)]))

A(section('BASE NORMATIVA VERIFICADA (para consulta do executivo)'))
BASE = [
    ('Código Civil, arts. 286–298 e 368–369', ' — cessão de crédito e compensação como instituto.'),
    ('CTN, arts. 156, II; 170; 170-A', ' — extinção por compensação; crédito líquido e certo; exigência do trânsito em julgado.'),
    ('Lei nº 9.430/1996, art. 74 (e §5º)', ' — PER/DCOMP; prazo de 1 ano e homologação tácita.'),
    ('IN RFB nº 2.055/2021', ' — procedimento de restituição, ressarcimento e compensação.'),
    ('Lei nº 9.250/1995, art. 39, §4º', ' — atualização SELIC do crédito.'),
    ('CF/88, arts. 150, §6º; 195; 100, §11 (EC 113/2021)', ' — legalidade, materialidade e a via complementar de quitação de parcelados/Dívida Ativa (não é a base do DCF).'),
    ('Decreto nº 11.249/2022 e Portaria PGFN nº 10.826/2022', ' — procedimento operacional da via do art. 100, §11 (citados no material-base como contexto).'),
    ('Tema 736/STF', ' — inconstitucionalidade da multa de 50% sobre compensação não homologada, sem má-fé.'),
    ('Tema 237/STJ', ' — CPD-EN mediante garantia.'),
    ('Súmula 461/STJ', ' — opção do contribuinte entre precatório e compensação do indébito transitado em julgado.'),
]
for t, d in BASE:
    A(bullet([(t, 1), (d, 0)]))

# ---------- aplicar: remove blocos 18..(cap2-2) e insere ----------
# preserva um eventual parágrafo de quebra imediatamente antes do heading do cap. 2
anchor_idx = cap2 - 1 if not ptext(B[cap2 - 1]).strip() else cap2
anchor = B[anchor_idx]
for el in B[18:anchor_idx]:
    body.remove(el)
for el in N:
    anchor.addprevious(el)

# ---------- colofão: distinção produto × fraude ----------
done_col = False
for p in doc.paragraphs:
    if 'Distinção que separa produto de fraude' in p.text:
        set_para_text(
            p,
            'Distinção que separa produto de fraude — no DCF, o cliente só compensa DEPOIS de habilitado no '
            'polo ativo como titular de fração do crédito (cessão formal + habilitação no juízo de origem). '
            'Compensar "crédito de terceiro" sem habilitação é a prática irregular contra a qual a RFB alerta '
            '— nunca confundir as duas na frente do cliente.')
        done_col = True
assert done_col, 'colofao nao encontrado'

# ---------- versão v1.2 -> v1.3 (SÓ o padrão v1.2 — nunca "1.2" solto: quebra "11.249") ----------
def bump_version(paragraphs):
    n = 0
    for p in paragraphs:
        if 'v1.2' in p.text or 'V1.2' in p.text or 'Versão 1.2' in p.text:
            for r in p.runs:
                if 'v1.2' in r.text or 'V1.2' in r.text or 'Versão 1.2' in r.text:
                    r.text = (r.text.replace('v1.2', 'v1.3').replace('V1.2', 'V1.3')
                              .replace('Versão 1.2', 'Versão 1.3'))
                    n += 1
    return n


# colofão — data/versão da edição
for p in doc.paragraphs:
    if 'versão 1 para validação' in p.text:
        for r in p.runs:
            if 'Agosto de 2026' in r.text or 'versão 1 para' in r.text:
                r.text = (r.text.replace('Agosto de 2026', 'Setembro de 2026')
                          .replace('versão 1 para validação', 'versão 1.3 para validação'))

nv = bump_version(doc.paragraphs)
for tbl in doc.tables:
    for row in tbl.rows:
        for cell in row.cells:
            nv += bump_version(cell.paragraphs)
for sec in doc.sections:
    for part in (sec.header, sec.footer, sec.first_page_header, sec.first_page_footer):
        if part is not None:
            nv += bump_version(part.paragraphs)
print('versoes atualizadas:', nv)

# ficha do documento — atualiza "Versão / Data" e imprime para conferência
ficha = doc.tables[0]
for row in ficha.rows:
    if row.cells[0].text.strip().startswith('Versão'):
        set_para_text(row.cells[1].paragraphs[0], 'Versão 1.3 · Setembro de 2026')
    print('FICHA |', ' || '.join(c.text[:90] for c in row.cells))

doc.save(OUT)
print('salvo', OUT)

# ---------- verificação ----------
check = Document(OUT)


def all_texts(d):
    for p in d.paragraphs:
        yield p.text
    for tbl in d.tables:
        for row in tbl.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    yield '[TBL] ' + p.text


texts = list(all_texts(check))
for pat in ['Menezes', 'consórcio', 'consorcio', 'PGFN nº 10.826', 'PF/BCN', 'precat']:
    hits = [t for t in texts if re.search(pat, t, re.I)]
    print(f'\n==== "{pat}": {len(hits)} ====')
    for h in hits[:14]:
        print('-', h.strip()[:150])
