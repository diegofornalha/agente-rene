# -*- coding: utf-8 -*-
"""Re-ancora a base legal do DCF: encontro de contas EC 113/2021 (CF art.100 §11)
+ normativos posteriores; remove a 9.430/96 como 'base' (fica só como distinção)."""
from docx import Document
from docx.shared import RGBColor
import copy

SRC = '/home/hermes/agente-rene/work/faq_dcf_fix/FAQ_v13_final_src.docx'
OUT = '/home/hermes/agente-rene/work/faq_dcf_fix/FAQ_v14_src.docx'
d = Document(SRC)

def cap_props(p):
    """Captura propriedades do 1º run negrito e do 1º run normal."""
    bold_r, norm_r = None, None
    for r in p.runs:
        if r.font.bold and bold_r is None: bold_r = r
        if not r.font.bold and norm_r is None: norm_r = r
    base = bold_r or norm_r or (p.runs[0] if p.runs else None)
    def props(r, fallback):
        r = r or fallback
        if r is None: return {}
        col = None
        try:
            if r.font.color and r.font.color.type is not None: col = r.font.color.rgb
        except Exception: pass
        return dict(name=r.font.name, size=r.font.size, color=col,
                    bold=bool(r.font.bold), italic=r.font.italic)
    return props(bold_r, base), props(norm_r, base)

def rebuild(p, segs):
    bp, np_ = cap_props(p)
    for r in list(p.runs):
        r._element.getparent().remove(r._element)
    for text, bold in segs:
        r = p.add_run(text)
        src = bp if bold else np_
        r.font.name = src.get('name'); r.font.size = src.get('size')
        r.font.bold = bool(bold) if bold else (src.get('bold') if not bold else True)
        r.font.bold = bool(bold)
        # cor: negrito herda cor do negrito original; normal idem
        if src.get('color') is not None: r.font.color.rgb = src['color']
        if src.get('italic'): r.font.italic = True

P = d.paragraphs

# --- Q5: pergunta + resposta (inverte a lógica: EC 113 É a base) ---
# título: preserva run do marcador, troca o texto
q5 = P[24]
assert '§11' in q5.text
rebuild(q5, [('▸  5. Qual é a base legal da operação? É a Lei 9.430/96?', True)])

rebuild(P[25], [
 ('Não. A base da operação é o ',0), ('encontro de contas inaugurado pela EC 113/2021',1),
 (', que incluiu o §11 no art. 100 da CF: a oferta de créditos líquidos e certos, ',0),
 ('próprios ou adquiridos de terceiros',1),
 (', decorrentes de decisões judiciais transitadas em julgado, para quitação de débitos perante a União — regulamentada pelos normativos posteriores (Decreto 11.249/2022, Portaria PGFN 10.826/2022 e atos correlatos). A compensação comum da Lei 9.430/96 (art. 74) é o rito de crédito próprio do contribuinte e ',0),
 ('não é a base do DCF',1),
 (' — o encontro de contas mensal opera com o cliente já habilitado como titular de fração do crédito.',0)])

# --- Q6: resposta (vedação do §12 = rito comum, que não é o nosso) ---
rebuild(P[27], [
 ('Essa é a pergunta que define o produto — e a resposta é ',0), ('não',1),
 ('. A vedação do art. 74, §12, da Lei 9.430/96 alcança quem tenta compensar crédito alheio pelo ',0),
 ('rito comum',1), (' — que não é o rito do DCF. Aqui, antes de qualquer declaração de compensação, o cliente é ',0),
 ('formalmente habilitado no polo ativo',1),
 (' do processo de origem como titular de fração do crédito — ele compensa crédito ',0),
 ('do qual é titular',1),
 (' por habilitação, com assento constitucional expresso para créditos adquiridos de terceiros (CF, art. 100, §11 — EC 113/2021). A operação é o exercício de direito legalmente previsto (CF, art. 100, §11; CTN, arts. 156, II, 170 e 170-A), em procedimento administrativo regular.',0)])

# --- Q7: bullets de âncoras legais ---
rebuild(P[33], [
 ('CF/88, art. 100, §11 (EC 113/2021)',1),
 (' — o assento constitucional do encontro de contas: oferta de créditos líquidos e certos, próprios ou adquiridos de terceiros, decorrentes de decisões judiciais transitadas em julgado, para quitação de débitos perante a União. Regulamentação posterior: Decreto 11.249/2022, Portaria PGFN 10.826/2022 e atos correlatos.',0)])
rebuild(P[36], [
 ('CF/88, arts. 150, §6º e 195',1),
 (' — legalidade tributária e materialidade dos tributos compensáveis.',0)])

# --- Etapa 4 · prazo legal ---
rebuild(P[49], [
 ('4 · Prazo legal',1),
 (' — a RFB tem até 1 ano para examinar o pedido de ressarcimento, na forma da legislação do processo administrativo fiscal. Durante o prazo, o crédito segue atualizado pela SELIC.',0)])

# --- Objeções ---
rebuild(P[81], [
 ('RFB não conclui a análise em 12 meses',1),
 (' — homologação tácita ao fim do prazo legal; crédito atualizado pela SELIC; cabível MS para forçar instauração — decisão de TRF (abr/2026) fixou 15 dias sob multa diária.',0)])
rebuild(P[84], [
 ('Alegação de “elisão abusiva”',1),
 (' — a operação exerce direito previsto na Constituição e na lei (CF, art. 100, §11 — EC 113/2021; CTN, art. 170), com crédito judicial; não há simulação, dissimulação ou fraude.',0)])
rebuild(P[89], [
 ('Sim.',1), (' É o exercício de direito expressamente previsto — ',0),
 ('CF, art. 100, §11 (EC 113/2021); CTN, arts. 156, II, 170 e 170-A',1),
 (' — com crédito judicial transitado em julgado, em procedimento 100% administrativo dentro da Receita Federal. Cada compensação gera protocolo individualizado; tudo é registrado e rastreável.',0)])

# --- p95: troca cirúrgica dentro do run (preserva negritos originais) ---
done95 = False
for r in P[95].runs:
    if 'art. 74; PER/DCOMP' in r.text:
        r.text = r.text.replace('a lei define o rito (art. 74; PER/DCOMP; homologação)',
                                'a norma define o rito (encontro de contas mensal; declarações de compensação; homologação)')
        done95 = True
assert done95, 'p95 não encontrado em run único'

# --- Regra de ouro ---
rebuild(P[101], [
 ('A âncora é a EC 113/2021 (CF, art. 100, §11)',1),
 (' — não apresente a operação como a compensação comum da Lei 9.430/96: o rito do art. 74 é de crédito próprio; o encontro de contas do DCF tem assento constitucional próprio e admite créditos adquiridos de terceiros.',0)])

# --- Glossário ---
rebuild(P[112], [
 ('PER/DCOMP (Dcomp):',1),
 (' Pedido Eletrônico de Restituição, Ressarcimento ou Reembolso e Declaração de Compensação — a declaração eletrônica utilizada no encontro de contas mensal.',0)])
rebuild(P[115], [
 ('Homologação tácita:',1),
 (' efeito do decurso do prazo legal de 1 ano sem manifestação da RFB sobre o pedido, na forma da legislação do processo administrativo fiscal.',0)])

# --- Base normativa verificada ---
rebuild(P[127], [
 ('EC 113/2021 — CF, art. 100, §11',1),
 (' — o assento constitucional do encontro de contas: créditos próprios ou adquiridos de terceiros, decorrentes de decisões transitadas em julgado, para quitação de débitos perante a União.',0)])
rebuild(P[130], [
 ('CF/88, arts. 150, §6º e 195',1),
 (' — legalidade tributária e materialidade dos tributos compensáveis.',0)])
rebuild(P[131], [
 ('Decreto nº 11.249/2022, Portaria PGFN nº 10.826/2022 e IN RFB nº 2.055/2021',1),
 (' — regulamentação posterior à EC 113/2021: disciplina operacional do encontro de contas e do processamento administrativo federal.',0)])

# --- Tabela "Não confundir" (tbl4) ---
t = d.tables[4]
def set_cell(cell, segs):
    p = cell.paragraphs[0]
    rebuild(p, segs)

set_cell(t.rows[2].cells[0], [('Compensação comum da Lei 9.430/96 (art. 74)',1)])
set_cell(t.rows[2].cells[1], [('Rito ordinário de compensação de crédito ',0),('próprio',1),(' do contribuinte via PER/DCOMP; o §12 veda compensar crédito de terceiro por essa via.',0)])
set_cell(t.rows[2].cells[2], [('O DCF não corre pelo rito comum do art. 74 — seu assento é o ',0),('encontro de contas da EC 113/2021 (CF, art. 100, §11)',1),(', que admite créditos próprios ou adquiridos de terceiros, com o cliente habilitado como titular de fração.',0)])
set_cell(t.rows[4].cells[2], [('O DCF exerce direito previsto na Constituição e na lei (CF, art. 100, §11 — EC 113/2021; CTN, art. 170), com crédito transitado em julgado e escrituração aceita pelo juízo — sem simulação. O Tema 736/STF protege o exercício do direito creditório.',0)])

d.save(OUT)
print('OK →', OUT)
