// PS · peças do carrossel do PetShop AI sobre o KIT: cabeçalho, prova, fecho, rodapé e o movimento genérico.
// Movimento (seek puro em t): 0,25–0,5 a prova sai pela direita; 0,5–0,85 volta vazia pela esquerda;
// cada .b pousa no seu data-t (uma batida); de 5,2 s em diante é repouso = quadro 0.
(function () {
  const K = window.KIT, A = K.A;
  const PS = (window.PS = {});
  PS.FONTES = ['400 100px Inter', '500 100px Inter', '600 100px Inter', '700 100px Inter', 'italic 100px "Instrument Serif"'];
  PS.i = (nome, cls = '') => `<svg class="icon ${cls}"><use href="#i-${nome}"/></svg>`;
  PS.chip = (tone, icon, px, fundo, raio) => `<span class="${tone}"><span class="chip ${fundo === 'claro' ? 'chip-light' : 'chip-dark'}" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.48)}px;border-radius:${raio || Math.round(px * 0.29)}px">${PS.i(icon)}</span></span>`;
  // os oito, na ordem do carrossel
  PS.OITO = [
    { tone: 'tone-metric', icon: 'globe', nome: 'Site' }, { tone: 'tone-system', icon: 'spark', nome: 'IA' },
    { tone: 'tone-time', icon: 'cal', nome: 'Agenda' }, { tone: 'tone-pet', icon: 'paw', nome: 'Pets' },
    { tone: 'tone-people', icon: 'user', nome: 'Tutor' }, { tone: 'tone-money', icon: 'cash', nome: 'Caixa' },
    { tone: 'tone-metric', icon: 'trend', nome: 'Fluxo' }, { tone: 'tone-brand', icon: 'box', nome: 'Estoque' },
  ];

  PS.fundo = function (q, fundo, tone) {
    q.className = fundo + ' ' + (tone || '');
    document.body.insertAdjacentHTML('afterbegin', window.PS_ICONES);
    if (fundo === 'escuro') {
      K.html(q, 'div', 'glow', '', { left: '-300px', top: '-260px', width: '1100px', height: '1100px', background: 'radial-gradient(circle, color-mix(in srgb, var(--dark, var(--accent)) 26%, transparent), transparent 62%)' });
      K.html(q, 'div', 'glow', '', { right: '-420px', bottom: '-200px', width: '1100px', height: '1100px', background: 'radial-gradient(circle, rgb(70 111 189 / 0.18), transparent 62%)' });
    } else {
      K.html(q, 'div', 'glow', '', { right: '-360px', top: '-320px', width: '1000px', height: '1000px', background: 'radial-gradient(circle, color-mix(in srgb, var(--tone) 12%, transparent), transparent 62%)' });
    }
    K.el(q, 'div', 'pontos');
  };
  PS.rodape = (q) => K.html(q, 'div', 'rodape', `<span class="m">${PS.i('paw')}</span>PetShop AI`);

  // slide de recurso: o: {index, fundo, tone, icon, n, nome, t1, t2, corpo, prova (html), fecho, duration, cues, extra(t)}
  PS.recurso = function (o) {
    K.pronto(() => {
      const q = document.getElementById('quadro');
      PS.fundo(q, o.fundo, o.tone);
      if (o.n) K.html(q, 'div', 'kicker', `${PS.chip(o.tone, o.icon, 46, o.fundo)}<span><span class="n">${o.n}</span> · ${o.nome}</span>`);
      const h = K.html(q, 'div', 'h1', `${o.t1}<span class="serif">${o.t2}</span>`, o.h1 || {});
      if (o.corpo) K.html(q, 'div', 'corpo', o.corpo, o.corpoCss || {});
      const prova = K.html(q, 'div', 'prova', o.prova || '', o.provaCss || {});
      if (o.fecho) K.html(q, 'div', 'fecho b', o.fecho, {}).dataset.t = o.fechoT || 4.5;
      if (o.depois) o.depois(q);
      if (!o.semRodape) PS.rodape(q);
      PS.anima(q, prova, h.querySelector('.serif'), o);
    }, PS.FONTES);
  };

  // ---------- movimento genérico ----------
  const fmt = (v, f) => (f === 'brl' ? 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : f === 'brl0' ? '+R$ ' + Math.round(v).toLocaleString('pt-BR') : String(Math.round(v)));
  PS.anima = function (q, prova, serif, o) {
    const itens = [...q.querySelectorAll('.b')].map((el) => ({ el, t: parseFloat(el.dataset.t || 1), k: el.dataset.k || 'sobe', txt: el.textContent, fora: !prova.contains(el) }));
    const cues = o.travessia === false ? [] : [{ t: 0.25, tipo: 'whoosh', o_que: 'a prova sai e volta' }];
    if (o.carimboSerif !== false) cues.push({ t: 1.0, tipo: 'impacto', o_que: 'a linha em serifa carimba' });
    for (const it of itens) cues.push({ t: it.t, tipo: it.k === 'pop' ? 'impacto' : it.el.classList.contains('fecho') ? 'tchac' : 'clique', o_que: (it.txt || it.k).trim().slice(0, 30) });
    window.seek = (t) => {
      // a prova atravessa a borda
      let x = 0;
      if (o.travessia !== false) {
      if (t > 0.25 && t < 0.5) x = 1150 * A.inC(A.seg(t, 0.25, 0.5));
      else if (t >= 0.5 && t < 0.85) x = -1150 * (1 - A.outBack(A.seg(t, 0.5, 0.85), 1.1));
      }
      A.tr(prova, x ? `translateX(${A.n(x)}px)` : '');
      if (serif && o.carimboSerif !== false) { const c = A.carimbo(t, 1.0, 0.16, 0.5); A.tr(serif, c.sx !== 1 ? `scale(${A.n(c.sx)},${A.n(c.sy)})` : '', '0% 80%'); }
      for (const it of itens) {
        const el = it.el;
        // fora da prova: sai por baixo de 0,25 a 0,5
        const escondido = t >= 0.5 && t < it.t;
        const saindo = it.fora && t > 0.25 && t < 0.5 ? A.inC(A.seg(t, 0.25, 0.5)) : 0;
        const u = t >= it.t ? A.seg(t, it.t, it.t + 0.45) : 1;
        if (it.k === 'desenha' && !(t >= it.t && t < it.t + 1.2)) { A.estilo(el, 'visibility', escondido ? 'hidden' : ''); A.estilo(el, 'clipPath', ''); continue; }
        A.estilo(el, 'visibility', escondido ? 'hidden' : '');
        if (it.k === 'conta') {
          const alvo = parseFloat(el.dataset.to); const v = t >= 0.5 && t < it.t + 1.2 ? alvo * A.outC(A.seg(t, it.t, it.t + 1.2)) : null;
          const txt = v === null ? it.txt : fmt(v, el.dataset.fmt);
          if (el.textContent !== txt) el.textContent = txt;
          A.estilo(el, 'visibility', '');
          continue;
        }
        let tr = '';
        if (saindo) tr = `translateY(${A.n(50 * saindo)}px)`;
        else if (u < 1 && t >= 0.5) {
          const e = A.outC(u);
          if (it.k === 'sobe') tr = `translateY(${A.n(46 * (1 - e))}px)`;
          else if (it.k === 'pop') tr = `scale(${A.n(Math.max(0, A.outBack(u, 2.2)))})`;
          else if (it.k === 'larg') tr = `scaleX(${A.n(e)})`;
          else if (it.k === 'cresce') tr = `scaleY(${A.n(e)})`;
          else if (it.k === 'esq') tr = `translateX(${A.n(-60 * (1 - e))}px)`;
          else if (it.k === 'desenha') { A.estilo(el, 'clipPath', `inset(0 ${A.n(100 * (1 - A.inOutC(A.seg(t, it.t, it.t + 1.2))))}% 0 0)`); A.tr(el, ''); continue; }
        }
        A.tr(el, tr, it.k === 'larg' ? '0% 50%' : it.k === 'cresce' ? '50% 100%' : '50% 50%');
        const clip = (it.k === 'sobe' || it.k === 'esq') && u < 1 && t >= 0.5 ? `inset(0 0 ${A.n(100 * (1 - A.outC(u)))}% 0)` : saindo ? `inset(0 0 ${A.n(100 * saindo)}% 0)` : '';
        A.estilo(el, 'clipPath', clip);
      }
      if (o.extra) o.extra(t);
      return true;
    };
    K.slide({ index: o.index, duration: o.duration || 6, cues: (o.cues || []).concat(cues) });
  };
})();
