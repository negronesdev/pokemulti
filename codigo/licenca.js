// O plano da edição de venda (mudou em 10/11/2026): 7 dias de Premium grátis; depois o app continua abrindo, no plano
// grátis, só com o jogo nas 4 contas (os recursos ficam desligados: ver `premium()` e os encaixes do gerar-venda.js), até
// receber uma key, que o vendedor envia à mão depois de conferir o Pix. Cada key vale para um PC e até uma data. Nada sai deste PC:
// o cliente é quem copia o código, e a hora vem do cabeçalho de um site público.
// O limite é conhecido: o app é JavaScript, e quem souber programar consegue remover a trava. Quem apagar o arquivo E o
// registro do Windows repete os 7 dias. Isso segura a maioria das pessoas, não um programador decidido.
const { app, BrowserWindow, ipcMain, net, shell, clipboard, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const F = require('./formato-key.js');
const CFG = require('./venda-config.json');

const DIA = F.DIA;
const TESTE_DIAS = 7;
const AVISO_DIAS = 3;              // a partir daqui, um aviso do Windows por dia
const VIGIA_MS = 10 * 60000;       // de quanto em quanto confere se venceu, com o app aberto
const HORA_REDE_MS = 60 * 60000;   // e acerta a hora pela internet e guarda o estado
const REG_CHAVE = 'HKCU\\Software\\PokeMulti';
const SITES_HORA = ['https://pokeidle.io/robots.txt', 'https://www.cloudflare.com/robots.txt'];
const REPO_PUBLICO = 'negronesdev/pokemulti'; // onde saem as versões novas
const VERSAO_ESPERA_MS = 30000, VERSAO_DE_NOVO_MS = 6 * 3600e3;
const SEGREDO_ESTADO = 'pm-estado-v1'; // não é segredo de verdade: só impede de editar a data à mão, sem programar

const espera = ms => new Promise(r => setTimeout(r, ms));
let appLog = () => {};
let codigo = '', st = null, difRede = null;
let janela = null, principal = null, barra = null;
let premiumAoAbrir = false, recursoPedido = '';

// ---- O código deste PC
const REG_EXE = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'reg.exe') : 'reg';
const reg = (...args) => new Promise(res => {
  execFile(REG_EXE, args, { windowsHide: true, timeout: 5000 }, (err, out) => res(err ? null : String(out)));
});
async function lerIdDoPc() {
  const out = await reg('query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid');
  const id = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out ?? '')?.[1];
  if (id) return id;
  appLog('licença: não consegui ler o id do Windows; usando nome do PC e do usuário');
  return `${os.hostname()}|${os.userInfo().username}`;
}

// ---- O estado: { inicio do teste, visto (a maior data já vista), key }, selado com o código do PC, em 2 lugares
const arquivo = () => path.join(app.getPath('userData'), 'licenca.dat');
const selo = b => crypto.createHmac('sha256', SEGREDO_ESTADO + codigo).update(b).digest('base64').slice(0, 22);
function selar(o) {
  const b = Buffer.from(JSON.stringify(o)).toString('base64');
  return `${b}.${selo(b)}`;
}
function abrirSelo(txt) {
  const [b, m] = String(txt ?? '').trim().split('.');
  if (!b || selo(b) !== m) return null;
  try { return JSON.parse(Buffer.from(b, 'base64').toString()); } catch { return null; }
}
const lerArquivo = () => { try { return fs.readFileSync(arquivo(), 'utf8'); } catch { return null; } };
async function lerRegistro() {
  const out = await reg('query', REG_CHAVE, '/v', 'd');
  return /\bd\s+REG_SZ\s+(\S+)/.exec(out ?? '')?.[1] ?? null;
}
// A key que serve: assinada, deste PC. O vencimento é conferido à parte.
function keyDestePc(k) {
  const l = k ? F.lerKey(k) : null;
  return l?.ok && l.codigo === F.normalizarCodigo(codigo) ? l : null;
}
async function carregar() {
  codigo = F.codigoDoPc(await lerIdDoPc());
  const brutos = [lerArquivo(), await lerRegistro()].filter(Boolean);
  const abertos = brutos.map(abrirSelo).filter(Boolean);
  if (!abertos.length) {
    // Nada guardado é a primeira vez. Guardado e ilegível é arquivo mexido ou trazido de outro PC: sem novo teste.
    st = { inicio: brutos.length ? 0 : null, visto: 0, key: '', oferta: 0 };
    if (brutos.length) appLog('licença: estado ilegível (mexido ou de outro PC); sem novo teste');
    return;
  }
  const keys = abertos.map(o => keyDestePc(o.key)).filter(Boolean).sort((a, b) => b.ateDia - a.ateDia);
  st = {
    inicio: Math.min(...abertos.map(o => o.inicio ?? 0)),
    visto: Math.max(...abertos.map(o => o.visto ?? 0)),
    key: keys[0]?.key ?? '',
    oferta: Math.max(...abertos.map(o => o.oferta ?? 0)) // o dia em que a tela do Premium abriu sozinha pela última vez
  };
}
function salvar() {
  st.visto = difRede != null ? agora() : Math.max(st.visto, Date.now());
  const s = selar(st);
  try { fs.writeFileSync(arquivo(), s); } catch (e) { appLog(`licença: não gravei o arquivo: ${e?.message}`); }
  reg('add', REG_CHAVE, '/v', 'd', '/t', 'REG_SZ', '/d', s, '/f');
}

// ---- A hora: a da internet, se der. Sem internet, nunca antes da maior data já vista: atrasar o relógio não adianta.
const agora = () => (difRede != null ? Date.now() + difRede : Math.max(Date.now(), st?.visto ?? 0));
async function acertarHora() {
  for (const url of SITES_HORA) {
    try {
      const r = await net.fetch(url, { method: 'HEAD', cache: 'no-store' });
      const d = Date.parse(r.headers.get('date'));
      if (Number.isFinite(d)) { difRede = d - Date.now(); return true; }
    } catch {}
  }
  return false;
}

function estado() {
  const t = agora();
  const l = keyDestePc(st.key);
  const fimKey = l ? F.fimDoDia(l.ateDia) : 0, fimTeste = st.inicio ? st.inicio + TESTE_DIAS * DIA : 0;
  const dias = fim => Math.ceil((fim - t) / DIA);
  if (fimKey > t && fimKey >= fimTeste) return { modo: 'licenca', premium: true, dias: dias(fimKey), ateTxt: F.dataDoDia(l.ateDia) };
  if (fimTeste > t) return { modo: 'teste', premium: true, dias: dias(fimTeste), ateTxt: F.dataDoDia(F.diaDe(fimTeste)) };
  if (l) return { modo: 'gratis', motivo: 'vencida', premium: false, ateTxt: F.dataDoDia(l.ateDia) };
  return { modo: 'gratis', motivo: 'teste', premium: false, ateTxt: '' };
}

// ---- O Pix: QR e copia e cola estáticos, com o valor, feitos aqui mesmo (padrão BR Code do Banco Central). O código
// do PC vai como identificador, e o banco pode mostrá-lo no extrato.
const preco = () => (CFG.valor ? `R$ ${CFG.valor.replace('.', ',')}` : '');
const semAcento = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .]/g, '').toUpperCase();
function crc16(txt) {
  let c = 0xFFFF;
  for (const b of Buffer.from(txt)) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
function pixCopiaCola() {
  if (!CFG.pixChave || !CFG.pixNome || !CFG.pixCidade || !CFG.valor) return '';
  const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
  const corpo = tlv('00', '01') +
    tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', CFG.pixChave)) +
    tlv('52', '0000') + tlv('53', '986') + tlv('54', CFG.valor) + tlv('58', 'BR') +
    tlv('59', semAcento(CFG.pixNome).slice(0, 25)) + tlv('60', semAcento(CFG.pixCidade).slice(0, 15)) +
    tlv('62', tlv('05', codigo.replace(/-/g, ''))) + '6304';
  return corpo + crc16(corpo);
}
const mensagem = () => `Olá! Quero ${keyDestePc(st.key) ? 'renovar' : 'ativar'} o Premium do PokeMulti. Segue o comprovante do Pix.\nCódigo do PC: ${codigo}`;

// ---- A janela do Premium: pagamento e key, por cima do app (o app nunca fica bloqueado)
function abrirJanela() {
  if (janela && !janela.isDestroyed()) { if (janela.isMinimized()) janela.restore(); janela.focus(); return; }
  janela = new BrowserWindow({
    width: 560, height: Math.min(880, screen.getPrimaryDisplay().workAreaSize.height), minWidth: 440, minHeight: 500,
    title: 'PokeMulti', backgroundColor: '#151515', autoHideMenuBar: true,
    parent: principal && !principal.isDestroyed() ? principal : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  janela.setMenu(null);
  janela.loadFile(path.join(__dirname, 'bloqueio.html'));
  janela.on('closed', () => { janela = null; });
}
function enviarBarra() {
  if (!barra || barra.isDestroyed()) return;
  const e = estado();
  // A barra mostra o plano com que o app abriu: os recursos só mudam ao reabrir
  const m = premiumAoAbrir ? e : { ...e, modo: 'gratis' };
  barra.send('licstate', { modo: m.modo, dias: m.dias, ateTxt: m.ateTxt, nova: novaVersao });
}
// Versão nova: pergunta ao GitHub qual é a última e, se for maior que esta, a barra mostra um botão. Só avisa: quem baixa
// e instala é o cliente. Não vai nenhum dado no pedido.
let novaVersao = '';
const partesVersao = v => String(v).replace(/^v/, '').split('.').map(n => Number(n) || 0);
function versaoMaior(a, b) {
  const x = partesVersao(a), y = partesVersao(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
async function conferirVersao() {
  try {
    const r = await net.fetch(`https://api.github.com/repos/${REPO_PUBLICO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!r.ok) return;
    const tag = String((await r.json()).tag_name ?? '');
    if (!/^v?\d+\.\d+\.\d+$/.test(tag) || !versaoMaior(tag, app.getVersion())) return;
    novaVersao = tag.replace(/^v/, '');
    appLog(`licença: versão nova disponível, ${novaVersao}`);
    enviarBarra();
  } catch {}
}
function reabrir() {
  app.relaunch();
  app.quit();
  // Se alguma janela segurar o fechamento, sai mesmo assim: os dados já foram gravados no fechar da principal
  setTimeout(() => app.exit(0), 5000);
}
async function aplicar(txt) {
  const k = F.lerKey(txt);
  if (!k.ok) return { ok: false, erro: k.erro === 'incompleta' ? 'A key está incompleta. Copie a mensagem inteira e cole de novo.' : 'Esta key não é válida. Confira se copiou certo.' };
  if (k.codigo !== F.normalizarCodigo(codigo)) return { ok: false, erro: 'Esta key é de outro PC. Envie o código deste PC para receber a certa.' };
  await Promise.race([acertarHora(), espera(3000)]);
  if (F.fimDoDia(k.ateDia) <= agora()) return { ok: false, erro: `Esta key venceu em ${F.dataDoDia(k.ateDia)}. Peça uma nova.` };
  const atual = keyDestePc(st.key);
  if (atual && atual.ateDia >= k.ateDia) return { ok: true, ateTxt: F.dataDoDia(atual.ateDia), reabrindo: false };
  st.key = k.key;
  salvar();
  appLog(`licença: key aplicada, vale até ${F.dataDoDia(k.ateDia)}`);
  enviarBarra();
  // No plano grátis, os recursos só ligam reabrindo o app
  const reabrindo = !premiumAoAbrir;
  if (reabrindo) setTimeout(reabrir, 1500);
  return { ok: true, ateTxt: F.dataDoDia(k.ateDia), reabrindo };
}
function registrarIpc() {
  ipcMain.handle('lic:dados', () => ({
    ...estado(), gratis: !premiumAoAbrir, recurso: recursoPedido, testeDias: TESTE_DIAS, codigo, preco: preco(), periodo: CFG.periodo ?? 'por mês',
    pix: pixCopiaCola(), whatsapp: !!CFG.whatsapp, instagram: CFG.instagram ?? ''
  }));
  ipcMain.handle('lic:aplicar', (_e, txt) => aplicar(txt));
  ipcMain.on('lic:copiar', (_e, qual) => {
    const t = { codigo, pix: pixCopiaCola(), mensagem: mensagem() }[qual];
    if (t) clipboard.writeText(t);
  });
  ipcMain.on('lic:link', (_e, qual) => {
    if (qual === 'whatsapp' && CFG.whatsapp) shell.openExternal(`https://wa.me/${encodeURIComponent(CFG.whatsapp)}?text=${encodeURIComponent(mensagem())}`);
    if (qual === 'instagram' && CFG.instagram) {
      clipboard.writeText(mensagem());
      shell.openExternal(`https://ig.me/m/${encodeURIComponent(CFG.instagram)}`);
    }
    if (qual === 'versao') shell.openExternal(`https://github.com/${REPO_PUBLICO}/releases/latest`);
  });
  ipcMain.on('lic:abrir', () => { recursoPedido = ''; abrirJanela(); });
}

// ---- Com o app aberto: o Premium venceu, reabre no plano grátis (desligar cada recurso com o app aberto deixaria algum
// pela metade). Perto de vencer, avisa uma vez por dia.
let ultimoAviso = -1;
function avisar(e) {
  const hoje = F.diaDe(agora());
  if (e.dias > AVISO_DIAS || ultimoAviso === hoje) return;
  ultimoAviso = hoje;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'PokeMulti', body: `${e.modo === 'teste' ? 'Seu Premium grátis' : 'Seu Premium'} termina em ${e.dias} ${e.dias === 1 ? 'dia' : 'dias'}. Depois, o app continua grátis só com o jogo nas 4 contas. Clique para ver como renovar.` });
  n.on('click', () => { recursoPedido = ''; abrirJanela(); });
  n.show();
}
function vigiar() {
  let horaEm = Date.now();
  setInterval(async () => {
    if (Date.now() - horaEm >= HORA_REDE_MS) {
      horaEm = Date.now();
      await acertarHora();
      salvar();
    }
    const e = estado();
    if (premiumAoAbrir && !e.premium) {
      appLog('licença: o Premium venceu com o app aberto; reabrindo no plano grátis');
      salvar();
      if (Notification.isSupported()) new Notification({ title: 'PokeMulti', body: 'Seu Premium terminou. O app vai reabrir no plano grátis, com o jogo nas 4 contas.' }).show();
      return reabrir();
    }
    enviarBarra();
    if (e.premium) avisar(e);
  }, VIGIA_MS);
}

// Confere o plano. O app sempre abre: com o Premium, ou no plano grátis, só com o jogo nas 4 contas.
async function iniciar({ log }) {
  appLog = log;
  registrarIpc();
  await carregar();
  await Promise.race([acertarHora(), espera(3000)]);
  if (st.inicio == null) {
    st.inicio = agora();
    appLog(`licença: teste de ${TESTE_DIAS} dias começou`);
  }
  salvar();
  app.on('second-instance', () => {
    if (janela && !janela.isDestroyed()) { if (janela.isMinimized()) janela.restore(); janela.focus(); }
  });
  const e = estado();
  premiumAoAbrir = e.premium;
  vigiar();
  if (e.premium) setTimeout(() => avisar(estado()), 60000);
  else {
    appLog(`licença: plano grátis (${e.motivo === 'vencida' ? 'a key venceu' : 'o Premium grátis terminou'}); recursos desligados`);
    // A tela do Premium abre sozinha uma vez por dia, por cima do jogo, e fecha no X
    const hoje = F.diaDe(agora());
    if (st.oferta !== hoje) {
      st.oferta = hoje;
      salvar();
      setTimeout(() => { recursoPedido = ''; abrirJanela(); }, 4000);
    }
  }
  setTimeout(() => { conferirVersao(); setInterval(conferirVersao, VERSAO_DE_NOVO_MS); }, VERSAO_ESPERA_MS);
  return true;
}
// Os recursos ficam ligados só se o app abriu com o Premium (o grátis tem só o jogo nas 4 contas)
const premium = () => premiumAoAbrir;
// Clicou num recurso do Premium no plano grátis: a tela do Premium abre dizendo qual
function pedirPremium(recurso) {
  recursoPedido = String(recurso ?? '');
  const jaAberta = janela && !janela.isDestroyed();
  abrirJanela();
  if (jaAberta) janela.webContents.reload();
}
function ligarBarra(wc, w) {
  barra = wc;
  principal = w;
  wc.on('did-finish-load', enviarBarra);
}

module.exports = { iniciar, ligarBarra, premium, pedirPremium };
