// Bandeja do Windows (16/11/2026, pedido de cliente; no app pessoal desde 21/11/2026): o app fica em segundo plano no canto da barra de tarefas, perto do
// relógio, com as contas rodando. Minimizar e o X mandam para a bandeja (padrão desde 16/11/2026, pedido do usuário); cada
// um pode ser desligado no menu do ícone. Clique no ícone traz de volta; "Sair do PokeMulti" no menu fecha de verdade.
// Esconder a janela não freia as contas: as páginas do jogo e das lives já rodam com backgroundThrottling desligado, igual
// a quando o app está minimizado.
const { app, Tray, Menu, Notification, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const NOME = 'PokeMulti'; // a venda troca para PokeMulti (gerar-venda.js)

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
    const n = new Notification({ title: NOME, body: `O ${NOME} continua rodando aqui na bandeja, com as contas abertas. Clique no ícone para voltar. Para fechar de vez, clique com o botão direito no ícone e escolha Sair.` });
    n.on('click', mostrar);
    n.show();
  }
}

// Abrir junto com o Windows (20/11/2026, pedido do dono): fica no Executar do usuário (HKCU\...\Run), ligado pelo menu
// do ícone; desligado de fábrica. Quem vale é o próprio Windows: se o cliente desligar no Gerenciador de Tarefas, a caixa
// aparece desmarcada. O desinstalador apaga a entrada (empacotar.js); a atualização não mexe nela.
// O getLoginItemSettings().openAtLogin só enxerga o nome padrão; por isso a busca pelo nome nos launchItems.
const NOME_INICIO = process.env.PKM_TESTE_INICIO || NOME;
// (O instalador é por usuário e sempre usa a mesma pasta, então o caminho do exe não muda entre versões.)
function abreComWindows() {
  try { return app.getLoginItemSettings({ path: process.execPath }).launchItems.some(x => x.name === NOME_INICIO && x.enabled); }
  catch { return false; }
}
function mudarComWindows(sim) {
  try {
    app.setLoginItemSettings({ openAtLogin: sim, path: process.execPath, args: [], name: NOME_INICIO, enabled: sim });
    log(`inicio: ${sim ? 'abre' : 'não abre mais'} junto com o Windows`);
  } catch (e) { log(`inicio: não consegui mudar (${e.message})`); }
}

function sair() {
  saindo = true;
  app.quit();
}

function montarMenu() {
  const o = opcoes();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Abrir o ${NOME}`, click: mostrar },
    { type: 'separator' },
    { label: 'Minimizar manda para a bandeja', type: 'checkbox', checked: o.minimizar, click: i => { o.minimizar = i.checked; salvar(); } },
    { label: 'O X manda para a bandeja (não fecha)', type: 'checkbox', checked: o.fechar, click: i => { o.fechar = i.checked; salvar(); } },
    { label: 'Abrir junto com o Windows', type: 'checkbox', checked: abreComWindows(), click: i => mudarComWindows(i.checked) },
    { type: 'separator' },
    // No app pessoal não há novidades nem atualização: só o tutorial
    ...(require('./ajuda.js').comAtualizacao()
      ? [{ label: 'Ajuda e novidades', click: () => { mostrar(); require('./ajuda.js').abrir('novidades'); } },
         { label: 'Verificar atualizações', click: () => { mostrar(); require('./ajuda.js').abrir('novidades'); } }]
      : [{ label: 'Ajuda', click: () => { mostrar(); require('./ajuda.js').abrir('ferramentas'); } }]),
    { type: 'separator' },
    { label: `Sair do ${NOME}`, click: sair }
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
  tray.setToolTip(NOME);
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

module.exports = { ligar, segurarFechar, mostrar, abreComWindows };
