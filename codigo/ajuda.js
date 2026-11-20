// ❓ Ajuda (20/11/2026, pedido do usuário): uma janela com o tutorial de todas as ferramentas, as novidades de cada
// versão e o botão "Verificar atualizações". As novidades abrem sozinhas na primeira vez que o app abre numa versão
// nova (a versão vista fica em novidades.json, na pasta de dados). O tutorial e as novidades estão no ajuda.html e
// aqui; não usam internet. Só o "Verificar atualizações" pergunta ao GitHub (o mesmo pedido da conferência automática).
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');

// As novidades de cada versão, da mais nova para a mais antiga. Sem valores, como no site.
const NOVIDADES = [
  { versao: '1.3.6', data: '20/11/2026', itens: [
    ['❓ Ajuda', 'Esta janela: o tutorial de todas as ferramentas, as novidades de cada versão (abrem sozinhas quando o app atualiza) e o botão "Verificar atualizações".'],
    ['🏆 Caça do Top Catch', 'Numa conta, vai de hunt em hunt atrás das espécies que ainda faltam no Top Catch da semana. Só troca de hunt com a trava do combate livre e pula a hunt onde o pokémon cai. Quem captura é o próprio jogo, pelo "Lançar sem parar" do VIP.'],
    ['🎨 Temas', 'Muda as cores do jogo em cada conta: Grafite, Azul noite, Verde floresta, Roxo, Cobre ou as suas 3 cores. "Uma cor por conta" ajuda a saber de relance em qual conta você está.'],
    ['🧟 Vigia de sessão zumbi', 'A conta conectada e numa hunt que fica 5 minutos sem receber o combate é recarregada sozinha.'],
    ['🎯 Teto de gasto por dia no Sniper', 'Em cada conta, um limite de coins e de gemas por dia. A janela do Sniper mostra quanto já foi gasto hoje.']
  ] },
  { versao: '1.3.5', data: '20/11/2026', itens: [
    ['Abrir junto com o Windows', 'Clique com o botão direito no ícone do PokeMulti, perto do relógio, e marque "Abrir junto com o Windows".']
  ] },
  { versao: '1.3.4', data: '18/11/2026', itens: [
    ['🗳 Voto em cada conta', 'O voto do IdleHub abre numa janela do app, com o login de cada conta (Google ou Discord), para votar em contas separadas.']
  ] },
  { versao: '1.3.3', data: '18/11/2026', itens: [
    ['⬆ Atualização pelo app', 'O botão "Nova versão" baixa, confere a assinatura, instala e abre o app de novo sozinho. Seus logins e ajustes continuam guardados.']
  ] },
  { versao: '1.3.2', data: '18/11/2026', itens: [
    ['🗳 Voto pelo IdleHub', 'O aviso de voto voltou a funcionar depois que o jogo trocou o TopIdle pelo IdleHub.'],
    ['🔧 Vigia do jogo que não abre', 'A conta presa na tela de abertura do jogo por 1 minuto é recarregada; da 2ª vez em diante, limpando o cache.']
  ] },
  { versao: '1.3.1', data: '16/11/2026', itens: [
    ['Bandeja do Windows', 'Minimizar e o X deixam o PokeMulti rodando perto do relógio, com as contas abertas. Clique no ícone para voltar; "Sair do PokeMulti" fecha de verdade.']
  ] }
];

let janela = null, principal = null, licenca = null, log = () => {};
const arquivo = () => path.join(app.getPath('userData'), 'novidades.json');

function abrir(aba = 'novidades') {
  if (janela && !janela.isDestroyed()) {
    if (janela.isMinimized()) janela.restore();
    janela.focus();
    janela.webContents.send('ajuda:aba', aba);
    return;
  }
  janela = new BrowserWindow({
    width: 780, height: 860, parent: principal && !principal.isDestroyed() ? principal : undefined, autoHideMenuBar: true, backgroundColor: '#151515',
    title: 'Ajuda do PokeMulti',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  janela.on('page-title-updated', e => e.preventDefault());
  janela.loadFile(path.join(__dirname, 'ajuda.html'), { query: { aba } });
  janela.on('closed', () => { janela = null; });
}

// Chamado pelo main.js depois de criar a janela principal
function ligar({ janela: w, licenca: lic, appLog }) {
  principal = w; licenca = lic; log = appLog || log;
  ipcMain.removeHandler('ajuda:dados');
  ipcMain.handle('ajuda:dados', () => ({ versao: app.getVersion(), novidades: NOVIDADES }));
  ipcMain.removeHandler('ajuda:verificar');
  ipcMain.handle('ajuda:verificar', async () => {
    const r = await licenca.verificarAgora();
    log(`ajuda: verificar atualizações: ${r.ok ? (r.nova ? `versão ${r.nova} disponível` : 'já é a mais nova') : r.erro}`);
    return r;
  });
  ipcMain.removeAllListeners('ajuda:abrir');
  ipcMain.on('ajuda:abrir', (_e, aba) => abrir(aba));
  ipcMain.removeAllListeners('ajuda:atualizar');
  ipcMain.on('ajuda:atualizar', () => licenca.atualizarAgora());
  // Primeira abertura numa versão: as novidades abrem sozinhas, alguns segundos depois do app (com o jogo carregando)
  let vista = '';
  try { vista = JSON.parse(fs.readFileSync(arquivo(), 'utf8')).vista || ''; } catch {}
  const atual = app.getVersion();
  if (vista === atual) return;
  try { fs.writeFileSync(arquivo(), JSON.stringify({ vista: atual })); } catch {}
  const temNovidade = NOVIDADES.some(n => n.versao === atual);
  log(`ajuda: primeira abertura da versão ${atual}${temNovidade ? '; abrindo as novidades' : ''}`);
  if (temNovidade) setTimeout(() => { if (principal && !principal.isDestroyed()) abrir('novidades'); }, Number(process.env.PKM_AJUDA_ESPERA_MS ?? 6000));
}

module.exports = { ligar, abrir, NOVIDADES };
