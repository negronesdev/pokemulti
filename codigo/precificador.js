'use strict';
// QUANTO PEDIR, EM GEMAS, POR UM POKÉMON: Vender rápido, Preço justo e Esperar, com a confiança.
//
// O cálculo é o do "Precificador de Pokémon" de briaoAle (github.com/briaoAle/precificador-pokemon, licença MIT;
// o aviso está no fim deste arquivo), refeito para rodar no app com os dados que ele já tem: as vendas do Monitor
// de Pokémons (pokemons.json), o preço dos fragmentos do Monitor de Preços (precos.json) e as espécies do catálogo
// que o app monta com o código do próprio jogo (jogo-especies.json). O Poder e a Nota seguem as fórmulas públicas
// do jogo (shared/ginasios.mjs e shared/nota-pokemon.mjs).
//
// A ideia, em poucas linhas:
//  - PODER = o PvE da última evolução da cadeia no Nv 100, sem TM e sem refino. Põe espécies diferentes na mesma
//    régua: um Squirtle vendido conta como o Blastoise que ele vira.
//  - Uma CURVA do mercado inteiro (shiny e não shiny à parte) diz quanto se paga por Poder, Nota e nível.
//  - De cada venda entra só o quanto ela saiu ACIMA ou ABAIXO da curva, com peso pela data (meia-vida de 14 dias),
//    pelo Poder, pela Nota, pelo nível e pela distância na cadeia: a mesma cadeia vale 1; os mesmos dois tipos,
//    0,2; um tipo em comum, 0,05; o resto, 0,01. Assim outra espécie ajuda sem copiar o preço dela.
//  - Os quartis dessas diferenças, em volta da curva no ponto do pokémon, dão os três preços. Os ADICIONAIS
//    (Z-Move, AoE e Mega: 10 fragmentos cada) saem de cada venda pelo preço do dia dela e voltam no fim pelo de hoje.
//  - A CONFIANÇA é a chance de a venda sair a até 25% do Preço justo, com pesos aprendidos nas vendas recentes
//    (calibrar, abaixo, refaz o teste do precificador com as nossas vendas).

const DIA = 864e5, FUSO_SP = -3 * 3600e3, LIDA_TARDE = 2 * 3600e3;
const STATS = ['hp', 'atk', 'def', 'spAtk', 'spDef', 'speed'];
const ITEM = { Z: 59194, AOE: 40530, MEGA: 70014, MEGA_SHINY: 70015 };
const POR_ADICIONAL = 10;
const JANELA_DIAS = 30;
const diaDe = at => new Date(at + FUSO_SP).toISOString().slice(0, 10);

// Os parâmetros do precificador (versão de 06/11/2026)
const LEVEL_BAND = 0.5, MIN_MARKET = 30, ITEM_DAYS = 3, FAR_ITEM_DAYS = 5;
const NEIGHBORS = { layers: [1, 0.2, 0.05, 0.01], levelSigma: 1.5, pveSigma: 0.15, notaSigma: 0.3, halfLifeDays: 14, minWeight: 1e-5,
  bias: Math.log(1.09), refinedWeight: 1, uncertainPlain: 1 };
const CONFIDENCE = { weights: [-2.64, 0.66, 0.68, 1.53, 0.85], keys: ['proximidade', 'certeza', 'consistencia', 'ampliacao'] };
const LEVEL_STEPS = [20, 40, 60, 80, 100, 150, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000, 10000];
const CAP_LADDER = { 1: [100], 2: [40, 100], 3: [20, 40, 100], 4: [20, 40, 70, 100] };

// ---------------------------------------------------------------- o catálogo e as fórmulas do jogo

const MULT_POTENCIA = [1, 1.05, 1.1, 1.25, 2];
const BONUS_POTENCIA = [0, 0.05, 0.1, 0.25, 1];
const EXPO = [0.95, 0.8, 0.8, 0.8, 0.8, 0.95]; // hp e speed 0,95; o resto 0,8 (EXPO_QUALIDADE do jogo)

// IVs em 6 letras (o IV − 1 em base 32), como o Monitor guarda cada venda: "hp atk def spAtk spDef speed"
const ivsDeTexto = s => {
  if (typeof s !== 'string' || s.length !== 6) return null;
  const o = {};
  for (let i = 0; i < 6; i++) { const v = parseInt(s[i], 32); if (!(v >= 0 && v <= 31)) return null; o[STATS[i]] = v + 1; }
  return o;
};
const ivsParaTexto = ivs => STATS.every(k => Number.isInteger(ivs?.[k]) && ivs[k] >= 1 && ivs[k] <= 32)
  ? STATS.map(k => (ivs[k] - 1).toString(32)).join('') : null;
// Só a soma: espalha igual pelos 6 (o resto vai para os primeiros). Serve às vendas guardadas antes de 06/11/2026.
const ivsDaSoma = t => {
  t = Math.min(192, Math.max(6, Math.round(Number(t) || 0)));
  const b = Math.floor(t / 6), r = t - 6 * b, o = {};
  STATS.forEach((k, i) => { o[k] = Math.min(32, b + (i < r ? 1 : 0)); });
  return o;
};

function catalogo(especies) {
  const species = new Map();
  for (const [id, e] of Object.entries(especies || {})) if (Array.isArray(e?.b) && e.b.length === 6) species.set(Number(id), { id: Number(id), ...e });
  const porNome = new Map();
  for (const e of [...species.values()].sort((a, b) => a.id - b.id)) if (!porNome.has(e.n)) porNome.set(e.n, e.id);
  // A Mega e a espécie dela, pelo nome ("Mega Charizard X" → Charizard)
  const megaBase = new Map();
  for (const e of species.values()) {
    if (!/^Mega /.test(e.n)) continue;
    const b = porNome.get(e.n.replace(/^Mega /, '').replace(/ [XYZ]$/, ''));
    if (b != null && b !== e.id) megaBase.set(e.id, b);
  }
  const kids = id => (species.get(id)?.e || []).filter(k => species.has(k) && k !== id);
  // Quem evolui para quem, de trás para a frente (a Mega conta como evolução da base): a régua da Nota
  const parents = new Map();
  const link = (de, para) => { if (!parents.has(para)) parents.set(para, new Set()); parents.get(para).add(de); };
  for (const [id] of species) for (const k of kids(id)) link(id, k);
  for (const [m, b] of megaBase) link(b, m);

  // As últimas evoluções (sem Mega) a partir de uma espécie
  const finaisCache = new Map();
  function finais(id) {
    if (finaisCache.has(id)) return finaisCache.get(id);
    const out = [], visto = new Set();
    const ir = x => { if (visto.has(x)) return; visto.add(x); const k = kids(x); if (!k.length) out.push(x); else k.forEach(ir); };
    if (species.has(id)) ir(id);
    finaisCache.set(id, out);
    return out;
  }

  // "Poder no PvE" do jogo (ratingNoNivel de shared/ginasios.mjs) no nível dado: o golpe que a IA escolheria entre
  // os aprendidos até o nível, dano por segundo × HP de combate × defesa média. Sem TM e sem refino.
  function poder(p, e, nivel = 100) {
    if (!e) return null;
    const mult = MULT_POTENCIA[p.potencia - 1] * (p.shiny ? 3 : 1) * (e.l ? 4 : 1), st = {};
    STATS.forEach((k, i) => { st[k] = Math.round((e.b[i] + 2 * p.ivs[k]) * (nivel / 100) * Math.pow(p.quality, EXPO[i]) * mult); });
    let golpe = { power: 30, cd: 2000 };
    const aprendidos = (e.g || []).filter(g => (g[4] || 1) <= nivel);
    if (aprendidos.length) {
      let melhor = -1;
      for (const g of aprendidos) {
        const especial = g[1] === 1, atk = especial ? st.spAtk : st.atk, def = especial ? st.spDef : st.def;
        const nota = (((2 * nivel) / 5 + 2) * (g[2] || 0) * (atk / Math.max(1, def)) / 50 + 2) * (e.t.includes(g[5]) ? 1.5 : 1);
        if (nota > melhor) { melhor = nota; golpe = { power: g[2] || 0, cd: g[3] }; }
      }
    }
    const atk = Math.max(st.atk, st.spAtk), def = (st.def + st.spDef) / 2;
    const dps = (((2 * nivel) / 5 + 2) * golpe.power * atk) / 50 / (Math.max(400, golpe.cd || 2000) / 1000);
    return Math.max(1, Math.round(dps * Math.max(24, Math.round(st.hp * 12)) * def / 1e7));
  }

  // A espécie que dá o Poder: a última evolução mais forte PARA ESTA FICHA (numa cadeia que se ramifica, cada
  // galho dá um Poder diferente). A Mega conta como a espécie base; o valor da pedra entra como Adicional.
  function avaliar(p, speciesId) {
    const base = megaBase.get(speciesId) ?? speciesId;
    if (!species.has(base)) return null;
    let melhor = null;
    for (const f of finais(base)) {
      const pv = poder(p, species.get(f));
      if (pv && (!melhor || pv > melhor.pve || (pv === melhor.pve && f < melhor.family))) melhor = { family: f, pve: pv };
    }
    return melhor && { ...melhor, familyName: species.get(melhor.family).n, mega: megaBase.has(speciesId), base };
  }

  // A Nota do jogo (0 a 10 dentro da espécie; shared/nota-pokemon.mjs, sem refino), com o piso da linhagem: a forma
  // evoluída nunca fica abaixo da anterior + 0,1 por passo. Porte do js/nota.js do precificador.
  const round3 = n => Math.round(n * 1000) / 1000, clamp = n => Math.min(1, Math.max(0, n));
  const all = n => Object.fromEntries(STATS.map(k => [k, n]));
  const nasc = (b, p) => b.reduce((s, v, i) => s + Math.round((v + 2 * p.ivs[STATS[i]]) * p.quality ** EXPO[i] * (1 + BONUS_POTENCIA[p.potencia - 1]) * (p.shiny ? 3 : 1)), 0);
  const NEUTRO = Array(6).fill(80), PIOR = { ivs: all(1), quality: 0.8, potencia: 1, shiny: false }, MELHOR = { ivs: all(32), quality: 1.8, potencia: 5, shiny: true };
  const LOW = Math.log(nasc(NEUTRO, PIOR)), HIGH = Math.log(nasc(NEUTRO, MELHOR));
  const escala = (b, p) => round3(10 * clamp((Math.log(nasc(b, p)) - LOW) / (HIGH - LOW))) / 10;
  const grau = (b, p) => { const min = escala(b, PIOR), max = escala(b, MELHOR); return max > min ? round3(10 * clamp((escala(b, p) - min) / (max - min))) : 0; };
  function nota(id, p) {
    const e = species.get(Number(id));
    if (!e || !STATS.every(k => Number.isInteger(p.ivs?.[k])) || !(p.quality > 0) || !(p.potencia >= 1 && p.potencia <= 5)) return null;
    let best = grau(e.b, p), camada = [...(parents.get(e.id) || [])];
    const visto = new Set([e.id]);
    for (let passo = 1; passo <= 12 && camada.length; passo++) {
      const prox = [];
      for (const a of camada) {
        if (visto.has(a)) continue;
        visto.add(a);
        const s = species.get(a);
        if (s) best = Math.max(best, Math.min(10, grau(s.b, p) + passo * 0.1));
        prox.push(...(parents.get(a) || []));
      }
      camada = prox;
    }
    return round3(best);
  }

  // Em que passo da cadeia a espécie está e quantos faltam: o nível em que ela costuma sair da hunt
  let profundidade = null;
  function nivelDeHunt(id) {
    if (!profundidade) {
      const up = new Map(), down = new Map();
      for (const [x] of species) { up.set(x, 0); down.set(x, 0); }
      for (let pass = 0; pass < 8; pass++) {
        let mudou = false;
        for (const [x] of species) for (const k of kids(x)) {
          if (up.get(x) + 1 > up.get(k)) { up.set(k, up.get(x) + 1); mudou = true; }
          if (down.get(k) + 1 > down.get(x)) { down.set(x, down.get(k) + 1); mudou = true; }
        }
        if (!mudou) break;
      }
      profundidade = { up, down };
    }
    const stage = profundidade.up.get(id) ?? 0, escada = CAP_LADDER[Math.min(4, stage + (profundidade.down.get(id) ?? 0) + 1)];
    return escada[Math.min(stage, escada.length - 1)];
  }

  const tipos = id => species.get(id)?.t || [];
  // Para o texto da tela: as formas da cadeia em ordem (da primeira à Mega)
  function profundidadeDe(id) { let d = 0; while (parents.has(id) && d < 9) { id = [...parents.get(id)][0]; d++; } return d; }
  return { species, megaBase, finais, poder, avaliar, nota, nivelDeHunt, tipos, profundidadeDe, kids };
}

// ---------------------------------------------------------------- o preço dos fragmentos (Adicionais)

// O preço de um item num dia é a mediana das leituras do MENOR anúncio em gemas naquele dia (registros de hora
// em hora do Monitor de Preços). [{ day, itemId, price }]
function cotacoesDosRegistros(registros, ids = Object.values(ITEM)) {
  const por = new Map();
  for (const r of registros || []) {
    const d = diaDe(r.em);
    for (const id of ids) {
      const v = Number(r.itens?.[id]?.[0]);
      if (!(v > 0)) continue;
      const k = id + '|' + d;
      if (!por.has(k)) por.set(k, []);
      por.get(k).push(v);
    }
  }
  const out = [];
  for (const [k, vs] of por) {
    const [id, day] = k.split('|');
    vs.sort((a, b) => a - b);
    const m = vs.length >> 1;
    out.push({ day, itemId: Number(id), price: vs.length % 2 ? vs[m] : (vs[m - 1] + vs[m]) / 2 });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}
function itemQuotes(itemPrices) {
  const by = new Map();
  for (const r of itemPrices || []) {
    if ((r.currency && r.currency !== 'orb') || !(r.price > 0)) continue;
    if (!by.has(r.itemId)) by.set(r.itemId, []);
    by.get(r.itemId).push({ t: Date.parse(r.day + 'T12:00:00-03:00'), price: r.price });
  }
  const near = (itemId, at, maxDays) => {
    let best = null;
    for (const q of by.get(itemId) || []) { const d = Math.abs(q.t - at); if (d <= maxDays * DIA && (!best || d < best.d)) best = { d, price: q.price }; }
    return best && { price: best.price, far: best.d > ITEM_DAYS * DIA };
  };
  const quote = (itemId, at) => near(itemId, at, ITEM_DAYS)?.price ?? null;
  quote.near = near;
  return quote;
}

// ---------------------------------------------------------------- as vendas do Monitor → linhas do cálculo

// Venda do Monitor: [id, em, especie, preco, moeda(1 = gemas), nota, nivel, shiny, potencia, ivTotal, qualidade,
// tm(0/1), vendedor, comprador, transferência, ivs (6 letras), tmElemental, marcas (1 AoE, 2 Z-Move físico,
// 4 refino), minutos entre a venda e a leitura]. As posições 15 a 18 existem desde 06/11/2026.
function linhas(vendas, cat, itemPrices, { agora = Date.now(), dias = JANELA_DIAS } = {}) {
  const quote = itemQuotes(itemPrices), rows = [], pulou = {};
  const pula = r => { pulou[r] = (pulou[r] || 0) + 1; };
  const corte = agora - dias * DIA, vistas = new Set();
  for (const v of vendas || []) {
    if (v[4] !== 1) continue; // só gemas
    if (vistas.has(v[0])) continue; // a mesma venda duas vezes conta uma
    vistas.add(v[0]);
    if (v[1] < corte || v[1] > agora) continue;
    if (v[14] === 1) { pula('entre contas'); continue; }
    if (!(v[3] > 0) || !(v[6] > 0) || v[8] == null || v[10] == null) { pula('ficha incompleta'); continue; }
    const exatos = ivsDeTexto(v[15]);
    const ivs = exatos || (v[9] != null ? ivsDaSoma(v[9]) : null);
    if (!ivs) { pula('ficha incompleta'); continue; }
    const p = { ivs, quality: Number(v[10]), potencia: Number(v[8]), shiny: v[7] === 1 };
    const a = cat.avaliar(p, v[2]);
    if (!a) { pula('espécie desconhecida'); continue; }
    // Os Adicionais da venda. Desde 06/11 o Monitor guarda qual TM; antes, só "tem TM": vale a média dos dois.
    const temNovo = v.length > 15 && v[15] != null;
    const ad = [];
    if (temNovo) {
      if (v[16]) ad.push(ITEM.Z);
      if ((v[17] & 1) === 1) ad.push(ITEM.AOE);
    } else if (v[11] === 1) ad.push('tm');
    if (a.mega) ad.push(p.shiny ? ITEM.MEGA_SHINY : ITEM.MEGA);
    let addons = 0, far = false;
    for (const id of ad) {
      const q = id === 'tm' ? media(quote.near(ITEM.Z, v[1], FAR_ITEM_DAYS), quote.near(ITEM.AOE, v[1], FAR_ITEM_DAYS)) : quote.near(id, v[1], FAR_ITEM_DAYS);
      if (!q) { addons = null; break; }
      addons += q.price * POR_ADICIONAL;
      far ||= q.far;
    }
    if (addons == null) { pula('sem cotação dos Adicionais'); continue; }
    const base = v[3] - addons;
    if (!(base > 0)) { pula('Adicionais acima do preço'); continue; }
    // O jogo mostra o Z-Move e o AoE de quando se lê, não os da venda: lida mais de 2 h depois, fica incerta
    const tmDaVenda = temNovo ? (!!v[16] || (v[17] & 1) === 1) : v[11] === 1;
    const lidaTarde = temNovo && v[18] != null && v[18] * 60000 > LIDA_TARDE;
    rows.push({ id: v[0], at: v[1], price: v[3], base, logBase: Math.log(base), addons, mega: a.mega, pve: a.pve, family: a.family,
      familyName: a.familyName, shiny: p.shiny, level: v[6], speciesId: v[2], name: cat.species.get(v[2])?.n || String(v[2]),
      nota: v[5] != null ? Number(v[5]) : null, uncertain: far || (tmDaVenda && lidaTarde), refined: temNovo && (v[17] & 4) === 4,
      aprox: !exatos });
  }
  return { rows, pulou };
}
const media = (a, b) => (a && b ? { price: (a.price + b.price) / 2, far: a.far || b.far } : a || b || null);
// O preço de uma pedra Mega (por unidade) no dia de uma venda: o que se desconta das vendas incertas de Mega
const megaUnitDe = itemPrices => { const q = itemQuotes(itemPrices); return (shiny, at) => q(shiny ? ITEM.MEGA_SHINY : ITEM.MEGA, at) ?? 0; };

// ---------------------------------------------------------------- a curva do mercado e as vendas parecidas

// Regressão isotônica (crescente) por blocos adjacentes
function pav(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x), blocks = [];
  for (const p of sorted) {
    blocks.push({ sum: p.y, n: 1, lo: p.x, hi: p.x });
    while (blocks.length > 1) {
      const b = blocks.at(-1), a = blocks.at(-2);
      if (a.sum / a.n <= b.sum / b.n) break;
      a.sum += b.sum; a.n += b.n; a.hi = b.hi; blocks.pop();
    }
  }
  const curve = blocks.map(b => ({ lo: b.lo, hi: b.hi, y: b.sum / b.n }));
  curve.mids = Float64Array.from(curve, c => (c.lo + c.hi) / 2);
  return curve;
}
// O valor da curva em x: reta entre os meios dos blocos vizinhos (busca binária; o mesmo resultado da busca em ordem)
function at(curve, x) {
  if (!curve.length) return null;
  const mids = curve.mids || Float64Array.from(curve, c => (c.lo + c.hi) / 2), n = curve.length;
  if (x <= mids[0]) return curve[0].y;
  if (x >= mids[n - 1]) return curve[n - 1].y;
  let lo = 1, hi = n - 1; // o primeiro j com x <= mids[j]
  while (lo < hi) { const m = (lo + hi) >> 1; if (x <= mids[m]) hi = m; else lo = m + 1; }
  const a = curve[lo - 1], b = curve[lo], t = (x - mids[lo - 1]) / (mids[lo] - mids[lo - 1]);
  return a.y + t * (b.y - a.y);
}
const nearLevel = (a, b) => Math.abs(Math.log2(a / b)) <= LEVEL_BAND;

function marketLine(points) {
  const n = points.length, m = k => points.reduce((s, p) => s + p[k], 0) / n, mx = m('x'), ml = m('l'), my = m('y');
  let xx = 0, ll = 0, xl = 0, xy = 0, ly = 0;
  for (const p of points) { const dx = p.x - mx, dl = p.l - ml, dy = p.y - my; xx += dx * dx; ll += dl * dl; xl += dx * dl; xy += dx * dy; ly += dl * dy; }
  const det = xx * ll - xl * xl;
  let b = det > 1e-9 ? (xy * ll - ly * xl) / det : 0, c = det > 1e-9 ? (ly * xx - xy * xl) / det : 0;
  if (b < 0) { b = 0; c = ll > 1e-9 ? Math.max(0, ly / ll) : 0; }
  if (c < 0) { c = 0; b = xx > 1e-9 ? Math.max(0, xy / xx) : 0; }
  return (x, l) => my + b * (x - mx) + c * (l - ml);
}
// log(preço sem Adicionais) = a0 + f(log Poder) [reta crescente] + g(Nota) [crescente] + h(log nível) [crescente]
function marketFit(same) {
  const L = same.filter(r => Number.isFinite(r.nota));
  if (L.length < MIN_MARKET) {
    const line = marketLine(same.map(r => ({ x: Math.log(r.pve), l: Math.log(r.level), y: r.logBase })));
    const g = (x, l) => line(x, l);
    g.level = l => line(0, l) - line(0, 0);
    return g;
  }
  const y = L.map(r => r.logBase), X = { pve: L.map(r => Math.log(r.pve)), nota: L.map(r => r.nota), level: L.map(r => Math.log(r.level)) }, n = L.length;
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length, a0 = mean(y), f = { pve: () => 0, nota: () => 0, level: () => 0 };
  const line = (xs, ys) => { const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } const k = sxx > 1e-9 ? Math.max(0, sxy / sxx) : 0; return x => k * (x - mx); };
  const curve = (xs, ys) => { const c = pav(xs.map((x, i) => ({ x, y: ys[i] }))); return x => at(c, x); };
  for (let pass = 0; pass < 6; pass++) for (const k of ['pve', 'nota', 'level']) {
    const others = Object.keys(f).filter(j => j !== k), res = y.map((v, i) => v - a0 - others.reduce((s, j) => s + f[j](X[j][i]), 0));
    const g = (k === 'pve' ? line : curve)(X[k], res), m = mean(X[k].map(g));
    f[k] = x => g(x) - m;
  }
  const notaMean = mean(X.nota);
  const g = (x, l, nota) => a0 + f.pve(x) + f.nota(Number.isFinite(nota) ? nota : notaMean) + f.level(l);
  g.level = l => f.level(l);
  g.nota = v => f.nota(v);
  g.pve = x => f.pve(x);
  g.a0 = a0;
  return g;
}
// Os quantis com peso, de uma vez (uma ordenação só): o 1º ponto em que o peso acumulado chega a q do total
function weightedQuantiles(points, qs) {
  const s = [...points].sort((a, b) => a.v - b.v), total = s.reduce((t, p) => t + p.w, 0), out = qs.map(() => s.at(-1).v);
  let acc = 0, i = 0;
  const ordem = qs.map((q, j) => [q, j]).sort((a, b) => a[0] - b[0]);
  for (const p of s) {
    acc += p.w;
    while (i < ordem.length && acc >= ordem[i][0] * total) { out[ordem[i][1]] = p.v; i++; }
    if (i >= ordem.length) break;
  }
  return out;
}
function confidence(parts, weights = CONFIDENCE.weights) {
  const x = CONFIDENCE.keys.map(k => parts[k]), z = weights[0] + x.reduce((s, v, i) => s + weights[i + 1] * v, 0), chance = 1 / (1 + Math.exp(-z));
  const lowest = CONFIDENCE.keys.map((k, i) => ({ k, loss: weights[i + 1] * (1 - x[i]) })).sort((a, b) => b.loss - a.loss)[0].k;
  return { chance, percent: Math.min(90, Math.max(10, Math.round(chance * 10) * 10)), lowest };
}
function influence(pts, W) {
  const by = new Map();
  for (const p of pts) if (p.layer === 0) by.set(p.r, (by.get(p.r) || 0) + p.w);
  return [...by].map(([r, w]) => ({ r, share: w / W, closeness: w })).sort((a, b) => b.share - a.share).slice(0, 30);
}
// As vendas parecidas, com peso, e os três preços. `same` = as vendas do mesmo tipo (shiny ou não) do alvo.
// `esperado` (opcional): o valor da curva em cada venda, guardado por quem chama muitas vezes com a mesma curva.
function neighbors(target, rows, { addons = 0, typesOf = () => [], megaUnit = () => 0, weights, cfg = NEIGHBORS, bias = cfg.bias ?? 0, fit: given, same: dados, esperado } = {}) {
  if (!target || addons == null) return null;
  const same = dados || rows.filter(r => r.shiny === target.shiny);
  let nNear = 0;
  for (const r of same) if (nearLevel(r.level, target.level)) nNear++;
  if ((nNear >= MIN_MARKET ? nNear : same.length) < 3) return null;
  const fit = given || marketFit(same), mine = typesOf(target.family);
  const curva = esperado || (r => fit(Math.log(r.pve), Math.log(r.level), r.nota));
  const camadaDe = new Map(); // por família: a camada não muda de venda para venda
  const notaW = r => cfg.notaSigma && Number.isFinite(r.nota) && Number.isFinite(target.nota) ? Math.exp(-(((r.nota - target.nota) / cfg.notaSigma) ** 2) / 2) : 1;
  const layerOf = r => {
    if (r.family === target.family) return 0;
    const t = typesOf(r.family);
    if (mine.length && t.length === mine.length && mine.every(x => t.includes(x))) return 1;
    return mine.some(x => t.includes(x)) ? 2 : 3;
  };
  const now = target.at ?? Date.now(), pts = [];
  for (const r of same) {
    let layer = camadaDe.get(r.family);
    if (layer === undefined) { layer = layerOf(r); camadaDe.set(r.family, layer); }
    const w = (r.refined ? cfg.refinedWeight ?? 1 : 1) * cfg.layers[layer] * Math.exp(-((Math.log(r.level / target.level) / cfg.levelSigma) ** 2) / 2)
      * Math.exp(-((Math.log(r.pve / target.pve) / cfg.pveSigma) ** 2) / 2) * notaW(r) * 0.5 ** ((now - r.at) / (cfg.halfLifeDays * DIA));
    if (!(w >= cfg.minWeight)) continue;
    const expected = curva(r), uncertain = r.uncertain === true;
    if (!uncertain) { pts.push({ v: r.logBase - expected, w, layer, uncertain, r }); continue; }
    const plain = Math.max(1, r.price - (r.mega ? POR_ADICIONAL * megaUnit(r.shiny, r.at) : 0));
    const up = cfg.uncertainPlain ?? 0.5;
    pts.push({ v: r.logBase - expected, w: w * (1 - up), layer, uncertain, r }, { v: Math.log(plain) - expected, w: w * up, layer, uncertain, r });
  }
  if (!pts.length) return null;
  const [q25, mid, q75] = weightedQuantiles(pts, [0.25, 0.5, 0.75]), lo = q25 - mid, hi = q75 - mid;
  const center = fit(Math.log(target.pve), Math.log(target.level), target.nota) + mid - bias;
  const price = x => Math.max(1, Math.round(Math.exp(x) + addons)), sum = f => pts.filter(f).reduce((s, p) => s + p.w, 0), W = sum(() => true);
  const close = pts.filter(p => p.layer <= 1), cw = close.reduce((s, p) => s + p.w, 0), neff = cw ? cw ** 2 / close.reduce((s, p) => s + p.w * p.w, 0) : 0;
  const parts = { proximidade: neff / (neff + 5), certeza: sum(p => !p.uncertain) / W, consistencia: Math.exp(-(hi - lo)), ampliacao: sum(p => p.layer === 0) / W };
  let familyCount = 0, uFam = 0, uMkt = 0;
  for (const r of same) { if (r.family === target.family) { familyCount++; if (r.uncertain) uFam++; } if (r.uncertain) uMkt++; }
  return { low: price(center + lo), median: price(center), high: price(center + hi), rawMedian: price(center + bias), base: Math.exp(center), addons,
    weight: parts.ampliacao, familyCount, marketCount: same.length, parts, confidence: confidence(parts, weights), influence: influence(pts, W),
    uncertain: { family: uFam, market: uMkt } };
}

// O nível em que a espécie costuma sair da hunt: o mais vendido dela, se for 30%+ das vendas; senão, pelo passo da cadeia
function dropLevel(cat, rows, speciesId) {
  const id = cat.megaBase.get(speciesId) ?? speciesId, count = new Map();
  for (const r of rows) if (r.speciesId === id) count.set(r.level, (count.get(r.level) || 0) + 1);
  const total = [...count.values()].reduce((a, b) => a + b, 0), [level, n] = [...count].sort((a, b) => b[1] - a[1])[0] || [];
  return n >= 5 && n / total >= 0.3 ? level : cat.nivelDeHunt(id);
}

// ---------------------------------------------------------------- o preço de UM pokémon

// alvo: { speciesId, level, potencia, quality, shiny, ivs {hp…}, tmElemental, tmAoe, nota? (a do jogo, se veio) }
// ctx: { cat, rows, itemPrices, unidades {itemId: preço por unidade escolhido pelo jogador}, agora, pesos, bias, fits }
function precificar(alvo, ctx) {
  const { cat, rows, itemPrices = [], unidades = {}, agora = Date.now() } = ctx;
  const e = cat.species.get(Number(alvo.speciesId));
  if (!e) throw new Error('Espécie desconhecida no catálogo do jogo.');
  if (!STATS.every(k => Number.isInteger(alvo.ivs?.[k]))) throw new Error('Faltam os 6 IVs para calcular o Poder.');
  if (!(alvo.level > 0) || !(alvo.potencia >= 1 && alvo.potencia <= 5) || !(alvo.quality > 0)) throw new Error('Ficha incompleta (nível, potência ou qualidade).');
  const p = { ivs: alvo.ivs, quality: Number(alvo.quality), potencia: Number(alvo.potencia), shiny: !!alvo.shiny };
  const a = cat.avaliar(p, e.id);
  if (!a) throw new Error('Não deu para calcular o Poder desta ficha.');
  const quote = itemQuotes(itemPrices);
  const ads = [];
  if (alvo.tmElemental) ads.push({ id: ITEM.Z, label: 'Z-Move' + (typeof alvo.tmElemental === 'string' ? ' ' + alvo.tmElemental : '') });
  if (alvo.tmAoe) ads.push({ id: ITEM.AOE, label: 'AoE' });
  if (a.mega) ads.push({ id: p.shiny ? ITEM.MEGA_SHINY : ITEM.MEGA, label: p.shiny ? 'Mega Shiny' : 'Mega' });
  const parts = ads.map(x => {
    const escolhido = Number(unidades?.[x.id]), cot = quote(x.id, agora);
    const unit = escolhido > 0 ? escolhido : cot;
    return { ...x, quantity: POR_ADICIONAL, unit: unit ?? null, quote: cot ?? null, total: unit != null ? Math.round(unit * POR_ADICIONAL) : null };
  });
  const known = parts.reduce((s, x) => s + (x.total || 0), 0);
  const nota = Number.isFinite(Number(alvo.nota)) && alvo.nota != null ? Number(alvo.nota) : cat.nota(e.id, p);
  const same = rows.filter(r => r.shiny === p.shiny);
  const fit = ctx.fits?.[p.shiny ? 1 : 0] || marketFit(same);
  const target = { pve: a.pve, family: a.family, familyName: a.familyName, shiny: p.shiny, level: alvo.level, at: agora, nota };
  const megaUnit = (shiny, at) => quote(shiny ? ITEM.MEGA_SHINY : ITEM.MEGA, at) ?? 0;
  const r = neighbors(target, rows, { addons: known, typesOf: cat.tipos, megaUnit, weights: ctx.pesos, fit, same, ...(Number.isFinite(ctx.bias) ? { bias: ctx.bias } : {}) });
  const res = { name: e.n, speciesId: e.id, types: e.t || [], family: a.familyName, familyId: a.family, mega: a.mega, shiny: p.shiny, pve: a.pve, level: alvo.level,
    nota, parts, missing: parts.filter(x => x.total == null).map(x => x.label) };
  if (!r) return { ...res, available: false };
  if (ctx.leve) return { ...res, available: true, low: r.low, median: r.median, high: r.high, confidence: r.confidence };
  const comps = r.influence.map(({ r: x, share, closeness }) => ({ share, closeness: Math.round(closeness * 1000) / 1000, at: x.at, price: x.price, base: Math.round(x.base),
    level: x.level, pve: Math.round(x.pve), nota: x.nota ?? null, speciesId: x.speciesId, name: x.name, shiny: x.shiny, uncertain: x.uncertain === true, aprox: x.aprox === true }));
  // O mesmo pokémon em outros níveis: a curva do nível do mercado, do nível da hunt até o maior vendido
  const drop = dropLevel(cat, rows, e.id), top = same.reduce((m, x) => (x.level > m ? x.level : m), alvo.level), from = Math.min(alvo.level, drop);
  const levels = [...new Set([...LEVEL_STEPS.filter(l => l > from && l <= top), from, alvo.level])].sort((x, y) => x - y), here = fit.level(Math.log(alvo.level));
  const byLevel = levels.map(level => {
    const k = Math.exp(fit.level(Math.log(level)) - here), pr = x => Math.max(1, Math.round(x * k + known));
    return { level, low: pr(r.low - known), median: pr(r.base), high: pr(r.high - known), current: level === alvo.level, drop: level === drop };
  });
  // Os pontos do gráfico: as vendas da cadeia, com o preço sem Adicionais
  const cadeia = same.filter(x => x.family === a.family).sort((x, y) => x.at - y.at).slice(-1500).map(x => ({ at: x.at, base: Math.round(x.base), price: x.price,
    nota: x.nota, pve: Math.round(x.pve), level: x.level, name: x.name, speciesId: x.speciesId, uncertain: x.uncertain, aprox: x.aprox }));
  return { ...res, available: true, low: r.low, median: r.median, high: r.high, base: Math.round(r.base), weight: r.weight, familyCount: r.familyCount,
    marketCount: r.marketCount, uncertain: r.uncertain, confidenceParts: r.parts, confidence: r.confidence, comps, byLevel, dropLevel: drop, cadeia };
}

// ---------------------------------------------------------------- o teste: cada venda precificada só com as anteriores

// Para a correção (o desvio médio das vendas recentes), os pesos da confiança e os números que a tela mostra. A curva
// do mercado é refeita uma vez por dia (com as vendas de antes do dia), como fica pesado refazer a cada venda.
// `amostra`: no máximo tantas vendas (de passo em passo, na ordem do tempo); `ceder`: uma promessa para soltar o app de
// tempos em tempos (a calibração roda no processo principal).
async function backtest(rows, { cat = null, typesOf = cat?.tipos, megaUnit = () => 0, desde = -Infinity, ate = Infinity, bias = 0, pesos, janelaDias = JANELA_DIAS,
  amostra = Infinity, ceder = null, progresso } = {}) {
  const porTipo = [false, true].map(sh => rows.filter(r => r.shiny === sh).sort((a, b) => a.at - b.at));
  const primeiro = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].at < t) lo = m + 1; else hi = m; } return lo; };
  const out = [], fits = new Map();
  let alvos = rows.filter(s => s.at >= desde && s.at < ate).sort((a, b) => a.at - b.at);
  if (alvos.length > amostra) { const passo = alvos.length / amostra; alvos = Array.from({ length: amostra }, (_, i) => alvos[Math.floor(i * passo)]); }
  let pausa = Date.now(), feitas = 0;
  for (const s of alvos) {
    feitas++;
    if (ceder && Date.now() - pausa > 15) { await ceder(); pausa = Date.now(); }
    if (progresso && feitas % 250 === 0) progresso(feitas, alvos.length);
    const arr = porTipo[s.shiny ? 1 : 0], ini = primeiro(arr, s.at - janelaDias * DIA), fim = primeiro(arr, s.at);
    const dia = diaDe(s.at), chave = dia + '|' + (s.shiny ? 1 : 0);
    if (!fits.has(chave)) {
      const antes = arr.slice(ini, primeiro(arr, Date.parse(dia + 'T00:00:00-03:00')));
      const fit = antes.length >= 3 ? marketFit(antes) : null;
      const cache = new Map();
      fits.set(chave, fit && { fit, esperado: r => { let v = cache.get(r); if (v === undefined) { v = fit(Math.log(r.pve), Math.log(r.level), r.nota); cache.set(r, v); } return v; } });
    }
    const f = fits.get(chave);
    if (!f) continue;
    const r = neighbors({ ...s, at: s.at }, null, { addons: s.addons, typesOf, megaUnit, weights: pesos, bias, fit: f.fit, esperado: f.esperado, same: arr.slice(ini, fim) });
    if (!r) continue;
    out.push({ at: s.at, price: s.price, low: r.low, median: r.median, high: r.high, raw: r.rawMedian, parts: r.parts, chance: r.confidence.chance });
  }
  return out;
}
const mediana = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };
// Onde o preço pago caiu. O viés é pela MEDIANA: umas poucas vendas saem por 10 ou 100 vezes o preço de vendas iguais
// (no teste de 06/11/2026, 1 em cada 10 saiu por 12 vezes ou mais), e a média seguiria só elas.
function resumo(teste) {
  const n = teste.length;
  if (!n) return null;
  let dentro = 0, abaixo = 0, acima = 0, ate25 = 0;
  const erros = [], logs = [];
  for (const t of teste) {
    if (t.price < t.low) abaixo++; else if (t.price > t.high) acima++; else dentro++;
    const razao = t.price / t.median;
    if (Math.abs(razao - 1) <= 0.25) ate25++;
    erros.push(Math.max(razao, 1 / razao));
    logs.push(Math.log(t.median / t.price));
  }
  return { vendas: n, dentroDaFaixa: dentro / n, abaixo: abaixo / n, acima: acima / n, ate25: ate25 / n, erroMediano: Math.round(mediana(erros) * 10) / 10,
    vies: Math.exp(mediana(logs)) - 1 };
}
// Regressão logística simples (gradiente, com um pouco de regularização): acerto a até 25% ~ as quatro notas
function ajustarPesos(teste, inicio = CONFIDENCE.weights) {
  const X = teste.map(t => CONFIDENCE.keys.map(k => t.parts[k])), y = teste.map(t => (Math.abs(t.price / t.median - 1) <= 0.25 ? 1 : 0));
  if (X.length < 200) return null;
  let w = [...inicio];
  const lr = 0.5, l2 = 1e-3;
  for (let it = 0; it < 2000; it++) {
    const g = Array(w.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const z = w[0] + X[i].reduce((s, v, j) => s + w[j + 1] * v, 0), p = 1 / (1 + Math.exp(-z)), d = p - y[i];
      g[0] += d;
      for (let j = 0; j < 4; j++) g[j + 1] += d * X[i][j];
    }
    for (let j = 0; j < w.length; j++) w[j] -= lr * (g[j] / X.length + (j ? l2 * w[j] : 0));
  }
  return w.map(v => Math.round(v * 1000) / 1000);
}
// A calibração inteira: desvio dos últimos `dias`, pesos da confiança e a conferência nos 2 últimos dias
async function calibrar(rows, { cat, megaUnit, agora = Date.now(), dias = 7, conferirDias = 2, amostra = 4000, ceder, progresso } = {}) {
  const desde = agora - dias * DIA;
  const cru = await backtest(rows, { cat, megaUnit, desde, bias: 0, amostra, ceder, progresso });
  if (cru.length < 200) return { vendas: cru.length, pronto: false };
  // A correção é a MEDIANA de log(previsto / pago): é o que reproduz a do precificador (0,0953 nas vendas dele de
  // 06/11/2026, com a mesma conta); a média caía para −0,32, puxada pelas vendas muito acima do preço de iguais.
  const bias = mediana(cru.map(t => Math.log(t.raw / t.price)));
  // Com a correção: os mesmos números deslocados (a correção só move o centro)
  const k = Math.exp(-bias);
  const teste = cru.map(t => ({ ...t, low: Math.max(1, t.low * k), median: Math.max(1, t.raw * k), high: Math.max(1, t.high * k) }));
  const pesos = ajustarPesos(teste);
  // Conferência: pesos aprendidos SEM os últimos dias, comparados com o que aconteceu neles
  const corte = agora - conferirDias * DIA;
  const pesosAntes = ajustarPesos(teste.filter(t => t.at < corte));
  const faixas = [];
  if (pesosAntes) {
    const por = new Map();
    for (const t of teste.filter(x => x.at >= corte)) {
      const c = confidence(t.parts, pesosAntes).percent;
      if (!por.has(c)) por.set(c, { confianca: c, vendas: 0, certas: 0 });
      const f = por.get(c);
      f.vendas++;
      if (Math.abs(t.price / t.median - 1) <= 0.25) f.certas++;
    }
    for (const f of [...por.values()].sort((a, b) => a.confianca - b.confianca)) faixas.push({ confianca: f.confianca, vendas: f.vendas, acerto: f.certas / f.vendas });
  }
  return { pronto: true, em: agora, dias, vendas: teste.length, bias, pesos: pesos || CONFIDENCE.weights, teste: resumo(teste), conferencia: { dias: conferirDias, faixas } };
}

module.exports = { catalogo, cotacoesDosRegistros, itemQuotes, megaUnitDe, linhas, marketFit, neighbors, precificar, backtest, resumo, ajustarPesos, calibrar,
  confidence, ivsDeTexto, ivsParaTexto, ivsDaSoma, diaDe, ITEM, POR_ADICIONAL, NEIGHBORS, CONFIDENCE, STATS };

/*
Partes deste arquivo vêm do Precificador de Pokémon (github.com/briaoAle/precificador-pokemon):

MIT License

Copyright (c) 2026 briaoAle

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
