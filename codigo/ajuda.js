// ❓ Ajuda (20/11/2026, pedido do usuário; no app pessoal desde 21/11/2026, sem novidades nem atualização): uma janela com o tutorial de todas as ferramentas, as novidades de cada
// versão e o botão "Verificar atualizações". As novidades abrem sozinhas na primeira vez que o app abre numa versão
// nova (a versão vista fica em novidades.json, na pasta de dados). O tutorial e as novidades estão no ajuda.html e
// aqui; não usam internet. Só o "Verificar atualizações" pergunta ao GitHub (o mesmo pedido da conferência automática).
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');

// As novidades de cada versão ficam em novidades.js, que só a venda tem. No app pessoal, a Ajuda é só o tutorial.
const NOME = 'PokeMulti'; // a venda troca para PokeMulti (gerar-venda.js)
let NOVIDADES = [];
try { NOVIDADES = require('./novidades.js'); } catch {}

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
    title: `Ajuda do ${NOME}`,
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
  ipcMain.handle('ajuda:dados', () => ({ versao: app.getVersion(), novidades: NOVIDADES, nome: NOME, venda: !!licenca }));
  ipcMain.removeHandler('ajuda:verificar');
  ipcMain.handle('ajuda:verificar', async () => {
    if (!licenca) return { ok: false, erro: 'este app não se atualiza sozinho' };
    const r = await licenca.verificarAgora();
    log(`ajuda: verificar atualizações: ${r.ok ? (r.nova ? `versão ${r.nova} disponível` : 'já é a mais nova') : r.erro}`);
    return r;
  });
  ipcMain.removeAllListeners('ajuda:abrir');
  ipcMain.on('ajuda:abrir', (_e, aba) => abrir(aba));
  ipcMain.removeAllListeners('ajuda:atualizar');
  ipcMain.on('ajuda:atualizar', () => { if (licenca) licenca.atualizarAgora(); });
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

// A venda tem atualização pelo app (e a licença); o app pessoal não
const comAtualizacao = () => !!licenca;

module.exports = { ligar, abrir, comAtualizacao, NOVIDADES };
