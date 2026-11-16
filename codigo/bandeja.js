// Bandeja do Windows (16/11/2026, pedido de cliente): o app fica em segundo plano no canto da barra de tarefas, perto do
// relógio, com as contas rodando. Minimizar e o X mandam para a bandeja (padrão desde 16/11/2026, pedido do usuário); cada
// um pode ser desligado no menu do ícone. Clique no ícone traz de volta; "Sair do PokeMulti" no menu fecha de verdade.
// Esconder a janela não freia as contas: as páginas do jogo e das lives já rodam com backgroundThrottling desligado, igual
// a quando o app está minimizado.
const { app, Tray, Menu, Notification, BrowserWindow, nativeImage } = require('electron');
const path = require('path');

let tray = null, win = null, cfg = null, salvar = () => {}, log = () => {};
let saindo = false, naBandeja = false;
let escondidas = []; // janelas de ferramentas (Sniper, Preços...) que estavam abertas ao ir para a bandeja

const opcoes = () => (cfg.bandeja = { minimizar: true, fechar: true, avisou: false, ...(cfg.bandeja || {}) });
const viva = w => w && !w.isDestroyed();

function mostrar() {
  if (!viva(win)) return;
  if (win.isMinimized()) win.restore();
  if (naBandeja) {
    naBandeja = false;
    win.show();
    for (const w of escondidas) if (viva(w)) w.showInactive();
    escondidas = [];
  }
  focarOriginal();
}
let focarOriginal = () => {};

// No Windows, o minimizar não dá para cancelar: a janela já chega aqui minimizada (e o Electron diz que ela não está
// visível). Por isso quem marca "está na bandeja" é o naBandeja, e não o isVisible().
function esconder() {
  if (!viva(win) || naBandeja) return;
  naBandeja = true;
  // Janelas filhas à vista (no X, a principal não minimiza antes) somem junto e voltam junto. Ao minimizar, o Windows
  // já esconde as filhas sozinho e as traz de volta no restore.
  escondidas = BrowserWindow.getAllWindows().filter(w => w !== win && w.isVisible() && w.getParentWindow() === win);
  for (const w of escondidas) w.hide();
  win.hide();
  log('bandeja: app escondido na bandeja');
  const o = opcoes();
  if (!o.avisou && Notification.isSupported()) {
    o.avisou = true; salvar();
    const n = new Notification({ title: 'PokeMulti', body: 'O PokeMulti continua rodando aqui na bandeja, com as contas abertas. Clique no ícone para voltar. Para fechar de vez, clique com o botão direito no ícone e escolha Sair.' });
    n.on('click', mostrar);
    n.show();
  }
}

function sair() {
  saindo = true;
  app.quit();
}

function montarMenu() {
  const o = opcoes();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir o PokeMulti', click: mostrar },
    { type: 'separator' },
    { label: 'Minimizar manda para a bandeja', type: 'checkbox', checked: o.minimizar, click: i => { o.minimizar = i.checked; salvar(); } },
    { label: 'O X manda para a bandeja (não fecha)', type: 'checkbox', checked: o.fechar, click: i => { o.fechar = i.checked; salvar(); } },
    { type: 'separator' },
    { label: 'Sair do PokeMulti', click: sair }
  ]));
}

// Chamado pelo main.js logo depois de criar a janela principal
function ligar(janela, { config, salvarConfig, appLog }) {
  win = janela; cfg = config; salvar = salvarConfig || salvar; log = appLog || log;
  opcoes();
  // Quem chama win.focus() (aviso clicado, segunda abertura do app) traz a janela de volta da bandeja
  focarOriginal = win.focus.bind(win);
  win.focus = () => { if (viva(win) && naBandeja) return mostrar(); focarOriginal(); };

  const icone = nativeImage.createFromPath(path.join(__dirname, 'bandeja.ico'));
  tray = new Tray(icone.isEmpty() ? nativeImage.createEmpty() : icone);
  tray.setToolTip('PokeMulti');
  tray.on('click', mostrar);
  montarMenu();

  win.on('minimize', () => { if (opcoes().minimizar) esconder(); });
  app.on('before-quit', () => { saindo = true; });
  win.on('session-end', () => { saindo = true; }); // desligando o Windows: fecha de verdade, sem segurar
  win.on('closed', () => { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; });
}

// Chamado no começo do win.on('close') do main.js: com "O X manda para a bandeja" ligado, segura o fechamento (e o
// main.js não fecha as contas). Ao sair pelo menu, pelo desligamento do Windows ou por app.quit(), fecha normalmente.
function segurarFechar(e) {
  if (saindo || !cfg || !opcoes().fechar) return false;
  e.preventDefault();
  esconder();
  return true;
}

module.exports = { ligar, segurarFechar, mostrar };
