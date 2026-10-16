// DISPOSITIVO "a mesma capa": a mesma foto num cartão 560x700, o texto disposto em cada um dos 8 layouts.
// Serve pro post "a mesma capa, oito layouts" e pra qualquer prova em que UMA variável muda (onde o texto senta).
// Uso: K.mesmaCapa(host, 'pilha', { textos:{k,c,l,s}, foto:'...', recorte:'...' })  →  peças pra animar (K.preparaCartao em anim.js)
(function () {
  const K = window.KIT;
  const A = K.A;
  K.TEXTOS_MC = { k: 'a mesma capa, oito vezes', c: 'CAPA', l: 'layouts', s: 'onde o texto senta' };

  // Cada layout devolve o estado de repouso de cada peça, em coordenadas do cartão (560x700). m(peça, fs) mede a largura.
  K.LAYOUTS = {
    erro(m) { return { foto: { dy: 0 }, k: { cx: 280, base: 282, fs: 18 }, c: { cx: 280, base: 400, fs: 150 }, l: { cx: 280, base: 470, fs: 76 }, s: { cx: 280, base: 506, fs: 17 } }; }, // o erro de sempre: tudo centrado em cima da pessoa
    pilha(m) { return { foto: { dy: 0 }, k: { x: 36, base: 482, fs: 17 }, c: { x: 31, base: 584, fs: 120 }, l: { x: 36, base: 642, fs: 66 }, s: { x: 38, base: 672, fs: 17 } }; },
    faixa(m) { const wc = m('c', 92), wl = m('l', 68), gap = 14, x0 = 280 - (wc + gap + wl) / 2, T = K.cor('tinta'); return { foto: { dy: 0 }, bloco: { y: 476, h: 150 }, k: { cx: 280, base: 507, fs: 16, color: T }, c: { x: x0, base: 584, fs: 92 }, l: { x: x0 + wc + gap, base: 584, fs: 68, color: T }, s: { cx: 280, base: 610, fs: 16, color: T } }; },
    metade(m) { const T = K.cor('tinta'); return { foto: { dy: -212 }, bloco: { y: 350, h: 350 }, k: { cx: 280, base: 412, fs: 18, color: T }, c: { cx: 280, base: 528, fs: 136 }, l: { cx: 280, base: 604, fs: 86, color: T }, s: { cx: 280, base: 648, fs: 17, color: T } }; },
    sobreposicao(m) { return { foto: { dy: 0 }, recorte: 1, k: { cx: 280, base: 150, fs: 18 }, c: { cx: 280, base: 334, fs: 196 }, l: { cx: 280, base: 630, fs: 96 }, s: { cx: 280, base: 674, fs: 17 } }; },
    canto(m) { return { foto: { dy: 0 }, k: { x: 34, base: 56, fs: 15 }, c: { x: 31, base: 124, fs: 84 }, l: { x: 34, base: 170, fs: 52 }, s: { x: 35, base: 198, fs: 15 } }; },
    linhabaixa(m) { const wk = m('k', 13), wc = m('c', 28), wl = m('l', 32), ws = m('s', 13); const livre = 526 - 34 - wk - wc - 7 - wl - ws, x0 = 34 + wk + livre / 2; return { foto: { dy: 0 }, k: { x: 34, base: 666, fs: 13 }, c: { x: x0, base: 666, fs: 28 }, l: { x: x0 + wc + 7, base: 666, fs: 32 }, s: { rx: 526, base: 666, fs: 13 } }; },
    moldura(m) { return { foto: { dy: 0 }, moldura: 1, k: { cx: 280, base: 84, fs: 17 }, c: { cx: 280, base: 198, fs: 124 }, l: { cx: 280, base: 600, fs: 96 }, s: { cx: 280, base: 640, fs: 17 } }; },
    soco(m) { const wl = m('l', 30); return { foto: { dy: 0 }, k: { x: 36, base: 492, fs: 17 }, c: { x: 28, base: 638, fs: 184, color: K.cor('laranja') }, l: { x: 36, base: 676, fs: 30 }, s: { x: 36 + wl + 10, base: 676, fs: 15 } }; },
  };
  K.ORDEM_LAYOUTS = ['pilha', 'faixa', 'metade', 'sobreposicao', 'canto', 'linhabaixa', 'moldura', 'soco'];

  K.mesmaCapa = function (host, layout, opts) {
    opts = opts || {};
    const TXT = Object.assign({}, K.TEXTOS_MC, opts.textos || {});
    const mc = K.el(host, 'div', 'mc');
    const foto = K.el(mc, 'img', 'foto'); foto.src = opts.foto;
    const bloco = K.el(mc, 'div', 'abs', null, { left: '0px', width: '560px', background: K.cor('laranja'), top: '0px', height: '0px' });
    const t = {};
    t.k = K.el(mc, 'div', 't k', TXT.k);
    t.c = K.el(mc, 'div', 't c', TXT.c);
    const recorte = K.el(mc, opts.recorte ? 'img' : 'div', 'foto'); if (opts.recorte) recorte.src = opts.recorte;
    t.l = K.el(mc, 'div', 't l', TXT.l);
    t.s = K.el(mc, 'div', 't s', TXT.s);
    const moldura = K.el(mc, 'div', 'abs', null, { left: '24px', top: '24px', width: '512px', height: '652px', border: '1.5px solid ' + K.cor('creme') });
    const pecas = { mc, foto, recorte, bloco, moldura, t };
    K.aplicaLayout(pecas, layout);
    return pecas;
  };

  K.aplicaLayout = function (p, layout) {
    const medir = (k, fs) => K.largura(p.t[k], fs);
    const L = K.LAYOUTS[layout](medir);
    for (const k of ['k', 'c', 'l', 's']) K.place(p.t[k], Object.assign({ color: K.cor('creme') }, L[k]));
    const dy = (L.foto && L.foto.dy) || 0;
    p.foto.style.transform = dy ? `translateY(${dy}px)` : '';
    p.recorte.style.transform = dy ? `translateY(${dy}px)` : '';
    p.recorte.style.opacity = L.recorte ? '1' : '0';
    if (L.bloco) { p.bloco.style.top = L.bloco.y + 'px'; p.bloco.style.height = L.bloco.h + 'px'; } else p.bloco.style.height = '0px';
    p.moldura.style.opacity = L.moldura ? '1' : '0';
    return L;
  };

  // ---------- o cartão em movimento: do layout anterior pro deste slide ----------
  const PECAS = ['k', 'c', 'l', 's'], PROPS = ['left', 'top', 'fontSize', 'color'];
  function captura(p) {
    const e = {};
    for (const k of PECAS) e[k] = A.guarda(p.t[k], PROPS);
    e.bloco = A.guarda(p.bloco, ['top', 'height']); e.moldura = A.guarda(p.moldura, ['opacity']);
    e.recorte = A.guarda(p.recorte, ['opacity', 'transform']); e.foto = A.guarda(p.foto, ['transform']);
    return e;
  }
  const px = (s) => parseFloat(s) || 0;
  const dyDe = (tr) => { const m = /translateY\((-?[\d.]+)px\)/.exec(tr || ''); return m ? +m[1] : 0; };

  K.preparaCartao = function (p, layout, antes) {
    K.aplicaLayout(p, antes); const A0 = captura(p);
    K.aplicaLayout(p, layout); const A1 = captura(p);
    const temBloco = (e) => px(e.bloco.height) > 0, temMoldura = (e) => e.moldura.opacity === '1';
    const CREME = K.cor('creme');
    const linhas = ['t', 'r', 'b', 'l'].map((lado) => {
      const d = K.el(p.mc, 'div', 'abs', null, { background: CREME, visibility: 'hidden' });
      if (lado === 't') Object.assign(d.style, { left: '24px', top: '24px', width: '512px', height: '1.5px', transformOrigin: '0 0' });
      if (lado === 'r') Object.assign(d.style, { left: '534.5px', top: '24px', width: '1.5px', height: '652px', transformOrigin: '0 0' });
      if (lado === 'b') Object.assign(d.style, { left: '24px', top: '674.5px', width: '512px', height: '1.5px', transformOrigin: '100% 0' });
      if (lado === 'l') Object.assign(d.style, { left: '24px', top: '24px', width: '1.5px', height: '652px', transformOrigin: '0 100%' });
      return d;
    });
    // u: 0 = layout anterior, 1 = este layout. extra: { empurra, uPeca, uX, uY, squash }
    function aplica(u, extra) {
      extra = extra || {};
      for (const k of PECAS) {
        const el = p.t[k];
        const uk = extra.uPeca ? extra.uPeca(k, u) : A.inOutC(u);
        if (uk >= 1) A.devolve(el, A1[k]);
        else if (uk <= 0) A.devolve(el, A0[k]);
        else {
          const ux = extra.uX ? extra.uX(k, uk) : uk, uy = extra.uY ? extra.uY(k, uk) : uk;
          A.estilo(el, 'left', A.n(A.lerp(px(A0[k].left), px(A1[k].left), ux)) + 'px');
          A.estilo(el, 'top', A.n(A.lerp(px(A0[k].top), px(A1[k].top), uy)) + 'px');
          A.estilo(el, 'fontSize', A.n(A.lerp(px(A0[k].fontSize), px(A1[k].fontSize), uk)) + 'px');
          A.estilo(el, 'color', A.mixCor(A0[k].color, A1[k].color, uk));
        }
        const sq = extra.squash ? extra.squash(k) : 0;
        if (sq) { const v = A.volume(sq); A.estilo(el, 'transformOrigin', '0% 85%'); A.estilo(el, 'transform', `scale(${A.n(v.sx)}, ${A.n(v.sy)})`); }
        else { A.estilo(el, 'transform', ''); A.estilo(el, 'transformOrigin', ''); }
      }
      const ub = A.inOutC(A.clamp(u));
      if (u >= 1) { A.devolve(p.bloco, A1.bloco); A.estilo(p.bloco, 'clipPath', ''); }
      else if (u <= 0) { A.devolve(p.bloco, A0.bloco); A.estilo(p.bloco, 'clipPath', ''); }
      else if (temBloco(A0) && temBloco(A1)) { A.estilo(p.bloco, 'top', A.n(A.lerp(px(A0.bloco.top), px(A1.bloco.top), ub)) + 'px'); A.estilo(p.bloco, 'height', A.n(A.lerp(px(A0.bloco.height), px(A1.bloco.height), ub)) + 'px'); A.estilo(p.bloco, 'clipPath', ''); }
      else if (temBloco(A1)) { A.devolve(p.bloco, A1.bloco); A.estilo(p.bloco, 'clipPath', `inset(0px ${A.n((1 - ub) * 100)}% 0px 0px)`); }
      else if (temBloco(A0)) { const t0 = px(A0.bloco.top), h0 = px(A0.bloco.height), h = h0 * (1 - ub); A.estilo(p.bloco, 'top', A.n(t0 + h0 - h) + 'px'); A.estilo(p.bloco, 'height', A.n(h) + 'px'); A.estilo(p.bloco, 'clipPath', ''); }
      else { A.devolve(p.bloco, A1.bloco); A.estilo(p.bloco, 'clipPath', ''); }
      const dy = A.lerp(dyDe(A0.foto.transform), dyDe(A1.foto.transform), ub);
      const empurra = extra.empurra || 0;
      if (!empurra && (u >= 1 || u <= 0)) { const e = u <= 0 ? A0 : A1; A.devolve(p.foto, e.foto); A.estilo(p.recorte, 'transform', e.recorte.transform); }
      else { const tr = `translateY(${A.n(dy)}px) scale(${A.n(1 + empurra)})`; A.estilo(p.foto, 'transform', tr); A.estilo(p.recorte, 'transform', tr); }
      A.estilo(p.recorte, 'opacity', u >= 0.5 ? A1.recorte.opacity : A0.recorte.opacity);
      const m0 = temMoldura(A0), m1 = temMoldura(A1);
      if (u >= 1 || u <= 0 || m0 === m1) { A.devolve(p.moldura, u <= 0 ? A0.moldura : A1.moldura); for (const d of linhas) A.estilo(d, 'visibility', 'hidden'); }
      else { A.estilo(p.moldura, 'opacity', '0'); const w = m1 ? ub : 1 - ub; linhas.forEach((d, i) => { const ui = A.clamp(w * 4 - i); A.estilo(d, 'visibility', ui > 0 ? 'visible' : 'hidden'); A.estilo(d, 'transform', i % 2 === 0 ? `scaleX(${A.n(ui)})` : `scaleY(${A.n(ui)})`); }); }
    }
    return { aplica, A0, A1 };
  };
})();
