// Atualização pelo próprio app (18/11/2026, pedido do usuário). O "⬆ Nova versão" da barra pergunta, baixa o instalador
// do release no GitHub (o mesmo do site), confere a ASSINATURA (feita com a chave privada das keys, que nunca sobe: ver
// formato-key.js) e só então fecha o app e roda o instalador em silêncio; no fim, o PokeMulti abre de novo na versão nova.
// Os logins e ajustes ficam em Documentos\PokeMulti-dados, que o instalador não toca.
// Sem assinatura válida, nada é instalado: o arquivo é apagado e o app oferece baixar pelo site. Qualquer falha no meio
// do caminho também cai nessa saída. Não vai nenhum dado no pedido.
const { app, dialog, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const F = require('./formato-key.js');

const { argsInstalar } = require('./instalar-comando.js');

let rodando = false;

function avisarBarra(barra, estado) {
  try { if (barra && !barra.isDestroyed()) barra.send('lic:atualizacao', estado); } catch {}
}

// Baixa para um arquivo, contando o SHA-256 no caminho
async function baixar(url, destino, aoAvancar) {
  const r = await net.fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`o GitHub respondeu ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(destino, 'w');
  let feito = 0, ultimo = -1;
  try {
    const leitor = r.body.getReader();
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      const b = Buffer.from(value);
      fs.writeSync(fd, b);
      hash.update(b);
      feito += b.length;
      const pct = total ? Math.floor(feito * 100 / total) : 0;
      if (pct !== ultimo) { ultimo = pct; aoAvancar(pct); }
    }
  } finally { fs.closeSync(fd); }
  if (total && feito !== total) throw new Error('o download veio incompleto');
  return hash.digest('hex');
}

// versao: a do último release (sem o "v"). janela: a principal. barra: o webContents da barra. repo: dono/nome no GitHub.
async function iniciar({ versao, janela, barra, repo, log = () => {}, publicaB64 }) {
  if (rodando || !/^\d+\.\d+\.\d+$/.test(String(versao))) return;
  const paginaDaVersao = `https://github.com/${repo}/releases/tag/v${versao}`;
  const r = await dialog.showMessageBox(janela, {
    type: 'question', title: 'PokeMulti', buttons: ['Atualizar agora', 'Ver o que mudou', 'Depois'], defaultId: 0, cancelId: 2,
    message: `Atualizar para a versão ${versao}?`,
    detail: 'O PokeMulti baixa a versão nova (cerca de 100 MB), confere se ela é original, fecha, instala e abre de novo sozinho. Seus logins e ajustes continuam guardados.'
  });
  if (r.response === 1) shell.openExternal(paginaDaVersao);
  if (r.response !== 0) return;

  rodando = true;
  const base = `https://github.com/${repo}/releases/download/v${versao}/`;
  const arquivo = path.join(app.getPath('temp'), `PokeMulti-Setup-${versao}.exe`);
  const progresso = pct => {
    avisarBarra(barra, { fase: 'baixando', pct });
    try { if (janela && !janela.isDestroyed()) janela.setProgressBar(pct / 100); } catch {}
  };
  try {
    log(`atualização: baixando a ${versao}`);
    avisarBarra(barra, { fase: 'baixando', pct: 0 });
    const ra = await net.fetch(base + 'PokeMulti-Setup.exe.assinatura', { cache: 'no-store' });
    if (!ra.ok) throw new Error('esta versão não tem a assinatura para a atualização pelo app');
    const assinatura = (await ra.text()).trim();
    const sha = await baixar(base + 'PokeMulti-Setup.exe', arquivo, progresso);
    avisarBarra(barra, { fase: 'conferindo' });
    if (!F.conferirAtualizacao(versao, sha, assinatura, publicaB64)) {
      try { fs.rmSync(arquivo, { force: true }); } catch {}
      throw new Error('a assinatura do instalador não confere (o arquivo pode ter sido trocado); nada foi instalado');
    }
    log(`atualização: ${versao} conferida (sha256 ${sha.slice(0, 12)}…); fechando para instalar`);
    avisarBarra(barra, { fase: 'instalando' });
    try { if (janela && !janela.isDestroyed()) janela.setProgressBar(2); } catch {} // barra "indeterminada" na tarefa
    // Um PowerShell escondido roda o instalador em silêncio (/S), espera ele terminar e abre o PokeMulti de novo; o
    // instalador espera o app fechar antes de trocar os arquivos (o porquê do cmd/start: instalar-comando.js)
    spawn('cmd.exe', argsInstalar(arquivo, process.execPath), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
    setTimeout(() => app.exit(0), 8000); // alguma janela segurando o fechamento não pode travar a instalação
  } catch (e) {
    rodando = false;
    const motivo = String(e?.message || e);
    log(`atualização: não deu (${motivo})`);
    avisarBarra(barra, { fase: 'erro', motivo });
    try { if (janela && !janela.isDestroyed()) janela.setProgressBar(-1); } catch {}
    const d = await dialog.showMessageBox(janela, {
      type: 'warning', title: 'PokeMulti', buttons: ['Baixar pelo site', 'Fechar'], defaultId: 0, cancelId: 1,
      message: 'Não deu para atualizar pelo app.',
      detail: `Motivo: ${motivo}.\n\nVocê pode baixar a versão ${versao} pela página dela e instalar por cima. Seus logins e ajustes continuam guardados.`
    });
    if (d.response === 0) shell.openExternal(paginaDaVersao);
  }
}

module.exports = { iniciar };
