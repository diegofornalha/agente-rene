'use strict';
// sock-ref.js — referência compartilhada ao socket Baileys ativo.
//
// O socket é criado (e recriado a cada reconnect) dentro de start() no
// whatsapp-channel.js. Módulos extraídos (tts, outbound, media-inbound,
// reply-delivery) não podem fechar sobre o `let sock` de lá — leem daqui.
// O core é o ÚNICO escritor (setSock/setReady).

let _sock = null;
let _ready = false;

module.exports = {
  getSock: () => _sock,
  setSock: (s) => { _sock = s; },
  isReady: () => _ready,
  setReady: (r) => { _ready = !!r; },
};
