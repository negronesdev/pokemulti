// NÃO é carregado como script do app: o main.js lê este texto e o roda (executeJavaScript) numa janela escondida
// aberta no robots.txt do pokeidle.io, como o dados-jogo.js — mesma origem dos arquivos do jogo, sem jogo e sem login.
//
// ✨ Retratos de SHINY (13/11/2026): o jogo desenha o shiny com outro looktype. Qual é o de cada espécie vem do
// servidor, na entrada (`shinyLooks` por número da dex e `shinyLooksOutland` por id), e o main.js o lê da página
// de uma conta (window.__pkmShinyLooks, guardado pela escuta). Aqui, a mesma conta do jogo (`looktypeDe` no app.js)
// acha o looktype, e o desenho sai do atlas de marcadores ou, se não estiver lá, da folha de sprites dele
// (`carregarOutfit` do próprio jogo, o 1º quadro de frente) — o mesmo `retratoDeLooktype` do jogo.
// Entrada: window.__pkmShiny = { SL, ids, ja } (ja = looktypes que o app já guardou). Saída: { looks, img }.
(async () => {
  const { SL, ids, ja } = window.__pkmShiny;
  const [spr, outland, megas, formas] = await Promise.all([
    import('/sprites.mjs'), import('/shared/outland.mjs'), import('/shared/megas.mjs'), import('/shared/formas.mjs'),
  ]);
  const dexDo = (id) => (id <= 1025 || megas.isMegaPokeId(id) || formas.isFormaPokeId(id) ? id : id % 1000);
  const lookDe = (id) => (outland.isOutlandPokeId(id)
    ? SL.outland?.[id] ?? null
    : SL.looks?.[dexDo(id)] ?? SL.looks?.[id] ?? null);
  const atlas = await fetch('/assets/site/assets/maps/marker-atlas.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  let atlasImg = null;
  const carregar = (src) => new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => err(new Error(src)); i.src = src; });
  const TAM = 48;
  // Recorta a parte visível do quadro e a encaixa numa casa de 48 px, sem borrar (pixel art)
  const recortar = (fonte, sx, sy, sw, sh) => {
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(fonte, sx, sy, sw, sh, 0, 0, sw, sh);
    const px = x.getImageData(0, 0, sw, sh).data;
    let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
    for (let y = 0; y < sh; y++) for (let k = 0; k < sw; k++) {
      if (px[(y * sw + k) * 4 + 3] > 8) { if (k < x0) x0 = k; if (k > x1) x1 = k; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return '';
    const w = x1 - x0 + 1, h = y1 - y0 + 1, s = Math.min(TAM / w, TAM / h);
    const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
    const o = document.createElement('canvas');
    o.width = o.height = TAM;
    const ox = o.getContext('2d');
    ox.imageSmoothingEnabled = s < 1;
    ox.drawImage(c, x0, y0, w, h, (TAM - dw) >> 1, (TAM - dh) >> 1, dw, dh);
    return o.toDataURL('image/png');
  };
  const looks = {}, img = {}, tem = new Set((ja || []).map(String));
  for (const id of ids) {
    const lk = Number(lookDe(Number(id))) || 0;
    looks[id] = lk;
    if (!lk || tem.has(String(lk))) continue;
    tem.add(String(lk));
    try {
      if (atlas?.slots?.[lk]) {
        atlasImg ??= await carregar(atlas.image || '/assets/site/assets/maps/marker-atlas.png');
        const [cx, cy] = atlas.slots[lk], cel = atlas.cell ?? 64;
        img[lk] = recortar(atlasImg, cx * cel, cy * cel, cel, cel);
      } else {
        const s = await spr.carregarOutfit(lk);
        const q = s && spr.quadrosDe(s, 3)[0];
        img[lk] = q ? recortar(s.imagens[q.pagina], q.x, q.y, q.w, q.h) : '';
      }
    } catch { img[lk] = ''; }
    await new Promise((r) => setTimeout(r, 150)); // um retrato de cada vez, sem pressa: é para guardar
  }
  return { looks, img };
})()
