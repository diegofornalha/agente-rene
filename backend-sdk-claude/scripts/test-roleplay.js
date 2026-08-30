// Teste E2E manual do role-play: start -> 2 turnos -> end -> evaluate -> sync CRM.
// Exercita claude-query de verdade. Rodar: node scripts/test-roleplay.js
require('dotenv').config();
const rp = require('../services/roleplay');

(async () => {
  console.log('== START (persona: desconfiado) ==');
  const s = await rp.start({ consultor: 'teste-diego', personaId: 'desconfiado', modalidade: 'r1' });
  console.log(JSON.stringify(s, null, 2));
  if (!s.ok) process.exit(1);
  const id = s.sessaoId;

  const falas = [
    'Bom dia! Sou consultor da Lucro Ativo. Entendo perfeitamente sua desconfiança — o mercado tá cheio de golpe de crédito falso, gente presa. Justamente por isso a gente opera diferente: crédito com origem em processo transitado em julgado, escritura pública em cartório, apólice da Berkley e ofício de não-sinistralidade. Posso te mostrar a documentação toda?',
    'Claro. Te mando agora a tela de uma homologação real de um cliente, o parecer jurídico e a apólice. E o custo de cartório é da nossa operação, você não paga nada antecipado — a gente executa, seu contador valida, e só depois você paga. Faz sentido a gente marcar uma reunião técnica com o Dr. Lucas pra ele te mostrar caso a caso?',
  ];
  for (const f of falas) {
    console.log('\n== TURN (consultor) ==\n' + f);
    const t = await rp.turn({ sessaoId: id, mensagem: f });
    console.log('LEAD:', t.ok ? t.lead : JSON.stringify(t));
    if (!t.ok) process.exit(1);
  }

  console.log('\n== END ==');
  console.log(JSON.stringify(rp.end({ sessaoId: id }), null, 2));

  console.log('\n== EVALUATE (já sincroniza no CRM automaticamente) ==');
  const ev = await rp.evaluate({ sessaoId: id });
  console.log(JSON.stringify(ev, null, 2));
  console.log('\ncrmSync:', JSON.stringify(ev.crmSync || null));
})().catch((e) => { console.error('ERRO:', e); process.exit(1); });
