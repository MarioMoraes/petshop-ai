// DISPOSITIVO "slide de layout / regra editorial": círculo com número · nome · subtítulo · cartão à esquerda ·
// três frases com fios à direita · barra de veredito · rodapé. Estático e vivo (6 s, 3 compassos a 120 BPM).
// Uso: KIT.pronto(() => KIT.slideLayout(DADOS)); DADOS = { index, numero, nome, subtitulo, layout, anterior, fundo:'papel'|'marinho',
//   frases:[3], barra, foto, recorte, textos }. Define window.seek(t) e registra o slide (duração e acertos sonoros).
(function () {
  const K = window.KIT, A = K.A;
  const T = { circ: [0.25, 0.5], circMola: 0.45, tituloSai: [0.55, 0.75], partes: [1.0, 1.5], queda: 0.22, tituloMola: 0.32,
    sai: [1.75, 2.05], volta: [2.05, 2.5], reorg: [3.0, 3.5], frases: [3.5, 4.0, 4.5], sobe: 0.2, fio: 0.3, barra: [4.6, 5.0], barraMola: 0.45, dur: 6 };
  K.T_LAYOUT = T;
  // os acertos sonoros da coreografia (vão pro beats.json e pra música)
  K.CUES_LAYOUT = [
    { t: 0.5, tipo: 'impacto', o_que: 'número carimba' }, { t: 1.0, tipo: 'clique', o_que: 'nome, parte 1' }, { t: 1.5, tipo: 'clique', o_que: 'nome, parte 2' },
    { t: 1.7, tipo: 'whoosh', o_que: 'cartão atravessa a borda' }, { t: 2.5, tipo: 'clique', o_que: 'cartão pousa' },
    { t: 3.0, tipo: 'whoosh', o_que: 'texto se reorganiza' }, { t: 3.5, tipo: 'clique', o_que: 'texto pousa + frase 1' },
    { t: 4.0, tipo: 'clique', o_que: 'frase 2' }, { t: 4.5, tipo: 'clique', o_que: 'frase 3' }, { t: 5.0, tipo: 'tchac', o_que: 'barra carimba' },
  ];

  K.slideLayout = function (d) {
    const q = document.getElementById('quadro');
    const escuro = d.fundo === 'marinho';
    if (escuro) K.fundoMarinho(q, 7); else K.fundoPapel(q, 3);
    const cor = escuro ? K.cor('creme') : K.cor('tinta');
    const p = {};
    p.circulo = K.el(q, 'div', 'circulo'); p.numero = K.el(p.circulo, 'span', null, d.numero);
    p.titulo = K.el(q, 'div', 'titulo', d.nome, { color: cor });
    let fs = 116; while (K.largura(p.titulo, fs) > 1008 - 270 && fs > 60) fs -= 1;
    K.place(p.titulo, { x: 268, base: 236, fs }); p.tituloFs = fs; p.tituloBase = K.base(p.titulo);
    p.tituloAnim = K.el(q, 'div', 'titulo', null, { color: cor, visibility: 'hidden' });
    const palavras = d.nome.split(' '), partes = palavras.length > 1 ? [palavras.slice(0, -1).join(' '), palavras[palavras.length - 1]] : [d.nome];
    p.partes = partes.map((txt, i) => { if (i) p.tituloAnim.appendChild(document.createTextNode(' ')); return K.el(p.tituloAnim, 'span', null, txt, { display: 'inline-block' }); });
    K.place(p.tituloAnim, { x: 268, base: 236, fs });
    p.subtitulo = K.el(q, 'div', 'subtitulo', d.subtitulo, { color: cor }); K.place(p.subtitulo, { x: 274, base: 296 });
    p.cartao = K.el(q, 'div', 'cartao');
    p.capa = K.mesmaCapa(p.cartao, d.layout, { foto: d.foto, recorte: d.recorte, textos: d.textos });
    p.frases = K.el(q, 'div', 'frases', null, { color: cor }); p.linhas = []; p.fios = [];
    d.frases.forEach((f, i) => { if (i) p.fios.push(K.el(p.frases, 'div', 'fio')); p.linhas.push(K.el(p.frases, 'div', 'frase', f)); });
    p.frases.style.top = (352 + 350 - p.frases.offsetHeight / 2).toFixed(1) + 'px';
    p.barra = K.el(q, 'div', 'barra');
    d.barra.split('\n').forEach((l, i) => { if (i) p.barra.appendChild(document.createElement('br')); p.barra.appendChild(document.createTextNode(l)); });
    p.rodape = K.rodape(q, cor);
    const ordem = K.ORDEM_LAYOUTS, i = ordem.indexOf(d.layout);
    p.anima = K.preparaCartao(p.capa, d.layout, d.anterior || (i > 0 ? ordem[i - 1] : 'erro'));
    p.layout = d.layout;
    window.__pecas = p;
    window.seek = (t) => seek(p, t);
    K.slide({ index: d.index || 2, duration: T.dur, cues: K.CUES_LAYOUT });
    return p;
  };

  function extrasDo(layout, t) {
    const L = T.reorg[1];
    if (layout === 'pilha') { // as peças caem e se empilham, cada uma achata no pouso
      const jan = { s: [0, 0.6], l: [0.13, 0.73], c: [0.27, 0.87], k: [0.4, 1] };
      return { uPeca: (k, u) => A.seg(u, jan[k][0], jan[k][1]), uX: (k, u) => A.outC(u), uY: (k, u) => A.inQ(u),
        squash: (k) => { const pouso = T.reorg[0] + jan[k][1] * (T.reorg[1] - T.reorg[0]); return -0.2 * A.mola(t - pouso, 0.3, 2.4); } };
    }
    if (layout === 'soco') return { uY: (k, u) => (k === 'c' ? A.inQ(u) : u), squash: (k) => (k === 'c' ? -0.22 * A.mola(t - L, 0.36, 2.2) : 0) };
    return {};
  }

  function seek(p, t) {
    const tr = A.tr;
    // 1. o círculo levanta e carimba
    if (t >= T.circ[0] && t < T.circ[1]) { const u = A.outC(A.seg(t, T.circ[0], T.circ[1])); tr(p.circulo, `translateY(${A.n(-8 * u)}px) rotate(${A.n(-6 * u)}deg) scale(${A.n(1 + 0.14 * u)})`, '50% 50%'); }
    else if (t >= T.circ[1] && t < T.circ[1] + T.circMola) { const tau = t - T.circ[1]; const v = A.volume(-0.13 * A.mola(tau, T.circMola, 2.4)); const rot = -6 * (1 - A.outC(A.seg(tau, 0, 0.08))); tr(p.circulo, `rotate(${A.n(rot)}deg) scale(${A.n(v.sx)}, ${A.n(v.sy)})`, '50% 100%'); }
    else tr(p.circulo, '');
    // 2. o nome cai pra fora e volta em duas batidas (achata pra direita: não come o espaço entre as palavras)
    const Hh = 1.1 * p.tituloFs, fimTitulo = T.partes[Math.min(1, p.partes.length - 1)] + T.tituloMola;
    const animando = t >= T.tituloSai[0] && t < fimTitulo;
    A.estilo(p.titulo, 'visibility', animando ? 'hidden' : ''); A.estilo(p.tituloAnim, 'visibility', animando ? 'visible' : 'hidden');
    A.estilo(p.tituloAnim, 'clipPath', animando ? `inset(0px -80px ${A.n(p.tituloAnim.offsetHeight - p.tituloBase - 0.26 * p.tituloFs)}px -40px)` : '');
    p.partes.forEach((el, j) => {
      const pouso = T.partes[Math.min(j, 1)]; let vis = '', v = '';
      if (t >= T.tituloSai[0] && t < T.tituloSai[1]) { const u = A.inQ(A.seg(t, T.tituloSai[0], T.tituloSai[1])); const s = A.volume(0.12 * u); v = `translateY(${A.n(u * Hh)}px) scale(${A.n(s.sx)}, ${A.n(s.sy)})`; }
      else if (t >= T.tituloSai[1] && t < pouso - T.queda) vis = 'hidden';
      else if (t >= pouso - T.queda && t < pouso) { const u = A.inQ(A.seg(t, pouso - T.queda, pouso)); const s = A.volume(0.12 * u); v = `translateY(${A.n(-Hh * (1 - u))}px) scale(${A.n(s.sx)}, ${A.n(s.sy)})`; }
      else if (t >= pouso && t < pouso + T.tituloMola) { const s = A.volume(-0.07 * A.mola(t - pouso, T.tituloMola, 2.6)); v = `scale(${A.n(s.sx)}, ${A.n(s.sy)})`; }
      A.estilo(el, 'visibility', vis); tr(el, v, '0% 100%');
    });
    // 3. o cartão sai pela borda direita e volta pela esquerda
    let x = 0;
    if (t >= T.sai[0] && t < T.sai[1]) x = 1030 * A.inC(A.seg(t, T.sai[0], T.sai[1]));
    else if (t >= T.volta[0] && t < T.volta[1]) x = -640 * (1 - A.outBack(A.seg(t, T.volta[0], T.volta[1]), 1.1));
    tr(p.cartao, x ? `translateX(${A.n(x)}px)` : ''); A.estilo(p.cartao, 'zIndex', t >= T.sai[0] && t < T.volta[1] ? '5' : '');
    // 4. dentro do cartão: do layout anterior pro deste slide; a foto respira e para antes do fim (quadro final = quadro 0)
    let u = 1; if (t >= T.sai[1] && t < T.reorg[0]) u = 0; else if (t >= T.reorg[0] && t < T.reorg[1]) u = A.seg(t, T.reorg[0], T.reorg[1]);
    const extra = extrasDo(p.layout, t); extra.empurra = t < 5.5 ? 0.025 * A.sino(t / 5.5) : 0;
    p.anima.aplica(u, extra);
    // 5. as frases somem quando o cartão passa por cima, voltam uma por batida com o fio se desenhando
    const tSome = T.sai[0] + (T.sai[1] - T.sai[0]) * Math.cbrt(490 / 1030);
    p.linhas.forEach((el, i) => {
      const chega = T.frases[i];
      if (t >= tSome && t < chega - T.sobe) { A.estilo(el, 'visibility', 'hidden'); tr(el, ''); A.estilo(el, 'clipPath', ''); return; }
      A.estilo(el, 'visibility', '');
      if (t >= chega - T.sobe && t < chega) { const hh = el.offsetHeight + 6; const dd = (1 - A.outC(A.seg(t, chega - T.sobe, chega))) * hh; tr(el, `translateY(${A.n(dd)}px)`); A.estilo(el, 'clipPath', `inset(-12px -24px ${A.n(dd)}px -24px)`); }
      else { tr(el, ''); A.estilo(el, 'clipPath', ''); }
    });
    p.fios.forEach((el, i) => { const a = T.frases[i], b = a + T.fio; if (t >= tSome && t < a) { A.estilo(el, 'visibility', 'hidden'); tr(el, ''); return; } A.estilo(el, 'visibility', ''); if (t >= a && t < b) tr(el, `scaleX(${A.n(A.inOutC(A.seg(t, a, b)))})`, '0% 50%'); else tr(el, ''); });
    // 6. a barra levanta e carimba no tempo forte
    if (t >= T.barra[0] && t < T.barra[1]) { const v = A.outC(A.seg(t, T.barra[0], T.barra[1])); tr(p.barra, `translateY(${A.n(-14 * v)}px) rotate(${A.n(-1.2 * v)}deg) scale(${A.n(1 + 0.02 * v)})`, '0% 100%'); }
    else if (t >= T.barra[1] && t < T.barra[1] + T.barraMola) { const tau = t - T.barra[1]; const s = A.volume(-0.16 * A.mola(tau, T.barraMola, 2.5)); const rot = -1.2 * (1 - A.outC(A.seg(tau, 0, 0.08))); tr(p.barra, `rotate(${A.n(rot)}deg) scale(${A.n(s.sx)}, ${A.n(s.sy)})`, '0% 100%'); }
    else tr(p.barra, '');
  }
})();
