// PokeMulti — 4 contas em abas internas, cada uma com sessão (cookies/localStorage) isolada.
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, Menu, dialog, clipboard, Notification, crashReporter, screen, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const licenca = require('./licenca.js');
const PR = require('./precificador.js'); // o 💲 Precificador (preço de um pokémon em gemas)

// ---------- Pasta de dados em Documentos ----------
// Os dados (logins, lives, config) ficam em Documentos\PokeMulti-dados, e não no AppData.
// Descoberto em 20/10/2026: o que um app aberto pelo Claude grava no AppData fica numa camada
// do sandbox dele, que o app aberto normalmente (dois cliques) não enxerga — os logins "sumiam".
// Documentos não tem esse problema, e a pasta também sobrevive a um novo empacotamento.
{
  const nome = app.getName() === 'pokeidle-multi' ? 'PokeidleMulti-dados' : `${app.getName()}-dados`;
  const dados = path.join(app.getPath('documents'), nome);
  try {
    fs.mkdirSync(dados, { recursive: true });
    app.setPath('userData', dados);
    app.setPath('crashDumps', path.join(dados, 'Crashpad'));
  } catch {}
}

// ---------- Diagnóstico: por que o app fechou? ----------
// Em 20/10/2026 o app saiu sozinho sem deixar rastro no Windows. Daqui em diante: o arquivo de
// travamento do Electron fica no PC (Crashpad, na pasta de dados; nada é enviado) e o app.log
// registra abertura, fechamento, quedas de processos com o motivo, erros e a memória.
crashReporter.start({ uploadToServer: false });
const appLog = msg => {
  try {
    const f = path.join(app.getPath('userData'), 'app.log');
    // Não deixa o registro crescer sem fim: passou de 2 MB, recomeça
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.old'); } catch {}
    fs.appendFileSync(f, `${new Date().toLocaleString('pt-BR')}  ${msg}\n`);
  } catch {}
};
process.on('uncaughtException', err => appLog(`ERRO não tratado: ${err?.stack || err}`));
process.on('unhandledRejection', err => appLog(`ERRO de promessa: ${err?.stack || err}`));
app.on('child-process-gone', (_e, d) => appLog(`processo caiu: tipo=${d.type} motivo=${d.reason} código=${d.exitCode}${d.name ? ` (${d.name})` : ''}`));
app.on('render-process-gone', (_e, wc, d) => {
  let url = ''; try { url = new URL(wc.getURL()).host + new URL(wc.getURL()).pathname; } catch {}
  appLog(`página caiu: ${url} motivo=${d.reason} código=${d.exitCode}`);
});
app.on('before-quit', () => appLog('fechando (before-quit)'));
app.on('will-quit', () => appLog('saiu (will-quit)'));

const GAME_URL = 'https://pokeidle.io/app';
const TOTAL = 4;
const BAR_H = 44;

// ---------- Config persistente (nomes das abas, opções) ----------
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
const defaults = {
  names: ['Conta 1', 'Conta 2', 'Conta 3', 'Conta 4'],
  muteHidden: true,        // silencia abas que não estão visíveis
  throttleHidden: false,   // economia extra: deixa o Chromium "desacelerar" abas ocultas
  ultra: false,            // ultra leve: a economia extra + movimento reduzido e faxina de memória
  active: 0,
  grid: false,             // modo grade: as 4 contas visíveis ao mesmo tempo (2x2)
  gridZoom: 0.6,           // zoom do jogo dentro de cada quadro no modo grade
  gridFps: 15,             // limite de quadros/s das contas NÃO selecionadas no modo grade (0 = sem limite)
  fpsVista: 30,            // limite de quadros/s da conta à vista (0 = sem limite); 30 desde 06/11/2026, pedido do usuário
  // Painel da Twitch: por conta, as lives abertas ({ login, video }) e qual está à vista
  twitch: { open: false, lista: true, canais: [[], [], [], []], ativo: ['', '', '', ''] },
  caixa: { ligado: false },
  bounds: { width: 1280, height: 820 }
};
let cfg = { ...defaults };
function loadCfg() {
  try { cfg = { ...defaults, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; } catch { cfg = { ...defaults }; }
}
function saveCfg() {
  try { fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2)); } catch {}
}

// ---------- Otimizações globais do Chromium ----------
// CalculateNativeWinOcclusion: não "congela" ao minimizar a janela.
// IntensiveWakeUpThrottling: página escondida e desacelerada há 5+ min tem os timers acordados só 1x por minuto.
// Teste isolado de 26/10/2026, mesmo com WebSocket aberto: um setInterval de 25 s (o ping do jogo) passou a sair
// a cada 48 e 60 s — e o servidor derruba quem fica ~60 s calado. Sem essa trava, segue a cada 25 s.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('enable-features', 'BackForwardCacheMemoryControls');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');

let win, bar, twbar;
const views = [];
let active = 0;

const TW_W = 380;    // largura do painel da Twitch
// Altura da lista de lives no topo do painel: cabeçalho + uma linha por live (até ~45% do painel)
const TWHEAD_H = 40, TWROW_H = 30;
function twbarHeight(area) {
  const n = cfg.twitch.canais[active]?.length ?? 0;
  if (!cfg.twitch.lista || !n) return TWHEAD_H;
  return TWHEAD_H + Math.min(n * TWROW_H + 6, Math.max(TWROW_H * 2, Math.floor(area * 0.45)));
}

function layout() {
  if (!win) return;
  const [W, h] = win.getContentSize();
  bar.setBounds({ x: 0, y: 0, width: W, height: BAR_H });
  const area = Math.max(0, h - BAR_H);
  // Com o painel da Twitch aberto, o jogo perde a faixa da direita
  const twOpen = cfg.twitch.open;
  const w = twOpen ? Math.max(200, W - TW_W) : W;
  if (twbar) {
    const th = twbarHeight(area);
    twbar.setVisible(twOpen);
    twbar.setBounds({ x: w, y: BAR_H, width: W - w, height: th });
    const box = { x: w, y: BAR_H + th, width: W - w, height: Math.max(0, area - th) };
    // A live da Twitch com vídeo que não está à vista, e a do "ouvir", ficam "visíveis" FORA da janela: o player da
    // Twitch não toca escondido, mas toca assim, sem aparecer na tela. No tamanho de uma janela normal: estreita, a
    // página esconde o chat, e é junto dele que ficam os pontos do canal.
    const fora = { x: W + 50, y: 0, width: 1100, height: 720 };
    twViews.forEach((m, i) => m.forEach((v, id) => v.setBounds(tocaFora(i, id) ? fora : box)));
  }
  if (cfg.grid) {
    // 2x2 com uma linha fina entre os quadros
    const gap = 2;
    const cw = Math.floor((w - gap) / 2), ch = Math.floor((area - gap) / 2);
    views.forEach((v, i) => v.setBounds({
      x: (i % 2) * (cw + gap),
      y: BAR_H + Math.floor(i / 2) * (ch + gap),
      width: cw, height: ch
    }));
  } else {
    views.forEach(v => v.setBounds({ x: 0, y: BAR_H, width: w, height: area }));
  }
}

function applyZoom(wc) {
  if (!wc.isDestroyed()) wc.setZoomFactor(cfg.grid ? cfg.gridZoom : 1);
}

// Limite de quadros por segundo: troca o requestAnimationFrame da página por um que só deixa
// passar N quadros por segundo. Todos os callbacks do mesmo quadro rodam juntos; os de quadros
// pulados esperam o próximo liberado. Só a animação fica menos fluida, a caçada é no servidor.
const FPS_SCRIPT = `(() => {
  if (window.__pkmFps) return;
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const map = new Map();
  let seq = 0, last = -1;
  window.__pkmFps = { limit: 0 };
  window.requestAnimationFrame = cb => {
    const id = ++seq;
    const run = ts => {
      const lim = window.__pkmFps.limit;
      if (lim && ts !== last && ts - last < 1000 / lim - 2) { map.set(id, raf(run)); return; }
      last = ts;
      map.delete(id);
      cb(ts);
    };
    map.set(id, raf(run));
    return id;
  };
  window.cancelAnimationFrame = id => {
    const r = map.get(id);
    if (r != null) { caf(r); map.delete(id); }
  };
})();`;

// A conta à vista (e a selecionada na grade) desenha a 30 quadros/s desde 06/11/2026 (pedido do usuário depois da análise:
// com a janela à frente, ela era 0,5 a 0,8 núcleo e a placa de vídeo outros 0,55 a 0,75). O botão direito no 🍃 troca
// para sem limite. As não selecionadas na grade seguem o 🎞.
const fpsFor = i => (cfg.grid && i !== active ? cfg.gridFps : (cfg.fpsVista ?? 30));
function applyFps(wc, i) {
  if (wc.isDestroyed()) return;
  wc.executeJavaScript(`${FPS_SCRIPT}; window.__pkmFps.limit = ${Number(fpsFor(i)) || 0};`).catch(() => {});
}

// MOVIMENTO REDUZIDO (🍃 Ultra leve). O jogo já tem um modo para quem pede "menos movimento" ao sistema
// (112 blocos `prefers-reduced-motion` no CSS e checagens no código): desliga as animações infinitas que
// repintam a tela — chuva, brasas, brilhos, pulsos; 99 das 300 — e os números que rolam. O app liga esse modo
// só nas páginas do jogo, pelo debugger do Electron (o mesmo pedido do DevTools ao emular a mídia). Testado em
// 26/10/2026: vale só na view escolhida, segue valendo ao recarregar e ao navegar, e some ao desligar.
function aplicarMovimento(wc) {
  if (wc.isDestroyed()) return;
  const d = wc.debugger;
  try {
    if (!d.isAttached()) { if (!cfg.ultra) return; d.attach('1.3'); }
  } catch { return; }
  d.sendCommand('Emulation.setEmulatedMedia', { features: cfg.ultra ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [] })
    .then(() => { if (!cfg.ultra && d.isAttached()) d.detach(); })
    .catch(() => {});
}

// DESACELERAR (🐢 Economia extra; sempre ligado no 🍃 Ultra leve). Medido em 26/10/2026 num teste isolado
// (Electron 44): uma view escondida SEM isso continua desenhando 60 quadros/s, e com a janela minimizada a
// conta à vista também. Com isso, a página que ninguém vê — conta oculta, live escondida e tudo com o app
// minimizado — para de desenhar e os timers dela andam 1x por segundo (o socket do jogo segue igual, e o ping
// dele é a cada 25 s). A que está à vista desenha normal com ou sem, então vale para todas as contas.
const desacelera = () => cfg.throttleHidden || cfg.ultra;

function applyVisibility(focus = true) {
  layout();
  views.forEach((v, i) => {
    const visible = cfg.grid || i === active;
    v.setVisible(visible);
    const wc = v.webContents;
    // No modo grade, só a conta selecionada toca som
    wc.setAudioMuted(cfg.muteHidden ? i !== active : false);
    wc.setBackgroundThrottling(desacelera());
    applyZoom(wc);
    applyFps(wc, i);
  });
  applyTwitchVisibility();
  if (focus) views[active].webContents.focus();
  pushState();
}

function pushState() {
  if (!bar) return;
  bar.webContents.send('state', {
    active,
    names: cfg.names,
    muteHidden: cfg.muteHidden,
    throttleHidden: cfg.throttleHidden,
    ultra: cfg.ultra,
    grid: cfg.grid,
    gridZoom: cfg.gridZoom,
    gridFps: cfg.gridFps,
    fpsVista: cfg.fpsVista ?? 30,
    twitchOpen: cfg.twitch.open,
    twitchPausado: !!cfg.twitch.pausado,
    votos: votos.map(v => !!v?.pode),
    caixa: caixaNivelBarra(),
    loading: views.map(v => !v.webContents.isDestroyed() && v.webContents.isLoading()),
    mem: null
  });
  pushTwitchState();
}

// ---------- Painel de lives (Twitch e Kick) ----------
// O bônus do jogo vem de PONTOS DO CANAL nas duas plataformas (na Twitch desde 04/11/2026, jogo 1.400; antes era o
// vigia do servidor procurando o jogador no chat). Os pontos só caem para quem assiste com o vídeo rodando na página
// do canal, então a live abre com vídeo, sem som; só o chat fica como opção e não ganha nada. Cada conta usa a própria
// sessão, então cada uma pode ter a sua Twitch logada. Cada live tem um id: o login puro na Twitch (como sempre foi,
// para a config antiga continuar valendo) e "kick:<canal>" na Kick.
const twViews = [new Map(), new Map(), new Map(), new Map()]; // id -> WebContentsView

const isTwitchHost = host => /(^|\.)twitch\.tv$/.test(host);
const isKickHost = host => /(^|\.)kick\.com$/.test(host);
const canalId = c => (c.plat === 'kick' ? `kick:${c.login}` : c.login);

// Aceita "nome", "@nome", "kick:nome", "kick/nome" ou um link da Twitch/Kick
function lerCanal(raw) {
  let s = String(raw ?? '').trim(), plat = 'twitch';
  const pref = s.match(/^kick[:/](.+)$/i);
  if (pref) { plat = 'kick'; s = pref[1]; }
  else if (/^https?:/i.test(s) || /(twitch\.tv|kick\.com)/i.test(s)) {
    try {
      const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
      if (isKickHost(u.hostname)) plat = 'kick';
      else if (!isTwitchHost(u.hostname)) return null;
      const partes = u.pathname.split('/').filter(Boolean);
      s = (partes[0] === 'popout' ? partes[1] : partes[0]) ?? '';
    } catch { return null; }
  }
  s = s.replace(/^@/, '').toLowerCase();
  const ok = plat === 'kick' ? /^[a-z0-9_-]{2,30}$/.test(s) : /^[a-z0-9_]{3,25}$/.test(s);
  return ok ? { login: s, plat } : null;
}
function twUrl(c) {
  if (c.plat === 'kick') return c.video ? `https://kick.com/${c.login}` : `https://kick.com/popout/${c.login}/chat`;
  return c.video ? `https://www.twitch.tv/${c.login}` : `https://www.twitch.tv/popout/${c.login}/chat?popout=`;
}
const normCanal = c => {
  const p = lerCanal(c?.plat === 'kick' ? `kick:${c?.login}` : c?.login);
  return p ? { ...p, video: p.plat === 'kick' ? c?.video !== false : !!c?.video } : null;
};

function twCreate(i, c) {
  const part = `persist:conta${i + 1}`;
  // A Twitch tem um preload: a página diz que não decodifica AV1 nem HEVC (ver twitch-preload.js)
  const v = new WebContentsView({
    webPreferences: { partition: part, backgroundThrottling: false, spellcheck: false, contextIsolation: true, sandbox: true,
      ...(c.plat === 'twitch' ? { preload: path.join(__dirname, 'twitch-preload.js') } : {}) }
  });
  v.setBackgroundColor('#0e0e10');
  const wc = v.webContents;
  wc.setAudioMuted(true);
  // Login da Twitch/Kick e afins abrem em pop-up na mesma sessão; o resto vai para o navegador
  wc.setWindowOpenHandler(abrirPopupNaSessao(part));
  wc.on('render-process-gone', () => setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 3000));
  wc.on('before-input-event', (e, input) => handleKeys(e, input, false));
  // A live da Twitch que só está ali pelos pontos roda na menor qualidade (o player lê isto ao iniciar). A que a
  // pessoa está vendo ou ouvindo fica como ela deixou.
  if (c.plat === 'twitch') wc.on('dom-ready', () => {
    const id = canalId(c);
    if (c.video && !twAVista(i, id) && !(cfg.twitch.ouvir?.conta === i && cfg.twitch.ouvir?.id === id)) {
      wc.executeJavaScript(`localStorage.setItem('video-quality', '{"default":"160p30"}')`).catch(() => {});
    }
    // Página nova: o CSS de fora da janela (ver `twAplicarCssFora`) sumiu junto com a antiga
    twAplicarCssFora(wc, tocaFora(i, id) && !twAVista(i, id), true);
  });
  // A live no "ouvir" volta com som depois de recarregar (o player pode guardar "mudo")
  wc.on('did-finish-load', () => {
    const o = cfg.twitch.ouvir;
    if (o?.conta !== i || o?.id !== canalId(c)) return;
    setTimeout(() => wc.isDestroyed() || wc.executeJavaScript(
      `document.querySelectorAll('video').forEach(x => { x.muted = false; if (!x.volume) x.volume = 0.5; if (x.paused) x.play().catch(() => {}); })`).catch(() => {}), 8000);
  });
  wc.loadURL(twUrl(c));
  win.contentView.addChildView(v);
  v.setVisible(false);
  twViews[i].set(canalId(c), v);
  return v;
}

function abrirPopupNaSessao(part) {
  return ({ url }) => {
    try {
      const host = new URL(url).hostname;
      if (isTwitchHost(host) || isKickHost(host)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 760, autoHideMenuBar: true, webPreferences: { partition: part } } };
      }
    } catch {}
    shell.openExternal(url);
    return { action: 'deny' };
  };
}

function twAdd(i, raw, { show = true } = {}) {
  const p = typeof raw === 'object' ? raw : lerCanal(raw);
  if (!p || i < 0 || i >= TOTAL) return false;
  if (cfg.twitch.pausado) twRetomar(`abriu ${p.login}`); // quem abre um canal quer as lives de volta
  const id = canalId(p);
  const lista = cfg.twitch.canais[i];
  if (!lista.some(c => canalId(c) === id)) lista.push({ login: p.login, plat: p.plat, video: true });
  if (show) { cfg.twitch.ativo[i] = id; cfg.twitch.open = true; }
  else if (!cfg.twitch.ativo[i]) cfg.twitch.ativo[i] = id;
  if (!twViews[i].has(id)) twCreate(i, lista.find(x => canalId(x) === id));
  saveCfg();
  layout();
  applyTwitchVisibility();
  pushState();
  return true;
}

// ---------- Abrir sozinho as lives com pontos (só na Conta 1) ----------
// O servidor manda ao jogo, pelo WebSocket, os blocos `twitch` e `kick` do estado: os canais oficiais
// (`oficiais`, com `aoVivo` e `ativo` = as recompensas do jogo estão no canal) e as horas de bônus de
// quem resgatou. O estado chega em delta, mas cada chave de topo vem INTEIRA quando muda (ver
// shared/estado-delta.mjs do jogo), então basta guardar o último `twitch` e `kick` que passaram.
// Este script só escuta as mensagens; não muda nada no jogo.
const TW_AUTO_CONTA = 0;           // Conta 1
const TW_AUTO_MS = 30 * 60 * 1000; // a cada 30 minutos
// Também serve ao Sniper do Mercado (ver SNIPER_SCRIPT): guarda o socket do jogo (o sniper pede
// pelo MESMO canal, sem abrir conexão nova), o relógio do servidor (a retenção é pelo relógio dele)
// e repassa as respostas e eventos do Mercado. Só abre (JSON.parse) as mensagens que interessam.
// E à Reposição (nas 4 contas): as bolas, os itens e as coins do estado (o estado vem em delta, mas cada
// chave de topo vem INTEIRA quando muda), o catálogo de bolas e os itens nossos do welcome e a última recusa do jogo.
const WS_ESCUTA = `(() => {
  if (window.__pkmWs) return;
  window.__pkmWs = true;
  const W = window.WebSocket;
  // Envio do sniper: direto, sem passar pela marcação de "item aberto pela pessoa"
  window.__pkmEnviar = obj => { const s = window.__pkmSock; if (!s || s.readyState !== 1) return false; W.prototype.send.call(s, JSON.stringify(obj)); return true; };
  window.WebSocket = class extends W {
    constructor(...a) {
      super(...a);
      window.__pkmSock = this;
      this.addEventListener('message', ev => {
        const d = ev.data;
        if (typeof d !== 'string') return;
        const hora = d.indexOf('"servidorAgora":');
        if (hora >= 0) { const n = Number(/^"servidorAgora":(\\d+)/.exec(d.slice(hora))?.[1]); if (n) window.__pkmOffset = n - Date.now(); }
        const tw = d.indexOf('"twitch"') >= 0, kk = d.indexOf('"kick"') >= 0;
        const item = d.indexOf('"aba":"item"') >= 0;
        // Vitrine de pokemon (anúncios de uma espécie, ou de todas): o Sniper de pokemon confere
        if (d.indexOf('"aba":"vitrine"') >= 0 && window.__pkmSniper?.aoVitrine) {
          try { const m = JSON.parse(d); if (m.t === 'market' && m.aba === 'vitrine') window.__pkmSniper.aoVitrine(m); } catch {}
        }
        // Resumo de todos os itens do RMT (menor preço e média de 7 dias): o Monitor de Preços guarda
        if (d.indexOf('"aba":"itens"') >= 0) {
          try { const m = JSON.parse(d); if (m.t === 'market' && m.aba === 'itens') window.__pkmItensResp = { em: Date.now(), resumo: m.resumo || {}, medias: m.medias || {} }; } catch {}
        }
        const evMk = d.indexOf('"marketComprado"') >= 0 || d.indexOf('"mktSorteio"') >= 0;
        const loja = d.indexOf('"balls"') >= 0 || d.indexOf('"items"') >= 0 || d.indexOf('"gold":') >= 0 || d.indexOf('"t":"erro"') >= 0;
        const est = d.indexOf('"t":"estado"') >= 0; // todo pedaço do estado vai para a Melhor hunt (ver HUNT_ESCUTA)
        const abate = d.indexOf('"k":"morte"') >= 0; // e cada abate, para o ritmo medido dela
        const golpe = d.indexOf('"por":"jogador"') >= 0; // e cada golpe dele (golpes por abate)
        if (!tw && !kk && !item && !evMk && !loja && !est && !abate && !golpe) return;
        try {
          const m = JSON.parse(d);
          if (m.t === 'erro') window.__pkmErro = { em: Date.now(), chave: String(m.chave || ''), msg: String(m.msg || '') };
          if (m.t === 'welcome' && Array.isArray(m.catalogoBolas)) {
            window.__pkmCatBolas = m.catalogoBolas.map(b => ({ id: b.id, nome: b.nome, preco: b.priceGold, compravel: !!b.compravel }));
          }
          // Os itens NOSSOS do jogo (fora do items.json, como a Golden Potion) entram no catálogo da loja como no
          // cliente: só os de cura. A cada entrada o catálogo é refeito (ver __pkmLoja): montado antes dela, ficava
          // sem eles para sempre (28/10: a Golden Potion faltou na lista)
          if (m.t === 'welcome') {
            window.__pkmItensNossos = (Array.isArray(m.itensNossos) ? m.itensNossos : []).filter(i => i && (i.category === 'heal' || i.category === 'revive'));
            window.__pkmEntrouEm = Date.now();
            window.__pkmCatItens = null;
            window.__pkmCatItensP = null;
          }
          // As hunts e as regras do combate da entrada, e o estado inteiro remontado: a Melhor hunt (HUNT_ESCUTA)
          if (m.t === 'welcome') {
            window.__pkmHuntBase = { em: Date.now(), hunts: Array.isArray(m.hunts) ? m.hunts : [], tabelaTipos: m.tabelaTipos || {},
              tiposBoost: m.tiposBoost || [], amp: m.ampliacaoHunt ?? 1.5, multHp: m.multHpSelvagem ?? 5, multDano: m.multDanoSelvagem ?? 1.8 };
          }
          if ((m.t === 'welcome' || m.t === 'estado') && m.estado) window.__pkmEstadoMsg?.(m);
          if ((abate || golpe) && m.t === 'batalha' && Array.isArray(m.ev)) for (const e of m.ev) {
            if (e?.k === 'morte' && e.quem === 'selvagem' && !e.safari) window.__pkmContarAbate?.(e);
            else if (e?.k === 'ataque' && e.por === 'jogador') window.__pkmContarGolpe?.();
          }
          if ((m.t === 'welcome' || m.t === 'estado') && m.estado) {
            if (m.estado.balls && typeof m.estado.balls === 'object') window.__pkmBolas = { em: Date.now(), b: m.estado.balls };
            if (m.estado.items && typeof m.estado.items === 'object') window.__pkmItens = { em: Date.now(), i: m.estado.items };
            if (typeof m.estado.gold === 'number') window.__pkmOuro = m.estado.gold;
          }
          if (item && m.t === 'market' && m.aba === 'item') window.__pkmSniper?.aoItem(m);
          if (evMk && Array.isArray(m.ev)) for (const e of m.ev) if (e.k === 'marketComprado' || e.k === 'mktSorteio') window.__pkmSniper?.aoEvento(e);
          // Catálogo do RMT (vem na entrada): nomes de itens que não estão no items.json
          if (m.t === 'welcome' && Array.isArray(m.mercado?.catalogo)) {
            window.__pkmCatalogo = {};
            for (const it of m.mercado.catalogo) if (it?.id && it.nome) window.__pkmCatalogo[it.id] = it.nome;
          }
          if ((m.t !== 'welcome' && m.t !== 'estado') || !m.estado) return;
          if ('twitch' in m.estado) window.__pkmTwitch = { em: Date.now(), tw: m.estado.twitch };
          if ('kick' in m.estado) window.__pkmKick = { em: Date.now(), kk: m.estado.kick };
        } catch {}
      });
    }
    // O item que a pessoa abriu no Mercado (o jogo pede os anúncios dele): o sniper oferece esse
    send(dado) {
      if (typeof dado === 'string' && dado.indexOf('"market.item"') >= 0) {
        try { const o = JSON.parse(dado); if (o.t === 'market.item' && o.itemId) window.__pkmUltimoItem = { itemId: o.itemId, moeda: o.moeda || 'orb', em: Date.now() }; } catch {}
      }
      return super.send(dado);
    }
  };
  // As poções e os revives que a loja vende, com o preço dela: a MESMA receita do cliente (items.json sem os
  // duplicados e os mortos, com os ajustes do espelho — o Max Revive custa 5.000, não os 2.500 do arquivo — e os
  // itens nossos do welcome), filtrada como a vitrine: categoria heal/revive com preço de NPC. O items.json e os
  // módulos já foram baixados pelo jogo: vêm do cache do navegador.
  window.__pkmCatItensCarregar = async () => {
    const [j, aj, vn, al] = await Promise.all([
      fetch('/assets/items.json').then(r => r.json()),
      import('/shared/ajuste-item-espelho.mjs').catch(() => null),
      import('/shared/venda-npc-item.mjs').catch(() => null),
      import('/shared/alias-item.mjs').catch(() => null),
    ]);
    const lista = [];
    for (let i of j.items || j) {
      if (al?.IDS_ITEM_DUPLICADO?.has(i.id) || vn?.itemMortoDoJogo?.(i)) continue;
      if (vn?.normalizarNpcPriceItem) i = vn.normalizarNpcPriceItem(i);
      if (aj?.ajustarItemEspelho) i = aj.ajustarItemEspelho(i);
      lista.push(i);
    }
    for (const i of window.__pkmItensNossos || []) lista.push(i);
    const porId = new Map();
    for (const i of lista) if ((i.category === 'heal' || i.category === 'revive') && i.npcPrice > 0) porId.set(i.id, { id: i.id, nome: i.name || i.nome || ('item ' + i.id), preco: i.npcPrice, cat: i.category });
    return (window.__pkmCatItens = [...porId.values()].sort((a, b) => (a.cat === b.cat ? a.preco - b.preco : a.cat === 'heal' ? -1 : 1)));
  };
  // O que a Reposição lê (ver repConta); a 1ª leitura DEPOIS da entrada na conta monta o catálogo de poções
  window.__pkmLoja = () => {
    if (window.__pkmEntrouEm && !window.__pkmCatItens && !window.__pkmCatItensP) window.__pkmCatItensP = window.__pkmCatItensCarregar().catch(() => { window.__pkmCatItensP = null; });
    return {
      con: window.__pkmSock?.readyState === 1, bolas: window.__pkmBolas || null, itens: window.__pkmItens || null, ouro: window.__pkmOuro ?? null,
      catBolas: window.__pkmCatBolas || null, catItens: window.__pkmCatItens || null, erro: window.__pkmErro || null
    };
  };
})();`;

// ---------- Melhor hunt: o estado inteiro de cada conta, remontado com o código do jogo ----------
// O estado chega em pedaços (delta); o jogo remonta com `criarMescladorDeEstado` (shared/estado-delta.mjs), e a
// Melhor hunt usa a MESMA função numa cópia nossa: o pokémon em campo (`activeId` → `pokemons`, com os `stats` e o
// `maxHp` que o servidor calcula), o nível do treinador, a hunt atual e os boosts. `__pkmHuntDados` junta isso às
// hunts da entrada e às contas do próprio jogo (XP e ouro por abate e multiplicadores do Hunt Analyser, efetividade
// de tipos, Z-Move). A luta é simulada na janela (hunts.html), fora da página do jogo, para não travar a tela dele.
const HUNT_ESCUTA = `(() => {
  if (window.__pkmEstadoMsg) return;
  let mesclar = null, fila = [];
  const aplicar = parte => { try { const eu = mesclar(parte); if (eu) window.__pkmEu = eu; } catch {} };
  import('/shared/estado-delta.mjs').then(mod => { mesclar = mod.criarMescladorDeEstado(); for (const p of fila.splice(0)) aplicar(p); fila = null; })
    .catch(() => { fila = null; });
  window.__pkmEstadoMsg = m => {
    const parte = m.t === 'welcome' ? { ...m.estado, cheio: true } : m.estado;
    if (mesclar) aplicar(parte);
    else if (fila && fila.length < 2000) fila.push(parte);
  };
  // O ritmo MEDIDO na hunt atual (a mesma conta da prancheta do jogo: o evento "morte" do selvagem): recomeça ao trocar
  // de hunt, de pokémon ou de dia sazonal, e depois de 2 min sem abate (Centro, queda, conta parada). A corrida que
  // valeu (20 abates em 3 min) fica guardada com o pokémon daquela hora: o main junta as das 4 contas (ritmoColetar)
  // e a 🗺 tira delas o tempo do MAPA, descontando a luta simulada desse pokémon
  const heroi = eu => {
    const p = (eu?.pokemons || []).find(x => x.id === eu.activeId);
    return p && { speciesId: p.speciesId, level: p.level, stats: p.stats || null, maxHp: p.maxHp ?? null, ivs: p.ivs || null, tipos: p.tipos || null,
      tmAoe: !!(p.tmAoe ?? p.tm_aoe), tmElemental: p.tmElemental || null, tmFisico: p.tmFisico ?? null };
  };
  const valeu = r => r.abates >= 21 && r.ultimo - r.inicio >= 180000;
  window.__pkmContarAbate = e => {
    const eu = window.__pkmEu, slug = eu?.huntSlug || '', pk = eu?.activeId ?? null, saz = eu?.diaSazonal?.tipo || '', agora = Date.now();
    let r = window.__pkmRitmo;
    if (!r || r.slug !== slug || r.pk !== pk || r.saz !== saz || agora - r.ultimo > 120000) {
      if (r && valeu(r)) { const p = (window.__pkmRitmosProntos ||= []); p.push({ ...r }); if (p.length > 30) p.shift(); }
      r = window.__pkmRitmo = { slug, pk, saz, inicio: agora, ultimo: agora, abates: 0, golpes: 0, xpPk: 0, xpTr: 0, ouro: 0, heroi: null, heroiEm: 0 };
    }
    r.abates++;
    r.ultimo = agora;
    if (r.abates > 1) { // o 1º abate só abre o relógio
      r.xpPk += Number(e.xpPokemon ?? e.xp) || 0;
      r.xpTr += Number(e.xpTreinador ?? e.xp) || 0;
      r.ouro += Number(e.ouro) || 0;
    }
    if (agora - r.heroiEm > 60000) { r.heroi = heroi(eu); r.heroiEm = agora; } // ele sobe de nível no caminho
  };
  // Os golpes dele depois do 1º abate: golpes por abate (1 = mata de um golpe, e o tempo medido é o do mapa)
  window.__pkmContarGolpe = () => {
    const r = window.__pkmRitmo, eu = window.__pkmEu;
    if (r && Date.now() - r.ultimo <= 120000 && r.slug === (eu?.huntSlug || '') && r.pk === (eu?.activeId ?? null)) r.golpes++;
  };
  // O que o main leva (a cada 5 min): as corridas que acabaram e a de agora, se já valeu, com o Z-Move pronto
  window.__pkmRitmosTirar = async () => {
    const lista = (window.__pkmRitmosProntos || []).splice(0), r = window.__pkmRitmo;
    if (r && valeu(r)) lista.push({ ...r });
    if (!lista.length) return [];
    const tm = await import('/shared/tm-elemental.mjs').catch(() => null);
    return lista.filter(c => c.heroi?.stats).map(({ heroiEm, xpTr, heroi: { tmElemental, tmFisico, ...h }, ...c }) =>
      ({ ...c, heroi: { ...h, zmove: tmElemental && tm ? tm.golpeTmElemental(tmElemental, tmFisico) : null } }));
  };
  // Os pokémon da conta para o 💲 Precificador: a coleção do estado (a equipe tem slot 0 a 4), os IVs em 6 letras
  window.__pkmMeusPokemons = () => {
    const eu = window.__pkmEu;
    if (!eu) return null;
    const K = ['hp', 'atk', 'def', 'spAtk', 'spDef', 'speed'];
    const iv = o => o && K.every(k => Number.isInteger(o[k]) && o[k] >= 1 && o[k] <= 32) ? K.map(k => (o[k] - 1).toString(32)).join('') : null;
    const refino = r => { if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = null; } } return !!r && typeof r === 'object' && Object.values(r).some(x => Number(x) > 0); };
    return (eu.pokemons || []).map(p => ({ id: p.id, sp: p.speciesId, nome: p.nome || '', lv: p.level, sh: !!p.shiny, pot: p.potencia,
      q: p.quality ?? p.qualidade, ivs: iv(p.ivs), z: p.tmElemental || '', zf: p.tmFisico === true, aoe: !!(p.tmAoe ?? p.tm_aoe),
      ref: refino(p.refino), slot: p.slot ?? null, ativo: p.id === eu.activeId }));
  };
  window.__pkmHuntDados = async () => {
    const eu = window.__pkmEu, base = window.__pkmHuntBase;
    if (!eu) return { erro: 'esperando o estado da conta (ela já entrou no jogo?)' };
    if (!base?.hunts?.length) return { erro: 'esperando a lista de hunts do jogo' };
    const [ha, cg, tm, te] = await Promise.all([import('/hunt-analyser.mjs'), import('/shared/cooldown-golpes.mjs'),
      import('/shared/tm-elemental.mjs'), import('/shared/tipo-efetividade.mjs')]);
    const agora = Date.now(), tb = base.tiposBoost || [];
    const bonus = ha.bonusLootPct(eu, agora, tb, Number(eu.evento?.farmPct) || 0);
    const hunts = [];
    for (const h of base.hunts) {
      if (!h || !Array.isArray(h.especies) || !h.especies.length || h.slug === 'centro_pokemon') continue;
      let md;
      try { md = ha.mediaPorKill(h, new Map(), bonus); } catch { continue; }
      hunts.push({ slug: h.slug, nome: h.nome || h.name || h.slug, area: h.area || '', regiao: h.regiao || '', nivel: Number(h.nivel ?? h.level) || 0,
        especies: h.especies.map(e => [Number(e.pokeId), Number(e.pontos) || 1]), xp: md.xp, ouro: md.gold });
    }
    const T = ha.TIPOS_ELEMENTAIS, matriz = {};
    for (const a of T) { matriz[a] = {}; for (const d of T) matriz[a][d] = te.efetividade(a, d, null, base.tabelaTipos || {}); }
    const pk = (eu.pokemons || []).find(p => p.id === eu.activeId) || null;
    const r = window.__pkmRitmo;
    return {
      em: agora, nivel: Number(eu.level) || 0, huntSlug: eu.huntSlug || '', noCentro: !!eu.noCentro,
      sazonal: eu.diaSazonal?.tipo ? { tipo: String(eu.diaSazonal.tipo), fim: Number(eu.diaSazonal.fim) || 0 } : null,
      multTr: ha.multXpTreinador(eu, agora, tb), multPk: ha.multXpPokemon(eu, agora, tb), bonusLoot: bonus,
      amp: base.amp, multHp: base.multHp, multDano: base.multDano,
      regras: { onda: ha.MS_ONDA, maxMobs: ha.MAX_MOBS, intervalo: ha.CD_GOLPE_MS, desloc: ha.MS_DESLOC_MS, espera: ha.CD_MOVIMENTO_MEDIO_MS ?? 2000, tetoSpeed: cg.SPEED_POTENCIAL_TETO_PCT },
      matriz, hunts, medido: r ? { slug: r.slug, pk: r.pk, saz: r.saz, inicio: r.inicio, ultimo: r.ultimo, abates: r.abates, golpes: r.golpes, xpPk: r.xpPk, ouro: r.ouro } : null,
      ativo: pk && { id: pk.id, nome: pk.nome || '', speciesId: pk.speciesId, level: pk.level, shiny: !!pk.shiny, potencia: pk.potencia,
        quality: pk.quality ?? pk.qualidade, ivs: pk.ivs || null, stats: pk.stats || null, maxHp: pk.maxHp ?? null, tipos: pk.tipos || null,
        tmAoe: !!(pk.tmAoe ?? pk.tm_aoe), zmove: pk.tmElemental ? tm.golpeTmElemental(pk.tmElemental, pk.tmFisico) : null }
    };
  };
})();`;

// ---------- Sniper do Mercado (nas 4 contas, cada uma com a sua lista) ----------
// Os Termos do jogo (seção 5, AUTOMAÇÃO) permitem automação no Mercado desde que siga as mesmas
// regras de quem compra na mão, não burle as travas e retenções e não sobrecarregue o servidor.
// Desde 01/11/2026 (pedido do usuário: "uma lista separada para cada conta", "todas entram na disputa") cada conta
// tem a sua lista, o seu modo e o que já comprou, mas só UMA conta pergunta ao Mercado: a que OLHA (a Conta 1; se
// ela cair, a primeira conectada). Os anúncios são os mesmos para todo mundo, e 4 contas perguntando seriam 4 vezes
// mais pedidos ao servidor pela mesma informação. Ela pergunta pela lista das 4 juntas, sem repetir, e o app repassa
// a cada conta o que pode servir a ela (ver sniperRepassar); cada conta pede a compra pelo PRÓPRIO socket. Quando
// duas contas querem o mesmo anúncio, as duas pedem e entram no sorteio (os Termos permitem até 4 contas por pessoa,
// e cada pedido tem a mesma chance). Medido em 01/11 (scratchpad\app-teste12, pior caso: cada resposta com todos os
// anúncios do item): +0,15% de um núcleo e +5 a 7 MB por conta com Sniper.
// Então este sniper:
//   - pergunta os anúncios de cada item da lista no máximo a cada `intervalo` s (padrão 15 s);
//   - anúncio RETIDO: espera o `compravelEm` (relógio do servidor) e pede logo depois. Os pedidos
//     dos 3 primeiros segundos vão para o SORTEIO do jogo (um por jogador, mesma chance) — o sniper
//     só garante estar lá na hora, como quem fica de olho na tela;
//   - anúncio já livre: pede na hora (aí leva quem pedir primeiro, a regra normal);
//   - nunca acima do preço máximo por unidade, nunca além da quantidade definida;
//   - em SIMULAÇÃO só anota o que compraria.
// Pede pelo socket do próprio jogo (`__pkmEnviar`, ver WS_ESCUTA): as respostas também passam pela
// tela do jogo, que as ignora quando não é o item que ela está mostrando.
// Pedido-e-resposta pelo socket do jogo, para os monitores (preços de itens e de pokemon):
// manda `msg` e espera a primeira resposta com `"aba":"<aba>"` (e o mesmo `seq`, se vier um).
// `__pkmMercadoAberto` diz se a pessoa está com o Mercado aberto nesta conta: as respostas de grade
// e de vitrine passam pela tela do jogo, e chegar uma no meio trocaria a página que ela está vendo.
const PEDIR_SCRIPT = `(() => {
  if (window.__pkmPedir) return;
  window.__pkmMercadoAberto = () => !!document.querySelector('#cm-lista')?.offsetParent;
  window.__pkmPedir = (msg, aba, ms = 12000) => new Promise(res => {
    const s = window.__pkmSock;
    if (!s || s.readyState !== 1) return res({ erro: 'sem conexão com o jogo' });
    const fim = setTimeout(() => { s.removeEventListener('message', f); res({ erro: 'sem resposta' }); }, ms);
    function f(ev) {
      const d = ev.data;
      if (typeof d !== 'string' || d.indexOf('"aba":"' + aba + '"') < 0) return;
      try {
        const m = JSON.parse(d);
        if (m.t !== 'market' || m.aba !== aba || (msg.seq != null && m.seq != null && m.seq !== msg.seq)) return;
        clearTimeout(fim); s.removeEventListener('message', f); res(m);
      } catch {}
    }
    s.addEventListener('message', f);
    if (!window.__pkmEnviar(msg)) { clearTimeout(fim); s.removeEventListener('message', f); res({ erro: 'sem conexão com o jogo' }); }
  });
})();`;

const SNIPER_CONTA = 0; // a conta que olha o Mercado quando está conectada
// Na página de cada conta: `cfg.alvos` são os alvos DESTA conta; `olheiro` diz se é ela quem pergunta ao Mercado, e
// `consultas` é o que ela pergunta (os alvos das 4 contas juntos, ver sniperConsultas)
const SNIPER_SCRIPT = `(() => {
  if (window.__pkmSniper) return;
  const S = window.__pkmSniper = {
    cfg: { alvos: [], simular: true, intervalo: 30, olheiro: false, consultas: [] },
    comprados: {}, log: [], nomes: {}, ultimaVista: {}, pendentes: {}, agendados: {}, tentados: {}, repasse: []
  };
  const agora = () => Date.now() + (window.__pkmOffset || 0);
  // Alvo de ITEM: item:moeda (como sempre foi). Alvo de POKEMON: pk:<uid> (cada alvo conta à parte)
  const ehPk = a => a.tipo === 'pokemon';
  const chave = a => (ehPk(a) ? 'pk:' + a.uid : a.itemId + ':' + a.moeda);
  // O nome como a tela do jogo mostra. O items.json só traz os itens do jogo base; os "nossos" (de 70000 para cima:
  // fragmentos, tickets, ovos...) vêm do catálogo do Mercado em inglês ("Bicycle Fragment"), e a tela do jogo os traduz
  // pelo dicionário dela (/i18n.mjs). Aqui, o mesmo dicionário: o nome em inglês acha a chave, e a chave dá o nome no
  // idioma do jogo ("Fragmento de Bicicleta"). Antes, sem o catálogo, esses itens ficavam "item 70013" (01/11/2026).
  const nome = id => { const n = S.nomes[id] || window.__pkmCatalogo?.[id]; return (n && S.traduzir?.(n)) || n || ('item ' + id); };
  const nomeAlvo = a => (ehPk(a) ? (a.nome || 'Qualquer pokémon') : nome(a.itemId));
  const moedaTxt = m => (m === 'gold' ? 'coins' : 'gemas');
  const reg = txt => { S.log.push({ em: Date.now(), txt }); if (S.log.length > 300) S.log.splice(0, S.log.length - 300); };
  fetch('/assets/items.json').then(r => r.json()).then(j => { for (const i of (j.items || j)) S.nomes[i.id] = i.name; }).catch(() => {});
  import('/i18n.mjs').then(m => {
    const chaves = new Map();
    for (const [k, v] of Object.entries(m._dicionarios?.en || {})) {
      if ((k.startsWith('item.') || k.startsWith('caixas.nome.')) && typeof v === 'string') chaves.set(v.toLowerCase(), k);
    }
    S.traduzir = n => { const k = chaves.get(String(n).toLowerCase()); const tr = k ? m.t(k) : null; return tr && tr !== k ? tr : null; };
  }).catch(() => {});

  const ativos = () => S.cfg.alvos.filter(a => a.ativo && !(a.qtdMax > 0 && (S.comprados[chave(a)] || 0) >= a.qtdMax));
  const mercadoAberto = () => !!document.querySelector('#cm-lista')?.offsetParent;

  // Os filtros do alvo de pokemon que o servidor aceita no market.listar (as faixas do Mercado)
  const filtrosServidor = a => {
    const f = a.filtros || {}, out = {};
    for (const [k, c] of [['notaMin', 'notaMin'], ['nivelMin', 'nivelMin'], ['ivMin', 'ivMin'], ['qualidadeMin', 'qualidadeMin'], ['potenciaMin', 'potenciaMin']]) {
      if (f[k] != null && f[k] !== '') out[c] = f[k];
    }
    if (f.shiny === 'so') out.soShiny = true;
    return out;
  };
  // ...e a conferência completa de um anúncio contra o alvo, feita aqui antes de pedir
  const servePk = (a, l) => {
    const fi = l.ficha || {}, f = a.filtros || {};
    if (l.tipo !== 'pokemon' || l.moeda !== a.moeda) return false;
    if (a.especie && fi.speciesId !== a.especie) return false;
    const preco = Number(l.preco);
    if (!(preco > 0) || preco > a.precoMax) return false;
    if (f.notaMin != null && f.notaMin !== '' && !((fi.nota ?? -1) >= f.notaMin - 1e-9)) return false;
    if (f.nivelMin != null && f.nivelMin !== '' && !((fi.level ?? 0) >= f.nivelMin)) return false;
    if (f.ivMin != null && f.ivMin !== '' && !((fi.ivTotal ?? 0) >= f.ivMin)) return false;
    if (f.qualidadeMin != null && f.qualidadeMin !== '' && !((fi.quality ?? 0) >= f.qualidadeMin - 1e-9)) return false;
    if (f.potenciaMin != null && f.potenciaMin !== '' && !((fi.potencia ?? 0) >= f.potenciaMin)) return false;
    if (f.shiny === 'so' && !fi.shiny) return false;
    if (f.shiny === 'nao' && fi.shiny) return false;
    return true;
  };

  // Uma consulta por vez, em rodízio: cada uma é perguntada a cada \`intervalo\` s, com no mínimo 2 s entre pedidos.
  // Só a conta que OLHA pergunta. A de pokemon espera enquanto o Mercado estiver aberto na tela dela (a resposta
  // trocaria a página que a pessoa está vendo).
  let vez = 0, relogio = null, ultimoPedido = 0;
  function rodar() {
    clearTimeout(relogio);
    const lista = S.cfg.olheiro ? S.cfg.consultas : [];
    const passo = Math.max(20, Number(S.cfg.intervalo) || 30) * 1000 / Math.max(1, lista.length);
    if (lista.length) {
      const a = lista[vez++ % lista.length];
      ultimoPedido = Date.now();
      if (!ehPk(a)) window.__pkmEnviar?.({ t: 'market.item', itemId: a.itemId, moeda: a.moeda });
      else if (!mercadoAberto()) {
        window.__pkmEnviar?.({ t: 'market.listar', tipo: 'pokemon', moeda: a.moeda, busca: '', ordem: 'baratos', criterios: [], elementos: [], pagina: 0, especieId: a.especie || 0, ...filtrosServidor(a) });
        S.pausadoMercado = false;
      } else S.pausadoMercado = true;
    } else S.pausadoMercado = false;
    // Anúncio tentado há mais de 20 s já pode ser tentado de novo: não precisa mais da marca
    for (const id in S.tentados) if (Date.now() - S.tentados[id] > 20000) delete S.tentados[id];
    relogio = setTimeout(rodar, Math.max(4000, passo));
  }

  S.config = (cfg, comprados, zerar) => {
    S.cfg = cfg;
    // O que já comprou só cresce: o app manda o que tinha guardado (para a página que acabou de abrir) e a página
    // fica com o maior; o "Zerar comprados" troca de vez. (A cópia do app tem até 30 s de atraso.)
    if (zerar) S.comprados = { ...(comprados || {}) };
    else for (const [k, v] of Object.entries(comprados || {})) if (!(S.comprados[k] >= v)) S.comprados[k] = v;
    // Agendamento de alvo que saiu da lista, foi desligado ou ficou com teto abaixo do anúncio cai; os outros ficam
    // (a config chega de novo quando qualquer conta muda a lista dela)
    for (const id in S.agendados) {
      const x = S.agendados[id], a = S.cfg.alvos.find(b => chave(b) === chave(x.alvo));
      if (a && a.ativo && Number(x.l.preco) <= a.precoMax) { x.alvo = a; continue; }
      clearTimeout(x.t);
      delete S.agendados[id];
    }
    // Sem pedido a mais: a próxima consulta respeita os 2 s desde a última
    clearTimeout(relogio);
    relogio = setTimeout(rodar, Math.max(0, 4000 - (Date.now() - ultimoPedido)));
  };

  // A conta que olha guarda para as outras (o app vem buscar, ver sniperRepassar) o que pode servir a elas: do item,
  // os anúncios até o maior teto entre as contas, com o menor preço e quantos anúncios havia; da vitrine de pokemon,
  // as fichas. O aviso pelo console faz o app buscar na hora; ele também confere a cada 5 s.
  const repassar = m => {
    S.repasse.push(m);
    if (S.repasse.length > 50) S.repasse.splice(0, S.repasse.length - 50);
    console.debug('__pkmSnRepasse');
  };
  S.tirarRepasse = () => S.repasse.splice(0);
  // O que a conta que olha repassou, conferido contra a lista DESTA conta
  S.receber = lista => { for (const m of lista || []) { if (m.aba === 'item') S.aoItem(m, true); else if (m.aba === 'vitrine') S.aoVitrine(m, true); } };

  // Resposta de item do próprio socket (do Sniper ou da tela do jogo) ou repassada (\`deFora\`: já vem com o menor
  // preço e quantos anúncios havia, e só com os que podem servir)
  S.aoItem = (m, deFora) => {
    const alvo = S.cfg.alvos.find(a => !ehPk(a) && a.ativo && a.itemId === Number(m.itemId) && a.moeda === m.moeda);
    const linhas = Array.isArray(m.linhas) ? m.linhas : [];
    const menor = deFora ? m.menor : linhas.reduce((x, l) => Math.min(x, Number(l.preco) || Infinity), Infinity);
    S.ultimaVista[m.itemId + ':' + m.moeda] = { em: deFora ? m.em : Date.now(), menor: isFinite(menor) ? menor : null, qtd: deFora ? m.qtd : linhas.length };
    const c = !deFora && S.cfg.olheiro ? S.cfg.consultas.find(x => !ehPk(x) && x.repassar && x.itemId === Number(m.itemId) && x.moeda === m.moeda) : null;
    if (c) repassar({ aba: 'item', itemId: Number(m.itemId), moeda: m.moeda, em: Date.now(), menor: isFinite(menor) ? menor : null, qtd: linhas.length, linhas: linhas.filter(l => Number(l.preco) > 0 && Number(l.preco) <= c.teto) });
    if (!alvo) return;
    for (const l of linhas) {
      const preco = Number(l.preco);
      if (!(preco > 0) || preco > alvo.precoMax) continue;
      planejar(alvo, l);
    }
  };

  // Qualquer vitrine de pokemon que passar (do sniper ou da própria tela do jogo) é conferida contra
  // TODOS os alvos de pokemon: cada anúncio só é pedido se bater com algum alvo
  S.aoVitrine = (m, deFora) => {
    const linhas = Array.isArray(m.linhas) ? m.linhas : [];
    if (!deFora && S.cfg.olheiro && S.cfg.consultas.some(x => ehPk(x) && x.repassar)) repassar({ aba: 'vitrine', em: Date.now(), linhas });
    for (const a of ativos().filter(ehPk)) {
      const servem = linhas.filter(l => servePk(a, l));
      const menor = linhas.filter(l => l.moeda === a.moeda && (!a.especie || l.ficha?.speciesId === a.especie)).reduce((x, l) => Math.min(x, Number(l.preco) || Infinity), Infinity);
      if (isFinite(menor)) S.ultimaVista[chave(a)] = { em: Date.now(), menor, qtd: linhas.length };
      for (const l of servem) planejar(a, l);
    }
  };

  function quantoFalta(alvo) {
    return alvo.qtdMax > 0 ? alvo.qtdMax - (S.comprados[chave(alvo)] || 0) - Object.values(S.pendentes).filter(p => chave(p.alvo) === chave(alvo)).reduce((s, p) => s + p.qtd, 0) : Infinity;
  }

  const descrever = (alvo, l, q) => {
    if (!ehPk(alvo)) return nome(alvo.itemId) + ' ' + q + 'x a ' + l.preco + ' ' + moedaTxt(alvo.moeda) + ' (de ' + (l.vendedor || '?') + ')';
    const f = l.ficha || {};
    return (f.shiny ? 'Shiny ' : '') + (f.nome || 'pokémon') + ' Nv ' + (f.level ?? '?') + ' N' + (f.nota != null ? Number(f.nota).toFixed(2) : '?') + ' IV ' + (f.ivTotal ?? '?') + ' P' + (f.potencia ?? '?') + ' a ' + l.preco + ' ' + moedaTxt(alvo.moeda) + ' (de ' + (l.vendedor || '?') + ') [alvo: ' + nomeAlvo(alvo) + ']';
  };

  function planejar(alvo, l) {
    const id = l.id;
    if (S.agendados[id] || S.pendentes[id]) return;
    if (S.tentados[id] && Date.now() - S.tentados[id] < 20000) return; // não insiste no mesmo anúncio
    const q = ehPk(alvo) ? Math.min(1, quantoFalta(alvo)) : Math.min(Number(l.qtd) || 1, quantoFalta(alvo));
    if (!(q > 0)) return;
    const espera = (Number(l.compravelEm) || 0) - agora();
    if (espera > 0) {
      // Retido: pede 300 ms depois de liberar, dentro dos 3 s do sorteio (com o alvo como estiver na hora)
      S.agendados[id] = { t: setTimeout(() => { const x = S.agendados[id]; delete S.agendados[id]; if (x) pedir(x.alvo, l, q); }, espera + 300), alvo, l };
      reg('agendado: ' + descrever(alvo, l, q) + ', libera em ' + Math.ceil(espera / 1000) + ' s');
    } else pedir(alvo, l, q);
  }

  function pedir(alvo, l, q) {
    q = Math.min(q, quantoFalta(alvo));
    if (!(q > 0) || !alvo.ativo) return;
    S.tentados[l.id] = Date.now();
    const desc = descrever(alvo, l, q);
    if (S.cfg.simular) { reg('[simulação] compraria ' + desc); return; }
    const ok = window.__pkmEnviar?.({ t: 'market.comprar', id: l.id, qtd: q, preco: l.preco, moeda: alvo.moeda, sorteioUi: 1 });
    if (!ok) { reg('sem conexão com o jogo, não pedi ' + desc); return; }
    S.pendentes[l.id] = { alvo, qtd: q, em: Date.now(), desc };
    setTimeout(() => { delete S.pendentes[l.id]; }, 30000); // sem resposta em 30 s, libera a cota
    reg('pedido: ' + desc);
  }

  S.aoEvento = e => {
    const p = S.pendentes[e.id];
    if (e.k === 'marketComprado' && p) {
      const q = ehPk(p.alvo) ? 1 : (Number(e.qtd) || p.qtd);
      S.comprados[chave(p.alvo)] = (S.comprados[chave(p.alvo)] || 0) + q;
      delete S.pendentes[e.id];
      reg('COMPROU ' + p.desc + (e.sorteio ? ' (ganhou o sorteio)' : ''));
    } else if (e.k === 'mktSorteio' && p && (e.fase === 'fim' || e.fim)) {
      // O fim do sorteio (sorteio-janela.mjs do jogo): \`ok\` = levou (o marketComprado conta), \`perdeu\` = outro levou;
      // sem os dois, o pedido não passou (\`msg\` diz por quê). Até 01/11/2026 isto lia campos que não existem e anotava
      // "não levou" também quando levou.
      if (e.perdeu) reg('sorteio: não levou desta vez (não paga nada) — ' + p.desc);
      else if (!e.ok) reg('sorteio: o pedido não passou' + (e.msg ? ' (' + e.msg + ')' : '') + ' — ' + p.desc);
      if (!e.ok) delete S.pendentes[e.id]; // não levou: a quantidade volta a valer para outros anúncios
    }
  };

  S.estado = () => ({
    comprados: S.comprados, log: S.log.slice(-60), pausadoMercado: !!S.pausadoMercado, olheiro: !!S.cfg.olheiro,
    agendados: Object.values(S.agendados).map(x => ({ item: ehPk(x.alvo) ? (x.l.ficha?.nome || nomeAlvo(x.alvo)) : nome(x.alvo.itemId), preco: x.l.preco, libera: x.l.compravelEm })),
    ultimoItem: window.__pkmUltimoItem ? { ...window.__pkmUltimoItem, nome: nome(window.__pkmUltimoItem.itemId) } : null,
    nomesAlvos: Object.fromEntries(S.cfg.alvos.filter(a => !ehPk(a)).map(a => [a.itemId, nome(a.itemId)])),
    ultimaVista: S.ultimaVista, conectado: window.__pkmSock?.readyState === 1
  });
})();`;

// Config do sniper (salva na config do app) e o que ele já comprou, por item:moeda
// Config do sniper (salva na config do app): o intervalo vale para todas; cada conta tem a lista, o modo e o que já
// comprou (por item:moeda, ou pk:<uid>)
const sniperCfg = () => {
  const s = (cfg.sniper ??= { intervalo: 30 });
  // Até 01/11/2026 o Sniper era só da Conta 1: a lista, o modo e o que ela comprou viram os da Conta 1
  if (!Array.isArray(s.contas)) {
    s.contas = [{ alvos: s.alvos ?? [], simular: s.simular ?? true, comprados: s.comprados ?? {} }];
    delete s.alvos; delete s.simular; delete s.comprados;
    for (let i = 1; i < TOTAL; i++) s.contas[i] = { alvos: [], simular: true, comprados: {} };
    s.intervalo ??= 30;
    saveCfg();
  }
  for (let i = 0; i < TOTAL; i++) s.contas[i] ??= { alvos: [], simular: true, comprados: {} };
  return s;
};

// O executeJavaScript espera a página terminar de carregar: uma conta presa carregando não pode parar o Sniper das outras
const sniperJs = (wc, codigo, ms = 5000) => Promise.race([wc.executeJavaScript(codigo).catch(() => null), new Promise(r => setTimeout(() => r(null), ms))]);

// O que a conta que olha pergunta: os alvos ligados (e ainda por completar) das 4 contas, sem repetir, cada um com o
// maior preço máximo entre elas (até onde vale repassar) e se alguma OUTRA conta precisa do repasse
let sniperOlheiro = SNIPER_CONTA;
function sniperConsultas() {
  const m = new Map();
  sniperCfg().contas.forEach((c, i) => {
    for (const a of c.alvos) {
      const pk = a.tipo === 'pokemon';
      if (!a.ativo || (a.qtdMax > 0 && (c.comprados?.[pk ? 'pk:' + a.uid : a.itemId + ':' + a.moeda] || 0) >= a.qtdMax)) continue;
      const k = pk ? JSON.stringify([a.moeda, a.especie || 0, a.filtros || {}]) : a.itemId + ':' + a.moeda;
      const x = m.get(k) ?? (pk ? { tipo: 'pokemon', moeda: a.moeda, especie: a.especie || 0, filtros: a.filtros || {}, teto: 0 } : { tipo: 'item', itemId: a.itemId, moeda: a.moeda, teto: 0 });
      x.teto = Math.max(x.teto, a.precoMax);
      if (i !== sniperOlheiro) x.repassar = true;
      m.set(k, x);
    }
  });
  // A vitrine de pokemon serve a TODOS os alvos de pokemon: repassa se outra conta tiver algum
  const pkFora = sniperCfg().contas.some((c, i) => i !== sniperOlheiro && c.alvos.some(a => a.ativo && a.tipo === 'pokemon'));
  return [...m.values()].map(x => (x.tipo === 'pokemon' ? { ...x, repassar: pkFora } : x));
}

// Manda a cada página a lista dela (e à que olha, também as consultas). `so` = só aquela conta e a que olha (a lista
// das consultas muda quando qualquer conta muda a dela); `zerar` = o "Zerar comprados" daquela conta.
let sniperConsultasEnviadas = '';
function sniperEnviarConfig(so = null, zerar = false) {
  const s = sniperCfg(), consultas = sniperConsultas();
  sniperConsultasEnviadas = JSON.stringify(consultas);
  views.forEach((v, i) => {
    const wc = v?.webContents;
    if (!wc || wc.isDestroyed() || (so != null && i !== so && i !== sniperOlheiro)) return;
    const c = s.contas[i], olheiro = i === sniperOlheiro;
    const conf = { alvos: c.alvos, simular: c.simular, intervalo: s.intervalo, olheiro, consultas: olheiro ? consultas : [] };
    wc.executeJavaScript(`window.__pkmSniper?.config(${JSON.stringify(conf)}, ${JSON.stringify(c.comprados || {})}, ${zerar && i === so})`).catch(() => {});
  });
}

// Leva às outras contas o que a que olha viu, só o que pode servir a cada uma: o item que está na lista dela, ou a
// vitrine se ela tiver alvo de pokemon. A página avisa pelo console (ver createGameView); a cada 5 s o app confere
// também, para o caso de o aviso falhar.
let sniperRepassando = false, sniperRepassarDeNovo = false;
async function sniperRepassar() {
  if (sniperRepassando) { sniperRepassarDeNovo = true; return; }
  sniperRepassando = true;
  try {
    do {
      sniperRepassarDeNovo = false;
      const o = sniperOlheiro, wc = views[o]?.webContents;
      if (!wc || wc.isDestroyed()) break;
      const lote = (await sniperJs(wc, 'window.__pkmSniper?.tirarRepasse?.() ?? []')) || [];
      if (!lote.length) continue;
      const s = sniperCfg();
      views.forEach((v, j) => {
        const dest = v?.webContents;
        if (j === o || !dest || dest.isDestroyed()) return;
        const alvos = s.contas[j].alvos.filter(a => a.ativo);
        const serve = lote.filter(m => (m.aba === 'vitrine' ? alvos.some(a => a.tipo === 'pokemon') : alvos.some(a => a.tipo !== 'pokemon' && a.itemId === m.itemId && a.moeda === m.moeda)));
        if (serve.length) dest.executeJavaScript(`window.__pkmSniper?.receber(${JSON.stringify(serve)})`).catch(() => {});
      });
    } while (sniperRepassarDeNovo);
  } finally { sniperRepassando = false; }
}
const sniperOutrasComAlvo = () => sniperCfg().contas.some((c, i) => i !== sniperOlheiro && c.alvos.some(a => a.ativo));

// Quem olha o Mercado: a Conta 1; se ela ficar 2 leituras seguidas sem conexão, a primeira conectada; quando a Conta 1
// volta, volta para ela
const sniperSemConexao = Array(TOTAL).fill(0);
function sniperEscolherOlheiro(sts) {
  sts.forEach((st, i) => { sniperSemConexao[i] = st?.conectado ? 0 : sniperSemConexao[i] + 1; });
  let novo = sniperOlheiro;
  if (sniperOlheiro !== SNIPER_CONTA && !sniperSemConexao[SNIPER_CONTA]) novo = SNIPER_CONTA;
  else if (sniperSemConexao[sniperOlheiro] >= 2) {
    const ligada = sniperSemConexao.findIndex(n => n === 0);
    if (ligada >= 0) novo = ligada;
  }
  if (novo === sniperOlheiro) return;
  const antes = sniperOlheiro;
  sniperOlheiro = novo;
  appLog(`sniper: quem olha o Mercado agora é a ${cfg.names[novo]} (${novo === SNIPER_CONTA ? 'ela voltou' : `a ${cfg.names[antes]} está sem conexão`})`);
  sniperEnviarConfig(antes);
}

// Lê o estado do sniper nas 4 páginas: guarda o que cada conta comprou, grava o registro novo no sniper.log
// e manda para a janela do sniper (se aberta). A cada 3 s com a janela aberta, 30 s sem ela.
let sniperUltimoLog = Array(TOTAL).fill(0), sniperWin = null, sniperTimer = null;
async function sniperLer() {
  const s = sniperCfg();
  const sts = await Promise.all(views.map(v => {
    const wc = v?.webContents;
    return wc && !wc.isDestroyed() ? sniperJs(wc, 'window.__pkmSniper?.estado() ?? null') : null;
  }));
  let mudou = false;
  const registro = [];
  sts.forEach((st, i) => {
    if (!st) return;
    const c = s.contas[i];
    if (JSON.stringify(st.comprados) !== JSON.stringify(c.comprados)) { c.comprados = st.comprados; mudou = true; }
    // O alvo guardado com o nome provisório ("item 70013", de quando o Sniper não sabia o nome dos itens fora do
    // items.json) fica com o nome que o jogo mostra
    for (const a of c.alvos) {
      const n = st.nomesAlvos?.[a.itemId];
      if (a.tipo !== 'pokemon' && n && !/^item \d+$/.test(n) && (!a.nome || /^item \d+$/.test(a.nome))) { a.nome = n; mudou = true; }
    }
    const novos = (st.log || []).filter(l => l.em > sniperUltimoLog[i]);
    if (novos.length) {
      sniperUltimoLog[i] = novos[novos.length - 1].em;
      for (const l of novos) registro.push({ em: l.em, txt: `[${cfg.names[i]}] ${l.txt}` });
    }
  });
  if (mudou) saveCfg();
  if (registro.length) {
    registro.sort((a, b) => a.em - b.em);
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'sniper.log'), registro.map(l => `${new Date(l.em).toLocaleString('pt-BR')}  ${l.txt}`).join('\n') + '\n'); } catch {}
  }
  sniperEscolherOlheiro(sts);
  // Alvo que completou sai das consultas de quem olha
  if (JSON.stringify(sniperConsultas()) !== sniperConsultasEnviadas) sniperEnviarConfig(sniperOlheiro);
  // As espécies conhecidas (do Monitor de Pokémons) para escolher no alvo de pokemon
  if (sniperWin && !sniperWin.isDestroyed()) {
    sniperWin.webContents.send('snstate', { cfg: s, sts, nomes: cfg.names, olheiro: sniperOlheiro, consultas: sniperConsultas().length, especies: pkmLer().especies });
  }
  clearTimeout(sniperTimer);
  sniperTimer = setTimeout(sniperLer, sniperWin && !sniperWin.isDestroyed() ? 3000 : 30000);
}

function abrirSniper() {
  if (!licenca.premium()) return licenca.pedirPremium('O 🎯 Sniper');
  if (sniperWin && !sniperWin.isDestroyed()) { if (sniperWin.isMinimized()) sniperWin.restore(); return sniperWin.focus(); }
  sniperWin = new BrowserWindow({
    width: 760, height: 940, parent: win, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Sniper do Mercado',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  sniperWin.on('page-title-updated', e => e.preventDefault());
  sniperWin.loadFile(path.join(__dirname, 'sniper.html'));
  sniperWin.webContents.on('did-finish-load', sniperLer);
  sniperWin.on('closed', () => { sniperWin = null; });
}

// O que a janela pode mudar: de uma conta (`conta`), a lista de itens (com teto e quantidade), a simulação e o zerar;
// de todas, o intervalo
function sniperSalvar(novo) {
  const s = sniperCfg();
  const num = (x, min, max) => Math.min(max, Math.max(min, Math.floor(Number(x) || 0)));
  const i = Number.isInteger(novo?.conta) && novo.conta >= 0 && novo.conta < TOTAL ? novo.conta : null;
  const c = i == null ? null : s.contas[i];
  if (c && Array.isArray(novo.alvos)) {
    const dec = x => (x === '' || x == null || !Number.isFinite(Number(String(x).replace(',', '.'))) ? '' : Number(String(x).replace(',', '.')));
    c.alvos = novo.alvos.map(a => {
      const base = { nome: String(a.nome ?? '').slice(0, 60), moeda: a.moeda === 'gold' ? 'gold' : 'orb', precoMax: num(a.precoMax, 0, 1e12), qtdMax: num(a.qtdMax, 0, 1e7), ativo: !!a.ativo };
      if (a.tipo !== 'pokemon') return { ...base, tipo: 'item', itemId: num(a.itemId, 1, 1e9) };
      // Alvo de POKEMON: espécie (0 = qualquer uma), filtros mínimos e shiny; `uid` separa a contagem de cada alvo
      const f = a.filtros || {};
      return {
        ...base, tipo: 'pokemon', especie: num(a.especie, 0, 1e7), uid: String(a.uid || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 20),
        filtros: { notaMin: dec(f.notaMin), nivelMin: dec(f.nivelMin), ivMin: dec(f.ivMin), qualidadeMin: dec(f.qualidadeMin), potenciaMin: dec(f.potenciaMin), shiny: ['so', 'nao'].includes(f.shiny) ? f.shiny : 'todos' }
      };
    }).filter(a => a.precoMax > 0 && (a.tipo === 'pokemon' || a.itemId));
  }
  if (c && 'simular' in novo) c.simular = !!novo.simular;
  if ('intervalo' in (novo ?? {})) s.intervalo = num(novo.intervalo, 20, 600);
  if (c && novo.zerar) c.comprados = {};
  saveCfg();
  if (c) appLog(`sniper ${cfg.names[i]}: ${c.simular ? 'SIMULAÇÃO' : 'COMPRA LIGADA'}, ${c.alvos.filter(a => a.ativo).length} alvos ativos (${c.alvos.filter(a => a.ativo && a.tipo === 'pokemon').length} de pokémon), a cada ${s.intervalo}s`);
  else appLog(`sniper: a cada ${s.intervalo}s`);
  sniperEnviarConfig(i, !!(c && novo.zerar));
  sniperLer();
}

// ---------- Reposição automática (loja do jogo, nas 4 contas): bolas, poções e revives ----------
// Pedido do usuário (28/10/2026): o VIP ("Lançar sem Parar", "Usar Poções", "Usar Revive") gasta da bolsa o tempo
// todo; para cada conta, uma LISTA do que recomprar na LOJA do jogo (NPC, em coins): quando o estoque de um item cair
// abaixo do "menos de", comprar até o "compra até".
// O pedido é o mesmo do botão Comprar da loja (`shop.buy`: kind ball para bolas, item para poções e revives), pelo
// socket da própria conta (`__pkmEnviar`), com no máximo 9.999 por compra (o teto do jogo, o do botão "Máx"). Os
// Termos (seção 5) só proíbem automação que explora falha, burla limite ou sobrecarrega o servidor: aqui é UMA compra
// por vez em cada conta, e a próxima só depois de a anterior aparecer (de 40 mil para 100 mil bolas são 7 compras,
// ~6 s entre elas). Os itens da lista são atendidos na ordem dela.
// A compra "apareceu" quando o estoque sobe mais que metade do comprado ou as coins caem mais que metade do total
// (o jogo faz igual no "+N" da loja: com a auto-ball jogando, o estoque sobe menos que o comprado).
// Travas: as coins da conta; o teto de gasto por dia (da conta, somando todos os itens); compra pequena (< 100, ou
// menos que a faixa entre os dois números) não sai; e a compra que não aparece em 20 s pausa AQUELE item por 5 min
// e, na 2ª seguida, desliga o item (o estoque pode não estar chegando ao app, e comprar às cegas seria gastar sem ver).
const REP_TETO_COMPRA = 9999;
const REP_MIN_COMPRA = 100;
const REP_TESTE = process.env.PKM_REP_TESTE === '1'; // o teste isolado encurta as esperas
const REP_ESPERA_MS = REP_TESTE ? 3000 : 20000;      // a compra tem de aparecer até aqui
const REP_PAUSA_MS = REP_TESTE ? 2000 : 5 * 60000;   // depois de uma compra que não apareceu
const REP_LEITURA_MS = 20000;                        // conta ligada e janela fechada: confere o estoque a cada 20 s
// Até o catálogo do jogo chegar (bolas: o `catalogoBolas` do welcome; poções e revives: ver __pkmCatItensCarregar)
const REP_PADRAO = [
  { tipo: 'bola', id: 1, nome: 'Poké Ball', preco: 5 }, { tipo: 'bola', id: 2, nome: 'Great Ball', preco: 20 },
  { tipo: 'bola', id: 3, nome: 'Super Ball', preco: 50 }, { tipo: 'bola', id: 4, nome: 'Ultra Ball', preco: 130 },
];
const repChave = x => `${x.tipo}:${x.id}`;
// Por conta: ligado, o teto de gasto por dia e a lista `itens` ({ tipo: bola|item, id, abaixo, ate, ativo }).
// A 1ª versão (28/10 de manhã) tinha uma bola só (bola/abaixo/ate): ela vira o 1º item da lista.
const repCfg = () => {
  const r = (cfg.reposicao ??= {});
  r.contas ??= [];
  for (let i = 0; i < TOTAL; i++) {
    const c = r.contas[i] = { ligado: false, tetoDia: 50000000, ...r.contas[i] };
    if (!Array.isArray(c.itens)) {
      c.itens = [{ tipo: 'bola', id: c.bola ?? 4, abaixo: c.abaixo ?? 50000, ate: c.ate ?? 100000, ativo: true }];
      delete c.bola; delete c.abaixo; delete c.ate;
    }
  }
  return r;
};
const repHoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// O gasto de hoje por conta (zera à meia-noite): o teto por dia é sobre ele
function repGasto(i, mais = 0) {
  const r = repCfg();
  if (r.gasto?.dia !== repHoje()) r.gasto = { dia: repHoje(), v: Array(TOTAL).fill(0), n: Array(TOTAL).fill(0) };
  if (mais) { r.gasto.v[i] += mais; r.gasto.n[i]++; saveCfg(); }
  return r.gasto.v[i];
}
// Por conta: a última leitura, a compra pendente (uma por vez), a pausa da conta (teto do dia ou sem coins) e, por
// item da lista, se está enchendo, até quando está pausado e quantas compras seguidas não apareceram
const repEst = Array.from({ length: TOTAL }, () => ({ leitura: null, lidoEm: 0, pend: null, ultima: null, aviso: '', erroCfg: '', pausa: 0, regras: {} }));
const repRegra = (e, k) => (e.regras[k] ??= { enchendo: false, proxCompra: 0, falhas: 0 });
const repLogs = [];
let repWin = null, repCatBolas = null, repCatItens = null, repRodando = false;
const repCatalogo = () => [
  ...(repCatBolas ? repCatBolas.filter(b => b.compravel).map(b => ({ tipo: 'bola', id: b.id, nome: b.nome, preco: b.preco })) : REP_PADRAO),
  ...(repCatItens ?? []).map(i => ({ tipo: 'item', id: i.id, nome: i.nome, preco: i.preco, cat: i.cat })),
];
const repAchar = x => repCatalogo().find(y => y.tipo === x.tipo && y.id === x.id);
const repNome = x => repAchar(x)?.nome || `${x.tipo === 'bola' ? 'bola' : 'item'} ${x.id}`;
const repPreco = x => Number(repAchar(x)?.preco) || 0;
const repFmt = n => Number(n).toLocaleString('pt-BR');
function repLog(i, txt) {
  const l = { em: Date.now(), conta: i, txt };
  repLogs.push(l);
  if (repLogs.length > 200) repLogs.splice(0, repLogs.length - 200);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'reposicao.log'), `${new Date(l.em).toLocaleString('pt-BR')}  ${cfg.names[i]}: ${txt}\n`); } catch {}
}

async function repConta(i) {
  const c = repCfg().contas[i], e = repEst[i], agora = Date.now();
  const ativos = c.ligado ? c.itens.filter(x => x.ativo) : [];
  const ler = e.pend || ativos.some(x => repRegra(e, repChave(x)).enchendo) || (ativos.length && agora - e.lidoEm >= REP_LEITURA_MS) || (repWin && agora - e.lidoEm >= 3000);
  if (!ler) return;
  const wc = views[i]?.webContents;
  const r = wc && !wc.isDestroyed() ? await wc.executeJavaScript('window.__pkmLoja ? window.__pkmLoja() : null').catch(() => null) : null;
  e.lidoEm = agora;
  e.leitura = r;
  if (r?.catBolas?.length) repCatBolas = r.catBolas;
  // O catálogo de poções junta o que as contas mandam (uma que ainda não entrou não apaga a Golden Potion de outra)
  if (r?.catItens?.length) {
    const porId = new Map((repCatItens ?? []).map(x => [x.id, x]));
    for (const x of r.catItens) porId.set(x.id, x);
    repCatItens = [...porId.values()].sort((a, b) => (a.cat === b.cat ? a.preco - b.preco : a.cat === 'heal' ? -1 : 1));
  }
  if (!r?.con || !r.bolas) { e.aviso = r?.con ? 'esperando o jogo mandar o estoque' : 'sem conexão com o jogo'; return; }
  e.aviso = '';
  const tem = x => Number((x.tipo === 'bola' ? r.bolas.b : r.itens?.i)?.[x.id]) || 0;

  if (e.pend) {
    const p = e.pend, total = p.qtd * p.preco, st = repRegra(e, repChave(p));
    if (tem(p) - p.antes >= p.qtd / 2 || (typeof r.ouro === 'number' && p.ouro - r.ouro >= total / 2)) {
      repGasto(i, total);
      e.ultima = { em: agora, tipo: p.tipo, id: p.id, qtd: p.qtd, total };
      repLog(i, `comprou ${repFmt(p.qtd)} ${repNome(p)} por ${repFmt(total)} coins (tinha ${repFmt(p.antes)}, agora ${repFmt(tem(p))})`);
      e.pend = null; st.falhas = 0; st.proxCompra = agora + 2500;
    } else if (agora - p.em > REP_ESPERA_MS) {
      const recusa = r.erro && r.erro.em >= p.em ? (r.erro.msg || r.erro.chave) : '';
      e.pend = null; st.enchendo = false; st.falhas++;
      if (st.falhas >= 2) {
        const x = c.itens.find(y => repChave(y) === repChave(p));
        if (x) x.ativo = false;
        saveCfg();
        repLog(i, `DESLIGUEI ${repNome(p)} na lista: a compra não apareceu 2 vezes seguidas${recusa ? ` (o jogo respondeu: ${recusa})` : ''}. Confira no jogo e marque de novo.`);
      } else {
        st.proxCompra = agora + REP_PAUSA_MS;
        repLog(i, `a compra de ${repFmt(p.qtd)} ${repNome(p)} não apareceu${recusa ? ` (o jogo respondeu: ${recusa})` : ''}; tento de novo em 5 min`);
      }
    }
    return;
  }
  if (!ativos.length || agora < e.pausa) return;
  for (const x of ativos) {
    if (x.tipo === 'item' && !r.itens) continue; // o estoque de itens ainda não chegou
    const st = repRegra(e, repChave(x)), atual = tem(x), nome = repNome(x);
    if (!st.enchendo && atual < x.abaixo && agora >= st.proxCompra) {
      st.enchendo = true;
      repLog(i, `${nome}: ${repFmt(atual)}, abaixo de ${repFmt(x.abaixo)}: comprando até ${repFmt(x.ate)}`);
    }
    if (!st.enchendo || agora < st.proxCompra) continue;
    const falta = x.ate - atual, minimo = Math.min(REP_MIN_COMPRA, x.ate - x.abaixo);
    if (falta < minimo) { st.enchendo = false; repLog(i, `${nome}: ${repFmt(atual)}, completo`); continue; }
    const preco = repPreco(x);
    if (!preco) {
      st.enchendo = false;
      st.proxCompra = agora + 10 * 60000;
      repLog(i, `${nome}: o preço na loja ainda não chegou do jogo; tento de novo em 10 min`);
      continue;
    }
    const resta = c.tetoDia > 0 ? c.tetoDia - repGasto(i) : Infinity;
    const qtd = Math.min(REP_TETO_COMPRA, falta, typeof r.ouro === 'number' ? Math.floor(r.ouro / preco) : Infinity, Math.floor(resta / preco));
    if (qtd < minimo) {
      const teto = Math.floor(resta / preco) < minimo;
      st.enchendo = false;
      const amanha = new Date();
      amanha.setHours(24, 0, 5, 0);
      e.pausa = teto ? amanha.getTime() : agora + 10 * 60000;
      repLog(i, teto ? `chegou no teto de ${repFmt(c.tetoDia)} coins de hoje; volta a comprar amanhã`
        : `sem coins para comprar ${nome} (tem ${repFmt(r.ouro)}); tento de novo em 10 min`);
      return;
    }
    const msg = { t: 'shop.buy', kind: x.tipo === 'bola' ? 'ball' : 'item', id: x.id, qty: qtd };
    const ok = await wc.executeJavaScript(`window.__pkmEnviar ? window.__pkmEnviar(${JSON.stringify(msg)}) : false`).catch(() => false);
    if (!ok) { e.aviso = 'sem conexão com o jogo'; e.pausa = agora + 30000; return; }
    e.pend = { em: agora, tipo: x.tipo, id: x.id, qtd, antes: atual, ouro: typeof r.ouro === 'number' ? r.ouro : NaN, preco };
    return; // uma compra por vez em cada conta
  }
}

// Uma volta pelas 4 contas a cada 3 s (cada conta só lê o estoque quando precisa: ver `ler` em repConta)
async function repTick() {
  if (repRodando) return;
  repRodando = true;
  try { for (let i = 0; i < TOTAL; i++) await repConta(i); } catch (e) { appLog(`reposição: erro (${e.message})`); }
  repRodando = false;
  repEnviar();
}

function repEnviar() {
  if (!repWin || repWin.isDestroyed()) return;
  const r = repCfg(), cat = repCatalogo();
  repGasto(0);
  repWin.webContents.send('repstate', {
    contas: r.contas, nomes: cfg.names, gasto: r.gasto, catalogo: cat,
    est: repEst.map(e => {
      const l = e.leitura, estoque = {};
      for (const x of cat) {
        const v = (x.tipo === 'bola' ? l?.bolas?.b : l?.itens?.i)?.[x.id];
        if (v != null) estoque[repChave(x)] = Number(v) || 0;
      }
      return {
        con: !!l?.con, lido: !!l?.bolas, itensLidos: !!l?.itens, estoque, ouro: l?.ouro ?? null, aviso: e.aviso, erroCfg: e.erroCfg,
        pend: e.pend && { tipo: e.pend.tipo, id: e.pend.id, qtd: e.pend.qtd }, ultima: e.ultima, pausa: e.pausa, regras: e.regras
      };
    }),
    log: repLogs.slice(-100)
  });
}

function abrirReposicao() {
  if (!licenca.premium()) return licenca.pedirPremium('A 🛒 Reposição');
  if (repWin && !repWin.isDestroyed()) { if (repWin.isMinimized()) repWin.restore(); return repWin.focus(); }
  repWin = new BrowserWindow({
    width: 860, height: 900, parent: win, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Reposição automática',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  repWin.on('page-title-updated', e => e.preventDefault());
  repWin.loadFile(path.join(__dirname, 'reposicao.html'));
  repWin.webContents.on('did-finish-load', repEnviar);
  repWin.on('closed', () => { repWin = null; });
}

// "Repor agora": enche todos os itens marcados até o "compra até", sem esperar cair abaixo do "menos de"
function repAgora(i) {
  const c = repCfg().contas[i], e = repEst[i];
  if (!c?.ligado || e.pend) return;
  e.pausa = 0;
  e.lidoEm = 0;
  for (const x of c.itens.filter(y => y.ativo)) Object.assign(repRegra(e, repChave(x)), { enchendo: true, proxCompra: 0, falhas: 0 });
  repLog(i, 'repor agora: enchendo todos os itens marcados');
  repTick();
}

// O que a janela muda numa conta: ligado, o teto por dia e a lista (item, "menos de", "até", marcado)
function repSalvar(i, novo) {
  const c = repCfg().contas[i], e = repEst[i];
  if (!c || !novo || !Array.isArray(novo.itens)) return;
  const num = (x, min, max) => Math.min(max, Math.max(min, Math.floor(Number(x) || 0)));
  const itens = novo.itens.slice(0, 12).map(x => ({
    tipo: x.tipo === 'item' ? 'item' : 'bola', id: num(x.id, 1, 1e9), abaixo: num(x.abaixo, 1, 1e7), ate: num(x.ate, 1, 1e7), ativo: !!x.ativo
  }));
  const cat = repCatalogo(), vistos = new Set();
  e.erroCfg = '';
  for (const x of itens) {
    const nome = repNome(x), conhecido = x.tipo === 'bola' ? !!repCatBolas || x.id <= 4 : !!repCatItens;
    if (x.ate <= x.abaixo) e.erroCfg = `${nome}: o "compra até" precisa ser maior que o "menos de".`;
    else if (vistos.has(repChave(x))) e.erroCfg = `${nome} está duas vezes na lista.`;
    else if (conhecido && !cat.some(y => y.tipo === x.tipo && y.id === x.id)) e.erroCfg = `${nome} não está à venda na loja.`;
    if (e.erroCfg) return repEnviar();
    vistos.add(repChave(x));
  }
  const ligou = !c.ligado && !!novo.ligado, desligou = c.ligado && !novo.ligado;
  Object.assign(c, { ligado: !!novo.ligado, tetoDia: num(novo.tetoDia, 0, 1e13), itens });
  // Item que saiu da lista ou foi desmarcado para de encher; item marcado de novo recomeça do zero
  for (const k of Object.keys(e.regras)) if (!itens.some(x => x.ativo && repChave(x) === k)) e.regras[k].enchendo = false;
  for (const x of itens) if (x.ativo && repRegra(e, repChave(x)).falhas >= 2) Object.assign(repRegra(e, repChave(x)), { falhas: 0, proxCompra: 0 });
  if (ligou) { e.pausa = 0; e.lidoEm = 0; for (const st of Object.values(e.regras)) Object.assign(st, { falhas: 0, proxCompra: 0 }); }
  saveCfg();
  if (ligou || desligou) {
    repLog(i, ligou ? `ligada: ${itens.filter(x => x.ativo).map(x => `${repNome(x)} abaixo de ${repFmt(x.abaixo)} até ${repFmt(x.ate)}`).join('; ') || 'nenhum item marcado'}${c.tetoDia ? `; no máximo ${repFmt(c.tetoDia)} coins por dia` : ''}` : 'desligada');
  }
  repEnviar();
}

// ---------- Monitor de Preços do RMT (só Conta 1) ----------
// Pede ao servidor o resumo do RMT (`market.itens`, a MESMA consulta que o jogo faz ao abrir a vitrine de
// itens): para cada item, o menor preço anunciado em gemas e em coins, quantos anúncios e a média de venda
// dos últimos 7 dias. Pokemon não entra (é outra consulta). É UMA chamada para todos os itens.
// Dois ritmos (23/10/2026, pedido do usuário para fazer trade):
//   - VERIFICAÇÃO a cada `verificarMin` (padrão 5 min, mínimo 2 — os Termos pedem para não sobrecarregar
//     o servidor): atualiza o "agora" e procura OPORTUNIDADES (menor anúncio bem abaixo da média de 7 dias);
//   - HISTÓRICO a cada `historicoMin` (padrão 60 min): o que vai para o gráfico.
// Guardado em precos.json, na pasta de dados, como linhas compactas por item:
//   [menorGema, menorCoin, anuncios, mediaGema7d, unidadesGema7d, mediaCoin7d, unidadesCoin7d]
const PRECO_CONTA = 0;
const PRECO_MAX_REG = 24 * 365; // um ano de histórico de hora em hora
const precosPath = () => path.join(app.getPath('userData'), 'precos.json');
let precosCache = null, precosWin = null, precoColetando = false, precoUltimaVerificacao = 0;

const precoOpcoes = () => {
  cfg.precos ??= {};
  return Object.assign(cfg.precos, {
    verificarMin: Math.max(2, Number(cfg.precos.verificarMin) || 5),
    historicoMin: Math.max(15, Number(cfg.precos.historicoMin) || 60),
    alertaPct: Math.min(90, Math.max(5, Number(cfg.precos.alertaPct) || 30)),
    alertaMinUnid: Math.max(0, Number(cfg.precos.alertaMinUnid ?? 20)),
    vendidosMin: !Number(cfg.precos.vendidosMin) ? 0 : Math.max(10, Number(cfg.precos.vendidosMin)),
    alertas: cfg.precos.alertas !== false
  });
};

function precosLer() {
  if (precosCache) return precosCache;
  try { precosCache = JSON.parse(fs.readFileSync(precosPath(), 'utf8')); } catch { precosCache = null; }
  if (!precosCache?.registros) precosCache = { versao: 1, nomes: {}, registros: [] };
  precosCache.alertas ??= [];      // os últimos avisos de oportunidade
  precosCache.avisados ??= {};     // item:moeda -> preço do último aviso (para não repetir)
  // O diário nasceu depois do histórico: na primeira leitura é montado com os pontos que já existem
  if (!precosCache.diario) {
    precosCache.diario = {};
    for (const r of precosCache.registros) somarNoDiario(precosCache, r.em, r.itens);
  }
  return precosCache;
}

// ---- Diário dos itens (velas): a cada verificação, por dia e por item, o menor anúncio do dia em
// gemas e em coins — abertura (1ª verificação), fechamento (última), mínima e máxima — e a média de
// venda de 7 dias e os anúncios da última verificação do dia:
//   [gAbre, gFecha, gMin, gMax, cAbre, cFecha, cMin, cMax, mediaGema, unidGema, mediaCoin, unidCoin, anuncios]
const diaDe = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function somarNoDiario(p, em, itens) {
  p.diario ??= {};
  const dia = (p.diario[diaDe(em)] ??= {});
  for (const [id, l] of Object.entries(itens)) {
    const d = (dia[id] ??= [null, null, null, null, null, null, null, null, null, null, null, null, 0]);
    for (const [col, base] of [[0, 0], [1, 4]]) {
      const v = l[col];
      if (v == null) continue;
      if (d[base] == null) d[base] = v;
      d[base + 1] = v;
      d[base + 2] = d[base + 2] == null ? v : Math.min(d[base + 2], v);
      d[base + 3] = d[base + 3] == null ? v : Math.max(d[base + 3], v);
    }
    d[8] = l[3]; d[9] = l[4]; d[10] = l[5]; d[11] = l[6]; d[12] = l[2];
  }
  // Dois anos de diário bastam
  const dias = Object.keys(p.diario).sort();
  for (const k of dias.slice(0, Math.max(0, dias.length - 730))) delete p.diario[k];
}
function precosGravar() {
  try { fs.writeFileSync(precosPath(), JSON.stringify(precosCache)); } catch (e) { appLog(`preços: não gravei (${e.message})`); }
}

// As colunas de cada moeda na linha do item
const COL_PRECO = { orb: { min: 0, med: 3, uni: 4 }, gold: { min: 1, med: 5, uni: 6 } };
const ehStone = nome => /\bstone$/i.test(nome || '');

// OPORTUNIDADE: o menor anúncio está `alertaPct`% (ou mais) abaixo da média de venda dos 7 dias, num item
// que vende (`alertaMinUnid` unidades na semana). Avisa uma vez; avisa de novo só se cair mais 10% ou se
// o preço subir de volta acima do limite e depois cair outra vez. Stones em gemas ficam de fora.
function procurarOportunidades(itens, p) {
  const o = precoOpcoes();
  const novas = [];
  for (const [id, l] of Object.entries(itens)) {
    for (const moeda of ['orb', 'gold']) {
      if (moeda === 'orb' && ehStone(p.nomes[id])) continue;
      const c = COL_PRECO[moeda];
      const min = l[c.min], med = l[c.med], uni = l[c.uni] ?? 0;
      const k = `${id}:${moeda}`;
      if (min == null || !med || uni < o.alertaMinUnid) continue;
      const desconto = (med - min) / med * 100;
      if (desconto < o.alertaPct) continue;
      // No máximo um aviso por item a cada 6 h — a não ser que caia mais 10% abaixo do último aviso.
      // (Antes o aviso "rearmava" quando o preço voltava acima do limite: um item oscilando entre 2 e
      // 5 gemas avisava a cada 5 min — foram 200 avisos num dia.)
      const antes = p.avisados[k];
      const ant = typeof antes === 'number' ? { preco: antes, em: 0 } : antes;
      if (ant && Date.now() - ant.em < 6 * 3600e3 && min > ant.preco * 0.9) continue;
      p.avisados[k] = { preco: min, em: Date.now() };
      novas.push({ em: Date.now(), id: Number(id), moeda, preco: min, media: med, desconto: Math.round(desconto), anuncios: l[2] ?? 0 });
    }
  }
  if (!novas.length) return;
  p.alertas.push(...novas);
  if (p.alertas.length > 200) p.alertas.splice(0, p.alertas.length - 200);
  for (const a of novas) appLog(`preços: OPORTUNIDADE ${p.nomes[a.id] || a.id} a ${a.preco} ${a.moeda === 'orb' ? 'gemas' : 'coins'} (média 7d ${a.media}, -${a.desconto}%)`);
  if (!o.alertas || !Notification.isSupported()) return;
  const fmt = v => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const titulo = novas.length === 1 ? '📉 Oportunidade no RMT' : `📉 ${novas.length} oportunidades no RMT`;
  const corpo = novas.slice(0, 4).map(a => `${p.nomes[a.id] || a.id}: ${fmt(a.preco)} ${a.moeda === 'orb' ? 'gemas' : 'coins'} (−${a.desconto}% da média ${fmt(a.media)})`).join('\n');
  const n = new Notification({ title: titulo, body: corpo });
  n.on('click', () => { abrirPrecos({ item: novas[0].id, moeda: novas[0].moeda }); });
  n.show();
}

async function precoColetar(motivo = 'agendado') {
  if (precoColetando) return;
  const wc = views[PRECO_CONTA]?.webContents;
  if (!wc || wc.isDestroyed()) return;
  precoColetando = true;
  precoUltimaVerificacao = Date.now();
  try {
    // Pede e espera a resposta (até 15 s) pelo socket do jogo; os nomes vêm do catálogo do jogo
    const r = await wc.executeJavaScript(`(async () => {
      const antes = window.__pkmItensResp?.em || 0;
      if (!window.__pkmEnviar?.({ t: 'market.itens' })) return { erro: 'sem conexão com o jogo' };
      for (let i = 0; i < 30 && (window.__pkmItensResp?.em || 0) <= antes; i++) await new Promise(r => setTimeout(r, 500));
      if ((window.__pkmItensResp?.em || 0) <= antes) return { erro: 'o servidor não respondeu' };
      const nomes = {};
      if (!window.__pkmNomesOk) {
        try { const j = await (await fetch('/assets/items.json')).json(); for (const it of (j.items || j)) nomes[it.id] = it.name; window.__pkmNomesOk = true; } catch {}
      }
      // Itens do RMT que não estão no items.json (ex.: 70095): o nome vem do catálogo do Mercado
      for (const [id, n] of Object.entries(window.__pkmCatalogo || {})) if (!nomes[id]) nomes['cat:' + id] = n;
      return { resumo: window.__pkmItensResp.resumo, medias: window.__pkmItensResp.medias, nomes };
    })()`);
    if (r?.erro) { appLog(`preços: não verifiquei (${r.erro})`); return; }
    const p = precosLer();
    const itens = {};
    const n = x => (Number.isFinite(Number(x)) && x !== null ? Number(x) : null);
    const ids = new Set([...Object.keys(r.resumo || {}), ...Object.keys(r.medias || {})]);
    for (const id of ids) {
      const s = r.resumo?.[id] || {}, m = r.medias?.[id] || {};
      const linha = [n(s.minOrb), n(s.minGold), n(s.anuncios) ?? 0, n(m.orb?.media), n(m.orb?.unidades), n(m.gold?.media), n(m.gold?.unidades)];
      if (linha.some((v, k) => k !== 2 && v != null) || linha[2]) itens[id] = linha;
    }
    for (const [k, v] of Object.entries(r.nomes || {})) {
      // Nome do items.json vale sempre; o do catálogo do Mercado só preenche quem não tem nome
      if (k.startsWith('cat:')) { const id = k.slice(4); if (!p.nomes[id]) p.nomes[id] = v; }
      else p.nomes[k] = v;
    }
    p.atual = { em: Date.now(), itens };
    somarNoDiario(p, p.atual.em, itens);
    procurarOportunidades(itens, p);
    // Histórico: só quando já passou o intervalo dele desde o último ponto do gráfico
    const ult = p.registros.at(-1)?.em || 0;
    if (Date.now() - ult >= precoOpcoes().historicoMin * 60000 - 30000 || motivo !== 'agendado') {
      p.registros.push({ em: Date.now(), itens });
      if (p.registros.length > PRECO_MAX_REG) p.registros.splice(0, p.registros.length - PRECO_MAX_REG);
      appLog(`preços: registrei ${Object.keys(itens).length} itens no histórico (${motivo})`);
    }
    precosGravar();
    precosEnviar();
    ecEnviar();
  } catch (e) {
    appLog(`preços: erro ao verificar (${e.message})`);
  } finally {
    precoColetando = false;
  }
}

// Confere a cada minuto se já é hora da próxima verificação
function precoTalvezColetar() {
  if (Date.now() - precoUltimaVerificacao >= precoOpcoes().verificarMin * 60000 - 5000) precoColetar();
}

function precosEnviar(foco) {
  if (!precosWin || precosWin.isDestroyed()) return;
  const p = precosLer(), o = precoOpcoes();
  precosWin.webContents.send('pcstate', {
    nomes: p.nomes, registros: p.registros, atual: p.atual ?? null, alertas: p.alertas, opcoes: o, diario: p.diario,
    vendidos: vendResumo(p),
    proxima: precoUltimaVerificacao + o.verificarMin * 60000,
    proximoHistorico: (p.registros.at(-1)?.em || Date.now()) + o.historicoMin * 60000,
    coletando: precoColetando, foco: foco ?? null
  });
}

function abrirPrecos(foco) {
  if (!licenca.premium()) return licenca.pedirPremium('O 📈 Monitor de Preços');
  if (precosWin && !precosWin.isDestroyed()) {
    if (precosWin.isMinimized()) precosWin.restore();
    precosWin.focus();
    if (foco) precosEnviar(foco);
    return;
  }
  precosWin = new BrowserWindow({
    width: 1150, height: 800, parent: win, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Monitor de Preços do RMT',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  precosWin.on('page-title-updated', e => e.preventDefault());
  precosWin.loadFile(path.join(__dirname, 'precos.html'));
  precosWin.webContents.on('did-finish-load', () => precosEnviar(foco));
  precosWin.on('closed', () => { precosWin = null; });
}

function precoSalvarOpcoes(novo) {
  const o = precoOpcoes();
  for (const k of ['verificarMin', 'historicoMin', 'alertaPct', 'alertaMinUnid', 'vendidosMin']) if (k in (novo ?? {})) o[k] = Number(novo[k]);
  if ('alertas' in (novo ?? {})) o.alertas = !!novo.alertas;
  precoOpcoes(); // aplica os limites
  saveCfg();
  appLog(`preços: verificar a cada ${o.verificarMin} min, histórico a cada ${o.historicoMin} min, alerta a -${o.alertaPct}% com ${o.alertaMinUnid}+ vendas, avisos ${o.alertas ? 'ligados' : 'desligados'}, vendidos ${o.vendidosMin ? `a cada ${o.vendidosMin} min` : 'desligado'}`);
  precosEnviar();
}

// ---------- Vendidos por dia (gráfico Diário do Monitor de Preços) ----------
// Pedido do usuário em 03/11/2026: "aparecer quantos foram vendidos cada dia no gráfico". O `market.itens` só diz o total
// dos últimos 7 dias, numa janela móvel; o número de cada dia sai da Tabela de preços do jogo (`market.historicoGlobal`),
// que traz venda por venda: 30 por página e até 41 páginas por recorte (shared/tabela-precos.mjs do jogo). Duas leituras:
//   · AS NOVAS, a cada `vendidosMin`: a tabela de todos os itens, da mais nova até encostar na última venda já contada.
//     Só entram na conta quando a leitura termina: se cair no meio, a próxima relê, sem contar nada duas vezes.
//   · OS TRECHOS QUE FALTAM (`fila`), uma página a cada 5 s: item por item e moeda por moeda, da venda mais nova para a
//     mais velha. Rodam uma vez para os dias que o gráfico já tinha, e de novo se o app ficar tanto tempo fechado que as
//     41 páginas das novas não alcançam a última contada. Item muito vendido não alcança o dia anterior: a leitura para
//     assim que vê que não vai fechar mais um dia inteiro, e o que sobrou fica em `faltam` (o gráfico marca esses dias).
// Em precos.json, `vend`: { marca e marcaEm (a última venda contada), inicio, dias: { dia: { item: [unGema, valorGema,
// unCoin, valorCoin] } }, faltam: { 'item:moeda': [[de, ate]] }, buracos: [[de, ate]], fila: [{ k, de, deId, ateId, pag, un }] }.
const VEND_TESTE = process.env.PKM_VEND_TESTE === '1';
const VEND_PAGINAS = 41;
const VEND_ESPERA_MS = VEND_TESTE ? 20 : 5000;
let vendOcupado = false, vendUlt = 0, vendEnviado = 0;
const vendSemItem = new Set();

const vendEstado = p => (p.vend ??= { marca: 0, marcaEm: 0, inicio: 0, dias: {}, faltam: {}, fila: [] });
const vendResumo = p => { const v = vendEstado(p); return { inicio: v.inicio, dias: v.dias, faltam: v.faltam, buracos: v.buracos ?? [], fila: v.fila.length }; };
// A venda de item vem como o recibo do Mercado: "4× TM Disk Piece", com o nome do catálogo
const vendQtd = l => Number(l.qtd) || Number(/^(\d+)\s*[×x]\s/i.exec(l.descricao ?? '')?.[1] ?? /^(\d+)×/.exec(l.descricao ?? '')?.[1]) || 1;
const vendNome = l => String(l.descricao ?? '').replace(/^\d+\s*(×\s*|x\s+)/i, '').replace(/\s*#\d+$/, '').trim().toLowerCase();

// Casa e Bicicleta vêm com número de série no recibo ("Common Bicycle #000452"), e até 04/11/2026 a leitura das novas
// não as reconhecia: do dia em que a contagem começou em diante, ficaram sem elas. Recontadas uma vez, pela fila.
function vendRecontarSeriais(p, v) {
  if (v.seriais || !v.marca) return;
  v.seriais = true;
  const de = new Date(v.inicio).setHours(0, 0, 0, 0);
  for (const [id, nome] of Object.entries(p.nomes)) {
    if (!/\b(house|bicycle)$/i.test(nome) || !p.atual?.itens?.[id]) continue;
    for (const moeda of ['orb', 'gold']) {
      const k = `${id}:${moeda}`, b = moeda === 'orb' ? 0 : 2;
      for (const [dia, d] of Object.entries(v.dias)) if (d[id] && new Date(`${dia}T00:00`).getTime() >= de) { d[id][b] = 0; d[id][b + 1] = 0; }
      (v.faltam[k] ??= [[0, de]]).push([de, v.marcaEm]);
      v.fila.push({ k, de, deId: 0, ateId: v.marca + 1, pag: 0, un: 0 });
    }
  }
  v.fila.sort((a, b) => a.un - b.un);
  appLog(`vendidos: recontando casas e bicicletas desde ${new Date(de).toLocaleDateString('pt-BR')}; ${v.fila.length} listas na fila`);
}

function vendSomar(v, id, moeda, qtd, bruto, em) {
  const c = ((v.dias[diaDe(em)] ??= {})[id] ??= [0, 0, 0, 0]), b = moeda === 'orb' ? 0 : 2;
  c[b] += qtd;
  c[b + 1] += Number(bruto) || 0;
}

function vendEnviar(ja) {
  if (!precosWin || precosWin.isDestroyed() || (!ja && Date.now() - vendEnviado < 20000)) return;
  vendEnviado = Date.now();
  precosWin.webContents.send('pcvend', vendResumo(precosLer()));
}

// Põe na fila o trecho sem contagem, de `de` até a venda `velha`, para cada item e moeda que o monitor acompanha. Os que
// venderam menos vêm primeiro: são poucas páginas, e os dias deles aparecem logo.
function vendEnfileirar(p, deId, de, velha) {
  const v = vendEstado(p), dentroDos7 = Date.now() - de < 7 * 864e5, itens = p.atual?.itens ?? {};
  const buracosAntes = [...(v.buracos ??= [])];
  // Item que nunca apareceu no monitor também tem de saber deste trecho: entra em `buracos`, que vale para quem não tem
  // `faltam` próprio. E quem já tem `faltam` entra na fila mesmo que a verificação de agora não traga o item.
  if (deId) v.buracos.push([de, velha.em]);
  const chaves = new Set(Object.keys(v.faltam));
  for (const [id, l] of Object.entries(itens)) for (const [moeda, c] of Object.entries(COL_PRECO)) if (l[c.min] != null || l[c.uni] != null) chaves.add(`${id}:${moeda}`);
  for (const k of chaves) {
    const [id, moeda] = k.split(':'), un = itens[id]?.[COL_PRECO[moeda].uni];
    // Nenhuma venda nos últimos 7 dias: um trecho dentro deles não tem o que contar
    if (dentroDos7 && itens[id] && !un) { if (!deId) v.faltam[k] ??= []; continue; }
    (v.faltam[k] ??= deId ? [[0, v.inicio], ...buracosAntes.map(t => [...t])] : []).push([de, velha.em]);
    v.fila.push({ k, de, deId, ateId: velha.id, pag: 0, un: un ?? 0 });
  }
  v.fila.sort((a, b) => a.un - b.un);
}

// As vendas novas de todos os itens. Devolve quantas páginas leu, ou -1 se não conseguiu.
async function vendLerNovas() {
  const p = precosLer(), v = vendEstado(p), primeira = !v.marca;
  const wc = views[PRECO_CONTA]?.webContents;
  const catalogo = wc && !wc.isDestroyed() ? await wc.executeJavaScript('window.__pkmCatalogo ?? null').catch(() => null) : null;
  const porNome = new Map([...Object.entries(p.nomes), ...Object.entries(catalogo ?? {})].map(([id, n]) => [String(n).toLowerCase(), Number(id)]));
  const novas = new Map();
  let encostou = false, acabou = false, pg = 0;
  for (; pg < VEND_PAGINAS; pg++) {
    const r = await pkmPedir({ t: 'market.historicoGlobal', tipo: 'item', pagina: pg, seq: ++pkmSeq }, 'historicoGlobal');
    if (r?.erro) { appLog(`vendidos: não li as vendas novas (${r.erro})`); return -1; }
    const linhas = r.linhas || [];
    if (primeira && linhas[0]) appLog(`vendidos: campos de uma venda: ${Object.keys(linhas[0]).join(', ')}`);
    for (const l of linhas) { if (l.id <= v.marca) encostou = true; else novas.set(l.id, l); }
    acabou = !r.temMais && (pg < VEND_PAGINAS - 1 || linhas.length < 30);
    if (encostou || !r.temMais || primeira) { pg++; break; }
    await espera(VEND_TESTE ? 5 : 1200);
  }
  if (!novas.size) return pg;
  for (const l of novas.values()) {
    const id = Number(l.itemId) || porNome.get(vendNome(l));
    if (id) { vendSomar(v, id, l.moeda, vendQtd(l), l.bruto, l.em); continue; }
    if (!vendSemItem.has(vendNome(l))) { vendSemItem.add(vendNome(l)); appLog(`vendidos: venda de um item que não reconheci: "${l.descricao}"`); }
  }
  const ids = [...novas.keys()], velha = novas.get(Math.min(...ids)), antes = { id: v.marca, em: v.marcaEm };
  v.marca = Math.max(...ids);
  v.marcaEm = novas.get(v.marca).em;
  if (primeira) {
    v.inicio = velha.em;
    const primeiroDia = Object.keys(p.diario ?? {}).sort()[0];
    const de = primeiroDia ? new Date(`${primeiroDia}T00:00`).getTime() : velha.em;
    if (de < velha.em) vendEnfileirar(p, 0, de, velha);
    appLog(`vendidos: comecei a contar em ${new Date(velha.em).toLocaleString('pt-BR')}; ${v.fila.length} listas para preencher os dias anteriores`);
  } else if (!encostou && !acabou) {
    vendEnfileirar(p, antes.id, antes.em, velha);
    appLog(`vendidos: as 41 páginas não alcançaram a última venda contada; faltam as de ${new Date(antes.em).toLocaleString('pt-BR')} a ${new Date(velha.em).toLocaleString('pt-BR')}, ${v.fila.length} listas na fila`);
  }
  const dias = Object.keys(v.dias).sort();
  for (const k of dias.slice(0, Math.max(0, dias.length - 730))) delete v.dias[k];
  return pg;
}

// Uma página do primeiro trecho da fila. Devolve false se não conseguiu.
async function vendLerFila(p, v) {
  const job = v.fila[0], [id, moeda] = job.k.split(':');
  const r = await pkmPedir({ t: 'market.historicoGlobal', tipo: 'item', itemId: Number(id), moeda, pagina: job.pag, seq: ++pkmSeq }, 'historicoGlobal');
  if (r?.erro) { appLog(`vendidos: parei a fila (${r.erro})`); return false; }
  const linhas = r.linhas || [];
  let chegou = false, ateId = job.ateId;
  const trecho = v.faltam[job.k]?.find(t => t[0] === job.de);
  for (const l of linhas) {
    if (l.id <= job.deId || l.em < job.de) { chegou = true; continue; }
    if (l.id >= job.ateId) continue; // já contada (a página andou porque entraram vendas novas)
    vendSomar(v, id, moeda, vendQtd(l), l.bruto, l.em);
    if (l.id < ateId) { ateId = l.id; if (trecho) trecho[1] = l.em; }
  }
  job.ateId = ateId;
  job.pag++;
  const acabou = chegou || (!r.temMais && (job.pag < VEND_PAGINAS || linhas.length < 30));
  // Pelo ritmo das páginas lidas, as que restam fecham o trecho ou o dia em que a leitura está? Se não, parar aqui poupa
  // o servidor: dia pela metade não muda o gráfico. O dobro do ritmo é a folga: a madrugada vende menos que o resto do dia.
  const em = trecho?.[1] ?? Date.now();
  const alcance = em - 2 * (Date.now() - em) / job.pag * (VEND_PAGINAS - job.pag);
  const naoFecha = job.pag >= 3 && alcance > Math.max(new Date(em).setHours(0, 0, 0, 0), job.de);
  if (acabou || !r.temMais || job.pag >= VEND_PAGINAS || naoFecha) {
    v.fila.shift();
    if (acabou) v.faltam[job.k] = (v.faltam[job.k] ?? []).filter(t => t !== trecho);
    appLog(`vendidos: ${p.nomes[id] ?? id} em ${moeda === 'orb' ? 'gemas' : 'coins'}: ${acabou ? 'dias anteriores contados' : `sem contagem antes de ${new Date(em).toLocaleString('pt-BR')}`} (${job.pag} página(s)); ${v.fila.length} na fila`);
    precosGravar();
    vendEnviar(!v.fila.length);
  } else if (job.pag % 10 === 0) precosGravar();
  return true;
}

async function vendTick() {
  const o = precoOpcoes();
  if (vendOcupado || !o.vendidosMin || !precosLer().atual) return;
  vendOcupado = true;
  try {
    vendRecontarSeriais(precosLer(), vendEstado(precosLer()));
    for (;;) {
      const p = precosLer(), v = vendEstado(p);
      if (Date.now() - vendUlt >= o.vendidosMin * 60000 - 5000) {
        vendUlt = Date.now();
        const pg = await vendLerNovas();
        if (pg < 0) { vendUlt = 0; break; }       // tenta de novo no próximo minuto
        if (pg > 8) vendUlt -= o.vendidosMin * 30000; // Mercado agitado: a próxima leitura vem na metade do tempo
        precosGravar();
        vendEnviar(true);
      }
      if (!v.fila.length || !await vendLerFila(p, v)) break;
      await espera(VEND_ESPERA_MS);
    }
  } catch (e) {
    appLog(`vendidos: erro (${e.message})`);
  } finally {
    vendOcupado = false;
  }
}

// ---------- Monitor de Pokémons do RMT (só Conta 1) ----------
// Três coletas, todas pelo socket do jogo, devagar (1,2 s entre pedidos) para não pesar no servidor:
//   1. VENDAS (a cada `vendasMin`, padrão 20 min): a Tabela de preços global do jogo
//      (`market.historicoGlobal`, tipo pokemon), 30 vendas por página, da mais nova para a mais
//      velha, até chegar numa venda já guardada. A ficha de cada venda já vem com a NOTA (0–10 dentro
//      da espécie, a mesma do jogo). É com elas que se avalia o preço por nota.
//   2. GRADE (a cada `gradeMin`, padrão 60 min): `market.especies`, 24 espécies por página, com
//      anúncios e o menor preço em gemas e em coins — vira o diário de cada espécie.
//   3. OBSERVADAS (a cada `avaliarMin`, padrão 30 min): os anúncios (`market.listar`) das espécies
//      marcadas, comparados ao preço estimado para a nota de cada um; avisa os que estão baratos.
// A grade e a vitrine passam pela tela do jogo: com o Mercado aberto na Conta 1 elas esperam.
// Vendas guardadas como linhas compactas (90 dias):
//   [idVenda, em, especie, preco, moeda(0=coins,1=gemas), nota, nivel, shiny, potencia, ivTotal, qualidade, tm,
//    vendedor, comprador (índices em `contas`), transferência entre contas (1/0),
//    ivs, tmElemental, marcas, minutos até a leitura]
// Vendedor e comprador só existem a partir de 26/10/2026; as vendas de antes ficam sem as três últimas posições.
// As quatro últimas (para o 💲 Precificador) existem desde 06/11/2026, ver pkmFichaExtra; as de antes recebem as três
// primeiras pela busca por espécie (pkmCompletarFichas).
const PKM_DIAS = 90;
const pkmPath = () => path.join(app.getPath('userData'), 'pokemons.json');
let pkmCache = null, pkmWin = null, pkmOcupado = false, pkmAviso = '';
const pkmUlt = { vendas: 0, grade: 0, avaliar: 0 };

const pkmOpcoes = () => {
  cfg.pokemons ??= {};
  const o = cfg.pokemons;
  return Object.assign(o, {
    vendasMin: Math.max(10, Number(o.vendasMin) || 20),
    gradeMin: Math.max(30, Number(o.gradeMin) || 60),
    avaliarMin: Math.max(10, Number(o.avaliarMin) || 30),
    alertaPct: Math.min(90, Math.max(5, Number(o.alertaPct) || 30)),
    minVendas: Math.max(3, Number(o.minVendas) || 6),
    alertas: o.alertas !== false,
    observadas: Array.isArray(o.observadas) ? o.observadas.map(Number).filter(Boolean).slice(0, 8) : []
  });
};

function pkmLer() {
  if (pkmCache) return pkmCache;
  try { pkmCache = JSON.parse(fs.readFileSync(pkmPath(), 'utf8')); } catch { pkmCache = null; }
  pkmCache ??= {};
  pkmCache.especies ??= {};
  pkmCache.vendas ??= [];
  pkmCache.ultimaVenda ??= 0;
  pkmCache.gradeDia ??= {};       // dia -> especie -> [anuncios, menorCoin, menorGema]
  pkmCache.gradeAtual ??= null;   // { em, esp: { id: [anuncios, menorCoin, menorGema, shinys] } }
  pkmCache.ofertas ??= {};        // especie -> { em, linhas: [[idAnuncio, preco, moeda, nota, nivel, shiny, potencia, vendedor, compravelEm, tm, ivTotal, qualidade]] }
  pkmCache.alertas ??= [];
  pkmCache.avisados ??= {};       // idAnuncio -> preço avisado
  pkmCache.contas ??= [];         // nomes de vendedor/comprador; as vendas guardam o índice
  pkmCache.buracos ??= [];        // [[de, ate]]: trechos em que faltam vendas (ver pkmColetarVendas)
  // A mesma venda duas vezes (achado em 06/11/2026: 31 vendas repetidas, linha igual, de antes): fica a primeira
  const vistas = new Set(), antes = pkmCache.vendas.length;
  pkmCache.vendas = pkmCache.vendas.filter(v => (vistas.has(v[0]) ? false : (vistas.add(v[0]), true)));
  if (pkmCache.vendas.length < antes) appLog(`pokémons: ${antes - pkmCache.vendas.length} vendas repetidas tiradas`);
  pkmMarcarTransferencias(pkmCache);
  return pkmCache;
}

// O índice de um nome em `contas` (o nome inteiro em cada venda dobraria o arquivo)
let pkmContaIdx = null;
function idxConta(p, nome) {
  nome = String(nome ?? '');
  pkmContaIdx ??= new Map(p.contas.map((n, i) => [n, i]));
  let i = pkmContaIdx.get(nome);
  if (i == null) { i = p.contas.length; p.contas.push(nome); pkmContaIdx.set(nome, i); }
  return i;
}

// TRANSFERÊNCIA entre contas da mesma pessoa não é preço de mercado: na Tabela de preços de 26/10/2026 as
// vendas "fulano → fulano2" tinham mediana de 378 gemas, contra 15 das outras. Três regras:
//   · o mesmo nome tirando números, símbolos e sufixos de conta reserva (Fulano → Fulano4);
//   · nome QUASE igual (até 2 letras de diferença, 5+ letras: Ciclano → ZCiclan, Valhala → Valhalla), desde
//     que o par seja 30%+ das compras do comprador — sem isso "Beltrano13 → Beltran" (um comprador que compra
//     de todo mundo) virava transferência;
//   · comprador "exclusivo": 4+ compras do mesmo vendedor em 14 dias, e 60%+ das compras dele vêm desse
//     vendedor (Fulana → FulanaDark). Quem compra de todo mundo fica de fora (o do exemplo: 9%).
// Marca a venda com 1 na posição 14; o preço estimado (aqui, na janela e na Economia) não a usa.
const raizConta = n => String(n).toLowerCase().replace(/[^a-z]/g, '').replace(/(alt|bank|banco|farm|conta|main|reserva)+$/, '');
// Quantas letras trocar, pôr ou tirar para um nome virar o outro (Levenshtein), parando em `teto` + 1
function distanciaNomes(a, b, teto = 2) {
  if (Math.abs(a.length - b.length) > teto) return teto + 1;
  let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const at = [i];
    for (let j = 1; j <= b.length; j++) at[j] = Math.min(ant[j] + 1, at[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...at) > teto) return teto + 1;
    ant = at;
  }
  return ant[b.length];
}
function pkmMarcarTransferencias(p) {
  const corte = Date.now() - 14 * 864e5;
  const compras = new Map(), par = new Map(), parecido = new Map();
  for (const v of p.vendas) {
    if (v[1] < corte || v[12] == null) continue;
    compras.set(v[13], (compras.get(v[13]) || 0) + 1);
    par.set(`${v[12]}:${v[13]}`, (par.get(`${v[12]}:${v[13]}`) || 0) + 1);
  }
  for (const v of p.vendas) {
    if (v[12] == null) continue;
    const k = `${v[12]}:${v[13]}`, n = par.get(k) || 0, fatia = n / (compras.get(v[13]) || 1);
    if (!parecido.has(k)) {
      const a = p.contas[v[12]], b = p.contas[v[13]], ra = raizConta(a), rb = raizConta(b);
      parecido.set(k, a === b || (ra.length >= 4 && ra === rb) ? 'igual'
        : ra.length >= 5 && rb.length >= 5 && distanciaNomes(ra, rb) <= 2 ? 'quase' : '');
    }
    const nome = parecido.get(k);
    v[14] = nome === 'igual' || (nome === 'quase' && fatia >= 0.3) || (n >= 4 && fatia >= 0.6) ? 1 : 0;
  }
}
function pkmGravar() {
  try { fs.writeFileSync(pkmPath(), JSON.stringify(pkmCache)); } catch (e) { appLog(`pokémons: não gravei (${e.message})`); }
}

// O que o 💲 Precificador precisa de cada venda, além do que o Monitor sempre guardou (posições 15 a 18): os 6 IVs
// em 6 letras (o IV − 1 em base 32, na ordem hp atk def spAtk spDef speed), o tipo do Z-Move, as marcas (1 AoE,
// 2 Z-Move físico, 4 refino, 8 TM incerto, 16 ficha completada depois) e quantos minutos depois da venda ela foi
// lida. A ficha da Tabela de preços é a de QUANDO SE LÊ: um TM posto depois da venda não estava no preço.
const temRefino = r => {
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return false; } }
  return !!r && typeof r === 'object' && Object.values(r).some(x => Number(x) > 0);
};
const pkmFichaExtra = (f, em, lidaEm) => [PR.ivsParaTexto(f.ivs), f.tmElemental ? String(f.tmElemental) : '',
  ((f.tmAoe ?? f.tm_aoe) ? 1 : 0) | (f.tmFisico === true ? 2 : 0) | (temRefino(f.refino) ? 4 : 0),
  Math.max(0, Math.round((lidaEm - em) / 60000))];

// COMPLETAR AS FICHAS (06/11/2026): as vendas guardadas antes do Precificador têm só a SOMA dos IVs, e o Poder
// precisa dos seis. A Tabela de preços do jogo busca por espécie (`busca`) nos últimos 30 dias, até 41 páginas de 30
// (shared/tabela-precos.mjs), e cada venda volta com a ficha inteira: o app procura cada venda guardada pelo id e
// completa os IVs. Uma espécie por vez, uma página a cada 4 s, nunca junto com a coleta do Monitor; é uma vez só
// (cada espécie fica marcada em `completar`), e as vendas novas já chegam completas. Espécie com mais de 41 páginas
// tenta também a ordem das mais caras e a das mais baratas. Do Z-Move e do AoE, a ficha de hoje só vale se a venda
// já tinha TM quando foi lida (posição 11); se hoje ela tem os dois, ou nenhum, o TM fica incerto (marca 8).
const PKM_COMPLETAR_MS = process.env.PKM_COMPLETAR_TESTE === '1' ? 50 : 4000;
let pkmCompletando = false;
async function pkmCompletarFichas() {
  return; // edição de venda: desligada
  if (pkmCompletando || pkmOcupado || !jogoLer()) return;
  const p = pkmLer();
  const c = (p.completar ??= { especies: {}, linhas: 0 });
  if (c.desligado) return;
  const corte = Date.now() - 30 * 864e5;
  const faltam = new Map(), maisVelha = new Map();
  for (const v of p.vendas) {
    if (v[4] !== 1 || v[1] < corte || v[15] != null || c.especies[v[2]]) continue;
    faltam.set(v[0], v);
    maisVelha.set(v[2], Math.min(maisVelha.get(v[2]) ?? Infinity, v[1]));
  }
  if (!faltam.size) return;
  pkmCompletando = true;
  let paginas = 0, achadas = 0, feitas = 0;
  try {
    // As espécies com mais vendas primeiro (o nome mais longo antes, quando um nome está dentro do outro)
    const fila = [...maisVelha.keys()].map(id => ({ id, nome: p.especies[id] || jogoLer()?.especies?.[id]?.n || '', n: [...faltam.values()].filter(v => v[2] === id).length }))
      .filter(e => e.nome).sort((a, b) => b.n - a.n || b.nome.length - a.nome.length);
    for (const e of fila) {
      if (c.especies[e.id]) continue; // completada junto com outra
      let achouAqui = 0, parou = '', seguir = false;
      for (const ordem of ['recentes', 'baratos', 'caros']) {
        // A próxima ordem só quando a anterior bateu nas 41 páginas sem cobrir tudo, e ainda falta venda desta espécie
        if (ordem !== 'recentes' && (!seguir || ![...faltam.values()].some(v => v[2] === e.id))) break;
        for (let pg = 0; pg < 41; pg++) {
          while (pkmOcupado) await espera(2000);
          const msg = { t: 'market.historicoGlobal', tipo: 'pokemon', moeda: 'orb', busca: e.nome, pagina: pg, seq: ++pkmSeq };
          if (ordem !== 'recentes') msg.ordem = ordem;
          const r = await pkmPedir(msg, 'historicoGlobal');
          paginas++;
          if (r?.erro) { parou = r.erro; break; }
          const linhas = (r.linhas || []).filter(l => l.tipo === 'pokemon' && l.ficha);
          // A busca tem de filtrar: se nenhuma venda da página tem o nome buscado, o jogo ignorou a busca
          if (linhas.length && !linhas.some(l => String(l.ficha.nome || '').toLowerCase().includes(e.nome.toLowerCase()))) {
            c.desligado = `a busca por espécie não filtrou (${e.nome})`;
            appLog(`pokémons: completar fichas DESLIGADO: ${c.desligado}`);
            return;
          }
          let velha = Infinity;
          for (const l of linhas) {
            velha = Math.min(velha, l.em);
            const v = faltam.get(l.id);
            if (!v || !pkmCompletarLinha(v, l.ficha)) continue;
            faltam.delete(l.id);
            achadas++; achouAqui++;
          }
          // Chegou às mais velhas que faltam, ou acabaram as vendas: a busca cobriu tudo. Na 41ª página o jogo para (e
          // diz que não tem mais): com a página cheia e sem ter chegado às mais velhas, bateu no teto.
          if (!linhas.length || (ordem === 'recentes' && velha < (maisVelha.get(e.id) ?? 0))) { seguir = false; break; }
          if (pg === 40) { seguir = linhas.length >= 30; break; }
          if (!r.temMais) { seguir = false; break; }
          await espera(PKM_COMPLETAR_MS);
        }
        if (parou) break;
      }
      if (parou) { appLog(`pokémons: completar fichas parou em ${e.nome} (${parou}); tenta de novo depois`); break; }
      c.especies[e.id] = 1;
      feitas++;
      c.linhas = (c.linhas || 0) + achouAqui;
      if (feitas % 10 === 0) { pkmGravar(); prEnviar(); }
      await espera(PKM_COMPLETAR_MS);
    }
  } finally {
    pkmCompletando = false;
    if (feitas || achadas) {
      pkmGravar();
      prEnviar();
      appLog(`pokémons: completei a ficha de ${achadas} vendas (${feitas} espécies, ${paginas} páginas); faltam ${faltam.size}`);
    }
  }
}
// Uma venda guardada ganha os IVs (e o TM, se ela já tinha TM quando foi lida) da ficha de hoje
function pkmCompletarLinha(v, f) {
  const ivs = PR.ivsParaTexto(f.ivs);
  if (!ivs) return false;
  const zHoje = f.tmElemental ? String(f.tmElemental) : '', aoeHoje = !!(f.tmAoe ?? f.tm_aoe);
  let z = '', marcas = 16 | (temRefino(f.refino) ? 4 : 0);
  if (v[11] === 1) {
    if (zHoje && aoeHoje || !zHoje && !aoeHoje) marcas |= 8;
    z = zHoje;
    if (aoeHoje) marcas |= 1;
    if (f.tmFisico === true) marcas |= 2;
  }
  while (v.length < 15) v.push(v.length === 14 ? 0 : null);
  v[15] = ivs; v[16] = z; v[17] = marcas; v[18] = null;
  return true;
}

async function pkmPedir(msg, aba) {
  const wc = views[PRECO_CONTA]?.webContents;
  if (!wc || wc.isDestroyed()) return { erro: 'sem a conta 1' };
  return wc.executeJavaScript(`window.__pkmPedir ? window.__pkmPedir(${JSON.stringify(msg)}, ${JSON.stringify(aba)}) : { erro: 'jogo ainda carregando' }`).catch(e => ({ erro: e.message }));
}
const pkmMercadoAberto = () => views[PRECO_CONTA]?.webContents.executeJavaScript('window.__pkmMercadoAberto?.() ?? false').catch(() => false);
const espera = ms => new Promise(r => setTimeout(r, ms));
let pkmSeq = 900000;

// 1. Vendas novas da Tabela de preços global
// Lê até encostar nas vendas já guardadas. Antes eram no máximo 12 páginas (360 vendas) por coleta, e no
// pico do meio-dia de 26/10/2026 saíram até 88 vendas por MINUTO: o app perdeu ~500 vendas, e como a marca
// avançava mesmo assim, nenhuma coleta voltava para buscá-las. Agora a marca (`ultimaVenda`) só avança
// quando a leitura chega nela, ou quando não há mais como chegar (ver `buracos` abaixo); fora do pico
// continua sendo 1 a 3 páginas. Devolve quantas páginas leu.
async function pkmColetarVendas() {
  const p = pkmLer();
  const primeira = !p.vendas.length;
  const maxPaginas = primeira ? 40 : 120;
  const conhecidas = new Set(p.vendas.map(v => v[0]));
  let novas = 0, maior = p.ultimaVenda, parou = '', chegou = false, encostou = false, pg = 0, maisVelha = Infinity;
  for (; pg < maxPaginas; pg++) {
    const r = await pkmPedir({ t: 'market.historicoGlobal', tipo: 'pokemon', pagina: pg, seq: ++pkmSeq }, 'historicoGlobal');
    if (r?.erro) { parou = r.erro; break; }
    const lidaEm = Date.now();
    for (const v of r.linhas || []) {
      if (v.tipo !== 'pokemon' || !v.ficha) continue;
      if (v.id <= p.ultimaVenda) { encostou = true; continue; }
      maisVelha = Math.min(maisVelha, v.em);
      if (conhecidas.has(v.id)) continue;
      conhecidas.add(v.id);
      const f = v.ficha;
      p.especies[f.speciesId] ??= f.nome;
      p.vendas.push([v.id, v.em, f.speciesId, Number(v.bruto) || 0, v.moeda === 'orb' ? 1 : 0, f.nota ?? null, f.level ?? null,
        f.shiny ? 1 : 0, f.potencia ?? null, f.ivTotal ?? null, f.quality ?? null, (f.tmElemental || f.tmAoe) ? 1 : 0,
        idxConta(p, v.vendedor), idxConta(p, v.comprador), 0, ...pkmFichaExtra(f, v.em, lidaEm)]);
      maior = Math.max(maior, v.id);
      novas++;
    }
    if (encostou || !r.temMais) { chegou = true; pg++; break; }
    await espera(1200);
  }
  // A leitura acabou sem encostar nas guardadas: o app ficou fechado tempo demais (mais de 120 páginas de vendas)
  // ou o histórico do jogo já não tem as mais velhas. As vendas entre a marca e a mais velha lida ficam faltando.
  // A marca avança assim mesmo (parada, toda coleta releria as 120 páginas, para sempre), e o trecho vai para
  // `buracos`: o "Por dia" da janela avisa que esses dias estão incompletos.
  const buraco = !encostou && !primeira && !parou && maisVelha < Infinity;
  if (buraco) {
    const de = p.vendas.reduce((m, v) => v[0] <= p.ultimaVenda && v[1] > m ? v[1] : m, 0);
    if (de && de < maisVelha) {
      p.buracos.push([de, maisVelha]);
      appLog(`pokémons: faltam as vendas de ${new Date(de).toLocaleString('pt-BR')} a ${new Date(maisVelha).toLocaleString('pt-BR')} (a leitura não alcançou as guardadas)`);
    }
  }
  if (chegou || primeira || buraco) p.ultimaVenda = maior;
  const corte = Date.now() - PKM_DIAS * 864e5;
  p.vendas = p.vendas.filter(v => v[1] >= corte).sort((a, b) => a[1] - b[1]);
  p.buracos = p.buracos.filter(b => b[1] >= corte);
  if (novas) pkmMarcarTransferencias(p);
  if (novas || parou) appLog(`pokémons: ${novas} vendas novas em ${pg} página(s)${parou ? ` (parou: ${parou})` : ''}${!chegou && !primeira && !buraco ? ' — ainda falta encostar nas guardadas' : ''}, ${p.vendas.length} guardadas`);
  return chegou ? pg : maxPaginas;
}

// 2. A grade de espécies (anúncios e menor preço) -> diário
async function pkmColetarGrade() {
  const p = pkmLer();
  const esp = {};
  let total = Infinity, pg = 0;
  while (pg * 24 < total && pg < 40) {
    if (await pkmMercadoAberto()) return 'adiada (mercado aberto)';
    const r = await pkmPedir({ t: 'market.especies', tipo: 'pokemon', moeda: '', busca: '', ordem: 'recentes', criterios: [], elementos: [], pagina: pg }, 'especies');
    if (r?.erro) return r.erro;
    total = Number(r.total) || 0;
    for (const e of r.linhas || []) {
      esp[e.speciesId] = [e.anuncios ?? 0, e.minGold ?? null, e.minOrb ?? null, e.shinys ?? 0];
      p.especies[e.speciesId] ??= e.nome;
    }
    pg++;
    await espera(1200);
  }
  p.gradeAtual = { em: Date.now(), esp };
  const dia = (p.gradeDia[diaDe(Date.now())] ??= {});
  for (const [id, [n, g, o]] of Object.entries(esp)) {
    const d = (dia[id] ??= [n, g, o]);
    d[0] = n;
    if (g != null) d[1] = d[1] == null ? g : Math.min(d[1], g);
    if (o != null) d[2] = d[2] == null ? o : Math.min(d[2], o);
  }
  const dias = Object.keys(p.gradeDia).sort();
  for (const k of dias.slice(0, Math.max(0, dias.length - 365))) delete p.gradeDia[k];
  appLog(`pokémons: grade com ${Object.keys(esp).length} espécies`);
  return '';
}

// O VALOR de um pokemon: a mediana do preço das vendas MAIS PARECIDAS com ele (mesma espécie e moeda,
// últimos 30 dias). "Parecida" pesa a nota (o principal), o nível (que mexe muito no preço — um Nv 500
// vale outra coisa), a potência e o TM; shiny só se compara com shiny. Começou como uma reta
// log(preço) × nota, mas as vendas se concentram em N3,5–5 e a reta extrapolava para bilhões: a
// mediana dos vizinhos não inventa preço onde não houve venda. Sem vendas parecidas, sem valor.
// Mesma conta em pokemons.html.
function pkmAvaliar(vendas, especie, moeda, alvo, minVendas) {
  const corte = Date.now() - 30 * 864e5;
  const cand = vendas.filter(v => !v[14] && v[2] === especie && v[4] === moeda && !!v[7] === !!alvo.shiny && v[5] != null && v[3] > 0 && v[1] >= corte);
  if (cand.length < minVendas || alvo.nota == null) return null;
  const lg = x => Math.log10(Math.max(1, Number(x) || 1));
  const dist = v => Math.abs(v[5] - alvo.nota) / 0.2 + Math.abs(lg(v[6]) - lg(alvo.nivel)) / 0.25
    + (v[8] !== alvo.potencia ? 0.6 : 0) + (!!v[11] !== !!alvo.tm ? 1 : 0);
  const viz = cand.map(v => ({ v, d: dist(v) })).sort((a, b) => a.d - b.d).slice(0, Math.min(8, cand.length));
  const dm = viz.reduce((s, x) => s + x.d, 0) / viz.length;
  if (dm > 3) return null; // nada parecido o bastante
  const p = viz.map(x => x.v[3]).sort((a, b) => a - b), k = p.length >> 1;
  return { valor: p.length % 2 ? p[k] : (p[k - 1] + p[k]) / 2, n: viz.length, distancia: dm };
}

// Linha compacta de um anúncio de pokemon (a janela lê pelas posições):
//   [idAnuncio, preco, moeda(0 coins, 1 gemas), nota, nivel, shiny, potencia, vendedor, compravelEm, tm, ivTotal, qualidade,
//    ivs [hp, atk, def, spAtk, spDef, speed] | null, tipo do Z-Move | '', Z-Move físico (1/0), especie]
// O IV de cada stat e o Z-Move vêm na ficha do anúncio (é o que a ficha do jogo desenha); anúncio antigo pode vir sem.
const IV_CHAVES = ['hp', 'atk', 'def', 'spAtk', 'spDef', 'speed'];
function linhaDoAnuncio(a) {
  const f = a.ficha;
  return [a.id, Number(a.preco) || 0, a.moeda === 'orb' ? 1 : 0, f.nota ?? null, f.level ?? null, f.shiny ? 1 : 0, f.potencia ?? null,
    a.vendedor ?? '', a.compravelEm ?? 0, (f.tmElemental || f.tmAoe) ? 1 : 0, f.ivTotal ?? null, f.quality ?? null,
    f.ivs && typeof f.ivs === 'object' ? IV_CHAVES.map(k => Number(f.ivs[k]) || 0) : null,
    f.tmElemental ? String(f.tmElemental) : '', f.tmFisico === true ? 1 : 0, Number(f.speciesId) || 0];
}
// O Mercado do jogo ORDENA por estes critérios (ORDER BY ... DESC, e o "mais baratos" fecha); são os do
// menu "Filtrar por" da vitrine. A janela usa o IV de ATK ou de SP.ATK, conforme os golpes da espécie.
const PKM_CRITERIOS = new Set(['ivAtk', 'ivSpAtk', 'ivSpd', 'nota', 'iv', 'qualidade', 'potencia', 'nivel']);
const pkmErroDaConta = erro => erro === 'sem conexão com o jogo' || erro === 'jogo ainda carregando'
  ? 'A Conta 1 não está conectada ao jogo agora (entrando ou reconectando). Tente de novo em instantes.'
  : `o jogo não respondeu (${erro}). Tente de novo.`;

// 3. Avalia os anúncios das espécies observadas e avisa as pechinchas
// Os filtros que o próprio servidor aceita no `market.listar` (as faixas da barra do Mercado do jogo e
// o "Só shiny"): com eles a busca recorta TODOS os anúncios da espécie, e não só as primeiras páginas.
function pkmFiltrosServidor(f) {
  if (!f || typeof f !== 'object') return {};
  const out = {};
  const num = (v, dec) => { const n = Number(String(v ?? '').replace(',', '.')); return v === '' || v == null || !Number.isFinite(n) ? '' : dec ? String(n) : Math.round(n); };
  for (const [c, dec] of [['nivelMin', 0], ['nivelMax', 0], ['potenciaMin', 0], ['potenciaMax', 0], ['ivMin', 0], ['ivMax', 0], ['qualidadeMin', 1], ['qualidadeMax', 1], ['notaMin', 1], ['notaMax', 1]]) {
    const v = num(f[c], dec);
    if (v !== '') out[c] = v;
  }
  if (f.shiny === 'so') out.soShiny = true;
  return out;
}

async function pkmAvaliarObservadas(soEstas = null, filtros = null) {
  const p = pkmLer(), o = pkmOpcoes();
  const lista = soEstas ?? o.observadas;
  const novos = [];
  const fs_ = pkmFiltrosServidor(filtros);
  // "⚔ Atacantes" na janela: os anúncios com o maior IV de ATK (ou SP.ATK) primeiro, em vez dos mais baratos
  const criterios = PKM_CRITERIOS.has(filtros?.criterio) ? [filtros.criterio] : [];
  for (const especie of lista) {
    if (await pkmMercadoAberto()) return 'adiada (mercado aberto)';
    const linhas = [];
    for (let pg = 0; pg < 3; pg++) {
      const r = await pkmPedir({ t: 'market.listar', tipo: 'pokemon', moeda: '', busca: '', ordem: 'baratos', criterios, elementos: [], pagina: pg, especieId: especie, ...fs_ }, 'vitrine');
      // Falhou já na 1ª página: não grava lista vazia por cima da que existia, e diz o porquê
      if (r?.erro && pg === 0) return pkmErroDaConta(r.erro);
      if (r?.erro) break;
      for (const a of r.linhas || []) {
        if (a.tipo !== 'pokemon' || !a.ficha) continue;
        p.especies[a.ficha.speciesId] ??= a.ficha.nome;
        linhas.push(linhaDoAnuncio(a));
      }
      if ((pg + 1) * 24 >= (Number(r.total) || 0)) break;
      await espera(1200);
    }
    p.ofertas[especie] = { em: Date.now(), linhas, filtros: fs_, pedido: filtros ?? {} };
    // Aviso de pechincha só nas espécies observadas ★ (olhar uma espécie na janela não dispara aviso)
    if (!o.observadas.includes(especie)) { await espera(1200); continue; }
    for (const moeda of [0, 1]) {
      for (const l of linhas) {
        if (l[2] !== moeda || l[3] == null) continue;
        const av = pkmAvaliar(p.vendas, especie, moeda, { nota: l[3], nivel: l[4], shiny: l[5], potencia: l[6], tm: l[9] }, o.minVendas);
        if (!av) continue;
        const est = av.valor;
        const desconto = (est - l[1]) / est * 100;
        if (desconto < o.alertaPct) continue;
        if (p.avisados[l[0]] != null && l[1] >= p.avisados[l[0]]) continue;
        p.avisados[l[0]] = l[1];
        novos.push({ em: Date.now(), especie, anuncio: l[0], preco: l[1], moeda, nota: l[3], nivel: l[4], estimado: Math.round(est), desconto: Math.round(desconto), vendedor: l[7] });
      }
    }
    await espera(1200);
  }
  if (novos.length) {
    p.alertas.push(...novos);
    if (p.alertas.length > 200) p.alertas.splice(0, p.alertas.length - 200);
    const ids = new Set(Object.values(p.ofertas).flatMap(x => x.linhas.map(l => String(l[0]))));
    for (const k of Object.keys(p.avisados)) if (!ids.has(k)) delete p.avisados[k]; // anúncio que sumiu
    const fmt = v => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
    for (const a of novos) appLog(`pokémons: PECHINCHA ${p.especies[a.especie]} N${a.nota} a ${a.preco} (estimado ${a.estimado}, -${a.desconto}%)`);
    if (o.alertas && Notification.isSupported()) {
      const n = new Notification({
        title: novos.length === 1 ? '🐉 Pechincha de pokémon no RMT' : `🐉 ${novos.length} pechinchas de pokémon no RMT`,
        body: novos.slice(0, 4).map(a => `${p.especies[a.especie]} N${(a.nota ?? 0).toFixed(2)}: ${fmt(a.preco)} ${a.moeda ? 'gemas' : 'coins'} (vale ~${fmt(a.estimado)}, −${a.desconto}%)`).join('\n')
      });
      n.on('click', () => abrirPokemons({ especie: novos[0].especie }));
      n.show();
    }
  }
  return '';
}

// ⚔ ATACANTES de todas as espécies: os anúncios com o MAIOR IV de ATK e os com o maior IV de SP.ATK (o
// próprio Mercado ordena por IV de cada stat), 3 páginas de cada — os mais baratos dentro do mesmo IV.
// Se o IV alto está no stat que os golpes da espécie usam, quem julga é a janela (pokemons.html).
// São 6 pedidos, 1,2 s entre eles, e só quando a pessoa clica.
async function pkmBuscarAtacantes(moeda, filtros) {
  const p = pkmLer();
  const fs_ = pkmFiltrosServidor(filtros);
  const linhas = new Map();
  for (const criterio of ['ivAtk', 'ivSpAtk']) {
    for (let pg = 0; pg < 3; pg++) {
      if (await pkmMercadoAberto()) return 'adiada (mercado aberto)';
      const r = await pkmPedir({ t: 'market.listar', tipo: 'pokemon', moeda, busca: '', ordem: 'baratos', criterios: [criterio], elementos: [], pagina: pg, especieId: 0, ...fs_ }, 'vitrine');
      if (r?.erro && !linhas.size) return pkmErroDaConta(r.erro);
      if (r?.erro) break;
      for (const a of r.linhas || []) {
        if (a.tipo !== 'pokemon' || !a.ficha) continue;
        p.especies[a.ficha.speciesId] ??= a.ficha.nome;
        linhas.set(a.id, linhaDoAnuncio(a));
      }
      if ((pg + 1) * 24 >= (Number(r.total) || 0)) break;
      await espera(1200);
    }
  }
  p.atacantes = { em: Date.now(), moeda, linhas: [...linhas.values()], pedido: filtros ?? {} };
  return '';
}

// ---------- Dados do jogo: golpes, tipos e stats-base de cada espécie, e os ícones ----------
// O catálogo de espécies é montado no CLIENTE do jogo, a partir de vários arquivos públicos e ajustes
// (as planilhas de golpes, os golpes de 600, as megas…) — o creatures.json cru do Glaceon nem tem os
// golpes que a ficha mostra. Para ver os mesmos golpes, o app roda essa montagem com o código do próprio
// jogo (dados-jogo.js) numa janela escondida aberta no robots.txt do site: mesma origem dos arquivos,
// sem jogo, sem login e sem socket. Junto vêm os retratos do atlas de marcadores, numa folha de 32 px.
// Fica em jogo-especies.json + jogo-icones.png e é refeito a cada 3 dias ou pelo botão da janela.
// Versão 2 (Pokédex de consulta): + evoluções e "tem Mega" por espécie e jogo-sprites.png, os retratos em
// tamanho real. Dados de versão antiga são refeitos na próxima montagem (5 min depois de abrir o app).
const JOGO_VERSAO = 2;
const jogoEspPath = () => path.join(app.getPath('userData'), 'jogo-especies.json');
const jogoIcoPath = () => path.join(app.getPath('userData'), 'jogo-icones.png');
const jogoSprPath = () => path.join(app.getPath('userData'), 'jogo-sprites.png');
let jogoDados, jogoMontando = false, jogoErro = '';
function jogoLer() {
  if (jogoDados !== undefined) return jogoDados;
  try { jogoDados = JSON.parse(fs.readFileSync(jogoEspPath(), 'utf8')); } catch { jogoDados = null; }
  return jogoDados;
}
async function jogoMontar(forcar = false) {
  const d = jogoLer();
  const valem = d?.v === JOGO_VERSAO && Date.now() - d.em < 3 * 864e5 && fs.existsSync(jogoIcoPath()) && fs.existsSync(jogoSprPath());
  if (jogoMontando || (!forcar && valem)) return;
  jogoMontando = true;
  pkmEnviar();
  pdEnviar();
  const w = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:dados-jogo', sandbox: true, contextIsolation: true } });
  try {
    await w.loadURL('https://pokeidle.io/robots.txt');
    const r = await w.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'dados-jogo.js'), 'utf8'));
    const { png, ...icones } = r.icones, { png: sprPng, ...sprites } = r.sprites;
    fs.writeFileSync(jogoIcoPath(), Buffer.from(png.split(',')[1], 'base64'));
    fs.writeFileSync(jogoSprPath(), Buffer.from(sprPng.split(',')[1], 'base64'));
    jogoDados = { ...r, icones, sprites };
    fs.writeFileSync(jogoEspPath(), JSON.stringify(jogoDados));
    jogoErro = '';
    appLog(`dados do jogo: ${Object.keys(r.especies).length} espécies, ${icones.n} ícones`);
  } catch (e) {
    jogoErro = e.message;
    appLog(`dados do jogo: não montei (${e.message})`);
  } finally {
    if (!w.isDestroyed()) w.destroy();
    jogoMontando = false;
    pkmJogoEnviar();
    pdEnviar();
    huJogoEnviar();
    pkmEnviar();
  }
}
// Vai para a janela uma vez ao abrir e depois de cada montagem (a folha de ícones vai como data URL)
function pkmJogoEnviar() {
  if (!pkmWin || pkmWin.isDestroyed()) return;
  const d = jogoLer();
  let png = null;
  try { if (d) png = `data:image/png;base64,${fs.readFileSync(jogoIcoPath()).toString('base64')}`; } catch {}
  pkmWin.webContents.send('pkjogo', d ? { em: d.em, especies: d.especies, icones: png ? { ...d.icones, png } : null } : null);
}

// Uma coleta por vez; a cada minuto vê o que está vencido
async function pkmTalvezColetar(forcar = null) {
  if (pkmOcupado || (!forcar && !cfg.pokemonsUsado)) return;
  const o = pkmOpcoes(), agora = Date.now();
  const venc = k => forcar === k || forcar === 'tudo' || agora - pkmUlt[k] >= o[`${k}Min`] * 60000 - 5000;
  if (!venc('vendas') && !venc('grade') && !(venc('avaliar') && o.observadas.length)) return;
  pkmOcupado = true;
  pkmEnviar();
  try {
    // Mercado agitado (muitas páginas, ou a leitura não chegou nas guardadas): a próxima coleta vem em 5 min
    if (venc('vendas')) { pkmUlt.vendas = agora; if (await pkmColetarVendas() > 8) pkmUlt.vendas = agora - Math.max(0, o.vendasMin - 5) * 60000; }
    if (venc('grade')) { const r = await pkmColetarGrade(); if (!r) pkmUlt.grade = agora; else appLog(`pokémons: grade ${r}`); }
    if (venc('avaliar') && o.observadas.length) { const r = await pkmAvaliarObservadas(); if (!r) pkmUlt.avaliar = agora; else appLog(`pokémons: avaliação ${r}`); }
    pkmGravar();
  } catch (e) {
    appLog(`pokémons: erro (${e.message})`);
  } finally {
    pkmOcupado = false;
    pkmEnviar();
    ecEnviar();
    pkmRodarPendente(); // um pedido da janela que chegou durante a coleta
    prEnviar();
  }
}

// As janelas do Monitor e da Economia leem só as 15 primeiras posições de cada venda (as do Precificador ficam aqui)
const pkmCurta = v => (v.length > 15 ? v.slice(0, 15) : v);
function pkmEnviar(foco) {
  if (!pkmWin || pkmWin.isDestroyed()) return;
  const p = pkmLer(), o = pkmOpcoes();
  pkmWin.webContents.send('pkstate', {
    especies: p.especies, vendas: p.vendas.map(pkmCurta), contas: p.contas, buracos: p.buracos, gradeAtual: p.gradeAtual, gradeDia: p.gradeDia,
    ofertas: p.ofertas, atacantes: p.atacantes ?? null, alertas: p.alertas, opcoes: o, ocupado: pkmOcupado, ult: pkmUlt, foco: foco ?? null,
    aviso: pkmAviso, jogo: { em: jogoLer()?.em ?? 0, montando: jogoMontando }
  });
}

function abrirPokemons(foco) {
  if (!licenca.premium()) return licenca.pedirPremium('O 🐉 Monitor de Pokémons');
  if (!cfg.pokemonsUsado) { cfg.pokemonsUsado = true; saveCfg(); }
  if (pkmWin && !pkmWin.isDestroyed()) {
    if (pkmWin.isMinimized()) pkmWin.restore();
    pkmWin.focus();
    if (foco) pkmEnviar(foco);
    return;
  }
  pkmWin = new BrowserWindow({
    width: 1250, height: 830, parent: win, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Monitor de Pokémons do RMT',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  pkmWin.on('page-title-updated', e => e.preventDefault());
  pkmWin.loadFile(path.join(__dirname, 'pokemons.html'));
  pkmWin.webContents.on('did-finish-load', () => { pkmJogoEnviar(); pkmEnviar(foco); });
  pkmWin.on('closed', () => { pkmWin = null; });
  if (!jogoLer()) jogoMontar();
}

function pkmSalvarOpcoes(novo) {
  const o = pkmOpcoes();
  for (const k of ['vendasMin', 'gradeMin', 'avaliarMin', 'alertaPct', 'minVendas']) if (k in (novo ?? {})) o[k] = Number(novo[k]);
  if ('alertas' in (novo ?? {})) o.alertas = !!novo.alertas;
  if (Array.isArray(novo?.observadas)) o.observadas = novo.observadas;
  pkmOpcoes();
  saveCfg();
  pkmEnviar();
}

// 💲 NA FICHA DO JOGO (07/11/2026, pedido do usuário): ao lado do "Copiar p/ ChatGPT" de qualquer ficha (a sua, a de um
// anúncio, a do ranking), um "💲 Precificar". Ele aperta o botão do próprio jogo, que copia a ficha em texto, e avisa o
// app pelo console; o app lê a área de transferência e abre o Precificador com a ficha colada. O Z-Move e o AoE não vêm
// no texto: saem dos selos da ficha (o cristal /img/itens/zmove/<tipo>.png e o selo .tm-selo.aoe).
const FICHA_PRECO_SCRIPT = `(() => {
  if (window.__pkmFichaPreco) return;
  window.__pkmFichaPreco = true;
  let espera = null;
  const pegar = texto => {
    if (!espera || typeof texto !== 'string') return;
    const p = espera;
    espera = null;
    console.debug('__pkmPrecoFicha:' + JSON.stringify({ ...p, texto }));
  };
  try {
    const cb = navigator.clipboard, orig = cb.writeText.bind(cb);
    cb.writeText = t => { pegar(t); return orig(t); };
  } catch (e) {}
  document.addEventListener('copy', () => { const el = document.activeElement; if (el && el.tagName === 'TEXTAREA') pegar(el.value); }, true);
  const por = () => {
    const gpt = document.getElementById('fi-gpt');
    if (!gpt || document.getElementById('pkm-preco')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'pkm-preco';
    b.className = gpt.className.replace('btn-apagado', '').replace(/ +/g, ' ').trim();
    b.title = 'Mostra aqui o preço em gemas desta ficha: Vender rápido, Preço justo e Esperar (copia a ficha, como o botão ao lado)';
    b.innerHTML = '<span>💲 Precificar</span>';
    b.onclick = ev => {
      ev.stopPropagation();
      const caixa = gpt.closest('[role="dialog"], .dlg, .modal, .fi-ficha, .ficha') || document;
      const img = caixa.querySelector('.tm-selo img[src*="/zmove/"]');
      const z = img ? ((img.getAttribute('src') || '').split('/zmove/')[1] || '').split('.')[0] || 'sim' : '';
      const aoe = !!caixa.querySelector('.tm-selo.aoe');
      caixaRes('<div style="opacity:.8">Calculando o preço…</div>');
      // O texto é pego na hora em que o jogo copia (a leitura da área de transferência pelo app falhava no jogo de verdade)
      const pedido = { z: z.toUpperCase(), aoe };
      espera = pedido;
      gpt.click();
      setTimeout(() => { if (espera === pedido) { espera = null; console.debug('__pkmPrecoFicha:' + JSON.stringify(pedido)); } }, 2500);
    };
    gpt.after(b);
  };
  // A caixa do resultado, logo abaixo dos botões, ocupando a linha inteira
  const caixaRes = html => {
    const b = document.getElementById('pkm-preco');
    if (!b) return null;
    let box = document.getElementById('pkm-preco-res');
    if (!box) {
      box = document.createElement('div');
      box.id = 'pkm-preco-res';
      box.style.cssText = 'flex-basis:100%;grid-column:1/-1;width:100%;box-sizing:border-box;margin:6px 0;padding:10px 12px;border-radius:10px;' +
        'background:rgba(30,18,40,.92);border:2px solid #b07ad8;color:#f3e9ff;font-size:13px;line-height:1.35;text-align:left';
      b.after(box);
    }
    box.innerHTML = html;
    const det = box.querySelector('[data-pkm-det]');
    if (det) det.onclick = e => { e.stopPropagation(); console.debug('__pkmPrecoDetalhe:1'); };
    return box;
  };
  const fmt = n => Math.round(n).toLocaleString('pt-BR');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  window.__pkmPrecoMostrar = r => {
    const det = '<span data-pkm-det style="cursor:pointer;text-decoration:underline;color:#d9b8ff;white-space:nowrap">Ver detalhes ›</span>';
    let h = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><b style="font-size:14px">💲 Preço em gemas</b>' +
      (r.conf != null ? '<span style="opacity:.85">· Confiança ' + r.conf + '%</span>' : '') + '<span style="flex:1"></span>' + det + '</div>';
    if (r.erro) { caixaRes(h + '<div>' + esc(r.erro) + '</div>'); return; }
    if (r.sem) h += '<div>Ainda não há vendas suficientes para comparar este pokémon.</div>';
    else {
      const col = (rot, v, destaque) => '<div style="flex:1;text-align:center;padding:6px 4px;border-radius:8px;' +
        (destaque ? 'background:rgba(255,215,90,.16);border:1px solid #ffd75a' : 'background:rgba(255,255,255,.06)') + '">' +
        '<div style="font-size:11px;opacity:.85">' + rot + '</div><div style="font-size:' + (destaque ? 19 : 16) + 'px;font-weight:800;color:' + (destaque ? '#ffd75a' : '#fff') + '">' + fmt(v) + '</div></div>';
      h += '<div style="display:flex;gap:6px">' + col('Vender rápido', r.low) + col('Preço justo', r.median, true) + col('Esperar', r.high) + '</div>';
    }
    const notas = [];
    if (r.adicionais) notas.push('Inclui ' + esc(r.adicionais) + '.');
    if (r.refino) notas.push('Não conta o refino.');
    if (r.fora) notas.push('O Mercado só aceita anúncio com Nv 50 e Nota 3,5 para cima: é só uma referência.');
    if (notas.length) h += '<div style="margin-top:6px;font-size:12px;opacity:.85">' + notas.join(' ') + '</div>';
    caixaRes(h);
  };
  setInterval(por, 700);
})();`;
// A leitura do texto do "Copiar p/ ChatGPT" (a mesma do lerFicha de precificar.html)
function prLerFicha(texto) {
  const linhas = String(texto || '').split(/\r?\n/);
  const campo = nome => { const re = new RegExp('^\\s*[-*]?\\s*(?:' + nome + ')\\s*:\\s*(.+)$', 'i'); for (const l of linhas) { const m = l.match(re); if (m) return m[1].trim(); } return null; };
  const inteiro = s => { const m = String(s ?? '').match(/\d[\d.,]*/); return m ? Number(m[0].replace(/[.,]/g, '')) : null; };
  const decimal = s => { const m = String(s ?? '').match(/\d+(?:[.,]\d+)?/); return m ? Number(m[0].replace(',', '.')) : null; };
  const esp = campo('esp[ée]cie|species');
  const idTxt = esp?.match(/\(#(\d+)\)/)?.[1];
  const nome = esp ? esp.replace(/\s*\(#\d+\).*$/, '').replace(/\s+[—–-]\s+[A-Z /]+$/, '').replace(/✨/g, '').trim() : null;
  const ST = { HP: 'hp', ATK: 'atk', DEF: 'def', SPATK: 'spAtk', SPDEF: 'spDef', SPD: 'speed', SPEED: 'speed', SPE: 'speed' };
  const ivs = {};
  let cols = null, refino = false;
  for (const l of linhas) {
    if (!l.trim().startsWith('|')) continue;
    const row = l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (/^stat$/i.test(row[0])) { cols = { base: row.findIndex(c => /^(?:species )?base/i.test(c)), iv: row.findIndex(c => /^iv\b/i.test(c)), refino: row.findIndex(c => /refino|refine/i.test(c)) }; continue; }
    const k = ST[row[0].toUpperCase().replace(/[^A-Z]/g, '')];
    if (!cols || !k || cols.iv < 0) continue;
    const iv = inteiro(row[cols.iv]);
    if (Number.isInteger(iv)) ivs[k] = iv;
    const rf = cols.refino >= 0 ? inteiro(row[cols.refino]) : inteiro(String(row[cols.base] ?? '').match(/\+\s*([\d.,]+)/)?.[1]);
    if (rf > 0) refino = true;
  }
  const especies = jogoLer()?.especies;
  let speciesId = idTxt ? Number(idTxt) : null;
  if ((!speciesId || especies?.[speciesId]?.n?.toLowerCase() !== nome?.toLowerCase()) && nome && especies) {
    const alvo = nome.toLowerCase();
    speciesId = Number(Object.keys(especies).find(id => especies[id].n.toLowerCase() === alvo)) || (especies[speciesId] ? speciesId : null);
  }
  return { speciesId, nome, level: inteiro(campo('n[íi]vel|level')), potencia: inteiro(campo('pot[êe]ncia|potency')), quality: decimal(campo('qualidade|quality')),
    nota: decimal(campo('nota(?: da calculadora)?|calculator score')), shiny: /^(sim|yes|true)\b/i.test(campo('shiny') || ''), ivs, refino };
}
// Atualizado em 07/11/2026 (pedido do usuário): o preço aparece na própria ficha do jogo; a janela só abre no "Ver detalhes"
async function prFichaDoJogo(i, json) {
  if (!cfg.pokemonsUsado) { cfg.pokemonsUsado = true; saveCfg(); }
  let f = {};
  try { f = JSON.parse(json); } catch {}
  const wc = views[i]?.webContents;
  const mostrar = r => { if (wc && !wc.isDestroyed()) wc.executeJavaScript(`window.__pkmPrecoMostrar && window.__pkmPrecoMostrar(${JSON.stringify(r)})`).catch(() => {}); };
  const texto = typeof f.texto === 'string' && f.texto ? f.texto : clipboard.readText();
  if (!/esp[ée]cie|species|especie/i.test(texto)) {
    appLog(`precificador: a ficha da ${cfg.names[i]} não chegou (${f.texto ? 'texto do jogo' : 'área de transferência'}: ${JSON.stringify(String(texto).slice(0, 80))})`);
    return mostrar({ erro: 'A ficha não chegou ao app. Tente de novo.' });
  }
  prFichaUltima[i] = { texto, z: f.z || '', aoe: !!f.aoe, conta: cfg.names[i] };
  const especies = jogoLer()?.especies;
  if (!especies) { if (!jogoMontando) jogoMontar(); return mostrar({ erro: 'O app ainda está montando os dados do jogo. Tente de novo em alguns segundos.' }); }
  const fi = prLerFicha(texto), falta = [];
  if (!fi.speciesId || !especies[fi.speciesId]) falta.push('a espécie');
  if (!(fi.level > 0)) falta.push('o nível');
  if (!(fi.potencia >= 1)) falta.push('a potência');
  if (!(fi.quality > 0)) falta.push('a qualidade');
  if (PR.STATS.some(k => !Number.isInteger(fi.ivs[k]))) falta.push('os 6 IVs');
  if (falta.length) return mostrar({ erro: `Não achei ${falta.join(', ')} na ficha.` });
  const r = prPrecificar({ speciesId: fi.speciesId, level: fi.level, potencia: fi.potencia, quality: fi.quality, shiny: fi.shiny, ivs: fi.ivs,
    tmElemental: f.z ? true : null, tmAoe: !!f.aoe, nota: fi.nota });
  if (r.erro) return mostrar({ erro: r.erro });
  const out = { conf: r.confidence?.percent ?? null, refino: fi.refino, fora: fi.level < 50 || r.nota == null || r.nota < 3.5 - 1e-9,
    adicionais: (r.parts || []).map(p => p.label).join(', ').replace(/, ([^,]*)$/, ' e $1') };
  if (r.available) Object.assign(out, { low: r.low, median: r.median, high: r.high }); else out.sem = true;
  mostrar(out);
  appLog(`precificador: ficha na ${cfg.names[i]}: ${r.name} Nv ${fi.level} → ${r.available ? `${r.low}/${r.median}/${r.high} gemas` : 'sem vendas'}`);
}
// "Ver detalhes" na ficha: abre a janela com a última ficha daquela conta
function prFichaDetalhe(i) {
  const d = prFichaUltima[i];
  if (!d) return abrirPrecificador();
  if (prWin && !prWin.isDestroyed()) prWin.webContents.send('prficha', d); else prFichaPendente = d;
  abrirPrecificador();
}
let prFichaPendente = null;
const prFichaUltima = {};

// ---------- 💲 Precificador: quanto pedir, em gemas, por um pokémon ----------
// Pedido do usuário em 06/11/2026, depois de ver o "Precificador de Pokémon" de briaoAle (site de um jogador). O
// cálculo mora em precificador.js: o do site, licença MIT, refeito com os dados do app. Aqui fica o contexto (as
// vendas em gemas dos últimos 30 dias do Monitor, o preço dos fragmentos do Monitor de Preços, o catálogo do jogo e a
// curva do mercado, refeitos quando chega coisa nova), a calibração (o teste com as vendas recentes: correção, pesos
// da confiança e os números de acerto; refeita a cada 12 h, aos poucos, para não travar o app), os pokémon das 4
// contas (lidos do estado de cada uma, ver __pkmMeusPokemons) e a janela precificar.html.
const prCalibPath = () => path.join(app.getPath('userData'), 'precificador.json');
const PR_CALIB_MS = 12 * 3600e3;
let prWin = null, prCtxCache = null, prCalib, prCalibrando = false, prCalibProg = '';
function prCalibLer() {
  if (prCalib === undefined) { try { prCalib = JSON.parse(fs.readFileSync(prCalibPath(), 'utf8')); } catch { prCalib = null; } }
  return prCalib;
}
function prCtx() {
  const d = jogoLer();
  if (!d?.especies) return { erro: 'O app ainda está montando os dados do jogo (leva uns segundos depois de abrir).' };
  const p = pkmLer(), regs = precosLer().registros || [];
  const chave = `${d.em}|${p.vendas.length}|${p.vendas.at(-1)?.[0]}|${p.completar?.linhas ?? 0}|${regs.length}|${regs.at(-1)?.em}`;
  if (prCtxCache?.chave === chave && Date.now() - prCtxCache.em < 30 * 60000) return prCtxCache;
  const t0 = Date.now();
  const cat = PR.catalogo(d.especies), itemPrices = PR.cotacoesDosRegistros(regs);
  const { rows, pulou } = PR.linhas(p.vendas, cat, itemPrices);
  const fits = [false, true].map(sh => { const same = rows.filter(r => r.shiny === sh); return same.length >= 3 ? PR.marketFit(same) : null; });
  prCtxCache = { chave, em: Date.now(), cat, itemPrices, rows, pulou, fits, ms: Date.now() - t0 };
  return prCtxCache;
}
const prOpcoes = () => { cfg.precificador ??= {}; cfg.precificador.unidades ??= {}; return cfg.precificador; };

// alvo: { speciesId, level, potencia, quality, shiny, ivs: {hp…} ou 6 letras, tmElemental, tmAoe, nota? }
function prPrecificar(alvo, leve = false) {
  const c = prCtx();
  if (c.erro) return { erro: c.erro };
  if (!c.rows.length) return { erro: 'Ainda não há vendas em gemas guardadas. O app começa a ler as vendas do Mercado (pela Conta 1) alguns minutos depois que você abre o Precificador ou o Monitor de Pokémons.' };
  const cal = prCalibLer();
  try {
    const ivs = typeof alvo?.ivs === 'string' ? PR.ivsDeTexto(alvo.ivs) : alvo?.ivs;
    return PR.precificar({ ...alvo, ivs }, { cat: c.cat, rows: c.rows, itemPrices: c.itemPrices, unidades: prOpcoes().unidades, agora: Date.now(),
      pesos: cal?.pronto ? cal.pesos : undefined, bias: cal?.pronto ? cal.bias : undefined, fits: c.fits, leve });
  } catch (e) {
    return { erro: e.message };
  }
}
// Vários de uma vez (a lista da conta): só os três preços e a confiança, cedendo a vez ao resto do app entre um e outro
async function prPrecificarLote(alvos) {
  const out = {};
  for (const a of (Array.isArray(alvos) ? alvos : []).slice(0, 400)) {
    const r = prPrecificar(a, true);
    out[a.chave] = r.erro ? { erro: r.erro } : r.available ? { low: r.low, median: r.median, high: r.high, conf: r.confidence?.percent ?? null } : { sem: true };
    await new Promise(res => setImmediate(res));
  }
  return out;
}
// Os pokémon das 4 contas, com a Nota (a mesma conta do jogo) e se o Mercado aceita o anúncio (Nv 50 e nota 3,5)
async function prContas() {
  const c = prCtx();
  const out = [];
  for (let i = 0; i < TOTAL; i++) {
    const wc = views[i]?.webContents;
    let lista = null, erro = '';
    try { lista = wc && !wc.isDestroyed() ? await wc.executeJavaScript('window.__pkmMeusPokemons ? window.__pkmMeusPokemons() : null') : null; } catch (e) { erro = e.message; }
    if (Array.isArray(lista) && !c.erro) {
      for (const p of lista) {
        const ivs = PR.ivsDeTexto(p.ivs);
        p.nota = ivs && p.pot >= 1 ? c.cat.nota(p.sp, { ivs, quality: Number(p.q), potencia: Number(p.pot), shiny: !!p.sh }) : null;
        p.ivt = ivs ? PR.STATS.reduce((s, k) => s + ivs[k], 0) : null;
      }
    }
    out.push({ conta: i, nome: cfg.names[i], lista: Array.isArray(lista) ? lista : null,
      erro: Array.isArray(lista) ? '' : erro || (wc ? 'a conta ainda não entrou no jogo' : 'conta fechada') });
  }
  if (!prContasLogou) {
    prContasLogou = true;
    appLog(`precificador: pokémon das contas: ${out.map(c => `${c.nome} ${c.lista ? `${c.lista.length} (${c.lista.filter(p => p.ivs).length} com IVs)` : `– (${c.erro})`}`).join(', ')}`);
  }
  return out;
}
let prContasLogou = false;

// A calibração: o teste do precificador com as nossas vendas (cada venda dos últimos 7 dias precificada só com as de
// antes dela). Dá a correção (o desvio médio), os pesos da confiança e os números da tela. Roda aos poucos.
async function prCalibrar(forcar = false) {
  if (prCalibrando) return;
  const cal = prCalibLer();
  if (!forcar && cal?.em && Date.now() - cal.em < PR_CALIB_MS) return;
  const c = prCtx();
  if (c.erro || c.rows.length < 500) return;
  prCalibrando = true; prCalibProg = ''; prEnviar();
  const t0 = Date.now();
  try {
    const megaUnit = PR.megaUnitDe(c.itemPrices);
    const r = await PR.calibrar(c.rows, { cat: c.cat, megaUnit, agora: Date.now(), ceder: () => new Promise(res => setImmediate(res)),
      progresso: (n, total) => { prCalibProg = `${n} de ${total}`; prEnviar(); } });
    prCalib = { ...r, ms: Date.now() - t0 };
    fs.writeFileSync(prCalibPath(), JSON.stringify(prCalib));
    appLog(`precificador: calibrado com ${r.vendas} vendas em ${Math.round((Date.now() - t0) / 1000)} s` + (r.teste ? ` (a até 25%: ${Math.round(r.teste.ate25 * 100)}%, na faixa: ${Math.round(r.teste.dentroDaFaixa * 100)}%)` : ''));
  } catch (e) {
    appLog(`precificador: calibração falhou (${e.message})`);
  } finally {
    prCalibrando = false; prCalibProg = ''; prEnviar();
  }
}

function prEnviar() {
  if (!prWin || prWin.isDestroyed()) return;
  const c = prCtx(), cal = prCalibLer(), p = pkmLer();
  const corte = Date.now() - 30 * 864e5;
  const faltam = p.vendas.reduce((n, v) => n + (v[4] === 1 && v[1] >= corte && v[15] == null ? 1 : 0), 0);
  prWin.webContents.send('prstate', {
    erro: c.erro || '', vendas: c.rows?.length ?? 0, aprox: c.rows?.filter(r => r.aprox).length ?? 0, pulou: c.pulou ?? {},
    primeira: c.rows?.length ? Math.min(...c.rows.map(r => r.at)) : null, ultima: c.rows?.length ? Math.max(...c.rows.map(r => r.at)) : null,
    calib: cal, calibrando: prCalibrando, calibProg: prCalibProg, unidades: prOpcoes().unidades,
    completar: { faltam, feitas: p.completar?.linhas ?? 0, rodando: pkmCompletando, desligado: 'edição de venda' }
  });
}
function prJogoEnviar() {
  if (!prWin || prWin.isDestroyed()) return;
  const d = jogoLer();
  let ico = null, spr = null;
  try { if (d) ico = `data:image/png;base64,${fs.readFileSync(jogoIcoPath()).toString('base64')}`; } catch {}
  try { if (d?.v === JOGO_VERSAO) spr = `data:image/png;base64,${fs.readFileSync(jogoSprPath()).toString('base64')}`; } catch {}
  const especies = {};
  for (const [id, e] of Object.entries(d?.especies ?? {})) especies[id] = { n: e.n, t: e.t, i: e.i, ...(e.e ? { e: e.e } : {}) };
  prWin.webContents.send('prjogo', d ? { em: d.em, especies, icones: ico ? { ...d.icones, png: ico } : null, sprites: spr ? { ...d.sprites, png: spr } : null } : null);
}
function abrirPrecificador() {
  if (!licenca.premium()) return licenca.pedirPremium('O 💲 Precificador');
  if (!cfg.pokemonsUsado) { cfg.pokemonsUsado = true; saveCfg(); }
  if (prWin && !prWin.isDestroyed()) { if (prWin.isMinimized()) prWin.restore(); return prWin.focus(); }
  prWin = new BrowserWindow({
    width: 1280, height: 860, parent: win, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Precificador de Pokémon',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  prWin.on('page-title-updated', e => e.preventDefault());
  prWin.loadFile(path.join(__dirname, 'precificar.html'));
  prWin.webContents.on('did-finish-load', () => {
    prJogoEnviar(); prEnviar(); setTimeout(() => prCalibrar(), 3000);
    if (prFichaPendente) { prWin.webContents.send('prficha', prFichaPendente); prFichaPendente = null; }
  });
  prWin.on('closed', () => { prWin = null; });
  if (!jogoLer()) jogoMontar();
}

// ---------- Economia (cotação gema ⇄ coin, rotas, ciclos, flips) ----------
// Só lê o que os monitores já coletaram (precos.json e pokemons.json): nenhuma consulta a mais ao jogo.
// As contas moram em economia.html; aqui só se manda os dados, e de novo a cada coleta.
let ecWin = null;
function ecEnviar() {
  if (!ecWin || ecWin.isDestroyed()) return;
  const p = precosLer(), k = pkmLer();
  const corte = Date.now() - 8 * 864e5;
  const dias = Object.keys(p.diario ?? {}).sort().slice(-8); // o diário dos itens: o porquê das stones ficarem fora
  ecWin.webContents.send('ecstate', {
    precos: { atual: p.atual ?? null, nomes: p.nomes, diario: Object.fromEntries(dias.map(d => [d, p.diario[d]])) },
    pk: { vendas: k.vendas.filter(v => v[1] >= corte).map(pkmCurta), especies: k.especies, gradeAtual: k.gradeAtual }
  });
}
function abrirEconomia() {
  if (!licenca.premium()) return licenca.pedirPremium('A 💰 Economia');
  if (ecWin && !ecWin.isDestroyed()) { if (ecWin.isMinimized()) ecWin.restore(); return ecWin.focus(); }
  ecWin = new BrowserWindow({
    width: 1200, height: 820, parent: win, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Economia do RMT',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  ecWin.on('page-title-updated', e => e.preventDefault());
  ecWin.loadFile(path.join(__dirname, 'economia.html'));
  ecWin.webContents.on('did-finish-load', ecEnviar);
  ecWin.on('closed', () => { ecWin = null; });
}

// ---------- Pokédex de consulta (para o Mini Games) ----------
// As espécies do jogo com a sombra de cada uma, filtradas pelas pistas que QUEM JOGA marca (tipos, região,
// atributos, evolução, selos, 1ª letra e tamanho do nome). Só usa os dados do jogo que o app já guarda
// (jogo-especies.json + jogo-sprites.png): a janela não conversa com o jogo nem lê a rodada. É filha da janela
// principal: fica por cima dela sem esconder o jogo (com a aba escondida por 30 s o Mini Games pausa a sala).
let pdWin = null;
function pdEnviar() {
  if (!pdWin || pdWin.isDestroyed()) return;
  const d = jogoLer();
  let png = null;
  try { if (d?.v === JOGO_VERSAO) png = `data:image/png;base64,${fs.readFileSync(jogoSprPath()).toString('base64')}`; } catch {}
  const especies = {};
  if (png) for (const [id, e] of Object.entries(d.especies)) especies[id] = { n: e.n, t: e.t, b: e.b, l: e.l, m: e.m, e: e.e, i: e.i };
  pdWin.webContents.send('pdjogo', png ? { em: d.em, especies, sprites: { ...d.sprites, png } } : { montando: jogoMontando, erro: jogoErro }, { cores: !!cfg.pokedex?.cores });
}
function abrirPokedex() {
  if (!licenca.premium()) return licenca.pedirPremium('A 🔍 Pokédex');
  if (pdWin && !pdWin.isDestroyed()) { if (pdWin.isMinimized()) pdWin.restore(); return pdWin.focus(); }
  // Onde ficou da última vez (se ainda cabe numa tela); na primeira, encostada à direita da janela do app
  const b = cfg.pokedex?.bounds, wb = win.getBounds();
  const cabe = b && screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80);
  const largura = 560;
  pdWin = new BrowserWindow({
    ...(cabe ? b : { width: largura, height: Math.min(880, wb.height - 60), x: wb.x + wb.width - largura - 16, y: wb.y + 50 }),
    minWidth: 420, minHeight: 420, parent: win, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Pokédex de consulta',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  const w = pdWin, guardar = () => { if (!w.isDestroyed()) { (cfg.pokedex ??= {}).bounds = w.getNormalBounds(); saveCfg(); } };
  w.on('moved', guardar);
  w.on('resized', guardar);
  pdWin.on('page-title-updated', e => e.preventDefault());
  pdWin.loadFile(path.join(__dirname, 'pokedex.html'));
  pdWin.webContents.on('did-finish-load', pdEnviar);
  pdWin.on('closed', () => { pdWin = null; });
  const d = jogoLer();
  if (d?.v !== JOGO_VERSAO || !fs.existsSync(jogoSprPath())) jogoMontar(true);
}

// ---------- 🗺 Melhor hunt (o pokémon em campo de cada conta) ----------
// Pedido do usuário (29/10/2026, depois de ver o site "PokeIdle Ferramentas"): recomendar a hunt pelo pokémon
// principal da conta. Os dados vêm AO VIVO da conta (HUNT_ESCUTA: pokémon em campo, nível, boosts, a lista de hunts
// de hoje), as espécies selvagens do catálogo que o app já monta (stats base, tipos, golpes) e a luta é simulada na
// janela com as regras da Pokepédia (capítulos Combate, Stats e Tipos). Só calcula quando a janela pede, e nada é
// mandado ao jogo; com ela fechada, só as corridas medidas são juntadas (ritmoColetar, a cada 5 min).
let huWin = null;
function huJogoEnviar() {
  if (!huWin || huWin.isDestroyed()) return;
  const d = jogoLer();
  if (!d?.especies) return huWin.webContents.send('hujogo', null);
  const especies = {};
  for (const [id, e] of Object.entries(d.especies)) especies[id] = { n: e.n, t: e.t, b: e.b, g: e.g };
  huWin.webContents.send('hujogo', { em: d.em, especies });
}
async function huCalcular(i) {
  if (!huWin || huWin.isDestroyed() || !(i >= 0 && i < TOTAL)) return;
  const wc = views[i]?.webContents;
  let d = null;
  try { d = wc && !wc.isDestroyed() ? await wc.executeJavaScript('window.__pkmHuntDados ? window.__pkmHuntDados() : null') : null; } catch (e) { d = { erro: e.message }; }
  if (huWin && !huWin.isDestroyed()) huWin.webContents.send('hudados', { conta: i, d: d ?? { erro: 'a conta ainda não carregou o jogo' } });
  ritmoColetar();
}

// O RITMO das hunts desde o jogo 1.377 (28/10/2026, hunts "em bandos"): o tempo entre um abate e outro é a caminhada
// entre os bandos, e ela depende do MAPA (2,3 a 5,6 s por abate para quem mata de um golpe). Duas fontes:
//   · a tabela por mapa do site PokéIdle Hub (de um jogador, medida pela telemetria do PokeIdle Launcher), baixada no
//     máximo 1x por dia quando a 🗺 abre — só leitura, nada nosso vai para lá; guardada limpa (só números e nomes de
//     mapa) em ritmo-site.json, e a última boa fica se o site sair do ar;
//   · as corridas medidas nas 4 contas (HUNT_ESCUTA), juntadas a cada 5 min em ritmo-medido.json: as 3 últimas de
//     cada hunt, de 14 dias para cá (o ritmo muda quando o jogo muda).
const RITMO_SITE_URL = 'https://pokeidle-gg.pages.dev/data/jogo/ritmo-mapas.json';
const RITMO_TENTA_MS = process.env.PKM_RITMO_TESTE === '1' ? 2000 : 10 * 60000; // entre duas tentativas que falharam
const ritmoSitePath = () => path.join(app.getPath('userData'), 'ritmo-site.json');
const ritmoMedPath = () => path.join(app.getPath('userData'), 'ritmo-medido.json');
let ritmoSite, ritmoMed, ritmoBaixando = false, ritmoTentou = 0, ritmoErro = '', ritmoColetando = false;
function ritmoSiteLer() {
  if (ritmoSite === undefined) { try { ritmoSite = JSON.parse(fs.readFileSync(ritmoSitePath(), 'utf8')); } catch { ritmoSite = null; } }
  return ritmoSite;
}
// Arquivo de fora: passa só o que a conta usa, com cada número na faixa e cada nome de mapa no formato dos slugs do jogo
function ritmoLimpar(j) {
  const num = (v, a, b) => (typeof v === 'number' && v >= a && v <= b ? v : null);
  const slug = v => (typeof v === 'string' && /^[a-z0-9_]{1,60}$/.test(v) ? v : null);
  const mapas = {}, hunts = {}, biomas = {};
  for (const [k, m] of Object.entries(j?.mapas ?? {})) {
    const s = num(m?.s, 0.5, 30);
    if (slug(k) && s) mapas[k] = { s, medidas: num(m.medidas, 0, 1e6) ?? 0, ...(m.indireto ? { indireto: true } : {}) };
  }
  for (const [k, v] of Object.entries(j?.hunts ?? {})) if (slug(k) && slug(v)) hunts[k] = v;
  for (const [k, b] of Object.entries(j?.biomas ?? {})) if (/^[A-Z]{3,10}$/.test(k) && slug(b?.mapa)) biomas[k] = { mapa: b.mapa, acertos: num(b.acertos, 0, 1e6) ?? 0, de: num(b.de, 0, 1e6) ?? 0 };
  const f = j?.faixa ?? {}, faixa = { p10: num(f.p10, 0.5, 30), mediana: num(f.mediana, 0.5, 30), p90: num(f.p90, 0.5, 30) };
  if (!Object.keys(mapas).length || !faixa.mediana || !faixa.p10 || !faixa.p90) return null;
  return { geradoEm: /^\d{4}-\d\d-\d\d$/.test(j.geradoEm) ? j.geradoEm : '', mapas, hunts, fontes: (Array.isArray(j.fontes) ? j.fontes : []).filter(slug), biomas, faixa };
}
async function ritmoBaixar() {
  return;
  const s = ritmoSiteLer();
  if (ritmoBaixando || (s && Date.now() - s.em < 864e5) || Date.now() - ritmoTentou < RITMO_TENTA_MS) return;
  ritmoBaixando = true;
  ritmoTentou = Date.now();
  huRitmoEnviar();
  try {
    const r = await net.fetch(RITMO_SITE_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const txt = await r.text();
    if (txt.length > 3e6) throw new Error('arquivo grande demais');
    const t = ritmoLimpar(JSON.parse(txt));
    if (!t) throw new Error('formato que o app não conhece');
    ritmoSite = { em: Date.now(), t };
    fs.writeFileSync(ritmoSitePath(), JSON.stringify(ritmoSite));
    ritmoErro = '';
    appLog(`ritmo das hunts: tabela do site com ${Object.keys(t.mapas).length} mapas (gerada em ${t.geradoEm || '?'})`);
  } catch (e) {
    ritmoErro = e.message;
    appLog(`ritmo das hunts: não baixei a tabela do site (${e.message})`);
  } finally {
    ritmoBaixando = false;
    huRitmoEnviar();
  }
}
function ritmoMedLer() {
  if (!ritmoMed) { try { ritmoMed = JSON.parse(fs.readFileSync(ritmoMedPath(), 'utf8')); } catch {} }
  if (!Array.isArray(ritmoMed?.corridas)) ritmoMed = { v: 1, corridas: [] };
  return ritmoMed;
}
async function ritmoColetar() {
  if (ritmoColetando) return;
  ritmoColetando = true;
  const m = ritmoMedLer();
  let mudou = false;
  try {
    for (let i = 0; i < TOTAL; i++) {
      const wc = views[i]?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      let lista = null;
      // Página travada não segura a coleta das outras (nem a próxima)
      try { lista = await Promise.race([wc.executeJavaScript('window.__pkmRitmosTirar ? window.__pkmRitmosTirar() : []'), new Promise(r => setTimeout(r, 5000, null))]); } catch {}
      for (const c of Array.isArray(lista) ? lista : []) {
        if (typeof c?.slug !== 'string' || !c.slug || !(c.abates >= 21) || !c.heroi?.stats) continue;
        const id = `${i}:${c.inicio}:${c.slug}`, k = m.corridas.findIndex(x => x.id === id);
        const nova = { id, conta: i, pk: c.pk ?? null, slug: c.slug, inicio: c.inicio, ultimo: c.ultimo, abates: c.abates, golpes: c.golpes || 0, saz: c.saz || '', heroi: c.heroi };
        if (k >= 0) m.corridas[k] = nova; else m.corridas.push(nova);
        mudou = true;
      }
    }
    if (!mudou) return;
    const corte = Date.now() - 14 * 864e5, porHunt = new Map();
    m.corridas = m.corridas.filter(c => c.ultimo >= corte).sort((a, b) => b.ultimo - a.ultimo)
      .filter(c => { const n = (porHunt.get(c.slug) || 0) + 1; porHunt.set(c.slug, n); return n <= 3; });
    try { fs.writeFileSync(ritmoMedPath(), JSON.stringify(m)); } catch (e) { appLog(`ritmo das hunts: não gravei as medidas (${e.message})`); }
    huRitmoEnviar();
  } finally {
    ritmoColetando = false;
  }
}
function huRitmoEnviar() {
  if (!huWin || huWin.isDestroyed()) return;
  const s = ritmoSiteLer();
  huWin.webContents.send('huritmo', { site: s?.t ?? null, siteEm: s?.em ?? 0, baixando: ritmoBaixando, erro: ritmoErro, corridas: ritmoMedLer().corridas });
}
function abrirHunts() {
  if (!licenca.premium()) return licenca.pedirPremium('A 🗺 Melhor hunt');
  if (huWin && !huWin.isDestroyed()) { if (huWin.isMinimized()) huWin.restore(); return huWin.focus(); }
  huWin = new BrowserWindow({
    width: 1180, height: 900, parent: win, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Melhor hunt',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  huWin.on('page-title-updated', e => e.preventDefault());
  huWin.loadFile(path.join(__dirname, 'hunts.html'));
  huWin.webContents.on('did-finish-load', () => {
    huWin.webContents.send('huinicio', { nomes: cfg.names, ativa: active });
    huJogoEnviar();
    huRitmoEnviar();
    ritmoBaixar();
  });
  huWin.on('closed', () => { huWin = null; });
  const d = jogoLer();
  if (d?.v !== JOGO_VERSAO) jogoMontar(true);
}

// ---------- 🏦 Caixa do projeto: a carteira do jogo na rede Solana ----------
// Pedido de 31/10/2026: "quero saber quando tiver saindo muito capital, para eu me precaver de futura liquidação ou
// fim de projeto". O dinheiro das Gemas fica numa carteira pública da Solana, a "Carteira do projeto" do painel de
// Gemas do jogo: o depósito de cada jogador cai num endereço só dele e é recolhido para ela, e os saques saem dela.
// A cada 10 min o app lê as transações novas na RPC pública da Solana (só leitura de dados públicos; nada nosso vai
// para lá) e separa o que mexeu no USDT da carteira:
//   - recolha: entrou USDT (os depósitos dos jogadores);
//   - saque: saiu USDT com o número do pedido de saque no memo (todo saque pago leva um);
//   - troca: saiu USDT e entrou SOL ou outro token na mesma transação (as taxas viram SOL para pagar a rede);
//   - manual: saiu USDT sem número de pedido e sem nada em troca, ou seja, dinheiro saindo por outro motivo.
// Conferido nos 86 dias de 06/08 a 31/10/2026 (as 7.380 transações; o saldo fecha no centavo): só 2 trocas e 3
// manuais (154 dólares). Esse histórico vem pronto no caixa-historico.json, e é dele que saem os limites (CAIXA_LIM).
// De hora em hora a Conta 1 também pede o painel de Gemas do jogo (`orbs.painel`, o mesmo da tela de depósito), para
// o "aguardando recolha" e para saber se a carteira do projeto mudou. Só os números públicos do caixa ficam no app.
const CAIXA_CARTEIRA = 'HSuL31wGKDhnX7jx6zYWZ7azJmAUKt7atg4WxNUG5PRc';
const CAIXA_CONTA = '9Fy644E5oBAhNbzKbWpSM8n341VqeYgS2dS6jmKpUd8G'; // a conta de USDT da carteira
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const CAIXA_RPC = 'https://api.mainnet-beta.solana.com';
// Teste isolado: PKM_CAIXA_TESTE=1 com a rede falsa (tudo rápido); =real com a rede de verdade, no ritmo normal
const CAIXA_TESTE = process.env.PKM_CAIXA_TESTE || '', CAIXA_RAPIDO = CAIXA_TESTE === '1';
const CAIXA_MS = 10 * 60000;
const CAIXA_PAINEL_MS = 60 * 60000;
// A RPC pública aguenta ~1 transação por segundo: 150 por verificação dão ~3 min (o normal são de 5 a 40 novas)
const CAIXA_POR_VEZ = CAIXA_RAPIDO ? 3000 : 150, CAIXA_ESPACO = CAIXA_RAPIDO ? 2 : 1100;
// Os limites, medidos no histórico de 06/08 a 31/10/2026 (entre parênteses, quantas vezes teriam tocado nele)
const CAIXA_LIM = {
  manual: 100,       // 🟡 uma saída manual de US$ 100 ou mais (1 vez: os 150 de 28/09)
  manual24: 1000,    // 🔴 saídas manuais somando US$ 1.000 em 24 h (0)
  trocas24: 2000,    // 🔴 trocas somando mais de US$ 2.000 em 24 h (0: foram 1.000 em 11/10 e 1.000 em 31/10)
  saqueGrande: 3000, // 🟡 um saque de US$ 3.000 ou mais (0: o maior foi de 1.530, em 18/10)
  queda24: 0.15,     // 🔴 15% abaixo do maior caixa das últimas 24 h (0 com o caixa acima de 5 mil: a pior foi 13,3%, em 18/10)
  queda7: 0.25,      // 🔴 25% abaixo do maior dos últimos 7 dias (0)
  corrida: 3,        // 🟠 saques em 24 h acima de 3× a média diária dos 14 dias antes, com o caixa caindo (0; sem a queda, 1: 21/10)
  corridaMin: 50,
  semRecolhaH: 12,   // 🟡 12 h sem recolha de depósito (0: a maior pausa desde 19/10 foi de 3,7 h)
  semSaqueH: 36,     // 🟠 36 h sem nenhum saque pago (0: o recorde foi de 25 h, de domingo para segunda)
  sol: 1,            // 🟡 menos de 1 SOL para as taxas (1 vez: 0,87 em 10/09, reposto no mesmo dia)
  solSaida: 1        // 🟡 1 SOL ou mais saindo da carteira sem ser taxa (0)
};
// Quantas horas cada alarme espera para avisar de novo no Windows (o registro da janela guarda todos os de eventos)
const CAIXA_ESPERA_H = { manual: 1, manual24: 2, trocas24: 6, saqueGrande: 1, permissao: 0, solSaida: 1, queda24: 6, queda7: 12, corrida: 12, semRecolha: 12, semSaque: 12, sol: 24, carteira: 24 };
const CAIXA_NIVEL = { amarelo: 1, laranja: 2, vermelho: 3 };
const CAIXA_DE_ESTADO = ['queda', 'corrida', 'semRecolha', 'semSaque', 'sol', 'carteira']; // os que valem enquanto durar a situação
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const caixaPath = () => path.join(app.getPath('userData'), 'caixa.json');
let caixa = null, caixaWin = null, caixaVerificando = false, caixaErroLog = '', caixaRegrasUlt = [];
let caixaTimer = null, caixaProxima = 0, caixaTimerPainel = null;
const r2 = v => Math.round(v * 100) / 100;
const caixaDia = ms => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10); // o dia em Brasília
const caixaUsd = v => `US$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const caixaPct = v => `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const caixaHoras = h => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`);
const caixaQuando = ms => { const d = new Date(ms); return `em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; };
const caixaCurto = s => String(s ?? '').split(', ').map(x => (x.length > 12 ? `${x.slice(0, 4)}…${x.slice(-4)}` : x)).join(', ');

function caixaLer() {
  if (caixa) return caixa;
  for (const f of [caixaPath(), path.join(__dirname, 'caixa-historico.json')]) {
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j?.v === 1 && j.cursor) { caixa = j; break; } } catch {}
  }
  caixa ??= { v: 1, cursor: {}, dias: {} };
  caixa.carteira ||= CAIXA_CARTEIRA;
  caixa.conta ||= CAIXA_CONTA;
  for (const k of ['fila', 'adiadas', 'lidas', 'horas', 'pontos', 'eventos', 'maiores', 'alertas']) if (!Array.isArray(caixa[k])) caixa[k] = [];
  caixa.avisados ??= {};
  return caixa;
}
function caixaGravar() {
  // Grava num arquivo à parte e troca: um fechamento no meio da gravação não estraga o caixa.json
  try { fs.writeFileSync(caixaPath() + '.tmp', JSON.stringify(caixa)); fs.renameSync(caixaPath() + '.tmp', caixaPath()); } catch (e) { appLog(`caixa: não gravei (${e.message})`); }
}

async function caixaRpc(method, params) {
  for (let t = 0; ; t++) {
    let r, j;
    try {
      r = await net.fetch(CAIXA_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      j = await r.json();
    } catch (e) {
      if (t >= 3) throw new Error(`a rede Solana não respondeu (${e.message})`);
      await espera(CAIXA_RAPIDO ? 20 : 4000 * (t + 1));
      continue;
    }
    // Pedidos demais: a RPC pública responde 429, às vezes dentro do JSON e com HTTP 200
    if (r.status === 429 || j?.error?.code === 429 || r.status >= 500) {
      if (t >= 4) throw new Error('a rede Solana pediu para esperar (pedidos demais)');
      await espera(CAIXA_RAPIDO ? 20 : 5000 * (t + 1));
      continue;
    }
    if (j?.error) throw new Error(`a rede Solana recusou o pedido (${String(j.error.message ?? j.error.code).slice(0, 120)})`);
    return j?.result;
  }
}

// As assinaturas novas de um endereço, da mais nova para a mais velha, até a marca `ate` (a mais nova já vista)
async function caixaAssinaturas(end, ate) {
  const out = [];
  let antes = null;
  for (let pg = 0; pg < 20; pg++) {
    const opt = { limit: 1000, commitment: 'finalized' };
    if (ate) opt.until = ate;
    if (antes) opt.before = antes;
    const r = await caixaRpc('getSignaturesForAddress', [end, opt]);
    if (!Array.isArray(r)) throw new Error('a rede Solana respondeu algo que o app não conhece');
    out.push(...r);
    if (r.length < 1000 || !ate) break;
    if (pg === 19) appLog('caixa: mais de 20 mil transações novas de uma vez; as mais antigas ficaram de fora');
    antes = r.at(-1).signature;
  }
  return out;
}

// O que uma transação fez com a carteira (o formato `jsonParsed` da RPC; vale para as "versão 1" também)
function caixaClassificar(tx, c) {
  const msg = tx?.transaction?.message, m = tx?.meta;
  if (!msg || !m) return null;
  const ks = (msg.accountKeys || []).map(k => (typeof k === 'string' ? k : k.pubkey));
  const iW = ks.indexOf(c.carteira), iC = ks.indexOf(c.conta);
  const pre = m.preTokenBalances || [], pos = m.postTokenBalances || [];
  const tok = (l, i, mint) => Number(l.find(b => b.accountIndex === i && b.mint === mint)?.uiTokenAmount?.amount || 0);
  const usdt = iC >= 0 ? (tok(pos, iC, USDT_MINT) - tok(pre, iC, USDT_MINT)) / 1e6 : 0;
  const temSaldo = iC >= 0 && pos.some(b => b.accountIndex === iC && b.mint === USDT_MINT);
  const sol = iW >= 0 ? (m.postBalances[iW] - m.preBalances[iW] + (ks[0] === c.carteira ? m.fee : 0)) / 1e9 : 0; // sem a taxa da rede
  const ixs = [...(msg.instructions || []), ...(m.innerInstructions || []).flatMap(x => x.instructions || [])];
  const memo = (msg.instructions || []).some(i => i.program === 'spl-memo' && UUID_RE.test(String(i.parsed ?? '')));
  const ganhouToken = pos.some(b => b.owner === c.carteira && b.mint !== USDT_MINT && tok(pos, b.accountIndex, b.mint) > tok(pre, b.accountIndex, b.mint));
  const para = [...new Set(pos.filter(b => b.mint === USDT_MINT && b.accountIndex !== iC && tok(pos, b.accountIndex, USDT_MINT) > tok(pre, b.accountIndex, USDT_MINT))
    .map(b => b.owner).filter(o => B58.test(o || '')))].join(', ');
  // Mexeram nas permissões da conta de USDT: delegado (approve), novo dono (setAuthority), conta fechada ou congelada
  const perm = [...new Set(ixs.filter(i => i.program === 'spl-token' && /^(approve|approveChecked|setAuthority|closeAccount|freezeAccount)$/.test(i.parsed?.type || '')
    && [i.parsed.info?.account, i.parsed.info?.source].includes(c.conta)).map(i => i.parsed.type))].join(', ');
  const k = { em: (tx.blockTime || 0) * 1000, usdt: r2(Math.abs(usdt)), saldoUsdt: temSaldo ? tok(pos, iC, USDT_MINT) / 1e6 : null, perm };
  const quem = sinal => ks.filter((x, j) => x !== c.carteira && Math.sign(m.postBalances[j] - m.preBalances[j]) === sinal).join(', ');
  if (usdt > 0) k.tipo = 'recolha';
  else if (usdt < 0 && (sol > 0.01 || ganhouToken)) Object.assign(k, { tipo: 'troca', sol: Math.round(sol * 1e4) / 1e4 });
  else if (usdt < 0) Object.assign(k, { tipo: memo ? 'saque' : 'manual', para });
  else if (Math.abs(sol) >= 0.05) Object.assign(k, { tipo: 'sol', sol: Math.round(sol * 1e4) / 1e4, para: quem(sol < 0 ? 1 : -1) });
  else k.tipo = 'nada'; // poeira (o spam de 1 lamport), taxas, conta de token nova
  return k;
}

function caixaContar(c, k, sig, novos) {
  const d = (c.dias[caixaDia(k.em)] ||= [0, 0, 0, 0, 0, 0, 0, null, 0]);
  if (k.saldoUsdt != null && k.em >= (d[8] || 0)) { d[7] = r2(k.saldoUsdt); d[8] = k.em; }
  const hora = Math.floor(k.em / 3600e3) * 3600;
  let h = c.horas.find(x => x[0] === hora);
  if (!h && (k.tipo === 'recolha' || k.tipo === 'saque')) c.horas.push(h = [hora, 0, 0, 0, 0]);
  const ev = extra => { const e = { em: k.em, tipo: k.tipo, ...extra, sig }; c.eventos.push(e); novos.push(e); };
  if (k.tipo === 'recolha') {
    d[0] = r2(d[0] + k.usdt); d[1]++; h[1]++; h[2] = r2(h[2] + k.usdt);
    c.ultimaRecolha = Math.max(c.ultimaRecolha || 0, k.em);
  } else if (k.tipo === 'saque') {
    d[2] = r2(d[2] + k.usdt); d[3]++; h[3]++; h[4] = r2(h[4] + k.usdt);
    c.ultimoSaque = Math.max(c.ultimoSaque || 0, k.em);
    if (c.maiores.length < 15 || k.usdt > c.maiores.at(-1).usdt) { c.maiores.push({ em: k.em, usdt: k.usdt, para: k.para, sig }); c.maiores.sort((a, b) => b.usdt - a.usdt).splice(15); }
    if (k.usdt >= CAIXA_LIM.saqueGrande) novos.push({ em: k.em, tipo: 'saqueGrande', usdt: k.usdt, para: k.para, sig });
  } else if (k.tipo === 'troca') { d[6] = r2(d[6] + k.usdt); ev({ usdt: k.usdt, sol: k.sol }); }
  else if (k.tipo === 'manual') { d[4] = r2(d[4] + k.usdt); d[5]++; ev({ usdt: k.usdt, para: k.para }); }
  else if (k.tipo === 'sol') ev({ sol: k.sol, para: k.para });
  if (k.perm) { const e = { em: k.em, tipo: 'permissao', perm: k.perm, sig }; c.eventos.push(e); novos.push(e); }
}

// Lê as transações da fila, na ordem. A que a RPC ainda não tem volta na próxima verificação (até 3 vezes)
async function caixaLerFila(c, novos, tentativas) {
  for (let n = 0; c.fila.length && n < CAIXA_POR_VEZ; n++) {
    const sig = c.fila[0];
    const tx = await caixaRpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
    c.fila.shift();
    if (!tx) c.adiadas.push([sig, (tentativas.get(sig) || 0) + 1]);
    else {
      const k = caixaClassificar(tx, c);
      if (k) caixaContar(c, k, sig, novos);
      c.lidas.push([sig.slice(0, 24), Date.now()]);
    }
    if (CAIXA_ESPACO) await espera(CAIXA_ESPACO);
  }
}

function caixaPodar(c) {
  const agora = Date.now();
  c.pontos = c.pontos.filter(p => p[0] >= agora - 8 * 864e5);
  c.horas = c.horas.filter(h => h[0] * 1000 >= agora - 16 * 864e5);
  c.lidas = c.lidas.filter(x => x[1] >= agora - 2 * 864e5);
  if (c.eventos.length > 500) c.eventos.splice(0, c.eventos.length - 500);
  if (c.alertas.length > 200) c.alertas.splice(0, c.alertas.length - 200);
}

// Os números de agora, para os alarmes e para a janela
function caixaResumo(c) {
  const agora = Date.now(), DIA = 864e5;
  const ev24 = tipo => c.eventos.filter(e => e.tipo === tipo && e.em > agora - DIA);
  const soma = l => r2(l.reduce((s, e) => s + (e.usdt || 0), 0));
  const somaH = (l, i) => l.reduce((s, h) => s + h[i], 0);
  const h24 = c.horas.filter(h => h[0] * 1000 > agora - DIA);
  const hAntes = c.horas.filter(h => h[0] * 1000 <= agora - DIA && h[0] * 1000 > agora - 15 * DIA);
  const diasAntes = hAntes.length ? Math.min(14, (agora - DIA - Math.min(...hAntes.map(h => h[0] * 1000))) / DIA) : 0;
  const usdt = c.saldo?.usdt ?? null;
  const fins = Object.values(c.dias).filter(d => d[7] != null);
  // O maior caixa desde um momento: pelas leituras de cada verificação e pelo fim de cada dia
  const maior = desde => Math.max(usdt ?? 0, ...c.pontos.filter(p => p[0] >= desde).map(p => p[1]), ...fins.filter(d => d[8] >= desde).map(d => d[7]));
  // O caixa num momento do passado: a última leitura até 3 h antes dele
  const em = ms => { let v = null; for (const p of c.pontos) if (p[0] <= ms && p[0] >= ms - 3 * 3600e3) v = p[1]; return v; };
  const max24 = maior(agora - DIA), max7 = maior(agora - 7 * DIA), v24 = em(agora - DIA), v7 = em(agora - 7 * DIA);
  const man = ev24('manual');
  return {
    usdt, sol: c.saldo?.sol ?? null, saldoEm: c.saldo?.em ?? 0,
    manual24: soma(man), nManual24: man.length, maiorManual24: Math.max(0, ...man.map(e => e.usdt)),
    trocas24: soma(ev24('troca')), perm24: ev24('permissao').map(e => e.em),
    nSaq24: somaH(h24, 3), saq24: r2(somaH(h24, 4)), nRec24: somaH(h24, 1), rec24: r2(somaH(h24, 2)),
    media14: diasAntes >= 3 ? somaH(hAntes, 3) / diasAntes : null,
    max24, max7, queda24: max24 >= 5000 && usdt != null ? 1 - usdt / max24 : 0, queda7: max7 >= 5000 && usdt != null ? 1 - usdt / max7 : 0,
    var24: v24 && usdt != null ? usdt / v24 - 1 : null, var7: v7 && usdt != null ? usdt / v7 - 1 : null,
    caindo: v24 != null && usdt != null && usdt < v24,
    semRecolhaH: c.ultimaRecolha ? (agora - c.ultimaRecolha) / 3600e3 : null,
    semSaqueH: c.ultimoSaque ? (agora - c.ultimoSaque) / 3600e3 : null,
    saqueGrande24: c.maiores.filter(x => x.usdt >= CAIXA_LIM.saqueGrande && x.em > agora - DIA).length,
    // Tudo lido e a última leitura deu certo: só assim valem os alarmes de contagem e de tempo
    completo: !c.fila.length && !c.erro && !!c.verificadoEm
  };
}

function caixaRegras(c, R = caixaResumo(c)) {
  const L = CAIXA_LIM, regras = [];
  const add = (id, nome, valor, limite, nivel) => regras.push({ id, nome, valor, limite, nivel: nivel || null });
  add('manual', 'Saída que não é saque', R.nManual24 ? `${caixaUsd(R.manual24)} em 24 h (${R.nManual24})` : 'nenhuma em 24 h',
    `aviso a partir de ${caixaUsd(L.manual)}; alarme com ${caixaUsd(L.manual24)} em 24 h`,
    R.manual24 >= L.manual24 ? 'vermelho' : R.maiorManual24 >= L.manual ? 'amarelo' : null);
  add('trocas24', 'Trocas por SOL ou outro token', R.trocas24 ? `${caixaUsd(R.trocas24)} em 24 h` : 'nenhuma em 24 h', `alarme acima de ${caixaUsd(L.trocas24)} em 24 h`,
    R.trocas24 > L.trocas24 ? 'vermelho' : null);
  add('queda', 'Queda do caixa', R.usdt == null ? 'sem leitura ainda' : `${caixaPct(Math.max(0, R.queda24))} abaixo do maior de 24 h · ${caixaPct(Math.max(0, R.queda7))} do de 7 dias`,
    `alarme com ${caixaPct(L.queda24)} em 24 h ou ${caixaPct(L.queda7)} em 7 dias`, R.queda24 >= L.queda24 || R.queda7 >= L.queda7 ? 'vermelho' : null);
  add('corrida', 'Corrida de saques', `${R.nSaq24} saques em 24 h${R.media14 == null ? '' : ` (média de ${Math.round(R.media14)} por dia)`}`, `${L.corrida}× a média, com o caixa caindo`,
    R.completo && R.media14 != null && R.nSaq24 >= L.corridaMin && R.nSaq24 > L.corrida * R.media14 && R.caindo ? 'laranja' : null);
  add('semRecolha', 'Recolha dos depósitos', R.semRecolhaH == null ? 'sem dado' : `a última há ${caixaHoras(R.semRecolhaH)}`, `aviso com ${L.semRecolhaH} h sem nenhuma`,
    R.completo && R.semRecolhaH > L.semRecolhaH ? 'amarelo' : null);
  add('semSaque', 'Saques sendo pagos', R.semSaqueH == null ? 'sem dado' : `o último há ${caixaHoras(R.semSaqueH)}`, `aviso com ${L.semSaqueH} h sem nenhum`,
    R.completo && R.semSaqueH > L.semSaqueH ? 'laranja' : null);
  add('sol', 'SOL para as taxas da rede', R.sol == null ? 'sem leitura ainda' : `${R.sol.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} SOL`, `aviso abaixo de ${L.sol} SOL`,
    R.sol != null && R.sol < L.sol ? 'amarelo' : null);
  add('saqueGrande', 'Saque grande', c.maiores[0] ? `o maior já pago: ${caixaUsd(c.maiores[0].usdt)}, ${caixaQuando(c.maiores[0].em)}` : 'sem dado',
    `aviso a partir de ${caixaUsd(L.saqueGrande)}`, R.saqueGrande24 ? 'amarelo' : null);
  add('permissao', 'Permissões da conta de USDT', R.perm24.length ? `mudou ${caixaQuando(R.perm24.at(-1))}` : 'sem mudança', 'qualquer mudança', R.perm24.length ? 'vermelho' : null);
  const p = c.painel, outra = !!p?.carteira && p.carteira !== c.carteira;
  add('carteira', 'Carteira no painel do jogo', !p ? 'sem leitura ainda (a Conta 1 confere de hora em hora)' : outra ? `OUTRA: ${caixaCurto(p.carteira)}` : `a mesma (conferida ${caixaQuando(p.em)})`,
    'outra carteira', outra ? 'laranja' : null);
  return regras;
}

// Os alarmes que valem enquanto durar a situação (queda, corrida, pausas, SOL, carteira trocada)
function caixaAlarmesEstado(c) {
  const R = caixaResumo(c), out = [];
  for (const r of (caixaRegrasUlt = caixaRegras(c, R))) {
    if (!r.nivel || !CAIXA_DE_ESTADO.includes(r.id)) continue;
    if (r.id === 'queda') {
      if (R.queda24 >= CAIXA_LIM.queda24) out.push([r.nivel, 'queda24', `O caixa caiu ${caixaPct(R.queda24)} em 24 h: de ${caixaUsd(R.max24)} para ${caixaUsd(R.usdt)}.`]);
      else out.push([r.nivel, 'queda7', `O caixa caiu ${caixaPct(R.queda7)} em 7 dias: de ${caixaUsd(R.max7)} para ${caixaUsd(R.usdt)}.`]);
    } else if (r.id === 'corrida') out.push([r.nivel, 'corrida', `Corrida de saques: ${R.nSaq24} em 24 h (${caixaUsd(R.saq24)}), ${(R.nSaq24 / R.media14).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}× a média, e o caixa caindo.`]);
    else if (r.id === 'semRecolha') out.push([r.nivel, 'semRecolha', `Nenhuma recolha de depósito há ${caixaHoras(R.semRecolhaH)}.`]);
    else if (r.id === 'semSaque') out.push([r.nivel, 'semSaque', `Nenhum saque pago há ${caixaHoras(R.semSaqueH)}.`]);
    else if (r.id === 'sol') out.push([r.nivel, 'sol', `A carteira está com só ${R.sol.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} SOL para as taxas da rede.`]);
    else if (r.id === 'carteira') out.push([r.nivel, 'carteira', `O painel de Gemas do jogo agora mostra outra carteira do projeto (${caixaCurto(c.painel.carteira)}). O monitor continua lendo a de antes.`]);
  }
  return out;
}

// Os alarmes das transações que acabaram de ser lidas
function caixaAlarmesEventos(c, novos) {
  const out = [], DIA = 864e5, deAgora = new Set(novos), lidos = { manual: [], troca: [] };
  // A soma das 24 h até este evento: os de antes desta leitura e, desta, só os que vieram antes dele (dois no mesmo
  // segundo não se somam fora de ordem)
  const somaAte = e => {
    const s = [...c.eventos.filter(x => x.tipo === e.tipo && !deAgora.has(x)), ...lidos[e.tipo]].filter(x => x.em > e.em - DIA).reduce((t, x) => t + x.usdt, 0);
    lidos[e.tipo].push(e);
    return s + e.usdt;
  };
  for (const e of novos) {
    const q = caixaQuando(e.em), para = e.para ? ` para ${caixaCurto(e.para)}` : '';
    if (e.tipo === 'manual') {
      const s = somaAte(e);
      if (s >= CAIXA_LIM.manual24) out.push(['vermelho', 'manual24', `Saíram ${caixaUsd(s)} do caixa sem ser saque em 24 h. A última, de ${caixaUsd(e.usdt)}, ${q}${para}.`, e.sig, true]);
      else if (e.usdt >= CAIXA_LIM.manual) out.push(['amarelo', 'manual', `Saída manual de ${caixaUsd(e.usdt)}, sem número de pedido de saque, ${q}${para}.`, e.sig, true]);
    } else if (e.tipo === 'troca') {
      const s = somaAte(e);
      if (s > CAIXA_LIM.trocas24) out.push(['vermelho', 'trocas24', `Trocas de USDT por SOL ou outro token somam ${caixaUsd(s)} em 24 h. A última, de ${caixaUsd(e.usdt)}, ${q}.`, e.sig, true]);
    } else if (e.tipo === 'permissao') {
      out.push(['vermelho', 'permissao', `Mudaram a permissão da conta de USDT do caixa (${e.perm}) ${q}.`, e.sig, true]);
    } else if (e.tipo === 'sol' && e.sol <= -CAIXA_LIM.solSaida) {
      out.push(['amarelo', 'solSaida', `Saíram ${(-e.sol).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} SOL da carteira, sem ser taxa, ${q}${para}.`, e.sig, true]);
    } else if (e.tipo === 'saqueGrande') {
      out.push(['amarelo', 'saqueGrande', `Saque grande: ${caixaUsd(e.usdt)} ${q}${para}.`, e.sig, true]);
    }
  }
  return out;
}

// Registra os alarmes e avisa no Windows (um aviso só por vez, com até 3 linhas). O alarme de estado só volta a ser
// registrado depois da espera dele; o de evento fica sempre no registro, mesmo sem aviso novo no Windows.
function caixaAlertar(c, lista) {
  const agora = Date.now(), avisar = [];
  for (const [nivel, regra, txt, sig, deEvento] of lista) {
    const livre = agora - (c.avisados[regra] || 0) >= (CAIXA_ESPERA_H[regra] ?? 6) * 3600e3;
    if (!livre && !deEvento) continue;
    c.alertas.push({ em: agora, nivel, regra, txt, ...(sig ? { sig } : {}) });
    appLog(`caixa: ALARME ${nivel}: ${txt}`);
    if (livre) { c.avisados[regra] = agora; avisar.push({ nivel, txt }); }
  }
  if (!avisar.length || cfg.caixa?.avisos === false || !Notification.isSupported()) return;
  avisar.sort((a, b) => CAIXA_NIVEL[b.nivel] - CAIXA_NIVEL[a.nivel]);
  const ic = { vermelho: '🔴', laranja: '🟠', amarelo: '🟡' }[avisar[0].nivel];
  const n = new Notification({ title: `${ic} Caixa do projeto${avisar.length > 1 ? ` (${avisar.length} avisos)` : ''}`, body: avisar.slice(0, 3).map(a => a.txt).join('\n') });
  n.on('click', () => abrirCaixa());
  n.show();
}

function caixaAgendar(ms) {
  clearTimeout(caixaTimer);
  caixaProxima = Date.now() + ms;
  caixaTimer = setTimeout(() => caixaVerificar(), ms);
}

async function caixaVerificar(motivo = 'agendado') {
  if (caixaVerificando) return;
  const c = caixaLer();
  if (cfg.caixa?.ligado === false && motivo === 'agendado') return caixaAgendar(CAIXA_MS);
  caixaVerificando = true;
  caixaEnviar();
  const novos = [];
  try {
    const tentativas = new Map(c.adiadas);
    c.adiadas = [];
    for (const [sig, n] of [...tentativas].reverse()) {
      if (n < 3) c.fila.unshift(sig);
      else appLog(`caixa: a rede Solana não devolveu a transação ${sig.slice(0, 12)}… em 3 tentativas; ficou de fora`);
    }
    // 1. As assinaturas novas da conta de USDT (todo movimento de USDT) e da carteira (o SOL e o resto). A marca de
    //    cada lista só anda depois de as duas chegarem, para nada ficar para trás se a segunda falhar
    const listas = [];
    for (const k of ['conta', 'carteira']) listas.push([k, await caixaAssinaturas(c[k], c.cursor[k])]);
    const ja = new Set([...c.fila.map(s => s.slice(0, 24)), ...c.lidas.map(x => x[0])]), novas = [];
    for (const [k, l] of listas) {
      if (l.length) c.cursor[k] = l[0].signature;
      for (const s of l) if (!s.err && !ja.has(s.signature.slice(0, 24))) { ja.add(s.signature.slice(0, 24)); novas.push(s); }
    }
    c.fila.push(...novas.sort((a, b) => a.slot - b.slot).map(s => s.signature));
    // 2. As transações, na ordem; as que não couberem nesta vez ficam para a próxima
    await caixaLerFila(c, novos, tentativas);
    // 3. O saldo de agora
    const sol = await caixaRpc('getBalance', [c.carteira, { commitment: 'finalized' }]);
    const usdt = await caixaRpc('getTokenAccountBalance', [c.conta, { commitment: 'finalized' }]);
    const u = Number(usdt?.value?.amount), s = Number(sol?.value);
    if (!Number.isFinite(u) || !Number.isFinite(s)) throw new Error('a rede Solana não devolveu o saldo');
    c.saldo = { usdt: r2(u / 1e6), sol: Math.round(s / 1e5) / 1e4, em: Date.now() };
    c.pontos.push([c.saldo.em, c.saldo.usdt, c.saldo.sol]);
    c.erro = '';
    c.verificadoEm = Date.now();
    if (caixaErroLog) appLog('caixa: a leitura da rede Solana voltou ao normal');
    caixaErroLog = '';
    if (c.fila.length) appLog(`caixa: ${c.fila.length} transações ainda na fila (lidas ${CAIXA_POR_VEZ} por vez)`);
  } catch (e) {
    c.erro = e.message;
    if (e.message !== caixaErroLog) appLog(`caixa: ${e.message}`);
    caixaErroLog = e.message;
  } finally {
    caixaPodar(c);
    caixaAlertar(c, [...caixaAlarmesEventos(c, novos), ...(c.erro ? [] : caixaAlarmesEstado(c))]);
    caixaGravar();
    caixaVerificando = false;
    // Com fila (o app ficou fechado um tempo), volta em 2 min; senão, em 10
    caixaAgendar(c.fila.length && !c.erro ? CAIXA_MS / 5 : CAIXA_MS);
    caixaEnviar();
    pushState();
  }
}

// O painel público do caixa, como o jogo mostra na tela de depósito e de saque. Pedido pela Conta 1, pelo socket do
// próprio jogo. A resposta também passa pela tela do jogo (`aoReceberOrbs`), que atualiza o saldo de gemas e redesenha
// o depósito, o saque ou a loja se um deles estiver aberto. Por isso, com um deles aberto, não pede. Volta para o app
// só o bloco `caixa` (números públicos); o saldo, o extrato e o endereço de depósito da conta ficam na página.
const CAIXA_PAINEL_JS = `new Promise(res => {
  const s = window.__pkmSock;
  if (!s || s.readyState !== 1 || !window.__pkmEnviar) return res({ erro: 'sem conexão com o jogo' });
  if (document.querySelector('#orbs-corpo')?.offsetParent || document.querySelector('.loja-filtros')?.offsetParent) return res({ erro: 'a tela de gemas ou a loja estava aberta' });
  const fim = setTimeout(() => { s.removeEventListener('message', f); res({ erro: 'o jogo não respondeu' }); }, 12000);
  function f(ev) {
    if (typeof ev.data !== 'string' || ev.data.indexOf('"t":"orbs"') < 0) return;
    try {
      const m = JSON.parse(ev.data);
      if (m.t !== 'orbs') return;
      clearTimeout(fim); s.removeEventListener('message', f); res({ caixa: m.caixa || null });
    } catch {}
  }
  s.addEventListener('message', f);
  if (!window.__pkmEnviar({ t: 'orbs.painel' })) { clearTimeout(fim); s.removeEventListener('message', f); res({ erro: 'sem conexão com o jogo' }); }
})`;
async function caixaPainel() {
  clearTimeout(caixaTimerPainel);
  let prox = CAIXA_PAINEL_MS;
  try {
    const wc = views[PRECO_CONTA]?.webContents;
    if (cfg.caixa?.ligado === false || !wc || wc.isDestroyed() || wc.isLoading()) return;
    const c = caixaLer();
    const r = await wc.executeJavaScript(CAIXA_PAINEL_JS).catch(e => ({ erro: e.message }));
    const x = r?.caixa;
    if (!x || typeof x !== 'object') { c.painelErro = r?.erro || 'o jogo não respondeu'; prox = CAIXA_PAINEL_MS / 6; return caixaEnviar(); }
    const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : r2(Number(v)));
    const cart = String(x.carteira ?? '');
    c.painel = {
      em: Date.now(), carteira: B58.test(cart) ? cart : '', arrecadado: num(x.arrecadadoUsdt), sacado: num(x.sacadoUsdt), taxas: num(x.taxasMercadoUsdt),
      taxasUsadas: num(x.taxasUsadasUsdt), emCaixa: num(x.emCaixaUsdt), aguardando: num(x.aguardandoRecolhaUsdt)
    };
    c.painelErro = '';
    caixaAlertar(c, caixaAlarmesEstado(c).filter(a => a[1] === 'carteira'));
    if (!caixaVerificando) caixaGravar(); // no meio de uma verificação, quem grava é ela, no fim
    caixaEnviar();
    pushState();
  } finally {
    caixaTimerPainel = setTimeout(caixaPainel, prox);
  }
}

// A cor do 🏦 na barra: o pior aviso que ainda não foi visto na janela, ou um alarme de estado que continua valendo
function caixaNivelBarra() {
  if (!caixa || cfg.caixa?.ligado === false) return '';
  const visto = cfg.caixa?.vistoEm || 0;
  let n = 0;
  for (const a of caixa.alertas) if (a.em > visto) n = Math.max(n, CAIXA_NIVEL[a.nivel] || 0);
  for (const r of caixaRegrasUlt) if (r.nivel && CAIXA_DE_ESTADO.includes(r.id)) n = Math.max(n, CAIXA_NIVEL[r.nivel] || 0);
  return ['', 'amarelo', 'laranja', 'vermelho'][n];
}

function caixaEnviar() {
  if (!caixaWin || caixaWin.isDestroyed()) return;
  const c = caixaLer(), R = caixaResumo(c);
  caixaWin.webContents.send('cxstate', {
    ligado: cfg.caixa?.ligado !== false, avisos: cfg.caixa?.avisos !== false,
    lendo: caixaVerificando, verificadoEm: c.verificadoEm || 0, proximaEm: caixaProxima, erro: c.erro || '', fila: c.fila.length,
    carteira: c.carteira, conta: c.conta, origem: c.origem || '', lim: CAIXA_LIM,
    resumo: R, regras: caixaRegras(c, R), ultimaRecolha: c.ultimaRecolha || 0, ultimoSaque: c.ultimoSaque || 0,
    dias: Object.entries(c.dias).sort(([a], [b]) => a.localeCompare(b)).map(([d, v]) => [d, ...v.slice(0, 8)]),
    eventos: c.eventos.slice(-60).reverse(),
    maiores: c.maiores.slice(0, 10),
    alertas: c.alertas.slice(-50).reverse(),
    painel: c.painel || null, painelErro: c.painelErro || '',
    visto: cfg.caixa?.vistoEm || 0
  });
}

function caixaVisto() {
  (cfg.caixa ??= {}).vistoEm = Date.now();
  saveCfg();
  pushState();
}
function abrirCaixa() {
  if (!licenca.premium()) return licenca.pedirPremium('O 🏦 Caixa do projeto');
  if (caixaWin && !caixaWin.isDestroyed()) { if (caixaWin.isMinimized()) caixaWin.restore(); caixaWin.focus(); return caixaVisto(); }
  caixaWin = new BrowserWindow({
    width: 1040, height: 920, parent: win, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Caixa do projeto',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  caixaWin.on('page-title-updated', e => e.preventDefault());
  caixaWin.loadFile(path.join(__dirname, 'caixa.html'));
  caixaWin.webContents.on('did-finish-load', caixaEnviar);
  caixaWin.on('focus', caixaVisto);
  caixaWin.on('closed', () => { caixaWin = null; });
  caixaVisto();
}
// Só no teste isolado (PKM_CAIXA_TESTE): o roteiro do teste chama a verificação e o painel quando quer
if (CAIXA_TESTE) global.__pkmCaixa = { verificar: caixaVerificar, painel: caixaPainel, ocupado: () => caixaVerificando, dados: () => caixa };

const twAuto = { ultima: null, abertas: [], noAr: 0, erro: '', pontos: {} };
const KICK_MAX = 2; // lives da Kick que a verificação mantém abertas (a Kick só pontua 2 por vez)
// Lives da Twitch com vídeo ao mesmo tempo, somando as 4 contas: a Twitch só conta 2 por rede, e com mais, segundo
// funcionários dela citados em 10/2025, não conta nenhuma
const TW_MAX = 2;

// Pontos do canal na Twitch: lidos na própria página da live aberta, no número que fica junto do chat. O que ela
// escreve depende do idioma ("1,2 mil", "1.2K", "1.234"). Da live que não está aberta fica o último visto.
// E o número é animado: enquanto troca, o valor velho e o novo ficam lado a lado no elemento, e na janela escondida a
// animação não termina ("0" e "3,2 mil" viram "03,2 mil", medido em 04/11/2026). Vale o último número, sem o zero da frente.
function twPontosDoTexto(s) {
  const m = /(\d{1,3}(?:[.,]\d{1,3})*)\s*(mil|k|mi|m)?\D*$/i.exec(String(s ?? ''));
  if (!m) return null;
  const num = m[1].replace(/^0+(?=\d)/, ''), suf = (m[2] ?? '').toLowerCase(), mult = suf === 'mil' || suf === 'k' ? 1e3 : suf ? 1e6 : 1;
  const n = mult > 1 ? Number(num.replace(',', '.')) : Number(num.replace(/[.,]/g, ''));
  return Number.isFinite(n) ? { n: Math.round(n * mult), txt: m[2] ? `${num} ${m[2]}` : num } : null;
}
const TW_ESTADO_JS = `(() => {
  const v = document.querySelector('video');
  const p = document.querySelector('[data-test-selector="balance-string"]') || document.querySelector('.community-points-summary button');
  const aviso = document.querySelector('[data-a-target="content-classification-gate-overlay-start-watching-button"], [data-a-target="player-overlay-mature-accept"]');
  const codec = /codecs="?([a-z0-9]+)/i.exec((window.__pkmCodecs || []).filter(t => /^video/i.test(t)).at(-1) || '')?.[1] || '';
  return { tocando: !!v && !v.paused && v.readyState >= 2, altura: v?.videoHeight ?? 0, pontos: p?.textContent ?? null, aviso: !!aviso, codec };
})()`;
// O formato do vídeo (AV1 e HEVC recusados, `__pkmCodecs`): ver twitch-preload.js
async function twLivesEstado(i) {
  const out = {};
  for (const c of cfg.twitch.canais[i]) {
    const v = twViews[i].get(canalId(c));
    if (c.plat !== 'twitch' || !c.video || !v || v.webContents.isDestroyed()) continue;
    const e = await sniperJs(v.webContents, TW_ESTADO_JS);
    if (e) out[c.login] = e;
  }
  return out;
}
function twGuardarPontos(login, txt) {
  const p = twPontosDoTexto(txt);
  if (!p) return false;
  const tw = cfg.twitch;
  (tw.pontos ??= {})[login] = p.n;
  (tw.pontosTxt ??= {})[login] = p.txt;
  (tw.pontosEm ??= {})[login] = Date.now();
  return true;
}

// ---- Os pontos na tela do próprio jogo (pedido do usuário em 04/11/2026: "minha pontuação de cada canal nessa tela")
// Na Conta 1, um número ao lado de cada canal das telas Bônus Twitch e Bônus Kick. Só mexe na tela, nesta máquina: o jogo
// não fica sabendo. O jogo remonta a lista a cada mudança no bloco (a contagem de espectadores anda sozinha), daí o vigia,
// que repõe o número antes de a tela ser desenhada. E fechar só esconde o modal: #tw-corpo continua no documento até a
// próxima abertura, por isso quem diz se a tela está à vista é o .hidden do #modal.
// O canal que não está com vídeo tem o saldo lido na página do chat, que mostra os pontos e não abre vídeo (não ocupa as 2
// vagas da Twitch): um por vez, e de novo só depois de 6 h. O que está com vídeo é lido na própria página, a cada
// conferência e ao abrir a tela.
const TELA_PONTOS_SCRIPT = `(() => {
  if (window.__pkmTelaPontos) return;
  let d = { tw: {}, em: {}, kk: {} }, aVista = null;
  const vigiadas = new WeakSet();
  const vigiar = el => { if (el && !vigiadas.has(el)) { vigiadas.add(el); new MutationObserver(pintar).observe(el, { childList: true }); } };
  function chip(a, txt, em) {
    let el = a.querySelector('.pkm-pontos');
    if (txt == null) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('span');
      el.className = 'pkm-pontos';
      el.style.cssText = 'flex:none;padding:2px 8px;border-radius:999px;background:#0000004d;color:#fff;font-size:11.5px;white-space:nowrap';
      (a.querySelector('.kk-canal-pontos, .kk-canal-falta') ?? a.querySelector('.tw-canal-nome, .kk-canal-nome'))?.after(el);
      // Com a janela estreita (grade de 4 contas e o painel aberto), a linha quebra em vez de empurrar o modal para o lado
      a.style.flexWrap = 'wrap'; a.style.rowGap = '4px';
    }
    const t = txt + ' pts';
    if (el.textContent !== t) el.textContent = t;
    el.title = em ? 'Seus pontos neste canal, como a Twitch mostra (arredondado), lidos em ' + new Date(em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'Seus pontos neste canal';
  }
  const canalDe = a => { try { return decodeURIComponent(new URL(a.href).pathname.split('/')[1] || '').toLowerCase(); } catch { return ''; } };
  function pintar() {
    vigiar(document.getElementById('modal-corpo'));
    const tw = document.getElementById('tw-corpo'), kk = document.getElementById('kk-corpo');
    const v = (tw || kk) && !document.getElementById('modal')?.classList.contains('hidden') ? tw || kk : null;
    if (v && v !== aVista) console.debug('__pkmTelaPontos:' + (tw ? 'tw' : 'kk'));
    aVista = v;
    if (!v) return;
    vigiar(v);
    for (const a of v.querySelectorAll('a.tw-canal, a.kk-canal')) {
      const c = canalDe(a);
      if (tw) chip(a, d.tw[c], d.em[c]); else chip(a, d.kk[c]);
    }
  }
  window.__pkmTelaPontos = x => { d = x; pintar(); };
  setInterval(pintar, 1000);
})();`;
function twTelaEnviar() {
  const wc = views[TW_AUTO_CONTA]?.webContents;
  if (!wc || wc.isDestroyed()) return;
  const kk = {};
  for (const [id, n] of Object.entries(twAuto.pontos)) if (id.startsWith('kick:')) kk[id.slice(5)] = n.toLocaleString('pt-BR');
  const dados = { tw: cfg.twitch.pontosTxt ?? {}, em: cfg.twitch.pontosEm ?? {}, kk };
  wc.executeJavaScript(`window.__pkmTelaPontos?.(${JSON.stringify(dados)}); 0`).catch(() => {});
}
const TW_SALDO_IDADE = 6 * 3600e3;
const TW_SALDO_JS = `(document.querySelector('[data-test-selector="balance-string"]') || document.querySelector('.community-points-summary button'))?.textContent ?? null`;
// A janela escondida da leitura em curso. Fecha junto com a principal (`win.on('close')`): o app só sai quando não sobra
// nenhuma janela, e com ela aberta ficaria rodando sem ninguém ver.
let twSaldoJanela = null;
// O texto do saldo; null se a página não mostrou número; undefined se o app fechou no meio
async function twSaldoLer(i, login) {
  const w = twSaldoJanela = new BrowserWindow({ show: false, webPreferences: { partition: `persist:conta${i + 1}`, sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: false } });
  w.webContents.setAudioMuted(true);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.loadURL(`https://www.twitch.tv/popout/${encodeURIComponent(login)}/chat?popout=`).catch(() => {});
  try {
    // Só vale o número que parou de mudar: antes de o saldo chegar, a página pode mostrar um 0 que não é o saldo
    const fim = Date.now() + (VEND_TESTE ? 4000 : 25000);
    let visto = null, desde = 0;
    while (Date.now() < fim && !w.isDestroyed()) {
      const txt = await sniperJs(w.webContents, TW_SALDO_JS, 3000);
      if (txt && /\d/.test(txt)) {
        if (txt !== visto) { visto = txt; desde = Date.now(); } else if (Date.now() - desde >= 1500) return txt;
      }
      await espera(500);
    }
    return w.isDestroyed() ? undefined : visto;
  } finally { if (!w.isDestroyed()) w.destroy(); }
}
let twSaldosRodando = false;
async function twSaldosAtualizar(i) {
  if (twSaldosRodando) return;
  twSaldosRodando = true;
  const lidos = [], semNumero = [];
  try {
    const wc = views[i]?.webContents;
    if (!wc || wc.isDestroyed() || !await twUsuario(i)) return;
    const tw = await sniperJs(wc, 'window.__pkmTwitch?.tw ?? null');
    const tentou = (cfg.twitch.saldoTentou ??= {});
    for (const o of Array.isArray(tw?.oficiais) ? tw.oficiais : []) {
      const login = minusculo(o.login);
      if (!o.ativo || cfg.twitch.canais[i].some(c => c.plat === 'twitch' && c.login === login && c.video) || Date.now() - (tentou[login] ?? 0) < TW_SALDO_IDADE) continue;
      if (!win || win.isDestroyed()) break;
      const txt = await twSaldoLer(i, login);
      if (txt === undefined) break;
      tentou[login] = Date.now();
      if (twGuardarPontos(login, txt)) lidos.push(`${login}=${cfg.twitch.pontosTxt[login]}`); else semNumero.push(login);
      twTelaEnviar();
      await espera(VEND_TESTE ? 50 : 2000);
    }
  } finally {
    twSaldosRodando = false;
    if (lidos.length || semNumero.length) {
      saveCfg();
      twAutoLog(`Conta ${i + 1}: saldos da Twitch lidos na página do chat: ${lidos.join(', ') || 'nenhum'}${semNumero.length ? `; sem número: ${semNumero.join(', ')}` : ''}`);
    }
  }
}
// A tela do jogo abriu: o que dá para atualizar sem custo vai na hora. Na Kick é um pedido por canal, então no máximo uma
// rodada por minuto, por mais que a pessoa abra e feche a tela.
let kkTelaEm = 0;
async function twTelaAberta(qual) {
  const i = TW_AUTO_CONTA;
  const wc = views[i]?.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (qual === 'kk') {
    if (Date.now() - kkTelaEm >= (VEND_TESTE ? 0 : 60000) && await kickLogado(i)) {
      kkTelaEm = Date.now();
      const kk = await sniperJs(wc, 'window.__pkmKick?.kk ?? null');
      const p = await kickPontos(i, (kk?.oficiais ?? []).filter(o => o.ativo).map(o => minusculo(o.slug)));
      for (const [s, n] of Object.entries(p)) twAuto.pontos[`kick:${s}`] = n;
    }
  } else {
    for (const [l, e] of Object.entries(await twLivesEstado(i))) twGuardarPontos(l, e.pontos);
    twSaldosAtualizar(i).catch(() => {});
  }
  twTelaEnviar();
}

// ---- O baú dos pontos do canal na Twitch (pedido do usuário em 04/11/2026: "pode fazer, quero só resgatar os pontos")
// A Twitch dá +50 a cada 15 min de live assistida, mas só para quem clica no baú: sem ele são 120 pontos por hora em cada
// live, com ele 320. Só clica nas lives com vídeo, nunca em quem está só no chat nem nas janelas que leem o saldo, e nunca
// gasta pontos. Liga no 🎁 do painel e vem desligado em instalação nova: os termos da Twitch proíbem meios automáticos de
// forma geral (item xi de "Prohibited Conduct"), então quem decide é cada um. O seletor e o clique são os do BetterTTV.
const TW_BAU_MS = VEND_TESTE ? 300 : 60000;
const TW_BAU_ACHAR = `(() => {
  const el = document.querySelector('.claimable-bonus__icon');
  if (!el) return null;
  const b = el.closest('button') ?? el;
  return b.disabled || (b.getAttribute('class') + ' ' + el.getAttribute('class')).includes('ScCoreButtonDestructive') ? null : b;
})()`;
const TW_BAU_CLICAR_JS = `(() => {
  const b = ${TW_BAU_ACHAR};
  if (!b) return false;
  if (b.click) b.click(); else b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
})()`;
const TW_BAU_TEM_JS = `!!${TW_BAU_ACHAR}`;
const TW_BAU_RESUMO_JS = `(() => {
  const el = document.querySelector('.community-points-summary');
  if (!el) return 'a página não tem o resumo de pontos';
  const c = el.cloneNode(true);
  c.querySelectorAll('svg, img').forEach(x => x.replaceWith('·'));
  return c.outerHTML.slice(0, 1500);
})()`;
let twBauRodando = false, twBauVisto = Date.now(), twBauAnotou = false;
const twBauEspera = new Map(); // "conta:login" -> não tenta antes disto: o clique não fez o baú sumir
const twBauHoje = () => (cfg.twitch.bauDia?.dia === repHoje() ? cfg.twitch.bauDia.n : 0);
async function twBauConferir() {
  if (!cfg.twitch.bau || twBauRodando || cfg.twitch.pausado) return;
  twBauRodando = true;
  try {
    let comVideo = null;
    for (let i = 0; i < TOTAL; i++) for (const c of [...cfg.twitch.canais[i]]) {
      const wc = twViews[i].get(canalId(c))?.webContents, chave = `${i}:${c.login}`;
      if (c.plat !== 'twitch' || !c.video || !wc || wc.isDestroyed()) continue;
      comVideo ??= wc;
      if (Date.now() < (twBauEspera.get(chave) ?? 0) || !await sniperJs(wc, TW_BAU_CLICAR_JS)) continue;
      twBauVisto = Date.now();
      // A resposta passa pelo servidor da Twitch: dá uns segundos para o baú sair da tela
      let sumiu = false;
      for (let k = 0; k < 3 && !sumiu && !wc.isDestroyed(); k++) {
        await espera(VEND_TESTE ? 100 : 2000);
        sumiu = (await sniperJs(wc, TW_BAU_TEM_JS)) === false;
      }
      if (sumiu) {
        cfg.twitch.bauDia = { dia: repHoje(), n: twBauHoje() + 1 };
        saveCfg();
        twAutoLog(`Conta ${i + 1}: baú da Twitch em ${c.login} resgatado (${cfg.twitch.bauDia.n} hoje)`);
        pushTwitchState();
      } else {
        twBauEspera.set(chave, Date.now() + 15 * 60000);
        twAutoLog(`Conta ${i + 1}: baú da Twitch em ${c.login}: cliquei e ele não sumiu; tento de novo em 15 min`);
      }
    }
    // 20 min com vídeo e nenhum baú: a live não está contando ou a Twitch mudou a página. Anota como ela está, uma vez só.
    if (comVideo && !twBauAnotou && Date.now() - twBauVisto > (VEND_TESTE ? 4000 : 20 * 60000)) {
      twBauAnotou = true;
      twAutoLog(`Baú da Twitch: nenhum em 20 min com vídeo aberto. Como está o resumo de pontos: ${await sniperJs(comVideo, TW_BAU_RESUMO_JS)}`);
    }
  } finally { twBauRodando = false; }
}

// A que ficou parada leva um empurrão; parada de novo na conferência seguinte, é recarregada
const twParadas = new Map();
function twDestravar(i, estados) {
  for (const [login, e] of Object.entries(estados)) {
    const wc = twViews[i].get(login)?.webContents;
    if (!wc || e.tocando || e.aviso) { twParadas.delete(login); continue; }
    const n = (twParadas.get(login) ?? 0) + 1;
    twParadas.set(login, n);
    if (n >= 2) { twParadas.delete(login); wc.reload(); }
    else wc.executeJavaScript(`document.querySelector('video')?.play().catch(() => {}); 0`).catch(() => {});
  }
}
// O player só lê a qualidade guardada ao iniciar: a live que abre pela primeira vez sobe no automático (720p medido em
// 04/11/2026, ~70% de um núcleo). Recarregada, já acha o 160p guardado. No máximo 2 vezes por live: canal sem as
// qualidades baixas fica no que tem. A que a pessoa está vendo ou ouvindo não é mexida.
const TW_ALTURA_MAX = 240;
const twRecargas = new Map();
async function twBaixarQualidade(i, estados) {
  for (const [login, e] of Object.entries(estados)) {
    const wc = twViews[i].get(login)?.webContents;
    const fixa = twAVista(i, login) || (cfg.twitch.ouvir?.conta === i && cfg.twitch.ouvir?.id === login);
    if (!wc || fixa || !e.tocando || e.altura <= TW_ALTURA_MAX || (twRecargas.get(login) ?? 0) >= 2) continue;
    twRecargas.set(login, (twRecargas.get(login) ?? 0) + 1);
    twAutoLog(`Conta ${i + 1}: ${login} estava em ${e.altura}p; recarregando para ficar em 160p`);
    await wc.executeJavaScript(`localStorage.setItem('video-quality', '{"default":"160p30"}'); 0`).catch(() => {});
    wc.reload();
  }
}

// Pontos do canal na Kick, por canal: o mesmo pedido que o site da Kick faz, com o login dela
// guardado na sessão da conta. O login não sai daqui; só o número volta.
async function kickPontos(i, slugs) {
  const ses = session.fromPartition(`persist:conta${i + 1}`);
  let tok = '';
  try {
    const cs = await ses.cookies.get({ name: 'session_token' });
    tok = decodeURIComponent(cs.find(c => /kick\.com$/.test(c.domain.replace(/^\./, '')))?.value ?? '');
  } catch {}
  const out = {};
  if (!tok) return out;
  for (const s of slugs) {
    try {
      const r = await ses.fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(s)}/points`, {
        headers: { accept: 'application/json', authorization: `Bearer ${tok}` }
      });
      const j = await r.json();
      const p = Number(j?.data?.points);
      if (r.ok && Number.isFinite(p)) out[s] = p;
    } catch {}
  }
  return out;
}
const twAutoLog = msg => {
  try {
    const f = path.join(app.getPath('userData'), 'twitch-auto.log');
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.old'); } catch {}
    fs.appendFileSync(f, `${new Date().toLocaleString('pt-BR')}  ${msg}\n`);
  } catch {}
};

// O que a lista de lives do jogo diz que vale abrir: nas duas plataformas, as lives no ar com as recompensas do jogo
// no canal — a mesma regra do próprio jogo (`livesTwitchNoAr` e `livesKickNoAr`)
const minusculo = x => String(x ?? '').toLowerCase();
function livesDoJogo(tw, kk) {
  return {
    tw: (tw?.oficiais ?? []).filter(o => o.aoVivo && o.ativo).map(o => minusculo(o.login)),
    kk: (kk?.oficiais ?? []).filter(o => o.aoVivo && o.ativo).map(o => minusculo(o.slug))
  };
}
const assinaturaLives = (tw, kk) => { const l = livesDoJogo(tw, kk); return `${[...l.tw].sort()}|${[...l.kk].sort()}`; };

// A LISTA MUDOU — uma live começou, acabou ou perdeu o bônus —: confere em ~1 min em vez de esperar os 30. O jogo
// manda o bloco `twitch`/`kick` inteiro a cada mudança (o WS_ESCUTA guarda o último); aqui, 1x por minuto, só a
// assinatura do que importa. A mudança tem de aparecer em duas leituras seguidas para valer: uma lista vazia por um
// instante não fecha tudo.
let twListaUlt = '', twListaPend = '';
async function twListaVigiar() {
  if (cfg.twitch.pausado) return;
  const wc = views[TW_AUTO_CONTA]?.webContents;
  if (!wc || wc.isDestroyed() || twAutoRodando) return;
  const d = await wc.executeJavaScript('({ tw: window.__pkmTwitch?.tw ?? null, kk: window.__pkmKick?.kk ?? null })').catch(() => null);
  if (!d?.tw && !d?.kk) return;
  const sig = assinaturaLives(d.tw, d.kk);
  if (!twListaUlt || sig === twListaUlt) { twListaUlt ||= sig; twListaPend = ''; return; }
  if (sig !== twListaPend) { twListaPend = sig; return; }
  twAutoLog(`Conta ${TW_AUTO_CONTA + 1}: a lista de lives do jogo mudou; conferindo agora`);
  twAutoVerificar();
}

// Uma conferência por vez: a agendada, a do botão 🔄 e a da lista que mudou podem coincidir
let twAutoRodando = false;
async function twAutoVerificar() {
  if (twAutoRodando || cfg.twitch.pausado) return;
  twAutoRodando = true;
  try { await twAutoConferir(); } finally { twAutoRodando = false; }
}

async function twAutoConferir() {
  const i = TW_AUTO_CONTA;
  const wc = views[i]?.webContents;
  if (!wc || wc.isDestroyed()) return;
  let dado = null;
  try { dado = await wc.executeJavaScript('({ tw: window.__pkmTwitch?.tw ?? null, kk: window.__pkmKick?.kk ?? null })'); } catch {}
  twAuto.ultima = Date.now();
  const { tw, kk } = dado ?? {};
  if (!tw && !kk) {
    twAuto.erro = 'o jogo ainda não mandou a lista de lives (a conta está logada?)';
    twAutoLog(`Conta ${i + 1}: sem dados de lives do jogo ainda`);
    pushTwitchState();
    return;
  }
  twListaUlt = assinaturaLives(tw, kk);
  twListaPend = '';
  const minus = minusculo;
  // Sem login na plataforma não adianta abrir: nenhuma das duas dá pontos. Então cada uma só entra
  // na conferência se a conta estiver logada nela.
  const [logTw, logKk] = await Promise.all([twUsuario(i), kickLogado(i)]);
  const lista = livesDoJogo(tw, kk);
  const noArTw = logTw ? lista.tw : [];
  const noArKk = logKk ? lista.kk : [];
  if (!logTw && !logKk) {
    twAuto.noAr = 0; twAuto.abertas = [];
    twAuto.erro = 'pulei: a conta não está logada na Twitch nem na Kick';
    twAutoLog(`Conta ${i + 1}: pulei, sem login na Twitch e na Kick`);
    pushTwitchState();
    return;
  }
  // Kick: medido em 20/10/2026, a conta só ganha pontos em 2 lives por vez (~10 a cada 6 min em
  // cada), por mais que estejam abertas. E o resgate gasta pontos de UM canal. Então ficam só as
  // 2 lives no ar com mais pontos (as mais perto de um resgate); as outras da Kick são fechadas.
  // (os fora do ar só entram para a tela do jogo mostrar o saldo deles)
  const pontosKk = logKk ? await kickPontos(i, (kk?.oficiais ?? []).filter(o => o.ativo).map(o => minusculo(o.slug))) : {};
  const kickAlvo = [...noArKk].sort((a, b) => (pontosKk[b] ?? -1) - (pontosKk[a] ?? -1)).slice(0, KICK_MAX);
  // Só mexe nas lives da Kick abertas se o jogo mandou a lista dela (sem lista, não fecha nada)
  const fechadas = logKk && kk
    ? cfg.twitch.canais[i].filter(c => c.plat === 'kick' && !kickAlvo.includes(c.login)).map(canalId)
        // A live que a pessoa está ouvindo não é fechada
        .filter(id => !(cfg.twitch.ouvir?.conta === i && cfg.twitch.ouvir?.id === id))
    : [];
  for (const id of fechadas) twRemove(i, id);
  // Twitch, desde 04/11/2026: igual à Kick. Ficam as lives no ar com mais pontos (as mais perto de um resgate; empate,
  // a que já está com vídeo e depois a mais assistida), e o resto fecha. Fecha só canal oficial do jogo ou que já
  // esteve na lista (`vistas`, pedido do usuário em 26/10/2026): o que a pessoa abriu e nunca esteve nela fica, e o que
  // está à vista no painel ou no "ouvir" também. Só que tudo o que fica com vídeo, nas 4 contas, ocupa uma das 2 vagas
  // da Twitch. Sem a lista no bloco do jogo, não fecha nada.
  const vistas = new Set(cfg.twitch.vistas);
  const nVistas = vistas.size;
  noArTw.forEach(l => vistas.add(l));
  if (vistas.size !== nVistas) cfg.twitch.vistas = [...vistas];
  const oficiaisTw = new Set((tw?.oficiais ?? []).map(o => minus(o.login)));
  const estadosTw = logTw ? await twLivesEstado(i) : {};
  for (const [l, e] of Object.entries(estadosTw)) twGuardarPontos(l, e.pontos);
  const pontosTw = (cfg.twitch.pontos ??= {});
  const fechavel = c => c.plat === 'twitch' && (oficiaisTw.has(c.login) || vistas.has(c.login)) && !twAVista(i, canalId(c)) &&
    !(cfg.twitch.ouvir?.conta === i && cfg.twitch.ouvir?.id === canalId(c));
  const fixas = cfg.twitch.canais.flatMap((l, j) => l.filter(c => c.plat === 'twitch' && c.video && !(j === i && fechavel(c))).map(c => c.login));
  const comVideo = new Set(cfg.twitch.canais[i].filter(c => c.plat === 'twitch' && c.video).map(c => c.login));
  const espect = new Map((tw?.oficiais ?? []).map(o => [minus(o.login), Number(o.espectadores) || 0]));
  const twAlvo = noArTw.filter(l => !fixas.includes(l))
    .sort((a, b) => (pontosTw[b] ?? -1) - (pontosTw[a] ?? -1) || comVideo.has(b) - comVideo.has(a) || (espect.get(b) ?? 0) - (espect.get(a) ?? 0))
    .slice(0, Math.max(0, TW_MAX - fixas.length));
  const foraDoAr = logTw && Array.isArray(tw?.oficiais)
    ? cfg.twitch.canais[i].filter(c => fechavel(c) && !twAlvo.includes(c.login)).map(canalId)
    : [];
  for (const id of foraDoAr) twRemove(i, id);
  // A que ficou e era só o chat passa para o vídeo: é ele que dá os pontos
  for (const c of cfg.twitch.canais[i]) {
    if (c.plat !== 'twitch' || c.video || !twAlvo.includes(c.login)) continue;
    c.video = true;
    twViews[i].get(canalId(c))?.webContents.loadURL(twUrl(c));
  }
  const alvo = [...twAlvo.map(login => ({ login, plat: 'twitch' })), ...kickAlvo.map(login => ({ login, plat: 'kick' }))];
  const jaAbertas = new Set(cfg.twitch.canais[i].map(canalId));
  const novas = alvo.filter(c => !jaAbertas.has(canalId(c)));
  for (const c of novas) twAdd(i, c, { show: false });
  saveCfg();
  applyTwitchVisibility();
  twDestravar(i, estadosTw);
  twBaixarQualidade(i, estadosTw);
  // A que acabou de abrir só tem vídeo daqui a pouco: confere a qualidade dela em 1 min
  setTimeout(async () => { if (!win?.isDestroyed()) twBaixarQualidade(i, await twLivesEstado(i)); }, VEND_TESTE ? 800 : 60000);
  // Se o vídeo das que ficaram está mesmo rodando (é o que dá os pontos)
  const videoTxt = Object.entries(estadosTw).filter(([l]) => cfg.twitch.canais[i].some(c => c.plat === 'twitch' && c.login === l))
    .map(([l, e]) => `${l} ${e.aviso ? 'pede confirmação na página (clique nela no painel)' : e.tocando ? `tocando ${e.altura}p${e.codec ? ` ${e.codec}` : ''}` : 'parada'}`).join(', ');
  twAuto.noAr = alvo.length;
  twAuto.abertas = novas.map(canalId);
  twAuto.pontos = { ...Object.fromEntries(Object.entries(pontosKk).map(([s, n]) => [`kick:${s}`, n])), ...pontosTw };
  twAuto.erro = !logTw ? 'Twitch pulada (sem login)' : !logKk ? 'Kick pulada (sem login)' : '';
  twAutoLog(`Conta ${i + 1}: Twitch ${logTw ? `${noArTw.length} no ar com pontos (${noArTw.map(l => `${l}=${pontosTw[l] ?? '?'}`).join(', ') || 'nenhuma'}), mantidas ${twAlvo.join(', ') || 'nenhuma'}` : 'pulada, sem login'}; ` +
    `Kick ${logKk ? `${noArKk.length} no ar com pontos (${noArKk.map(s => `${s}=${pontosKk[s] ?? '?'}`).join(', ') || 'nenhuma'}), mantidas ${kickAlvo.join(', ') || 'nenhuma'}` : 'pulada, sem login'}; ` +
    `abri ${novas.length ? novas.map(canalId).join(', ') : 'nenhuma nova'}${fechadas.length ? `; fechei ${fechadas.join(', ')}` : ''}` +
    `${foraDoAr.length ? `; fechei da Twitch: ${foraDoAr.join(', ')}` : ''}${videoTxt ? `; vídeo: ${videoTxt}` : ''}`);
  pushTwitchState();
  twTelaEnviar();
  twSaldosAtualizar(i).catch(() => {});
}

// ---------- Aviso de voto do TopIdle ----------
// A mesma consulta que o jogo faz para montar a tela "Vote & Ganhe" (`/topidle/me`, com o token
// da sessão da conta): diz se o voto está liberado, quanto falta e o link com o nick. O app só
// AVISA e abre o link no navegador; o voto (com a conta Google) a pessoa faz lá.
const VOTO_JS = `(async () => {
  try {
    const s = JSON.parse(localStorage.getItem('sessao') || 'null');
    if (!s?.token) return null;
    const r = await fetch('/topidle/me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: s.token }) });
    if (!r.ok) return null;
    const d = await r.json();
    return { ativo: !!d.ativo, esperaMs: Number(d.esperaMs) || 0, url: String(d.url || ''), nick: String(d.identificador || s.nick || '') };
  } catch { return null; }
})()`;
const votos = [null, null, null, null];
const votoTimers = [];

// O jogo e o TopIdle contam a recarga cada um do seu lado: em 26/10 o jogo liberou o voto e a página
// do TopIdle ainda dizia "Volte em 1h" (ela arredonda para cima — pode faltar 1 min ou 60). Quem aceita
// o voto é o TopIdle, então, quando o jogo libera, o app confere com ele usando o login do TopIdle salvo
// na janela de voto da conta: `/api/me` diz se há login, e `/api/games` traz, para esse login, o
// `canVote` e o `nextVoteAt` (segundos) de cada jogo. É um pedido por conta por dia, na hora da liberação.
// Sem login do TopIdle na conta (ou com o site fora), vale a hora do jogo mais 1 h de folga.
const TOPIDLE_FOLGA_MS = 60 * 60000;
const topidleProx = [0, 0, 0, 0];     // quando o TopIdle libera (ms); 0 = ainda não perguntado, -1 = já livre
const votoLiberaEm = [0, 0, 0, 0];    // quando o jogo libera (ms), visto enquanto ainda faltava

async function topidleVoto(i, url) {
  const ses = session.fromPartition(`persist:conta${i + 1}`);
  const pedir = async caminho => (await ses.fetch(`https://topidle.com${caminho}`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000)
  })).json();
  try {
    const me = await pedir('/api/me');
    if (!me?.user) return { logado: false };
    const lista = (await pedir('/api/games')).games ?? [];
    const id = /\/(?:jogo|go)\/([\w-]+)/.exec(url || '')?.[1];
    const g = lista.find(x => x.id === id) ?? lista.find(x => /pokeidle\.io/i.test(x.name || ''));
    if (!g) return null;
    const prox = Number(g.nextVoteAt) * 1000 || 0;
    return { logado: true, pode: g.canVote !== false && prox <= Date.now(), prox };
  } catch { return null; }
}

const horaCurta = ms => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

async function votoChecar(i) {
  clearTimeout(votoTimers[i]);
  const wc = views[i]?.webContents;
  if (!wc || wc.isDestroyed()) return;
  let d = null;
  if (/^https:\/\/pokeidle\.io\//.test(wc.getURL())) d = await wc.executeJavaScript(VOTO_JS).catch(() => null);
  // Quanto falta de verdade: o do jogo enquanto ele ainda conta; depois que ele libera, o do TopIdle
  let espera = d?.esperaMs ?? 0;
  if (d?.ativo && d.esperaMs > 0) {
    votoLiberaEm[i] = Date.now() + d.esperaMs;
    topidleProx[i] = 0;
  } else if (d?.ativo) {
    // Pergunta uma vez quando o jogo libera, e de novo só quando chegar a hora que o TopIdle deu
    if (topidleProx[i] === 0 || (topidleProx[i] > 0 && topidleProx[i] <= Date.now())) {
      const t = await topidleVoto(i, d.url);
      if (t?.logado) {
        topidleProx[i] = t.pode || !(t.prox > Date.now()) ? -1 : t.prox;
        if (topidleProx[i] > 0) twAutoLog(`Voto Conta ${i + 1}: o jogo já liberou, mas o TopIdle só às ${horaCurta(t.prox)}`);
      } else if (votoLiberaEm[i] + TOPIDLE_FOLGA_MS > Date.now()) {
        topidleProx[i] = votoLiberaEm[i] + TOPIDLE_FOLGA_MS;
        twAutoLog(`Voto Conta ${i + 1}: ${t ? 'sem login do TopIdle nesta conta' : 'TopIdle não respondeu'} — aviso às ${horaCurta(topidleProx[i])} (1 h de folga)`);
      } else topidleProx[i] = -1;
    }
    if (topidleProx[i] > Date.now()) espera = topidleProx[i] - Date.now();
  }
  const antes = !!votos[i]?.pode, primeira = votos[i] === null && !votoTimers[`ok${i}`];
  votos[i] = d ? { ...d, esperaMs: espera, pode: d.ativo && espera <= 0 } : null;
  if (primeira || antes !== !!votos[i]?.pode) {
    votoTimers[`ok${i}`] = true;
    const h = Math.ceil((votos[i]?.esperaMs ?? 0) / 60000);
    twAutoLog(`Voto Conta ${i + 1}: ${!d ? 'sem resposta (conta logada?)' : votos[i].pode ? 'liberado' : `falta ${Math.floor(h / 60)}h${String(h % 60).padStart(2, '0')}`}`);
  }
  if (votos[i]?.pode && !antes) avisarVoto(i);
  // Olha de novo logo depois de a recarga acabar, ou a cada 15 min
  const v = votos[i];
  const prox = v && !v.pode && v.esperaMs > 0 ? Math.min(v.esperaMs + 30000, 15 * 60000) : 15 * 60000;
  votoTimers[i] = setTimeout(() => votoChecar(i), prox);
  pushState();
}

function avisarVoto(i) {
  const v = votos[i];
  twAutoLog(`Voto liberado na Conta ${i + 1} (${v?.nick || cfg.names[i]})`);
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: 'Voto disponível no TopIdle',
    body: `${cfg.names[i]}${v?.nick ? ` (${v.nick})` : ''} já pode votar. Clique para abrir.`
  });
  n.on('click', () => abrirVoto(i));
  n.show();
}

function abrirVoto(i, url = votos[i]?.url) {
  if (!url || !/^https:\/\//i.test(url)) return;
  abrirJanelaVoto(i, url);
  // O TopIdle avisa o jogo em segundos; daqui a 3 min o selo some se o voto entrou
  clearTimeout(votoTimers[i]);
  votoTimers[i] = setTimeout(() => votoChecar(i), 3 * 60000);
}

// O TopIdle abre numa janela do app, na sessão da conta: o login dele fica salvo por conta.
// Lá dá para entrar com Google ou Discord, mas o Google recusa login dentro de apps (o mesmo
// bloqueio do jogo); o Discord funciona.
const isTopIdleHost = host => /(^|\.)topidle\.com$/.test(host);
const votoWins = [];
function abrirJanelaVoto(i, url) {
  const part = `persist:conta${i + 1}`;
  let w = votoWins[i];
  if (w && !w.isDestroyed()) {
    w.loadURL(url);
    if (w.isMinimized()) w.restore();
    return w.focus();
  }
  w = votoWins[i] = new BrowserWindow({
    width: 1150, height: 850, parent: win, autoHideMenuBar: true, backgroundColor: '#0e0e10',
    title: `Votar no TopIdle · ${cfg.names[i]}${votos[i]?.nick ? ` (${votos[i].nick})` : ''}`,
    webPreferences: { partition: part, contextIsolation: true, sandbox: true }
  });
  w.on('page-title-updated', e => e.preventDefault());
  // Login (Discord/Google) em pop-up na mesma sessão; links de fora vão para o navegador
  w.webContents.setWindowOpenHandler(({ url: u }) => {
    try {
      const host = new URL(u).hostname;
      if (isTopIdleHost(host) || /(^|\.)discord\.com$|(^|\.)google\.com$/.test(host)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 760, autoHideMenuBar: true, webPreferences: { partition: part } } };
      }
    } catch {}
    shell.openExternal(u);
    return { action: 'deny' };
  });
  w.on('closed', () => setTimeout(() => votoChecar(i), 5000));
  w.loadURL(url);
}

// ⏸ PAUSAR AS LIVES (06/11/2026, pedido do usuário depois de fechar as lives à mão às 15:35 e o app reabrir sozinho às
// 15:46): fecha as páginas de todas as lives, nas 4 contas, e o app para de abrir, conferir, trocar e clicar no baú até
// a pessoa retomar. A lista de canais fica guardada, e a pausa continua depois de fechar e abrir o app. Retomar recria
// as páginas e confere na hora (as 2 + 2 com mais pontos). Abrir um canal pelo + do painel ou pelo jogo também retoma.
function twPausar() {
  if (cfg.twitch.pausado) return;
  cfg.twitch.pausado = true;
  cfg.twitch.ouvir = null;
  for (const m of twViews) {
    for (const v of m.values()) { win.contentView.removeChildView(v); if (!v.webContents.isDestroyed()) v.webContents.close(); }
    m.clear();
  }
  saveCfg();
  layout();
  applyTwitchVisibility();
  pushState();
  twAutoLog('Lives PAUSADAS: fechei todas; o app não abre nenhuma até retomar');
  appLog('lives pausadas');
}
function twRetomar(motivo = '') {
  if (!cfg.twitch.pausado) return;
  cfg.twitch.pausado = false;
  saveCfg();
  for (let i = 0; i < TOTAL; i++) for (const c of cfg.twitch.canais[i]) if (!twViews[i].has(canalId(c))) twCreate(i, c);
  layout();
  applyTwitchVisibility();
  pushState();
  twAutoLog(`Lives retomadas${motivo ? ` (${motivo})` : ''}`);
  appLog('lives retomadas');
  twAutoVerificar();
}

function twRemove(i, id) {
  const lista = cfg.twitch.canais[i];
  const at = lista.findIndex(c => canalId(c) === id);
  if (at < 0) return;
  lista.splice(at, 1);
  if (cfg.twitch.ouvir?.conta === i && cfg.twitch.ouvir?.id === id) cfg.twitch.ouvir = null;
  const v = twViews[i].get(id);
  if (v) { win.contentView.removeChildView(v); v.webContents.close(); twViews[i].delete(id); }
  if (cfg.twitch.ativo[i] === id) { const c = lista[Math.min(at, lista.length - 1)]; cfg.twitch.ativo[i] = c ? canalId(c) : ''; }
  saveCfg();
  layout();
  applyTwitchVisibility();
  pushState();
}

function twToggleVideo(i, id) {
  const c = cfg.twitch.canais[i].find(x => canalId(x) === id);
  if (!c) return;
  c.video = !c.video;
  saveCfg();
  twViews[i].get(id)?.webContents.loadURL(twUrl(c));
  applyTwitchVisibility();
  pushState();
}

const twAVista = (i, id) => cfg.twitch.open && i === active && cfg.twitch.ativo[i] === id;
const ouvindoFora = (i, id) => cfg.twitch.ouvir?.conta === i && cfg.twitch.ouvir?.id === id && !twAVista(i, id);
// As que tocam fora da janela (ver `layout`): a do "ouvir" e a da Twitch com vídeo. A da Kick toca escondida mesmo.
const tocaFora = (i, id) => ouvindoFora(i, id) ||
  (!id.startsWith('kick:') && !twAVista(i, id) && cfg.twitch.canais[i].some(c => canalId(c) === id && c.video));

// A página da Twitch que toca fora da janela não precisa desenhar o que ninguém vê: o chat de uma live movimentada
// custava ~70% de um núcleo (107% contra 39% de uma live calma, medido em 04/11/2026). O saldo de pontos fica junto do
// campo do chat, que continua lá.
const TW_CSS_FORA = `.chat-scrollable-area__message-container, .chat-list__list-container, .side-nav, [data-a-target="side-nav-bar"],
  .channel-info-content, .about-section, .channel-panels { display: none !important; }`;
// Guarda TODAS as chaves: a live que abre fora da janela recebe o CSS duas vezes (ao ser criada, com a página carregando,
// e no dom-ready), e com uma chave só a outra cópia ficava para sempre, sem chat quando a pessoa fosse ver a live.
const twCssFora = new WeakMap(); // webContents -> { quer, chaves }
async function twAplicarCssFora(wc, fora, paginaNova = false) {
  if (wc.isDestroyed()) return;
  let e = twCssFora.get(wc);
  if (!e) twCssFora.set(wc, e = { quer: false, chaves: [] });
  if (!paginaNova && fora === e.quer) return;
  e.quer = fora;
  if (fora) {
    const k = await wc.insertCSS(TW_CSS_FORA).catch(() => null);
    if (k == null || wc.isDestroyed()) return;
    // Mudou de ideia enquanto o CSS entrava: ele sai na hora
    if (e.quer) e.chaves.push(k); else wc.removeInsertedCSS(k).catch(() => {});
  } else {
    for (const k of e.chaves.splice(0)) wc.removeInsertedCSS(k).catch(() => {});
  }
}

function applyTwitchVisibility() {
  const ouvir = cfg.twitch.ouvir; // { conta, id } da live escolhida para ficar ouvindo, ou null
  layout(); // reposiciona as lives que tocam fora da janela
  twViews.forEach((m, i) => m.forEach((v, id) => {
    const visible = twAVista(i, id);
    v.setVisible(visible || tocaFora(i, id));
    if (!id.startsWith('kick:')) twAplicarCssFora(v.webContents, !visible && tocaFora(i, id));
    // Com uma live no "ouvir", só ela tem som (esteja à vista ou não). Sem ela, o som é da live
    // à vista e com vídeo; as escondidas (que rodam com vídeo pelos pontos) ficam mudas.
    const c = cfg.twitch.canais[i].find(x => canalId(x) === id);
    const som = ouvir ? ouvir.conta === i && ouvir.id === id : visible && c?.video;
    v.webContents.setAudioMuted(!som);
    // Desacelerar a live (ver `desacelera`): só a que está só no chat — escondido, ele gastava ~4,5% de um núcleo
    // desenhando, e desacelerado 0,4% (teste de 26/10/2026). A com vídeo NUNCA: o bônus são pontos por assistir, e em
    // 26/10/2026 a Kick escondida e desacelerada seguiu tocando o vídeo mas parou de dar pontos (faturetosl e biscoitao
    // ficaram 24 min sem ganhar, contra ~10 a cada 6 min soltas); e a do "ouvir" tem que tocar com o app minimizado.
    v.webContents.setBackgroundThrottling(desacelera() && !c?.video);
  }));
}

// Liga/desliga o "ouvir" de uma live. Uma por vez: escolher outra troca o som de lugar.
function twOuvir(i, id) {
  const atual = cfg.twitch.ouvir;
  if (atual && atual.conta === i && atual.id === id) {
    cfg.twitch.ouvir = null;
  } else {
    const c = cfg.twitch.canais[i].find(x => canalId(x) === id);
    if (!c) return;
    cfg.twitch.ouvir = { conta: i, id };
    // O som vem do vídeo: a live que estava só no chat passa para o vídeo
    if (!c.video) { c.video = true; twViews[i].get(id)?.webContents.loadURL(twUrl(c)); }
    const v = twViews[i].get(id);
    if (!v) return;
    // O player pode ter guardado "mudo" ou volume zero; destrava quando o vídeo existir
    const destravar = () => v.webContents.executeJavaScript(
      `document.querySelectorAll('video').forEach(x => { x.muted = false; if (!x.volume) x.volume = 0.5; if (x.paused) x.play().catch(() => {}); })`).catch(() => {});
    setTimeout(destravar, 1500);
    setTimeout(destravar, 8000);
  }
  saveCfg();
  applyTwitchVisibility();
  pushState();
}

// Qual Twitch está logada nesta conta: a Twitch grava o nome do usuário no cookie "login"
async function twUsuario(i) {
  try {
    const cs = await session.fromPartition(`persist:conta${i + 1}`).cookies.get({ name: 'login' });
    return cs.find(c => /twitch\.tv$/.test(c.domain.replace(/^\./, '')))?.value ?? '';
  } catch { return ''; }
}

// A Kick logada deixa o cookie "session_token" no kick.com
async function kickLogado(i) {
  try {
    const cs = await session.fromPartition(`persist:conta${i + 1}`).cookies.get({ name: 'session_token' });
    return cs.some(c => /kick\.com$/.test(c.domain.replace(/^\./, '')) && c.value);
  } catch { return false; }
}

async function pushTwitchState() {
  if (!twbar || twbar.webContents.isDestroyed()) return;
  const conta = active;
  const [usuario, kick] = await Promise.all([twUsuario(conta), kickLogado(conta)]);
  if (twbar.webContents.isDestroyed()) return;
  twbar.webContents.send('twstate', {
    conta,
    nome: cfg.names[conta],
    usuario,
    kick,
    canais: cfg.twitch.canais[conta].map(c => ({ ...c, id: canalId(c), pontos: conta === TW_AUTO_CONTA ? twAuto.pontos[canalId(c)] ?? null : null })),
    ativo: cfg.twitch.ativo[conta],
    lista: cfg.twitch.lista,
    // A live no "ouvir" (pode ser de outra conta: aí a barra mostra para dar para desligar)
    ouvir: cfg.twitch.ouvir ? {
      ...cfg.twitch.ouvir,
      nome: cfg.twitch.canais[cfg.twitch.ouvir.conta]?.find(c => canalId(c) === cfg.twitch.ouvir.id)?.login ?? '',
      contaNome: cfg.names[cfg.twitch.ouvir.conta]
    } : null,
    auto: conta === TW_AUTO_CONTA ? { ...twAuto, proxima: twAuto.proxima } : null,
    bau: { ligado: !!cfg.twitch.bau, hoje: twBauHoje() },
    pausado: !!cfg.twitch.pausado,
    total: cfg.twitch.canais.reduce((s, l) => s + l.length, 0)
  });
}

// Janela de login da Twitch, na sessão da conta. Fecha sozinha quando o login entra, e os
// chats daquela conta recarregam já logados.
// Na Kick o login é um pop-up dentro do site: a janela abre o kick.com e a pessoa clica em entrar.
const twLoginWins = {};
function twAbrirLogin(i, plat = 'twitch') {
  const chave = `${plat}${i}`;
  if (twLoginWins[chave] && !twLoginWins[chave].isDestroyed()) return twLoginWins[chave].focus();
  const part = `persist:conta${i + 1}`;
  const kick = plat === 'kick';
  const w = twLoginWins[chave] = new BrowserWindow({
    width: kick ? 1000 : 520, height: 780, parent: win, autoHideMenuBar: true, backgroundColor: '#0e0e10',
    title: `Entrar na ${kick ? 'Kick' : 'Twitch'} · ${cfg.names[i]}`,
    webPreferences: { partition: part, contextIsolation: true, sandbox: true }
  });
  w.webContents.setAudioMuted(true);
  w.on('page-title-updated', e => e.preventDefault());
  w.webContents.setWindowOpenHandler(abrirPopupNaSessao(part));
  const ses = session.fromPartition(part);
  const aoMudarCookie = (_e, cookie, _cause, removed) => {
    const dom = cookie.domain.replace(/^\./, '');
    const entrou = kick ? cookie.name === 'session_token' && /kick\.com$/.test(dom) && cookie.value
      : cookie.name === 'login' && /twitch\.tv$/.test(dom);
    if (removed || !entrou) return;
    setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 2000);
  };
  ses.cookies.on('changed', aoMudarCookie);
  w.on('closed', () => {
    ses.cookies.removeListener('changed', aoMudarCookie);
    for (const [id, v] of twViews[i]) {
      if ((id.startsWith('kick:') === kick) && !v.webContents.isDestroyed()) v.webContents.reload();
    }
    pushTwitchState();
  });
  w.loadURL(kick ? 'https://kick.com/' : 'https://www.twitch.tv/login');
}

function toggleTwitch() {
  if (!licenca.premium()) return licenca.pedirPremium('O 📺 painel de lives');
  cfg.twitch.open = !cfg.twitch.open;
  saveCfg();
  layout();
  applyTwitchVisibility();
  pushState();
}

function select(i, focus = true) {
  if (i < 0 || i >= TOTAL) return;
  active = i;
  cfg.active = i;
  saveCfg();
  applyVisibility(focus);
}

function toggleGrid() {
  cfg.grid = !cfg.grid;
  saveCfg();
  applyVisibility();
}

// 🍃 Ultra leve: o desacelerar em tudo (contas e chats; as lives com vídeo não), o movimento reduzido do jogo e a faxina
// de memória.
function toggleUltra() {
  cfg.ultra = !cfg.ultra;
  saveCfg();
  appLog(`ultra leve ${cfg.ultra ? 'LIGADO' : 'desligado'}`);
  views.forEach(v => aplicarMovimento(v.webContents));
  applyVisibility(false);
}

// ---------- 🍃 Ultra leve: faxina de memória ----------
// Página ESCONDIDA que passa muito do normal em 3 leituras seguidas (15 min) é recarregada, no máximo 1x por
// hora cada. Na madrugada de 25 para 26/10/2026 o app foi de 6,1 para 9 GB em 9,5 h com as mesmas 13 lives.
// Uma conta do jogo recarregada volta em segundos (o servidor segura a caçada por 90 s numa reconexão); cada
// conta espera o sniper dela ficar livre (a Conta 1, também os monitores). Pela memória PRIVADA de cada página — o
// normal, em 26/10, era conta 250–550 MB, chat da Twitch ~190 MB e vídeo da Kick ~280 MB.
const FAXINA_MB = { conta: 1000, twitch: 800, kick: 800 };
const faxinaLeituras = new WeakMap(); // webContents -> leituras seguidas acima do limite
const faxinaFeita = new WeakMap();    // webContents -> quando a faxina recarregou
async function contaLivre(i) {
  if (i === PRECO_CONTA && (pkmOcupado || pkmPendente || precoColetando)) return false;
  const wc = views[i]?.webContents;
  if (!wc || wc.isDestroyed()) return false;
  return wc.executeJavaScript('(s => !s || (!Object.keys(s.agendados).length && !Object.keys(s.pendentes).length))(window.__pkmSniper)').catch(() => false);
}
async function faxina(de) {
  const ouvindo = (i, id) => cfg.twitch.ouvir?.conta === i && cfg.twitch.ouvir?.id === id;
  const paginas = [
    ...views.map((v, i) => ({ wc: v.webContents, tipo: 'conta', nome: cfg.names[i], i, escondida: !cfg.grid && i !== active })),
    ...twViews.flatMap((m, i) => [...m].map(([id, v]) => ({
      wc: v.webContents, tipo: id.startsWith('kick:') ? 'kick' : 'twitch', nome: `a live ${id}`, escondida: !twAVista(i, id) && !ouvindo(i, id)
    })))
  ];
  for (const p of paginas) {
    const m = de(p.wc);
    if (!m) continue;
    const mb = Math.round((m.memory.privateBytes ?? m.memory.workingSetSize) / 1024);
    const n = mb > FAXINA_MB[p.tipo] ? (faxinaLeituras.get(p.wc) ?? 0) + 1 : 0;
    faxinaLeituras.set(p.wc, n);
    if (n < 3 || !p.escondida || p.wc.isLoading() || Date.now() - (faxinaFeita.get(p.wc) ?? 0) < 60 * 60000) continue;
    if (p.tipo === 'conta' && !(await contaLivre(p.i))) continue;
    faxinaFeita.set(p.wc, Date.now());
    faxinaLeituras.set(p.wc, 0);
    appLog(`ultra leve: recarreguei ${p.nome}, escondida com ${mb} MB de memória privada há 15 min`);
    p.wc.reload();
  }
}

function changeGridZoom(delta) {
  if (!cfg.grid) return;
  cfg.gridZoom = delta === 0 ? defaults.gridZoom
    : Math.min(1, Math.max(0.3, Math.round((cfg.gridZoom + delta) * 100) / 100));
  saveCfg();
  views.forEach(v => applyZoom(v.webContents));
  pushState();
}

function createGameView(i) {
  const part = `persist:conta${i + 1}`; // sessão separada e salva em disco
  const ses = session.fromPartition(part);
  // O user agent fica o padrão do Electron: disfarçado de Chrome, a verificação da Cloudflare
  // (Turnstile) do login do jogo falhava.
  // Bloqueia pedidos de permissão desnecessários (câmera, mic, notificações...)
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'fullscreen'].includes(perm)));

  const v = new WebContentsView({
    webPreferences: {
      partition: part,
      backgroundThrottling: false,
      spellcheck: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  v.setBackgroundColor('#111111');
  const wc = v.webContents;

  // Pop-ups (login etc.) abrem dentro do app, na MESMA sessão da conta.
  // Links para outros sites (Discord, wiki externa...) vão para o navegador padrão.
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const host = new URL(url).hostname;
      // Canal da Twitch clicado no jogo (tela "Bônus Twitch"): abre no painel desta conta
      if ((isTwitchHost(host) || isKickHost(host)) && twAdd(i, url)) return { action: 'deny' };
      // "Votar no TopIdle" do jogo: abre na janela de voto do app, e não no navegador
      if (isTopIdleHost(host)) { abrirVoto(i, url); return { action: 'deny' }; }
      const authLike = /pokeidle\.io$|accounts\.google\.com|google\.com$|discord\.com$|facebook\.com$/.test(host);
      if (authLike) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520, height: 700, autoHideMenuBar: true,
            webPreferences: { partition: part }
          }
        };
      }
    } catch {}
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Se a página travar/crashar, recarrega sozinha
  wc.on('render-process-gone', () => setTimeout(() => wc.reload(), 3000));
  wc.on('unresponsive', () => setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 15000));
  ['did-start-loading', 'did-stop-loading'].forEach(ev => wc.on(ev, pushState));
  wc.on('did-finish-load', () => applyZoom(wc));
  wc.on('dom-ready', () => {
    applyFps(wc, i);
    aplicarMovimento(wc); // no Ultra leve; depois de uma queda do processo, prende o debugger de novo
    // A escuta vai nas 4 contas (a Reposição e a Melhor hunt usam em todas); o Sniper também (cada conta compra a
    // lista dela); o pedido-e-resposta dos monitores, só na Conta 1
    if (!licenca.premium()) return; // plano grátis: só o jogo, sem nenhum script nosso
    wc.executeJavaScript(WS_ESCUTA + HUNT_ESCUTA + FICHA_PRECO_SCRIPT).catch(() => {});
    wc.executeJavaScript((i === PRECO_CONTA ? PEDIR_SCRIPT : '') + SNIPER_SCRIPT).then(() => sniperEnviarConfig(i)).catch(() => {});
    if (i === TW_AUTO_CONTA) wc.executeJavaScript(TELA_PONTOS_SCRIPT).then(twTelaEnviar).catch(() => {});
  });
  // O Sniper da conta que olha o Mercado avisa pelo console quando tem anúncio para repassar às outras (sniperRepassar),
  // e a Conta 1 avisa quando a tela de bônus da Twitch ou da Kick abre (twTelaAberta)
  wc.on('console-message', e => {
    if (e.message === '__pkmSnRepasse' && i === sniperOlheiro) sniperRepassar();
    else if (i === TW_AUTO_CONTA && e.message.startsWith('__pkmTelaPontos:')) twTelaAberta(e.message.slice(16)).catch(() => {});
    else if (e.message.startsWith('__pkmPrecoFicha:')) prFichaDoJogo(i, e.message.slice(16));
    else if (e.message.startsWith('__pkmPrecoDetalhe:')) prFichaDetalhe(i);
  });

  // No modo grade, clicar dentro de um quadro torna aquela conta a selecionada
  wc.on('focus', () => { if (cfg.grid && active !== i) select(i, false); });

  // Atalhos dentro do jogo
  wc.on('before-input-event', (e, input) => handleKeys(e, input));

  wc.loadURL(GAME_URL);
  win.contentView.addChildView(v);
  return v;
}

// Tab e Ctrl+Tab vão para a próxima conta; com Shift, para a anterior. Segurar a tecla troca uma vez só. Com
// `tab` false fica só o Ctrl+Tab: nas páginas das lives o Tab completa nomes e emotes no chat, e a barra e a lista
// de lives tratam o Tab sozinhas (`proxima`), para não trocar de conta no meio de um nome ou canal sendo digitado.
function proximaConta(passo) { select((active + passo + TOTAL) % TOTAL); }

function handleKeys(e, input, tab = true) {
  if (input.type !== 'keyDown') return;
  if (input.control && /^[1-4]$/.test(input.key)) { select(Number(input.key) - 1); e.preventDefault(); }
  else if (input.key === 'Tab' && !input.alt && !input.meta && (input.control || tab)) {
    e.preventDefault();
    if (!input.isAutoRepeat) proximaConta(input.shift ? -1 : 1);
  }
  else if (input.control && input.key.toLowerCase() === 'g') { toggleGrid(); e.preventDefault(); }
  else if (input.control && (input.key === '=' || input.key === '+')) { changeGridZoom(0.05); e.preventDefault(); }
  else if (input.control && input.key === '-') { changeGridZoom(-0.05); e.preventDefault(); }
  else if (input.control && input.key === '0') { changeGridZoom(0); e.preventDefault(); }
  else if (input.control && input.key.toLowerCase() === 't') { toggleTwitch(); e.preventDefault(); }
  else if (input.key === 'F5') { views[active].webContents.reload(); e.preventDefault(); }
  else if (input.key === 'F12') { views[active].webContents.toggleDevTools(); e.preventDefault(); }
}

function createWindow() {
  win = new BrowserWindow({
    width: cfg.bounds.width,
    height: cfg.bounds.height,
    minWidth: 600,
    minHeight: 400,
    title: app.getName().includes('teste') ? 'PokeMulti (TESTE)' : 'PokeMulti',
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false }
  });
  Menu.setApplicationMenu(null);

  bar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  bar.webContents.loadFile(path.join(__dirname, 'toolbar.html'));
  licenca.ligarBarra(bar.webContents, win);
  bar.webContents.on('before-input-event', (e, input) => handleKeys(e, input, false));
  win.contentView.addChildView(bar);

  for (let i = 0; i < TOTAL; i++) views.push(createGameView(i));

  // Barra das lives (fica por cima do painel da Twitch)
  twbar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  twbar.webContents.loadFile(path.join(__dirname, 'twitchbar.html'));
  twbar.webContents.on('before-input-event', (e, input) => handleKeys(e, input, false));
  twbar.webContents.on('did-finish-load', pushTwitchState);
  win.contentView.addChildView(twbar);

  // Config antiga ou mexida à mão: garante a forma esperada, e reabre as lives salvas
  const tw = cfg.twitch = { ...defaults.twitch, ...(cfg.twitch || {}) };
  for (let i = 0; i < TOTAL; i++) {
    tw.canais[i] = (Array.isArray(tw.canais[i]) ? tw.canais[i] : []).map(normCanal).filter(Boolean);
    tw.ativo[i] = tw.canais[i].some(c => canalId(c) === tw.ativo[i]) ? tw.ativo[i] : (tw.canais[i][0] ? canalId(tw.canais[i][0]) : '');
  }
  const o = tw.ouvir;
  if (!o || !tw.canais[o.conta]?.some(c => canalId(c) === o.id)) tw.ouvir = null;
  // Os canais que já estiveram na lista de lives do jogo (para fechar a live quando ela sai da lista). Na primeira
  // vez, vêm do registro das conferências
  if (!Array.isArray(tw.vistas)) {
    const vistas = new Set();
    try {
      const reg = fs.readFileSync(path.join(app.getPath('userData'), 'twitch-auto.log'), 'utf8');
      for (const m of reg.matchAll(/no ar com bônus \(([^)]*)\)/g)) {
        for (const l of m[1].split(', ')) if (l !== 'nenhuma' && /^[a-z0-9_]{3,25}$/.test(l)) vistas.add(l);
      }
    } catch {}
    tw.vistas = [...vistas];
  }

  active = Math.min(Math.max(cfg.active || 0, 0), TOTAL - 1);
  // Com as lives pausadas (⏸ no painel), as páginas só voltam ao retomar
  if (!licenca.premium()) tw.open = false; // plano grátis: sem lives
  else if (!tw.pausado) for (let i = 0; i < TOTAL; i++) tw.canais[i].forEach(c => twCreate(i, c));
  applyVisibility();

  win.on('resize', layout);
  win.on('unresponsive', () => appLog('janela principal sem resposta'));
  win.on('responsive', () => appLog('janela principal voltou a responder'));
  win.on('close', () => {
    appLog('janela principal fechando');
    clearInterval(metricsTimer);
    clearInterval(flushTimer);
    if (twSaldoJanela && !twSaldoJanela.isDestroyed()) twSaldoJanela.destroy();
    flushAll(); // grava o login de cada conta antes de fechar
    const [width, height] = win.getSize();
    cfg.bounds = { width, height };
    saveCfg();
    // Fecha as páginas do jogo (e da Twitch) já, para as conexões caírem na hora. Antes, os
    // processos das contas às vezes sobreviviam alguns segundos ao app, ainda conectados: o
    // servidor seguia contando 4 contas online neste IP e, reabrindo logo, recusava as novas
    // ("rede cheia"), deixando o jogo parado na tela de entrada.
    for (const v of [...views, ...twViews.flatMap(m => [...m.values()])]) {
      try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch {}
    }
  });
  bar.webContents.on('did-finish-load', pushState);

  // Uso de memória (por conta) a cada 5s na barra (minimizado, ninguém vê a barra)
  const metricsTimer = setInterval(() => {
    if (!bar || bar.webContents.isDestroyed() || win.isMinimized()) return;
    const metrics = app.getAppMetrics();
    const proc = v => {
      if (v.webContents.isDestroyed()) return null;
      const pid = v.webContents.getOSProcessId();
      return metrics.find(x => x.pid === pid) ?? null;
    };
    const mem = views.map(v => { const m = proc(v); return m ? Math.round(m.memory.workingSetSize / 1024) : null; }); // MB
    const cpu = views.map(v => { const m = proc(v); return m ? Math.round(m.cpu.percentCPUUsage) : null; });
    bar.webContents.send('metrics', { mem, cpu });
  }, 5000);

  // O Chromium grava o localStorage (onde fica o login do jogo) no disco só de vez em quando.
  // Forçar a cada 30s garante que o login sobrevive mesmo a um fechamento brusco.
  const flushTimer = setInterval(flushAll, 30000);

  // Memória a cada 5 min: do app (soma dos processos), de cada conta, das lives e da GPU, e livre no PC.
  // No Ultra leve a faxina usa a mesma leitura.
  const memLog = () => {
    const met = app.getAppMetrics();
    const porPid = new Map(met.map(m => [m.pid, m]));
    const de = wc => (wc.isDestroyed() ? null : porPid.get(wc.getOSProcessId()) ?? null);
    const mb = kb => Math.round((kb ?? 0) / 1024);
    const total = mb(met.reduce((s, m) => s + (m.memory?.workingSetSize ?? 0), 0));
    const contas = views.map(v => { const m = de(v.webContents); return m ? mb(m.memory.workingSetSize) : '?'; });
    const lv = twViews.flatMap(m => [...m.values()]);
    const pidsLives = new Set(lv.map(v => de(v.webContents)?.pid).filter(Boolean));
    const lives = mb([...pidsLives].reduce((s, pid) => s + porPid.get(pid).memory.workingSetSize, 0));
    const gpu = met.find(m => m.type === 'GPU');
    appLog(`memória: app ${total} MB, livre no PC ${Math.round(os.freemem() / 1048576)} MB, ${lv.length} lives abertas` +
      ` (contas ${contas.join('/')} MB, lives ${lives} MB, GPU ${gpu ? mb(gpu.memory.workingSetSize) : '?'} MB${cfg.ultra ? ', ultra leve' : ''})`);
    if (cfg.ultra) faxina(de);
  };
  appLog(`abriu (versão ${app.getVersion()}, Electron ${process.versions.electron})`);
  setTimeout(memLog, 60000);
  setInterval(memLog, 5 * 60000);

  if (!licenca.premium()) return; // plano grátis: nenhuma rotina dos recursos (monitores, Sniper, Reposição, Caixa, voto, lives)
  // Monitor de Preços: primeira conferência 2,5 min depois de abrir (o jogo já logou), depois a cada 10 min
  setTimeout(precoColetar, 150000);
  setInterval(precoTalvezColetar, 60000);
  // Monitor de Pokémons: começa 3,5 min depois de abrir (depois do de itens), e confere a cada minuto
  setTimeout(() => { pkmTalvezColetar(); setInterval(pkmTalvezColetar, 60000); }, 210000);
  // As fichas das vendas de antes do 💲 Precificador (uma vez só; ver pkmCompletarFichas)
  setTimeout(() => {
    const ir = () => pkmCompletarFichas().catch(e => appLog(`pokémons: completar fichas: erro (${e.message})`));
    ir(); setInterval(ir, 5 * 60000);
  }, process.env.PKM_COMPLETAR_TESTE === '1' ? 3000 : 330000);
  // Vendidos por dia: começa 4,5 min depois de abrir (depois dos dois), e confere a cada minuto
  setTimeout(() => { vendTick(); setInterval(vendTick, VEND_TESTE ? 200 : 60000); }, VEND_TESTE ? 1500 : 270000);
  // Dados do jogo (golpes e ícones das espécies): 5 min depois de abrir, se os guardados tiverem mais de 3 dias
  setTimeout(() => jogoMontar(), 300000);
  // O ritmo medido nas hunts (🗺): as corridas das 4 contas a cada 5 min, mesmo com a janela fechada
  setInterval(ritmoColetar, 5 * 60000);

  // Sniper: guarda as compras e o registro mesmo com a janela dele fechada; e confere o repasse da conta que olha a
  // cada 5 s, para o caso de o aviso pelo console falhar
  sniperTimer = setTimeout(sniperLer, 30000);
  setInterval(() => { if (sniperOutrasComAlvo()) sniperRepassar(); }, 5000);
  // Reposição (bolas, poções e revives): as contas ligadas conferem o estoque a cada 20 s (a cada 3 s enquanto compram)
  setInterval(repTick, 3000);
  // 🏦 Caixa do projeto: a carteira do jogo na rede Solana a cada 10 min (a cada 2 enquanto houver fila); o painel de
  // Gemas do jogo, pela Conta 1, de hora em hora
  caixaAgendar(CAIXA_TESTE ? 3000 : 45000);
  caixaTimerPainel = setTimeout(caixaPainel, CAIXA_TESTE ? 8000 : 4 * 60000);

  // Voto do TopIdle: primeira consulta de cada conta ~1,5 min depois de abrir (o jogo já logou)
  for (let i = 0; i < TOTAL; i++) votoTimers[i] = setTimeout(() => votoChecar(i), 90000 + i * 5000);

  // Lives com bônus da Conta 1: primeira conferência 2 min depois de abrir (dá tempo do jogo
  // logar e receber a lista), depois a cada 30 min — e em ~1 min quando a lista do jogo muda
  const agendar = ms => { twAuto.proxima = Date.now() + ms; };
  agendar(2 * 60 * 1000);
  setTimeout(() => {
    twAutoVerificar();
    agendar(TW_AUTO_MS);
    setInterval(() => { twAutoVerificar(); agendar(TW_AUTO_MS); }, TW_AUTO_MS);
    setInterval(twListaVigiar, 60000);
  }, 2 * 60 * 1000);
  setInterval(() => twBauConferir().catch(() => {}), TW_BAU_MS);
}

function flushAll() {
  for (let i = 0; i < TOTAL; i++) {
    try { session.fromPartition(`persist:conta${i + 1}`).flushStorageData(); } catch {}
  }
}

// ---------- IPC vindo da barra de abas ----------
ipcMain.on('select', (_e, i) => select(i));
ipcMain.on('proxima', (_e, passo) => proximaConta(passo < 0 ? -1 : 1));
ipcMain.on('reload', (_e, i) => views[i ?? active]?.webContents.reload());
ipcMain.on('reloadAll', () => views.forEach(v => v.webContents.reload()));
ipcMain.on('rename', (_e, { i, name }) => {
  if (typeof name === 'string' && name.trim()) { cfg.names[i] = name.trim().slice(0, 24); saveCfg(); pushState(); }
});
ipcMain.on('toggle', (_e, key) => {
  if (key === 'muteHidden' || key === 'throttleHidden') { cfg[key] = !cfg[key]; saveCfg(); applyVisibility(); }
  else if (key === 'grid') toggleGrid();
  else if (key === 'ultra') toggleUltra();
});
ipcMain.on('gridZoom', (_e, delta) => changeGridZoom(Number(delta) || 0));
ipcMain.on('tw:toggle', () => toggleTwitch());
ipcMain.on('tw:pausa', () => (cfg.twitch.pausado ? twRetomar('pelo botão') : twPausar()));
ipcMain.on('fpsVista', () => {
  cfg.fpsVista = (cfg.fpsVista ?? 30) ? 0 : 30;
  saveCfg();
  applyVisibility(false);
  appLog(`conta à vista: ${cfg.fpsVista ? cfg.fpsVista + ' quadros/s' : 'sem limite de quadros'}`);
  pushState();
});
ipcMain.on('sn:abrir', () => abrirSniper());
ipcMain.on('pc:abrir', () => abrirPrecos());
// Vendas reais de um item (09/11/2026, pedido do usuário: "qual o valor máximo vendido nos últimos 3 dias" do AoE TM):
// a Tabela de preços do jogo filtrada pelo item e pela moeda (Conta 1). Lê da mais nova para trás até passar do período
// (o jogo para na 41ª página, ~1.230 vendas), e tenta também a ordem das mais caras para achar o máximo mesmo quando o
// período não cabe nas 41 páginas. Uma página a cada 0,6 s, esperando as coletas automáticas.
async function pcVendasReais(id, moeda, dias = 3) {
  const corte = Date.now() - dias * 864e5, vistas = new Map();
  let paginas = 0, maisVelha = Infinity, chegou = false, erro = '';
  const ler = async (pg, ordem) => {
    while (pkmOcupado) await espera(1500);
    const msg = { t: 'market.historicoGlobal', tipo: 'item', itemId: Number(id), moeda, pagina: pg, seq: ++pkmSeq };
    if (ordem) msg.ordem = ordem;
    const r = await pkmPedir(msg, 'historicoGlobal');
    paginas++;
    await espera(600);
    if (r?.erro) { erro = r.erro; return null; }
    const linhas = r.linhas || [];
    for (const l of linhas) {
      if (l.em >= corte && Number(l.bruto) > 0) vistas.set(l.id ?? `${l.em}:${l.bruto}`, { em: l.em, qtd: vendQtd(l), un: Number(l.bruto) / vendQtd(l) });
    }
    return { linhas, temMais: !!r.temMais };
  };
  for (let pg = 0; pg < 41; pg++) {
    const r = await ler(pg);
    if (!r) break;
    for (const l of r.linhas) maisVelha = Math.min(maisVelha, l.em);
    // A 41ª página sempre vem com temMais falso (o jogo para ali): só é o fim de verdade antes dela ou com página incompleta
    if (r.linhas.some(l => l.em < corte) || (!r.temMais && (pg < 40 || r.linhas.length < 30))) { chegou = true; break; }
  }
  // Não coube: as mais caras primeiro (se o jogo aceitar a ordem), até achar algumas do período
  let porCaras = false;
  if (!chegou && !erro) {
    // A ordem pode ser pelo total do lote: o preço por unidade nunca passa do total, então quando o menor total da página
    // já fica abaixo da maior unidade achada no período, nenhuma venda adiante pode ser mais cara
    for (let pg = 0; pg < 15; pg++) {
      const r = await ler(pg, 'caros');
      if (!r) break;
      const tot = r.linhas.map(l => Number(l.bruto));
      if (pg === 0 && tot.some((v, k) => k && v > tot[k - 1])) break; // o jogo ignorou a ordem
      porCaras = true;
      const maiorUn = Math.max(0, ...[...vistas.values()].map(x => x.un));
      if (!r.temMais || !tot.length || Math.min(...tot) < maiorUn) break;
    }
  }
  const v = [...vistas.values()], uns = v.map(x => x.un).sort((a, b) => a - b), unid = v.reduce((s, x) => s + x.qtd, 0);
  const top = [...v].sort((a, b) => b.un - a.un).slice(0, 5);
  const res = { id, moeda, dias, n: v.length, unid, max: top[0] ?? null, top, min: uns[0] ?? null, mediana: uns.length ? uns[Math.floor((uns.length - 1) / 2)] : null,
    chegou, desde: chegou ? corte : maisVelha, porCaras, paginas, erro };
  appLog(`preços: vendas reais de ${precosLer().nomes?.[id] ?? id} em ${moeda === 'orb' ? 'gemas' : 'coins'}, ${dias} dias: ${v.length} vendas, maior ${res.max ? Math.round(res.max.un) : '–'} (${paginas} páginas${chegou ? '' : ', não coube'}${erro ? `, erro: ${erro}` : ''})`);
  return res;
}
ipcMain.handle('pc:vendasReais', (_e, id, moeda, dias) => pcVendasReais(id, moeda === 'gold' ? 'gold' : 'orb', Math.min(30, Math.max(1, Number(dias) || 3))));
ipcMain.on('pc:agora', async () => { await precoColetar('pedido na janela'); precosEnviar(); vendUlt = 0; vendTick(); });
ipcMain.on('pc:opcoes', (_e, novo) => precoSalvarOpcoes(novo));
ipcMain.on('pk:abrir', () => abrirPokemons());
ipcMain.on('pr:abrir', () => abrirPrecificador());
ipcMain.handle('pr:precificar', (_e, alvo) => prPrecificar(alvo));
ipcMain.handle('pr:lote', (_e, alvos) => prPrecificarLote(alvos));
ipcMain.handle('pr:contas', () => prContas());
ipcMain.on('pr:calibrar', () => prCalibrar(true));
// O preço por unidade de um fragmento (Z-Move, AoE, Mega), escolhido na janela; vazio volta à cotação do dia
ipcMain.on('pr:unidades', (_e, id, valor) => {
  const u = prOpcoes().unidades, v = Number(valor);
  if (![59194, 40530, 70014, 70015].includes(Number(id))) return;
  if (v > 0 && v < 1e9) u[id] = v; else delete u[id];
  saveCfg();
  prEnviar();
});
ipcMain.on('ec:abrir', () => { if (!cfg.pokemonsUsado) { cfg.pokemonsUsado = true; saveCfg(); } abrirEconomia(); });
ipcMain.on('pd:abrir', () => abrirPokedex());
ipcMain.on('rep:abrir', () => abrirReposicao());
ipcMain.on('hu:abrir', () => abrirHunts());
ipcMain.on('cx:abrir', () => abrirCaixa());
ipcMain.on('cx:agora', () => caixaVerificar('pedido na janela'));
ipcMain.on('cx:opcoes', (_e, novo) => {
  const o = (cfg.caixa ??= {});
  for (const k of ['ligado', 'avisos']) if (typeof novo?.[k] === 'boolean') o[k] = novo[k];
  saveCfg();
  caixaEnviar();
  pushState();
});
// Abre a transação ou o endereço no Solscan, no navegador (só endereços e assinaturas da Solana)
ipcMain.on('cx:solscan', (_e, tipo, id) => {
  const s = String(id ?? '');
  if (B58.test(s)) shell.openExternal(`https://solscan.io/${tipo === 'tx' ? 'tx' : 'account'}/${s}`);
});
ipcMain.on('hu:calcular', (_e, i) => huCalcular(Number(i)));
ipcMain.on('rep:salvar', (_e, i, novo) => repSalvar(Number(i), novo));
ipcMain.on('rep:agora', (_e, i) => repAgora(Number(i)));
ipcMain.on('pd:montar', () => jogoMontar(true));
ipcMain.on('pd:copiar', (_e, nome) => clipboard.writeText(String(nome ?? '').slice(0, 40)));
ipcMain.on('pd:cfg', (_e, novo) => { (cfg.pokedex ??= {}).cores = !!novo?.cores; saveCfg(); });
ipcMain.on('pk:agora', () => pkmTalvezColetar('tudo'));
ipcMain.on('pk:opcoes', (_e, novo) => pkmSalvarOpcoes(novo));
// "Ver anúncios agora" de uma espécie, observada ou não (a janela também pede sozinha ao escolher uma)
// Com o app ocupado numa coleta, o pedido da janela ESPERA na fila (antes era descartado, e a janela
// ficava em "Buscando os anúncios…") e roda assim que a coleta acaba
let pkmPendente = null;
ipcMain.on('pk:avaliar', (_e, especie, filtros) => {
  especie = Number(especie);
  if (!especie) return;
  pkmPendente = { especie, filtros };
  pkmRodarPendente();
});
// ⚔ Atacantes de todas as espécies, na moeda da janela (gold = coins, orb = gemas)
ipcMain.on('pk:atacantes', (_e, moeda, filtros) => {
  pkmPendente = { atacantes: true, moeda: moeda === 'gold' ? 'gold' : 'orb', filtros };
  pkmRodarPendente();
});
ipcMain.on('pk:dadosJogo', () => jogoMontar(true));
async function pkmRodarPendente() {
  if (pkmOcupado || !pkmPendente) return;
  const { especie, filtros, atacantes, moeda } = pkmPendente;
  pkmPendente = null;
  pkmOcupado = true; pkmAviso = ''; pkmEnviar();
  try {
    const r = atacantes ? await pkmBuscarAtacantes(moeda, filtros) : await pkmAvaliarObservadas([especie], filtros);
    if (r) {
      appLog(`pokémons: ${atacantes ? 'atacantes' : 'avaliação'} ${r}`);
      pkmAviso = r.includes('mercado aberto') ? 'Feche o Mercado na Conta 1 para o app buscar os anúncios (a resposta trocaria a página que você está vendo).' : r;
    }
    pkmGravar();
  } finally {
    pkmOcupado = false;
    pkmEnviar(atacantes ? null : { especie });
    pkmRodarPendente();
  }
}
// Leva a UM anúncio no jogo, na Conta 1: o mesmo caminho do link "Ver anúncio" do chat (um elemento
// `.m-anuncio-link` clicado dentro de #chat-msgs, que o jogo trata pedindo o anúncio na hora ao servidor)
ipcMain.on('pk:abrirAnuncio', (_e, id) => {
  id = Number(id);
  const wc = views[PRECO_CONTA]?.webContents;
  if (!Number.isSafeInteger(id) || id <= 0 || !wc || wc.isDestroyed()) return;
  select(PRECO_CONTA);
  if (win.isMinimized()) win.restore();
  win.focus();
  // Com o Mercado fechado, o 1º clique abre o Mercado e a vitrine padrão chega por cima da ficha do
  // anúncio; então, nesse caso, clica de novo 1,5 s depois, com o Mercado já aberto.
  wc.executeJavaScript(`(async () => {
    const box = document.querySelector('#chat-msgs');
    if (!box) return false;
    const clicar = () => {
      const a = document.createElement('span');
      a.className = 'm-anuncio-link'; a.dataset.anuncio = '${id}'; a.style.display = 'none';
      box.appendChild(a); a.click(); a.remove();
    };
    const aberto = !!document.querySelector('#cm-lista')?.offsetParent;
    clicar();
    if (!aberto) { await new Promise(r => setTimeout(r, 1500)); clicar(); }
    return true;
  })()`).catch(() => {});
});
ipcMain.on('sn:salvar', (_e, novo) => sniperSalvar(novo));
ipcMain.on('votar', (_e, i) => { if (Number.isInteger(i) && i >= 0 && i < TOTAL) abrirVoto(i); });
ipcMain.on('tw:login', (_e, plat) => twAbrirLogin(active, plat === 'kick' ? 'kick' : 'twitch'));
ipcMain.on('tw:auto', () => twAutoVerificar());
ipcMain.on('tw:bau', () => {
  cfg.twitch.bau = !cfg.twitch.bau;
  twBauVisto = Date.now();
  saveCfg();
  twAutoLog(`Baú da Twitch ${cfg.twitch.bau ? 'ligado' : 'desligado'}`);
  pushTwitchState();
  twBauConferir().catch(() => {});
});
ipcMain.on('tw:lista', () => { cfg.twitch.lista = !cfg.twitch.lista; saveCfg(); layout(); pushTwitchState(); });
ipcMain.on('tw:add', (_e, s) => twAdd(active, s));
ipcMain.on('tw:select', (_e, login) => {
  if (!twViews[active].has(login)) return;
  cfg.twitch.ativo[active] = login; saveCfg(); applyTwitchVisibility(); pushTwitchState();
});
ipcMain.on('tw:remove', (_e, login) => twRemove(active, login));
ipcMain.on('tw:ouvir', (_e, id) => twOuvir(active, id));
ipcMain.on('tw:pararOuvir', () => { cfg.twitch.ouvir = null; saveCfg(); applyTwitchVisibility(); pushState(); });
ipcMain.on('tw:video', (_e, login) => twToggleVideo(active, login));
ipcMain.on('tw:reload', (_e, login) => twViews[active].get(login)?.webContents.reload());
// Cicla o limite de quadros das contas não selecionadas: 5 → 10 → 15 → 30 → sem limite
const FPS_STEPS = [5, 10, 15, 30, 0];
ipcMain.on('cycleFps', () => {
  const at = FPS_STEPS.indexOf(cfg.gridFps);
  cfg.gridFps = FPS_STEPS[(at + 1) % FPS_STEPS.length];
  saveCfg();
  applyVisibility(false);
});
// Botão direito numa aba (07/11/2026, pedido do usuário: o duplo clique para renomear não funcionava)
ipcMain.on('tabMenu', (_e, i) => {
  if (!Number.isInteger(i) || i < 0 || i >= TOTAL) return;
  const nome = cfg.names[i];
  Menu.buildFromTemplate([
    { label: `${nome}  ·  Ctrl+${i + 1}`, enabled: false },
    { type: 'separator' },
    { label: 'Renomear…', click: () => { bar?.webContents.focus(); bar?.webContents.send('renomear', i); } },
    { label: 'Recarregar esta conta', click: () => views[i]?.webContents.reload() },
    { label: 'Importar login do navegador…', click: () => importarLogin(i) },
    { type: 'separator' },
    { label: 'Sair da conta (apaga o login salvo)…', click: async () => {
      const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Sair da conta', 'Cancelar'], defaultId: 1, cancelId: 1,
        title: 'Sair da conta', message: `Sair da "${nome}"?`, detail: 'Isso apaga o login salvo só desta aba.' });
      if (r.response === 0) ipcMain.emit('clearSession', {}, i);
    } }
  ]).popup({ window: win });
});
ipcMain.on('clearSession', async (_e, i) => {
  await session.fromPartition(`persist:conta${i + 1}`).clearStorageData();
  views[i].webContents.loadURL(GAME_URL);
});

// ---------- Importar login feito no navegador ----------
// O Google não deixa logar dentro do app. A pessoa entra pelo Chrome, copia o localStorage do
// jogo de lá (onde fica a sessão) e cola aqui, na conta escolhida.
const COMANDO_COPIAR = 'copy(JSON.stringify(localStorage))';

function lerLoginDaAreaDeTransferencia() {
  let dados;
  try { dados = JSON.parse(clipboard.readText().trim()); } catch { return null; }
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return null;
  if (typeof dados.sessao !== 'string' || !dados.sessao) return null;
  for (const v of Object.values(dados)) if (typeof v !== 'string') return null;
  return dados;
}

async function gravarLogin(i, dados) {
  const wc = views[i].webContents;
  if (new URL(wc.getURL() || 'about:blank').origin !== new URL(GAME_URL).origin) {
    await wc.loadURL(GAME_URL).catch(() => {});
  }
  await wc.executeJavaScript(
    `(d => { localStorage.clear(); for (const [k, v] of Object.entries(d)) localStorage.setItem(k, v); })(${JSON.stringify(dados)})`
  );
  wc.reload();
}

async function importarLogin(i) {
  if (!views[i]) return;
  select(i);
  const nome = cfg.names[i];
  while (true) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Importar login',
      message: `Entrar com Google na "${nome}"`,
      detail:
        '1. Clique em "Abrir no navegador" e entre com o Google no jogo, pelo Chrome.\n' +
        '2. Com o jogo aberto lá, aperte F12, clique em "Console", digite o comando abaixo e aperte Enter:\n\n' +
        `      ${COMANDO_COPIAR}\n\n` +
        '3. Feche a aba do jogo no Chrome SEM clicar em sair da conta.\n' +
        '4. Volte aqui e clique em "Colar login".',
      buttons: ['Colar login', 'Abrir no navegador', 'Copiar o comando', 'Cancelar'],
      defaultId: 0,
      cancelId: 3,
      noLink: true
    });
    if (response === 1) { shell.openExternal(GAME_URL); continue; }
    if (response === 2) { clipboard.writeText(COMANDO_COPIAR); continue; }
    if (response === 3) return;

    const dados = lerLoginDaAreaDeTransferencia();
    if (!dados) {
      await dialog.showMessageBox(win, {
        type: 'warning', title: 'Importar login', noLink: true,
        message: 'Não encontrei o login copiado.',
        detail: 'Rode o comando no Console do Chrome com o jogo aberto e já logado, e tente de novo. ' +
          'Se você clicou em "Copiar o comando" depois disso, ele substituiu o login copiado.'
      });
      continue;
    }
    try {
      await gravarLogin(i, dados);
      clipboard.clear(); // o token não fica dando sopa na área de transferência
    } catch (err) {
      await dialog.showMessageBox(win, { type: 'error', title: 'Importar login', message: 'Não deu para gravar o login.', detail: String(err?.message || err) });
    }
    return;
  }
}
ipcMain.on('importLogin', (_e, i) => importarLogin(Number.isInteger(i) ? i : active));

// ---------- Ciclo de vida ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  // Sem isso o Windows não mostra as notificações (aviso de voto) de um app empacotado
  app.setAppUserModelId('com.pokemulti.app');
  app.whenReady().then(async () => {
    loadCfg();
    if (await licenca.iniciar({ log: appLog })) createWindow();
  });
  app.on('before-quit', flushAll);
  app.on('window-all-closed', () => app.quit());
}
