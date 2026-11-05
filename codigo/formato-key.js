// O formato do código do PC e da key do PokeMulti. O app só confere, com a chave pública, que não é segredo. Quem assina
// é o gerador, no PC do vendedor, com a chave privada, que nunca sai de lá. Por isso ninguém fabrica uma key, nem vendo
// este código. Letras e números só em maiúsculas, sem traço, sublinhado ou asterisco: passa inteira pelo WhatsApp.
const crypto = require('crypto');

const CHAVE_PUBLICA = 'GOpYUAuzDNRvfUayO9hIEuRZSw7ZxZ4Fe92JkiA61H0='; // 32 bytes em base64 (gerador/criar-chave.js)
const DOMINIO = Buffer.from('pokemulti-key-v1:');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PREFIXO = 'PM1';
const TAM_PAYLOAD = 15, TAM_ASSINATURA = 64, TAM_TEXTO = 127; // 79 bytes em base32

// Os dias contam pelo horário de Brasília: a key "até 05/12" vale até o fim do dia 05/12
const DIA = 864e5, FUSO = 3 * 3600e3, EPOCA = Date.UTC(2020, 0, 1);
const diaDe = ms => Math.floor((ms - FUSO - EPOCA) / DIA);
const fimDoDia = dia => EPOCA + (dia + 1) * DIA + FUSO;
function dataDoDia(dia) {
  const d = new Date(EPOCA + dia * DIA);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function paraB32(buf) {
  let bits = 0, v = 0, s = '';
  for (const b of buf) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      s += ALFABETO[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
    v &= (1 << bits) - 1;
  }
  if (bits) s += ALFABETO[(v << (5 - bits)) & 31];
  return s;
}
function deB32(s) {
  let bits = 0, v = 0;
  const out = [];
  for (const c of s) {
    const n = ALFABETO.indexOf(c);
    if (n < 0) return null;
    v = (v << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255);
      bits -= 8;
    }
    v &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

// ---- O código do PC: 16 letras e números, o último confere os outros (o gerador recusa um código digitado errado)
const digitoDe = s15 => ALFABETO[crypto.createHash('sha256').update('pm-dv:' + s15).digest()[0] & 31];
const formatarCodigo = c => c.match(/.{4}/g).join('-');
function codigoDoPc(idDoPc) {
  const h = crypto.createHash('sha256').update('pokemulti-pc:' + String(idDoPc).trim().toLowerCase()).digest();
  const s = paraB32(h.subarray(0, 10)).slice(0, 15);
  return formatarCodigo(s + digitoDe(s));
}
function normalizarCodigo(txt) {
  const s = String(txt ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 16 || deB32(s) === null || digitoDe(s.slice(0, 15)) !== s[15]) return null;
  return s;
}

// ---- A key: PM1 + base32 de [versão, código do PC, vencimento, emissão, assinatura]
const chavePublica = (b64 = CHAVE_PUBLICA) => crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' });
function gerarKey({ codigo, ateDia, emitidoDia }, chavePrivadaPem) {
  const c = normalizarCodigo(codigo);
  if (!c) throw new Error('código do PC inválido');
  const p = Buffer.alloc(TAM_PAYLOAD);
  p[0] = 1;
  deB32(c).copy(p, 1);
  p.writeUInt16BE(ateDia, 11);
  p.writeUInt16BE(emitidoDia, 13);
  const assinatura = crypto.sign(null, Buffer.concat([DOMINIO, p]), crypto.createPrivateKey(chavePrivadaPem));
  return PREFIXO + paraB32(Buffer.concat([p, assinatura]));
}
// Aceita a key no meio de um texto, com espaços e quebras de linha: o cliente cola a mensagem como vier
function lerKey(txt, publicaB64) {
  const limpo = String(txt ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const i = limpo.indexOf(PREFIXO);
  if (i < 0) return { ok: false, erro: 'invalida' };
  const corpo = limpo.slice(i + PREFIXO.length).match(/^[A-Z2-7]*/)[0];
  if (corpo.length < TAM_TEXTO) return { ok: false, erro: 'incompleta' };
  const b = deB32(corpo.slice(0, TAM_TEXTO));
  if (!b || b.length !== TAM_PAYLOAD + TAM_ASSINATURA) return { ok: false, erro: 'invalida' };
  const p = b.subarray(0, TAM_PAYLOAD), assinatura = b.subarray(TAM_PAYLOAD);
  let valida = false;
  try { valida = p[0] === 1 && crypto.verify(null, Buffer.concat([DOMINIO, p]), chavePublica(publicaB64), assinatura); } catch {}
  if (!valida) return { ok: false, erro: 'invalida' };
  return { ok: true, key: PREFIXO + corpo.slice(0, TAM_TEXTO), codigo: paraB32(p.subarray(1, 11)), ateDia: p.readUInt16BE(11), emitidoDia: p.readUInt16BE(13) };
}

module.exports = { CHAVE_PUBLICA, DIA, diaDe, fimDoDia, dataDoDia, codigoDoPc, normalizarCodigo, formatarCodigo, gerarKey, lerKey };
