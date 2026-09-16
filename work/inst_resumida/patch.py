# -*- coding: utf-8 -*-
import io, re
p='deck.html'
h=io.open(p,encoding='utf-8').read()

# ---------- 1) SEGURANCA: tom corporativo ----------
old_title='<h2 class="title" style="color:#fff">Operação estruturada não é esquema</h2>'
new_title='<h2 class="title" style="color:#fff">Segurança jurídica construída em camadas</h2>'
assert old_title in h
h=h.replace(old_title,new_title)

h=h.replace('<div class="sub" style="color:#c8cdf0">O mercado tem visto autuações. Elas atingem uma prática específica — e é exatamente a que não praticamos.</div>',
            '<div class="sub" style="color:#c8cdf0">Quatro pilares que sustentam cada operação — do enquadramento inicial à execução mensal.</div>')

h=h.replace('<div class="s"><h4>Titularidade antes do uso</h4><p>O crédito é transferido e habilitado <b>em nome do cliente</b> antes de qualquer compensação. Não se utiliza crédito alheio.</p></div>',
            '<div class="s"><h4>Titularidade prévia</h4><p>A cessão formal e a habilitação do cliente como <b>titular do direito creditório</b> precedem qualquer compensação — a operação parte de um direito próprio.</p></div>')

h=h.replace('<div class="s"><h4>Ativo maduro</h4><p>Direito creditório reconhecido em <b>decisão transitada em julgado</b> — não laudo, não expectativa, não decisão pendente.</p></div>',
            '<div class="s"><h4>Ativo consolidado</h4><p>Direito creditório reconhecido em <b>decisão transitada em julgado</b>, com liquidez e certeza já definidas na esfera judicial.</p></div>')

h=h.replace('<div class="s"><h4>Dentro do sistema</h4><p>Compensações protocoladas na <b>Receita Federal via PER/DCOMP</b>. Nada informal, nada paralelo, tudo rastreável.</p></div>',
            '<div class="s"><h4>Rastreabilidade integral</h4><p>Compensações protocoladas na <b>Receita Federal, via PER/DCOMP</b>, com trilha documental completa de cada competência.</p></div>')

h=h.replace('<div class="s"><h4>Responsabilidade profissional</h4><p>Operação conduzida por <b>sociedade de advogados</b>, com parecer de viabilidade caso a caso — inclusive para dizer não.</p></div>',
            '<div class="s"><h4>Responsabilidade profissional</h4><p>Operação conduzida por <b>sociedade de advogados</b>, com parecer de viabilidade individual, sigilo profissional e acompanhamento contínuo.</p></div>')

h=h.replace('O enquadramento de cada operação é objeto de análise técnica individual.',
            'O enquadramento de cada operação é objeto de análise técnica individual, formalizada antes de qualquer implementação.')

# ---------- 2) CONTATO EM BRANCO ----------
old_sign='''    <div class="sign">
      <div class="b"><b>L. Santos Sociedade Individual de Advocacia</b><span>CNPJ 30.444.414/0001-70</span><span>Rua Garibaldi, 2.795 · Alto da Boa Vista · Ribeirão Preto/SP</span></div>
      <div class="b"><b>Contato</b><span>contato@meulucroativo.com.br</span><span>meulucroativo.com.br · @meulucroativo</span></div>
    </div>'''
assert old_sign in h
new_sign='''    <div class="sign">
      <div class="b"><b>&nbsp;</b><span class="ln"></span><span class="ln"></span></div>
      <div class="b"><b>&nbsp;</b><span class="ln"></span><span class="ln"></span></div>
    </div>'''
h=h.replace(old_sign,new_sign)
h=h.replace('.sign .b span{font-size:16px;color:var(--grey);line-height:1.4;display:block}',
            '.sign .b span{font-size:16px;color:var(--grey);line-height:1.4;display:block}\n  .sign .b span.ln{border-bottom:1px solid #d7dbea;height:22px;margin-top:8px}')

# ---------- 3) NOVOS SLIDES GS ----------
gs = '''
<!-- 8 · ECOSSISTEMA GRUPO STUDIO -->
<div class="slide navy">
  <div class="topbar"><div class="tag" style="color:#fff"><span class="n">07</span>ECOSSISTEMA</div></div>
  <div class="rule" style="background:linear-gradient(90deg,#fff 0 70%,var(--gold) 70% 100%)"></div>
  <div class="cobrand" style="top:32px"><img src="gs_branco.png" alt="Grupo Studio" style="height:30px"></div>
  <div class="content">
    <div class="z">
      <h2 class="title" style="color:#fff">Uma aliança que amplia o alcance da assessoria</h2>
      <div class="sub" style="color:#c8cdf0">A Lucro Ativo integra o ecossistema do <b style="color:#fff">Grupo Studio</b>, somando às teses tributárias proprietárias um portfólio consolidado de soluções fiscais, financeiras e de conformidade.</div>
      <div class="stats3">
        <div class="stat" style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25)"><div class="v">+35 mil</div><div class="l">empresas atendidas pelo ecossistema</div></div>
        <div class="stat" style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25)"><div class="v">+500</div><div class="l">atestados de capacidade técnica emitidos por clientes</div></div>
        <div class="stat" style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25)"><div class="v">360°</div><div class="l">diagnóstico do cliente em plataforma própria</div></div>
      </div>
      <div class="askbox" style="margin-top:24px">
        <h4>O que isso significa para a sua empresa</h4>
        <ul>
          <li><b>Diagnóstico completo</b> — a análise não se limita ao tributo: mapeia energia, capital, riscos e conformidade.</li>
          <li><b>Um único interlocutor</b> — a Lucro Ativo conduz a relação e responde pela execução em todas as frentes.</li>
          <li><b>Lastro de experiência</b> — soluções já aplicadas em escala, com histórico documentado por segmento.</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="foot" style="background:transparent;color:#aab1e8"><span class="brand" style="color:#fff">LUCRO ATIVO · COMPLIANCE FISCAL TRIBUTÁRIO</span><span>08</span></div>
</div>

<!-- 9 · VERTICAIS COMPLEMENTARES -->
<div class="slide">
  <div class="topbar"><div class="tag"><span class="n">08</span>SOLUÇÕES COMPLEMENTARES</div></div>
  <div class="cobrand"><img src="la_logo_navy.png" alt="Lucro Ativo"><span class="sep"></span><img src="gs_grafite.png" alt="Grupo Studio"></div>
  <div class="rule"></div>
  <div class="content">
    <div class="ghost">08</div>
    <div class="z">
      <h2 class="title">Cinco verticais além da tese tributária</h2>
      <div class="sub">Disponibilizadas pelo ecossistema Grupo Studio, com condução da Lucro Ativo.</div>
      <div class="grid3">
        <div class="card"><div class="mb"></div><h3>Studio Fiscal</h3><p>Planejamento e revisão de apuração, captura de créditos não aproveitados e revisão das bases previdenciárias sobre a folha.</p></div>
        <div class="card"><div class="mb"></div><h3>Studio Energy</h3><p>Migração ao Mercado Livre, auditoria da fatura de energia e projetos de geração — redução estrutural de um custo relevante.</p></div>
        <div class="card"><div class="mb"></div><h3>Studio Bank</h3><p>Operações estruturadas, captação via nota comercial e garantias sob medida — alternativas ao crédito bancário tradicional.</p></div>
        <div class="card"><div class="mb"></div><h3>Seguros &amp; Agro</h3><p>Gestão de risco para o agronegócio: seguro por cultura, proteção de ativos rurais e reestruturação de dívidas do produtor.</p></div>
        <div class="card"><div class="mb"></div><h3>LGPD &amp; Governança</h3><p>Adequação à Lei Geral de Proteção de Dados e estruturação de governança corporativa e societária.</p></div>
        <div class="card gold"><div class="mb"></div><h3>Condução Lucro Ativo</h3><p>Independentemente da vertical acionada, o <b>diagnóstico, a modelagem e o acompanhamento</b> permanecem sob a mesma responsabilidade técnica.</p></div>
      </div>
      <div class="gsnote"><b>Como é apresentado:</b> a frente complementar só entra em pauta quando o diagnóstico identifica ganho concreto — não há oferta cruzada sem fundamento técnico.</div>
    </div>
  </div>
  <div class="foot"><span class="brand">LUCRO ATIVO · COMPLIANCE FISCAL TRIBUTÁRIO</span><span>09</span></div>
</div>
'''
anchor='<!-- 8 · METODOLOGIA -->'
assert anchor in h
h=h.replace(anchor, gs.strip()+'\n\n<!-- 10 · METODOLOGIA -->')

# ---------- 4) RENUMERAR os slides seguintes ----------
h=h.replace('<div class="tag" style="color:#fff"><span class="n">07</span>METODOLOGIA</div>','<div class="tag" style="color:#fff"><span class="n">09</span>METODOLOGIA</div>')
h=h.replace('<div class="tag" style="color:#fff"><span class="n">08</span>SEGURANÇA JURÍDICA</div>','<div class="tag" style="color:#fff"><span class="n">10</span>ESTRUTURA E RESPALDO</div>')
h=h.replace('<div class="tag"><span class="n">09</span>PERFIL DE ATENDIMENTO</div>','<div class="tag"><span class="n">11</span>PERFIL DE ATENDIMENTO</div>')
h=h.replace('<div class="ghost">09</div>','<div class="ghost">11</div>')

# rodapes: de tras pra frente
h=h.replace('<span>11</span></div>\n</div>\n\n</body>','<span>13</span></div>\n</div>\n\n</body>')
h=h.replace('<span class="brand">LUCRO ATIVO · COMPLIANCE FISCAL TRIBUTÁRIO</span><span>10</span>','<span class="brand">LUCRO ATIVO · COMPLIANCE FISCAL TRIBUTÁRIO</span><span>12</span>')
h=h.replace('<span class="brand" style="color:#fff">LUCRO ATIVO · COMPLIANCE FISCAL TRIBUTÁRIO</span><span>09</span>','<span class="brand" style="color:#fff">LUCRO ATIVO · COMPLIANCE FISCAL TRIBUTÁRIO</span><span>11</span>')
h=h.replace('<span class="brand" style="color:#fff">LUCRO ATIVO · COMPLIANCE FISCAL TRIBUTÁRIO</span><span>08</span>','<span class="brand" style="color:#fff">LUCRO ATIVO · COMPLIANCE FISCAL TRIBUTÁRIO</span><span>10</span>')

io.open(p,'w',encoding='utf-8').write(h)
print('ok', h.count('class="slide'))
