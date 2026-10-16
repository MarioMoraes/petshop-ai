// KIT · motor do carrossel (estático e vivo). Tudo é determinístico: nenhum Math.random, nenhum relógio.
// Nasceu do projeto "layouts de capa" (out/2026) e do motor do Orbit v2. Expõe window.KIT (apelido window.K).
(function () {
  const K = (window.KIT = window.K = {});
  const W = 1080, H = 1350, FPS = 30, BEAT = 0.5;
  Object.assign(K, { W, H, FPS, BEAT });

  // ---------- marca (o slide pode sobrescrever com K.marca({...}) antes de montar) ----------
  K.MARCA = { handle: '@handle', rodapeDir: 'criador · fala ia', cabEsq: 'OUT ©2026', cabMeio: 'NOME', cabDir: 'TÍTULO' };
  K.marca = (o) => Object.assign(K.MARCA, o || {});
  // cores lidas dos tokens do kit.css (o MARCA.md muda o CSS, o JS acompanha)
  K.cor = (nome) => getComputedStyle(document.documentElement).getPropertyValue('--' + nome).trim();
  Object.defineProperty(K, 'CORES', { get: () => ({ PAPEL: K.cor('papel'), MARINHO: K.cor('marinho'), TINTA: K.cor('tinta'), LARANJA: K.cor('laranja'), CREME: K.cor('creme') }) });

  // ---------- ruído com semente (mulberry32) ----------
  K.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // ---------- linho: trama de fios horizontais e verticais (papel claro ou marinho) ----------
  // base: cor de fundo; fio: "r,g,b" do fio; forca: 0.02 (marinho) a 0.05 (papel); seed: inteiro
  K.linho = function (host, base, fio, forca, seed) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H; c.className = 'linho';
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, W, H);
    const r = K.rng(seed);
    for (let y = 0; y < H; y++) { g.fillStyle = `rgba(${fio},${((r() * 0.9 + 0.1) * forca * (r() < 0.06 ? 2.2 : 1)).toFixed(4)})`; g.fillRect(0, y, W, 1); }
    for (let x = 0; x < W; x++) { g.fillStyle = `rgba(${fio},${((r() * 0.9 + 0.1) * forca * 0.8 * (r() < 0.05 ? 2.2 : 1)).toFixed(4)})`; g.fillRect(x, 0, 1, H); }
    for (let i = 0; i < 2600; i++) {
      const x = r() * W, y = r() * H, w = 3 + r() * 14;
      g.fillStyle = `rgba(${fio},${(forca * 1.6 * r()).toFixed(4)})`;
      if (r() < 0.5) g.fillRect(x, Math.round(y), w, 1); else g.fillRect(Math.round(x), y, 1, w);
    }
    host.prepend(c);
    return c;
  };
  // atalhos: o fundo do padrão-base
  K.fundoPapel = (q, seed = 3) => { q.classList.add('papel'); return K.linho(q, K.cor('papel'), '120,104,82', 0.05, seed); };
  K.fundoMarinho = (q, seed = 7) => { q.classList.add('marinho'); return K.linho(q, K.cor('marinho'), '255,244,232', 0.022, seed); };
  // fundo liso (sem linho), pra referência que é chapada: nome do token ('papel'|'marinho') ou uma cor
  K.fundoLiso = (q, nome = 'papel') => { q.classList.add(nome === 'marinho' ? 'marinho' : 'papel'); q.style.background = K.cor(nome) || nome; return null; };
  // grão fino monocromático por cima do fundo (forca 0.03 a 0.10), com semente: pra referência com grão em vez de linho
  K.grao = function (host, forca = 0.06, seed = 5) {
    const c = document.createElement('canvas'); c.width = W; c.height = H; c.className = 'linho';
    const g = c.getContext('2d'); const img = g.createImageData(W, H); const d = img.data; const r = K.rng(seed);
    for (let i = 0; i < d.length; i += 4) { const v = r() < 0.5 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = Math.round(255 * forca * r()); }
    g.putImageData(img, 0, 0); host.appendChild(c); return c;
  };

  // ---------- elementos ----------
  K.el = function (parent, tag, cls, text, style) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (style) Object.assign(e.style, style);
    parent.appendChild(e);
    return e;
  };
  K.html = (parent, tag, cls, html, style) => { const e = K.el(parent, tag, cls, null, style); e.innerHTML = html; return e; };
  K.css = (e, o) => { Object.assign(e.style, o); return e; };
  K.show = (e, v) => { e.style.visibility = v ? 'visible' : 'hidden'; };
  // transform completo (posição, rotação, escala separada pra estica/achata)
  K.T = function (e, { x = 0, y = 0, r = 0, s = 1, sx = 1, sy = 1, ox, oy, z } = {}) {
    e.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) rotate(${r.toFixed(3)}deg) scale(${(s * sx).toFixed(4)},${(s * sy).toFixed(4)})`;
    if (ox !== undefined) e.style.transformOrigin = `${ox}px ${oy}px`;
    if (z !== undefined) e.style.zIndex = z;
  };

  // ---------- texto: posicionar pela linha de base, medir, caber ----------
  K.base = function (e) {
    let m = e.querySelector(':scope > i.__b');
    if (!m) { m = document.createElement('i'); m.className = '__b'; m.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;'; e.appendChild(m); }
    return m.offsetTop;
  };
  // o: { x | cx | rx, base, fs, color } → posiciona um bloco de uma linha pela linha de base
  K.place = function (e, o) {
    if (o.fs != null) e.style.fontSize = o.fs + 'px';
    if (o.color) e.style.color = o.color;
    const w = e.offsetWidth;
    let x = o.x;
    if (o.cx != null) x = o.cx - w / 2;
    if (o.rx != null) x = o.rx - w;
    e.style.left = x.toFixed(2) + 'px';
    e.style.top = '0px';
    const b = K.base(e);
    e.style.top = (o.base - b).toFixed(2) + 'px';
    return { x, w, top: o.base - b };
  };
  K.largura = (e, fs) => { if (fs != null) e.style.fontSize = fs + 'px'; return e.offsetWidth; };
  // encolhe a fonte até o texto caber em maxW (a palavra gigante nunca passa da margem)
  K.fit = function (e, maxW = W - 144, minPx = 40) {
    let px = parseFloat(getComputedStyle(e).fontSize);
    const prev = e.style.whiteSpace; e.style.whiteSpace = 'nowrap';
    while (px > minPx && e.offsetWidth > maxW) { px -= 1; e.style.fontSize = px + 'px'; }
    e.style.whiteSpace = prev || '';
    return px;
  };

  // ---------- anatomia fixa ----------
  K.rodape = function (q, cor, esq, dir) {
    const a = K.el(q, 'div', 'rodape', esq || K.MARCA.handle);
    const b = K.el(q, 'div', 'rodape', dir || K.MARCA.rodapeDir);
    K.place(a, { x: 72, base: 1278, color: cor });
    K.place(b, { x: 676, base: 1278, color: cor }); // alinhado com a coluna da direita, longe do ícone de som
    return [a, b];
  };
  K.cabecalho = function (q, cor, esq, meio, dir) {
    const c = K.el(q, 'div', 'cabecalho', null, { color: cor || '' });
    K.el(c, 'span', null, esq || K.MARCA.cabEsq);
    K.el(c, 'span', 'meio', meio || K.MARCA.cabMeio);
    K.el(c, 'span', null, dir || K.MARCA.cabDir);
    return c;
  };

  // ---------- pronto pra fotografar ----------
  // Espera fontes e imagens; chama fn (que monta o slide e define window.seek); sinaliza pro render.
  // as famílias vêm dos tokens --alta/--quieta/--mono (kit.css, sobrescritos em marca.css)
  K.fontes = function () {
    const a = K.cor('alta') || "'Geist'", q = K.cor('quieta') || "'DM Serif'", m = K.cor('mono') || "'Geist Mono'";
    return [`800 100px ${a}`, `900 100px ${a}`, `700 100px ${a}`, `500 100px ${a}`, `italic 100px ${q}`, `100px ${q}`, `700 100px ${q}`, `500 20px ${m}`];
  };
  K.pronto = async function (fn, fontes) {
    for (const f of fontes || K.fontes()) { try { await document.fonts.load(f); } catch (e) {} }
    await document.fonts.ready;
    if (fn) await fn();
    await Promise.all([...document.images].map((i) => (i.complete ? i.decode().catch(() => {}) : new Promise((r) => { i.onload = () => i.decode().then(r, r); i.onerror = r; }))));
    if (!window.seek) window.seek = () => true;
    if (!window.__slide) K.slide({});
    window.seek(0);
    window.__pronto = window.__ready = true;
    if (location.search.includes('play')) { const t0 = performance.now(); const loop = () => { window.seek((performance.now() - t0) / 1000); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
    const m = location.search.match(/[?&]t=([\d.]+)/); if (m) window.seek(parseFloat(m[1]));
  };
  // registra o slide: duração em s (4, 6 ou 8) e os acertos sonoros (pro beats.json): [{t, tipo:'impacto|tchac|whoosh|clique|tecla|pop|land', o_que}]
  K.slide = function ({ index = 1, duration = 6, cues = [] } = {}) {
    window.__slide = { index, duration, bars: duration / 2, cues };
    const base = window.seek || (() => true);
    window.seek = (t) => { t = ((t % duration) + duration) % duration; return base(t); };
  };
})();
