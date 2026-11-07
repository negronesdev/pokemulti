// Preload das lives da Twitch (só elas; a Kick não usa). Roda antes de qualquer script da página.
//
// O FORMATO DO VÍDEO (06/11/2026). O player da Twitch escolhe o formato pelo que o navegador diz decodificar, e o
// Chromium do app diz que decodifica AV1 (no processador: a placa deste PC, GTX 1050 Ti, não tem AV1) e HEVC. Medido
// em 06/11: a live de rodil (sem 160p, só 720p) custava sozinha 1,3 a 1,4 núcleo nas threads Media e CodecWorker,
// que decodificam o vídeo no processador, mais o envio de cada quadro para a placa; as outras lives, em H.264, a placa
// decodifica (o motor de vídeo da GPU estava em uso) e custam ~5%. Aqui a página passa a dizer que não decodifica AV1
// nem HEVC, e o player fica no H.264. `__pkmCodecs` guarda os formatos que o player abriu (o registro das lives mostra).
// Testado isolado (scratchpad\teste-codec): o 1º script da página já vê a regra, ela continua ao recarregar, e o H.264
// e o áudio seguem aceitos. Não alcança MediaSource dentro de worker; se a Twitch decidir o formato lá, o registro
// continua mostrando av01.
const { webFrame } = require('electron');
webFrame.executeJavaScript(`(() => {
  if (window.__pkmCodecGuarda) return;
  window.__pkmCodecGuarda = true;
  const ruim = t => /\\b(av01|av1|hev1|hvc1|hevc|dvh1|dvhe)\\b/i.test(String(t || ''));
  for (const nome of ['MediaSource', 'ManagedMediaSource']) {
    const M = window[nome];
    if (!M || typeof M.isTypeSupported !== 'function') continue;
    const orig = M.isTypeSupported.bind(M);
    try { Object.defineProperty(M, 'isTypeSupported', { value: t => !ruim(t) && orig(t), configurable: true, writable: true }); } catch (e) {}
    const add = M.prototype && M.prototype.addSourceBuffer;
    if (add) M.prototype.addSourceBuffer = function (t) {
      (window.__pkmCodecs = window.__pkmCodecs || []).push(String(t));
      if (window.__pkmCodecs.length > 20) window.__pkmCodecs.shift();
      return add.call(this, t);
    };
  }
  const cpt = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (t) { return ruim(t) ? '' : cpt.call(this, t); };
  const mc = navigator.mediaCapabilities;
  if (mc && typeof mc.decodingInfo === 'function') {
    const orig = mc.decodingInfo.bind(mc);
    mc.decodingInfo = cfg => ruim(cfg && cfg.video && cfg.video.contentType)
      ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false }) : orig(cfg);
  }
})();`);
