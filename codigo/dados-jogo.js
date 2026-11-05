// NÃO é carregado como script do app: o main.js lê este texto e o roda (executeJavaScript) numa janela
// escondida aberta no robots.txt do pokeidle.io — mesma origem dos arquivos do jogo, sem jogo, sem login
// e sem socket.
//
// Monta o catálogo de espécies com as MESMAS funções e na MESMA ordem do cliente do jogo
// (`carregarCatalogoEspecies` no app.js): o espelho, as espécies novas, Outland e formas, a auditoria,
// as planilhas de golpes, as heranças de Orre/Outland, os golpes de 600 e as megas. Só a parte que mexe
// em golpes, tipos, stats-base e looktype — loot, preço e nota ficam de fora.
//
// E recorta os retratos do atlas de marcadores do mapa (indexado por LOOKTYPE, não por pokeId) numa
// folha de 32 px, cada um aparado na parte visível — o "encaixar" dos retratos do jogo.
//
// Para a Pokédex de consulta (pokedex.html), versão 2: os mesmos retratos em TAMANHO REAL (é a arte que o
// Mini Games mostra; aqui encolhida para 30 px ela perde o contorno), cada um no canto de uma casa de 66 px,
// com a largura e a altura; e por espécie, para quem ela evolui (`destinosDeEvolucao`, as ramificadas
// juntas) e se ela tem Mega (`megasDaEspecie`) — as mesmas funções que dão as pistas do Mini Games.
(async () => {
  const imp = (m) => import(`/shared/${m}.mjs`);
  const [outland, cruz, ramif, teto, megas, planilhas, especiais, orre, baseOut, ajustes, lookOrre, lookOut, mistico] = await Promise.all([
    imp('outland'), imp('evolucoes-cruzadas'), imp('evolucoes-ramificadas'), imp('teto-captura'), imp('megas'),
    imp('golpes-planilhas'), imp('golpes-especiais'), imp('herdar-golpes-orre'), imp('herdar-base-outland'),
    imp('ajustes-especie-espelho'), imp('herdar-looktype-orre'), imp('herdar-looktype-outland'), imp('mistico'),
  ]);
  const json = (u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const cr = await json('/assets/creatures.json');
  if (!cr?.creatures?.length) throw new Error('o catálogo do jogo não carregou');
  const lista = [...cr.creatures];
  for (const f of ['creatures-novos', 'creatures-outland-novos', 'creatures-formas']) {
    const x = await json(`/assets/${f}.json`);
    if (x?.creatures?.length) lista.push(...x.creatures);
  }
  outland.aplicarRemapOutlandLista(lista);
  const lab = await json('/assets/creatures-sprites-lab.json');
  for (const p of lab?.patches ?? []) {
    const c = lista.find((x) => x.pokeId === p.pokeId);
    if (c && p.looktype) c.looktype = p.looktype;
  }
  const ovr = await json('/assets/creatures-audit-overrides.json');
  for (const o of ovr?.overrides ?? []) {
    const c = lista.find((x) => x.pokeId === o.pokeId);
    if (!c) continue;
    for (const k of ['baseHp', 'baseAtk', 'baseDef', 'baseSpAtk', 'baseSpDef', 'baseSpeed']) if (typeof o[k] === 'number') c[k] = o[k];
    if (Array.isArray(o.attacks)) c.attacks = o.attacks.map((a) => ({ ...a }));
  }
  planilhas.aplicarGolpesDasPlanilhas((id) => lista.filter((c) => c.pokeId === id));
  lookOrre.herdarLooktypeOrre(lista);
  lookOut.herdarLooktypeOutland(lista);
  baseOut.herdarBaseOutland(lista);
  cruz.aplicarCadeiasTruncadas(lista);
  cruz.normalizarEvolveLevel600(lista);
  ajustes.aplicarAjustesHuntLevel((id) => lista.find((c) => c.pokeId === id));
  const porId = new Map();
  for (const c of lista) {
    if (outland.isEspelhoFantasmaPokeId(c.pokeId)) continue;
    especiais.injetarGolpesEspeciais(c);
    if (outland.isOutlandPokeId(c.pokeId)) { c.evolvesToId = 0; c.evolveLevel = 0; }
    porId.set(c.pokeId, c);
  }
  orre.herdarGolpesOrre(lista);
  cruz.aplicarEvolucoesEntreGeracoes(lista);
  ramif.alinharNivelPadraoRamificado(lista);
  cruz.corrigirNiveisDeEvolucao(lista);
  teto.aplicarTetoDeCaptura(lista, (id) => porId.get(id));
  for (const esp of megas.criarEspeciesMega(lista)) porId.set(esp.pokeId, esp);

  // ---- Retratos
  const atlas = await json('/assets/site/assets/maps/marker-atlas.json');
  const img = new Image();
  img.src = atlas?.image || '/assets/site/assets/maps/marker-atlas.png';
  await img.decode();
  const CEL = 32, LADO = 30, origem = atlas?.cell ?? 64, cols = 40;
  // A mega sem retrato próprio usa o da espécie base (o nome sem "Mega " e sem o " X"/" Y")
  const porNome = new Map([...porId.values()].map((c) => [c.name, c]));
  const lookDe = (c) => {
    if (atlas?.slots?.[c.looktype]) return c.looktype;
    const base = porNome.get(String(c.name).replace(/^Mega /, '').replace(/ [XY]$/, ''));
    return base && atlas?.slots?.[base.looktype] ? base.looktype : null;
  };
  const looks = [...new Set([...porId.values()].map(lookDe).filter((l) => l != null))];
  const tela = document.createElement('canvas');
  tela.width = cols * CEL; tela.height = Math.max(1, Math.ceil(looks.length / cols)) * CEL;
  const ctx = tela.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const cel = document.createElement('canvas');
  cel.width = cel.height = origem;
  const cctx = cel.getContext('2d', { willReadFrequently: true });
  // A folha em tamanho real, na mesma ordem: casas de 64 px + 1 px de folga em volta, para a escala quebrada
  // da Pokédex não puxar uma fileira de pixels do vizinho
  const real = document.createElement('canvas'), CR = origem + 2;
  real.width = cols * CR; real.height = Math.max(1, Math.ceil(looks.length / cols)) * CR;
  const rctx = real.getContext('2d');
  rctx.imageSmoothingEnabled = false;
  const tam = [];
  const posDoLook = new Map();
  looks.forEach((lk, n) => {
    const [cx, cy] = atlas.slots[lk];
    cctx.clearRect(0, 0, origem, origem);
    cctx.drawImage(img, cx * origem, cy * origem, origem, origem, 0, 0, origem, origem);
    const px = cctx.getImageData(0, 0, origem, origem).data;
    let x0 = origem, y0 = origem, x1 = -1, y1 = -1;
    for (let y = 0; y < origem; y++) for (let x = 0; x < origem; x++) {
      if (px[(y * origem + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = origem - 1; y1 = origem - 1; }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, s = Math.min(LADO / w, LADO / h, 1);
    const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
    const ox = (n % cols) * CEL + Math.floor((CEL - dw) / 2), oy = Math.floor(n / cols) * CEL + Math.floor((CEL - dh) / 2);
    ctx.imageSmoothingEnabled = s < 1;
    ctx.drawImage(cel, x0, y0, w, h, ox, oy, dw, dh);
    rctx.drawImage(cel, x0, y0, w, h, (n % cols) * CR + 1, Math.floor(n / cols) * CR + 1, w, h);
    tam.push([w, h]);
    posDoLook.set(lk, n);
  });

  const CAT = { PHYSICAL: 0, SPECIAL: 1 };
  const especies = {};
  for (const c of porId.values()) {
    const lk = lookDe(c);
    const evolui = ramif.destinosDeEvolucao(c, (id) => porId.get(id)).map((d) => d.pokeId);
    especies[c.pokeId] = {
      n: c.name,
      t: [c.type1, c.type2].filter(Boolean),
      b: [c.baseHp, c.baseAtk, c.baseDef, c.baseSpAtk, c.baseSpDef, c.baseSpeed].map((v) => Number(v) || 0),
      g: (c.attacks ?? []).map((a) => [a.name, CAT[a.category] ?? 2, Number(a.power) || 0, Number(a.cooldownMs) || 0, Number(a.learnLevel) || 1, a.type || '']),
      ...(mistico.ehLendarioOuMitico(c.pokeId) ? { l: 1 } : {}),
      ...(megas.megasDaEspecie(c.pokeId).length ? { m: 1 } : {}),
      ...(evolui.length ? { e: evolui } : {}),
      ...(lk != null ? { i: posDoLook.get(lk) } : {}),
    };
  }
  return {
    v: 2, em: Date.now(), atlas: atlas?.version ?? '', especies,
    icones: { png: tela.toDataURL('image/png'), cel: CEL, cols, n: looks.length },
    sprites: { png: real.toDataURL('image/png'), cel: CR, borda: 1, cols, tam },
  };
})()
