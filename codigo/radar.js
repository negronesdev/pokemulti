// 📡 RADAR DO MERCADO (21/11/2026, pedido do dono): cada anúncio de pokémon do Mercado da Comunidade avaliado contra as
// vendas reais que o próprio app guardou (o 🐉 Monitor de Pokémons). Aqui mora só a conta, sem Electron, para dar para
// testar à parte: o valor de referência vem de fora (o 💲 Precificador em gemas, a mediana das vendas parecidas em coins,
// ver radarReferencia em main.js) e este arquivo transforma valor + contexto em veredito, oportunidade e lucro.
//
// O VEREDITO sai do desconto (quanto o preço pedido está abaixo do valor de mercado) e da OPORTUNIDADE (0 a 100):
//   EXCEPCIONAL  40%+ abaixo, oportunidade 75+ e 8+ vendas confirmando
//   ÓTIMO        25%+ abaixo e oportunidade 55+
//   BOM          10%+ abaixo
//   JUSTO        até 10% acima ou abaixo
//   CARO         mais de 10% acima
//   POUCAS       sem vendas parecidas o bastante para dar um valor
// Referência aproximada (poucas vendas ou confiança baixa do Precificador) vai no máximo até BOM. E o ÓTIMO e o
// EXCEPCIONAL caem um degrau a cada motivo para desconfiar (ver MOTIVOS): o radar prefere errar para menos.
'use strict';

const VEREDITOS = ['caro', 'justo', 'bom', 'otimo', 'excepcional']; // do pior ao melhor; 'poucas' fica de fora da escada
const ROTULO = { excepcional: 'EXCEPCIONAL', otimo: 'ÓTIMO', bom: 'BOM', justo: 'JUSTO', caro: 'CARO', poucas: 'POUCAS REFERÊNCIAS' };
const NIVEL = { poucas: -1, caro: 0, justo: 1, bom: 2, otimo: 3, excepcional: 4 };
const MOTIVOS = {
  duplicado: 'Tem outro igual à venda quase pelo mesmo preço.',
  queda: 'O preço desta espécie está caindo nos últimos dias.',
  parado: 'O anúncio está parado há dias: se fosse tão bom, já teria saído.',
  vendaPerto: 'Um parecido foi vendido há pouco por um preço próximo.',
  barato: 'É um pokémon barato, numa faixa de preço que oscila muito.'
};

// O que o vendedor recebe (o que sobraria revendendo). Pokémon em gemas: taxa por FAIXA marginal, 13% até 500, 10% de
// 501 a 5.000 e 7,5% acima, arredondada para cima (a mesma de economia.html). Em coins, 15% sempre.
function liquido(preco, moeda) {
  const t = Math.floor(Number(preco) || 0);
  if (t <= 0) return 0;
  if (moeda !== 'orb') return t - Math.ceil(t * 0.15);
  let piso = 0, bp = 0;
  for (const [ate, b] of [[500, 1300], [5000, 1000], [Infinity, 750]]) {
    const teto = Math.min(t, ate);
    if (teto <= piso) break;
    bp += (teto - piso) * b;
    piso = teto;
  }
  return t - Math.min(t, Math.ceil(bp / 10000));
}

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mediana = xs => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b), n = s.length;
  return !n ? null : n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
// Em que posição `x` fica numa lista ORDENADA: a fração dos valores menores que ele (0 a 1)
function fracaoAbaixo(ordenada, x) {
  if (!ordenada?.length || !Number.isFinite(x)) return null;
  let lo = 0, hi = ordenada.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ordenada[m] < x) lo = m + 1; else hi = m; }
  return lo / ordenada.length;
}

// O FOCO dos golpes da espécie: a fração do poder dos golpes de dano que é física (0 a 1). Os golpes do catálogo do
// jogo (jogo-especies.json): [nome, categoria 0 físico / 1 especial / 2 status, poder, recarga, nível, tipo]. Pesa o
// poder por segundo de cada golpe, e o golpe do tipo da espécie vale 1,5 (é o que o combate escolhe mais).
function fracaoFisica(e) {
  let f = 0, s = 0;
  for (const g of e?.g || []) {
    if (!g || g[1] === 2 || !(g[2] > 0)) continue;
    const v = g[2] / Math.max(0.4, (g[3] || 2000) / 1000) * ((e.t || []).includes(g[5]) ? 1.5 : 1);
    if (g[1] === 1) s += v; else f += v;
  }
  return f + s > 0 ? f / (f + s) : null;
}
// IV ÚTIL: só o IV do ataque que a espécie usa (ATK no físico, SP.ATK no especial; no misto, o maior dos dois), de 0 a
// 100%. `ivs`: [hp, atk, def, spAtk, spDef, speed] de 1 a 32.
function ivUtil(e, ivs) {
  if (!Array.isArray(ivs) || ivs.length !== 6) return null;
  const fis = fracaoFisica(e);
  const atk = Number(ivs[1]) || 0, spa = Number(ivs[3]) || 0;
  const iv = fis == null || (fis > 0.35 && fis < 0.65) ? Math.max(atk, spa) : fis >= 0.65 ? atk : spa;
  return iv >= 1 ? Math.round((iv - 1) / 31 * 100) : null;
}

// A OPORTUNIDADE, de 0 a 100: junta o tamanho do desconto (até 55 pontos, cheio com 50% abaixo), quantas vendas confirmam
// o valor (até 20), se a espécie vende rápido (até 10), a força do pokémon na régua do mercado (até 10) e a firmeza do
// preço (até 5, tirados quando as vendas parecidas variam muito). Preço acima do mercado é 0.
function oportunidade({ desconto, n = 0, conf = null, vendas7d = 0, regua = null, espalhamento = null }) {
  if (!(desconto > 0)) return 0;
  const refs = conf != null ? clamp(conf / 100) * 0.5 + clamp(n / 12) * 0.5 : clamp(n / 12);
  const firmeza = espalhamento == null ? 0.5 : clamp(1 - espalhamento / 1.5);
  const pts = 55 * clamp(desconto / 0.5) + 20 * refs + 10 * clamp(vendas7d / 14) + 10 * clamp((regua ?? 0) / 100) + 5 * firmeza;
  return Math.round(clamp(pts, 0, 100));
}

// Um anúncio avaliado. `an`: { preco, moeda: 'orb'|'gold' }. `ref`: { valor, low, high, n, conf (0–100 ou null) } ou null.
// `ctx`: { minVendas, vendas7d, regua, motivos: { duplicado, queda, parado, vendaPerto } }. Devolve o que a etiqueta e o
// painel mostram (nomes curtos: vai para as 4 contas e para a janela a cada vitrine).
function avaliar(an, ref, ctx = {}) {
  const preco = Number(an.preco) || 0;
  const out = { v: 'poucas', vs: null, lucro: null, op: 0, med: null, n: ref?.n ?? 0, conf: ref?.conf ?? null, aprox: false, motivos: [] };
  if (!(preco > 0) || !ref || !(ref.valor > 0)) return out;
  const valor = ref.valor, minVendas = Math.max(1, Number(ctx.minVendas) || 4);
  const desconto = (valor - preco) / valor;
  out.med = Math.round(valor);
  out.vs = Math.round((preco - valor) / valor * 100);
  out.lucro = Math.round(liquido(valor, an.moeda) - preco);
  // A referência é aproximada com poucas vendas parecidas, ou com o Precificador pouco confiante (menos de 40%)
  out.aprox = (ref.n || 0) < minVendas || (ref.conf != null && ref.conf < 40);
  const espalhamento = ref.low > 0 && ref.high > 0 ? (ref.high - ref.low) / valor : null;
  out.op = oportunidade({ desconto, n: ref.n || 0, conf: ref.conf, vendas7d: ctx.vendas7d || 0, regua: ctx.regua, espalhamento });

  let v = desconto < -0.1 ? 'caro' : desconto < 0.1 ? 'justo' : 'bom';
  if (desconto >= 0.25 && out.op >= 55) v = 'otimo';
  if (desconto >= 0.4 && out.op >= 75 && (ref.n || 0) >= 8) v = 'excepcional';
  if (out.aprox && NIVEL[v] > NIVEL.bom) v = 'bom';

  // Os motivos para desconfiar de uma pechincha: cada um tira um degrau do ÓTIMO e do EXCEPCIONAL (não passa de BOM)
  const m = { ...(ctx.motivos || {}) };
  if (an.moeda === 'orb' && preco < 60 && desconto < 0.5) m.barato = true; // em coins, a faixa barata ainda não foi medida
  for (const k of Object.keys(MOTIVOS)) {
    if (!m[k] || NIVEL[v] < NIVEL.otimo) continue;
    out.motivos.push(k);
    v = VEREDITOS[NIVEL[v] - 1];
  }
  out.v = v;
  return out;
}

// O veredito mínimo pedido (das opções da janela) é atendido por `v`?
const atende = (v, minimo) => (NIVEL[v] ?? -1) >= (NIVEL[minimo] ?? 99);

module.exports = { VEREDITOS, ROTULO, NIVEL, MOTIVOS, liquido, mediana, fracaoAbaixo, fracaoFisica, ivUtil, oportunidade, avaliar, atende };
