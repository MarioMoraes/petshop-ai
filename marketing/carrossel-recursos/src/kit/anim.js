// ANIM · ferramentas de movimento. Tudo é função pura do tempo: nenhum estado entre quadros.
(function () {
  const K = window.KIT;
  const A = (K.A = {});

  A.clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  A.seg = (t, a, b) => A.clamp((t - a) / (b - a));
  A.lerp = (a, b, u) => a + (b - a) * u;
  A.n = (v) => +v.toFixed(3);

  // suavidade: nada anda em linha reta
  A.inQ = (u) => u * u;
  A.outQ = (u) => 1 - (1 - u) * (1 - u);
  A.inOutQ = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
  A.inC = (u) => u * u * u;
  A.outC = (u) => 1 - Math.pow(1 - u, 3);
  A.inOutC = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  A.outQuart = (u) => 1 - Math.pow(1 - u, 4);
  A.outExpo = (u) => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * u));
  A.outBack = (u, s = 1.3) => 1 + (s + 1) * Math.pow(u - 1, 3) + s * Math.pow(u - 1, 2);
  A.sino = (u) => { const v = Math.pow(Math.sin(Math.PI * A.clamp(u)), 2); return v < 1e-9 ? 0 : v; }; // 0 → 1 → 0, derivada zero nas pontas; zero EXATO nas pontas (senão vira um scale(1) que o Chrome rasteriza diferente e o loop não fecha)
  A.tw = (t, a, b, v0, v1, e = A.inOutC) => A.lerp(v0, v1, e(A.seg(t, a, b)));

  // mola amortecida que chega a zero EXATAMENTE em `dur` (sem resíduo na emenda do loop). tau = t - t0
  A.mola = (tau, dur, f) => (tau < 0 || tau >= dur ? 0 : Math.pow(1 - tau / dur, 2) * Math.cos(2 * Math.PI * f * tau));
  // peso: estica ou achata mantendo o volume (mais largo = mais baixo). a > 0 estica na vertical, a < 0 achata
  A.volume = (a) => ({ sx: 1 / (1 + a), sy: 1 + a });
  // atalhos de peso, puros em t: devolvem {sx, sy}
  A.carimbo = (t, t0, forca = 0.14, dur = 0.45, f = 2.4) => A.volume(-forca * A.mola(t - t0, dur, f)); // achata no impacto e volta
  A.pop = (t, t0, forca = 0.1, dur = 0.4, f = 2.6) => 1 + forca * A.mola(t - t0, dur, f);         // escala uniforme que volta a 1
  // entrada de 0 → 1 com sobrepasso, zerando em dur (pra deslizar, cair, subir)
  A.chega = (t, t0, dur = 0.5, e = A.outC) => e(A.seg(t, t0, t0 + dur));

  A.cor = (c) => (c.startsWith('#') ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : c.match(/\d+/g).map(Number).slice(0, 3));
  A.mixCor = (a, b, u) => { const x = A.cor(a), y = A.cor(b); return `rgb(${x.map((v, i) => Math.round(A.lerp(v, y[i], u))).join(', ')})`; };

  // guarda e devolve os estilos exatos do repouso (o quadro 0 tem que ser o PNG aprovado)
  A.guarda = (el, props) => { const o = {}; for (const p of props) o[p] = el.style[p]; return o; };
  A.devolve = (el, o) => { for (const p in o) if (el.style[p] !== o[p]) el.style[p] = o[p]; };
  A.estilo = (el, p, v) => { if (el.style[p] !== v) el.style[p] = v; };
  A.tr = (el, v, origem) => { A.estilo(el, 'transform', v); A.estilo(el, 'transformOrigin', v ? origem || '' : ''); };

  // ---------- parallax de camadas (capa e CTA fotográficos) ----------
  // camadas: [{el, fator}] (fundo 0.04, pessoa 0.055, título 0.07). A câmera empurra devagar e volta antes de `fim`.
  A.parallax = (t, camadas, fim = 7.5, ini = 0.5) => {
    const u = A.sino(A.seg(t, ini, fim));
    for (const { el, fator } of camadas) A.tr(el, u ? `scale(${A.n(1 + fator * u)})` : '', '50% 60%');
  };
  // escrever letra a letra (CTA): devolve quantas letras estão visíveis em t
  A.digita = (t, t0, n, passo = 0.5) => A.clamp(Math.floor((t - t0) / passo) + 1, 0, n);
})();
