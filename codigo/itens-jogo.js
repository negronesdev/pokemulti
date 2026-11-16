// NÃO é carregado como script do app: o main.js lê este texto e o roda (executeJavaScript) na página do jogo da
// Conta 1, a cada verificação do Monitor de Preços, com os ids dos itens do RMT e os ícones que já tem guardados.
//
// Dá, para cada item, o NOME como a tela do jogo mostra e o ÍCONE que o jogo usa, pelas mesmas regras do cliente
// (`nomeItem` e `iconeItem` no app.js, lidos em 14/11/2026):
//   - nome: 59194 é o "Fragmento de Z-Move" (no items.json ele ainda é "TM Disk Piece"); "<Tipo>-Type TM Disk" é
//     "Z-Move <TIPO>"; os itens de 70000 para cima (casas, bicicletas, fragmentos, tickets) saem do dicionário do
//     jogo (/i18n.mjs), no idioma em que o jogo está; os outros ficam com o nome do items.json;
//   - ícone: os fixos e os de Z-Move primeiro, depois o que vem na entrada (`itensNossos`), depois o do items.json;
//     casas, bicicletas e tickets têm um caminho de reserva.
// O ícone volta já desenhado num quadrado de 40 px (aparado na parte visível), como texto de imagem.
(async (ids, tem) => {
  const json = u => fetch(u).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!window.__pkmItensCat) {
    const j = await json('/assets/items.json'), m = {};
    for (const it of (j?.items || j || [])) m[it.id] = { n: it.name, i: it.icon };
    if (Object.keys(m).length) window.__pkmItensCat = m;
  }
  const cat = window.__pkmItensCat || {}, nossos = window.__pkmItensIco || {}, catalogo = window.__pkmCatalogo || {};
  let i18n = null;
  try { i18n = await import('/i18n.mjs'); } catch {}
  const chaves = new Map();
  for (const [k, v] of Object.entries(i18n?._dicionarios?.en || {})) {
    if ((k.startsWith('item.') || k.startsWith('caixas.nome.')) && typeof v === 'string' && !chaves.has(v.toLowerCase())) chaves.set(v.toLowerCase(), k);
  }
  const t = (k, p) => { try { const r = i18n?.t(k, p); return r && r !== k ? r : null; } catch { return null; } };
  const titulo = n => (!n || n !== n.toLowerCase() ? n : n.replace(/(?:^|[\s-])\w/g, c => c.toUpperCase()));
  const ingles = id => nossos[id]?.n || cat[id]?.n || catalogo[id] || '';
  const disco = id => /^([A-Za-z]+)-Type TM Disk$/.exec(ingles(id));
  const nome = id => {
    const en = ingles(id);
    if (id === 59194) return t('item.fragmentoZMove') || en;
    const z = disco(id);
    if (z) return t('item.zmove', { tipo: z[1].toUpperCase() }) || en;
    if (id >= 70000) { const k = chaves.get(en.toLowerCase()), tr = k && t(k); if (tr) return tr; }
    return titulo(en);
  };

  const rel = ic => (!ic ? null : ic.startsWith('site/') ? ic : ic.startsWith('/') ? 'site' + ic : 'site/assets/items/' + ic);
  const FIXOS = { 30: 'site/assets/items/dark_gem.png', 63: 'site/assets/items/goggles.png', 47: 'site/assets/items/farfetchd_stick.png',
    5041: 'site/assets/items/farfetchd_stick.png', 70070: '/img/itens/golden-potion.png',
    59194: '/img/itens/zmove/fragmento.png', 40530: '/img/itens/zmove/aoe-peca.png', 40575: '/img/itens/zmove/aoe-disco.png' };
  const RAR = ['comum', 'incomum', 'rara', 'mitica', 'lendaria'];
  const RESERVA = { 70011: "/img/itens/fragmento-chave.png", 70013: "/img/itens/fragmento-bicicleta.png", 70014: "/img/itens/fragmento-mega.png", 70090: '/img/itens/mystic-ticket.png', 70095: '/img/itens/safari-ticket.png', 70015: '/img/itens/fragmento-mega-shiny.png', 70017: '/img/itens/fragmento-ovo-shiny.png' };
  const reserva = id => (id >= 70040 && id <= 70044 ? `/img/itens/casa-${RAR[id - 70040]}.png` : id >= 70080 && id <= 70084 ? `/img/itens/bicicleta-${RAR[id - 70080]}.png` : RESERVA[id] || null);
  const caminhos = id => {
    const z = disco(id), n = nossos[id]?.i;
    const lista = [FIXOS[id], z ? `/img/itens/zmove/${z[1].toLowerCase()}.png` : null, n ? (n.startsWith('/') ? n : rel(n)) : null, rel(cat[id]?.i), reserva(id)];
    return [...new Set(lista.filter(Boolean).map(r => (r.startsWith('/') ? r : '/assets/' + r)))];
  };

  const L = 40;
  const desenhar = async url => {
    const r = await fetch(url);
    if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) return null;
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    const px = cx.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (px[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, s = Math.min(L / w, L / h);
    const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
    const o = document.createElement('canvas');
    o.width = o.height = L;
    const ox = o.getContext('2d');
    ox.imageSmoothingEnabled = s < 1; ox.imageSmoothingQuality = 'high';
    ox.drawImage(c, x0, y0, w, h, Math.floor((L - dw) / 2), Math.floor((L - dh) / 2), dw, dh);
    return o.toDataURL('image/png');
  };

  const rotulos = {}, icones = {};
  for (const id of ids) {
    const n = nome(id);
    if (n) rotulos[id] = n;
    const urls = caminhos(id);
    if (!urls.length || urls.includes(tem[id])) continue; // já tem o desenho de um dos caminhos deste item
    for (const u of urls) {
      let d = null;
      try { d = await desenhar(u); } catch {}
      if (d) { icones[id] = { u, d }; break; }
    }
    if (!icones[id] && !tem[id]) icones[id] = { u: urls[0], d: null }; // não achou: não tenta de novo a cada verificação
  }
  return { rotulos, icones, idioma: i18n ? 'ok' : 'sem dicionário', nossos: Object.keys(nossos).length };
})
