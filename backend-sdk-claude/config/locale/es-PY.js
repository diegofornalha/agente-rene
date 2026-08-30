// Strings es-PY (español paraguayo, voseo) do canal WhatsApp.
// Mesma estrutura de pt-BR.js — usada quando AGENT_LOCALE=es-PY.
module.exports = {
  code: 'es-PY',

  ttsSummary: [
    'Comenzá tu respuesta con la línea exacta: "[RESUMEN]: <1-2 frases en español, naturales, resumiendo lo que vas a responder>".',
    'Después, dejá una línea en blanco.',
    'A continuación, escribí la respuesta completa en texto normal.',
    'Escribí SIEMPRE en español con acentuación y ortografía correctas — tildes y eñes son obligatorias y esenciales para que el TTS pronuncie bien (ej.: "vos podés", "está", "más", "mañana", "señal"). Nunca escribas sin tildes, aunque mensajes anteriores del historial aparezcan sin acentuación.',
    'Usá el voseo paraguayo natural ("vos podés", "tenés", "querés") — nunca "tú puedes".',
    'El resumen será sintetizado en audio y enviado antes del texto. Por eso tiene que ser corto, hablado, sin markdown ni código.',
  ].join(' '),

  ttsFull: [
    'Escribí tu respuesta en texto normal, en español, con tono natural y hablado.',
    'Escribí SIEMPRE en español con acentuación y ortografía correctas — tildes y eñes son obligatorias y esenciales para que el TTS pronuncie bien (ej.: "vos podés", "está", "más", "mañana", "señal"). Nunca escribas sin tildes, aunque mensajes anteriores del historial aparezcan sin acentuación.',
    'Usá el voseo paraguayo natural ("vos podés", "tenés", "querés") — nunca "tú puedes".',
    'Evitá markdown, bloques de código, tablas y formato visual — la respuesta será convertida enteramente en audio.',
    'Sé directo pero completo.',
  ].join(' '),

  ttsAudioOnly: [
    'Tu respuesta será convertida ENTERAMENTE en audio y enviada como mensaje de voz en WhatsApp.',
    'Escribí SIEMPRE en español con acentuación y ortografía correctas — tildes y eñes son obligatorias para que el TTS pronuncie bien (ej.: "vos podés", "está", "más", "mañana"). Nunca escribas sin tildes.',
    'Usá el voseo paraguayo natural ("vos podés", "tenés", "querés") — nunca "tú puedes".',
    'Escribí en lenguaje natural y conversacional, como una persona hablando. Sin markdown, bloques de código, tablas ni formato visual.',
    'NO dictes datos técnicos en medio del habla: números largos, valores exactos con céntimos, IPs, códigos, identificadores y URLs suenan robóticos cuando se hablan. En el habla, mencionalos de forma natural y redondeada (ej.: "unos trescientos millones de guaraníes", "te paso los datos exactos por escrito").',
    'Si hay datos técnicos precisos que el usuario necesite (números o valores exactos, códigos, IPs, URLs/links), ponelos al FINAL del mensaje, después de una línea que empiece exactamente con "📋 Detalles:". Todo lo anterior a esa línea se convierte en audio; el bloque de Detalles se envía como texto y no se habla. Si no hay datos precisos que destacar, no incluyas el bloque.',
  ].join(' '),

  videoDescribePrompt: (frameCount) =>
    `Describí el contenido visual de este video en español (${frameCount} frames extraídos). Sé conciso: máximo 3-4 frases cubriendo lo que aparece, el escenario y cualquier texto visible.`,

  imageDescribePrompt:
    'Describí esta imagen en español, de forma concisa (máximo 3-4 frases). Incluí cualquier texto visible en la imagen.',

  imageDescribeShortPrompt:
    'Describí esta imagen en español, de forma concisa (máximo 2 frases).',

  // Fragmentos del heartbeat de progreso (_summarizeStepsViaClaude).
  steps: {
    analyzing: (n) => `Analizando contexto — ${n} bloque${n > 1 ? 's' : ''} de razonamiento procesado${n > 1 ? 's' : ''}.`,
    processing: (n) => `Procesando ${n} paso${n > 1 ? 's' : ''} del pipeline.`,
    read: (n) => n === 1 ? 'consulté 1 archivo' : `leí ${n} archivos`,
    web: (n) => n === 1 ? 'busqué en la web' : `hice ${n} búsquedas en la web`,
    edit: (n) => n === 1 ? 'hice 1 cambio' : `hice ${n} cambios`,
    bash: (n) => n === 1 ? 'ejecuté un comando' : `ejecuté ${n} comandos`,
    task: (n) => `delegué ${n} subtarea${n > 1 ? 's' : ''}`,
    nowBash: (w) => w ? `, ejecutando \`${w}\` ahora` : ', ejecutando comandos',
    nowEdit: (w) => w ? `, editando \`${w}\` ahora` : ', editando archivos',
    nowRead: ', todavía consultando código',
    nowWeb: ', buscando en la web',
    nowTask: ', con subagente trabajando',
    executingOps: (n, names) => `Ejecutando ${n} operaci${n > 1 ? 'ones' : 'ón'}: ${names}.`,
    already: (parts, now) => `Ya ${parts.join(' y ')}${now}.`,
  },
};
