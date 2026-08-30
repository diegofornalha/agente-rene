// Strings PT-BR do canal WhatsApp — extraídas de whatsapp-channel.js sem
// alteração de conteúdo (regressão: saída byte-idêntica à versão hardcoded).
module.exports = {
  code: 'pt-BR',

  ttsSummary: [
    'Comece sua resposta com a linha exata: "[RESUMO]: <1-2 frases em PT-BR, naturais, resumindo o que você responderá>".',
    'Depois, deixe uma linha em branco.',
    'Em seguida, escreva a resposta completa em texto normal.',
    'Escreva SEMPRE em português do Brasil com acentuação e ortografia corretas — acentos, til e cedilha são obrigatórios e essenciais para o TTS pronunciar bem (ex.: "você", "está", "é", "não", "português", "ação"). Nunca escreva sem acento, mesmo que mensagens anteriores no histórico apareçam sem acentuação.',
    'O resumo será sintetizado em áudio e enviado antes do texto. Por isso ele precisa ser curto, falado, sem markdown nem código.',
  ].join(' '),

  ttsFull: [
    'Escreva sua resposta em texto normal, PT-BR, tom natural e falado.',
    'Escreva SEMPRE em português do Brasil com acentuação e ortografia corretas — acentos, til e cedilha são obrigatórios e essenciais para o TTS pronunciar bem (ex.: "você", "está", "é", "não", "português", "ação"). Nunca escreva sem acento, mesmo que mensagens anteriores no histórico apareçam sem acentuação.',
    'Evite markdown, blocos de código, tabelas e formatação visual — a resposta será convertida inteiramente em áudio.',
    'Seja direto mas completo.',
  ].join(' '),

  ttsAudioOnly: [
    'Sua resposta será convertida INTEIRAMENTE em áudio e enviada como mensagem de voz no WhatsApp.',
    'Escreva SEMPRE em português do Brasil com acentuação e ortografia corretas — acentos, til e cedilha são obrigatórios para o TTS pronunciar bem (ex.: "você", "está", "é", "não", "ação"). Nunca escreva sem acento.',
    'Escreva em linguagem natural e conversacional, como uma pessoa falando. Sem markdown, blocos de código, tabelas ou formatação visual.',
    'NÃO dite dados técnicos no meio da fala: números longos, valores exatos com centavos, IPs, códigos, identificadores e URLs ficam robóticos quando falados. Na fala, mencione-os de forma natural e arredondada (ex.: "cerca de mil e quinhentos reais", "te passo o IP e os dados exatos por escrito").',
    'Se houver dados técnicos precisos que o usuário precise ter (números ou valores exatos, códigos, IPs, URLs/links), coloque-os ao FINAL da mensagem, depois de uma linha que comece exatamente com "📋 Detalhes:". Tudo antes dessa linha vira áudio; o bloco de Detalhes é enviado como texto e não é falado. Se não houver dados precisos a destacar, não inclua o bloco.',
  ].join(' '),

  videoDescribePrompt: (frameCount) =>
    `Descreva o conteúdo visual deste vídeo em português (${frameCount} frames extraídos). Seja conciso: no máximo 3-4 frases cobrindo o que aparece, o cenário e qualquer texto visível.`,

  imageDescribePrompt:
    'Descreva esta imagem em português, de forma concisa (máximo 3-4 frases). Inclua qualquer texto visível na imagem.',

  imageDescribeShortPrompt:
    'Descreva esta imagem em português, de forma concisa (máximo 2 frases).',

  // Fragmentos do heartbeat de progresso (_summarizeStepsViaClaude).
  steps: {
    analyzing: (n) => `Analisando contexto — ${n} bloco${n > 1 ? 's' : ''} de raciocínio processado${n > 1 ? 's' : ''}.`,
    processing: (n) => `Processando ${n} step${n > 1 ? 's' : ''} do pipeline.`,
    read: (n) => n === 1 ? 'consultei 1 arquivo' : `li ${n} arquivos`,
    web: (n) => n === 1 ? 'pesquisei na web' : `fiz ${n} buscas na web`,
    edit: (n) => n === 1 ? 'fiz 1 alteração' : `fiz ${n} alterações`,
    bash: (n) => n === 1 ? 'rodei um comando' : `executei ${n} comandos`,
    task: (n) => `deleguei ${n} subtarefa${n > 1 ? 's' : ''}`,
    nowBash: (w) => w ? `, rodando \`${w}\` agora` : ', executando comandos',
    nowEdit: (w) => w ? `, editando \`${w}\` agora` : ', editando arquivos',
    nowRead: ', ainda consultando código',
    nowWeb: ', buscando na web',
    nowTask: ', com subagente trabalhando',
    // (corrige typo do original, que gerava "operaçãoões" no plural)
    executingOps: (n, names) => `Executando ${n} operaç${n > 1 ? 'ões' : 'ão'}: ${names}.`,
    already: (parts, now) => `Já ${parts.join(' e ')}${now}.`,
  },
};
