// Fotografa os slides com o Chrome sem janela (Playwright), servindo a pasta do projeto por HTTP
// (fetch de JSON, fontes e imagens funcionam; file:// não). Rode de dentro da pasta do projeto.
//   node scripts/render.mjs stills [all|02,03]      -> resultados/estatico/slide-NN.png (quadro 0)
//   node scripts/render.mjs quadro <NN> <t> <saida>   -> um quadro qualquer
//   node scripts/render.mjs cues                      -> audio/beats.json (duração e acertos declarados em cada slide)
//   node scripts/render.mjs frames [all|02]           -> build/frames/slide-NN/0000.png… (todos os quadros, fora de ordem)
//   node scripts/render.mjs video [all|02]            -> resultados/slide-NN.mp4 (quadros direto no ffmpeg + audio/slide-NN.wav)
//                                                        e resultados/quadros/slide-NN/ com o quadro 0, o último e um por batida
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const ROOT = process.cwd();
let chromium;
try { ({ chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright')); }
catch { ({ chromium } = createRequire(path.join(process.env.PLAYWRIGHT_DIR || (process.env.HOME + '/carroussel/projetos/orbit-saas-02'), 'package.json'))('playwright')); }
const EXE = process.env.CHROME_HEADLESS || (process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const FPS = 30;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.json': 'application/json', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.svg': 'image/svg+xml' };
const pad = (n, k = 4) => String(n).padStart(k, '0');
const todos = () => fs.readdirSync(path.join(ROOT, 'src', 'slides')).filter((f) => /^slide-\d+\.html$/.test(f)).map((f) => f.match(/\d+/)[0]).sort();
const lista = (a) => (!a || a === 'all' ? todos() : a.split(',').map((s) => pad(parseInt(s, 10), 2)));

function servidor() {
  return new Promise((ok) => {
    const s = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}
async function abrir(browser, porta, s) {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(`[slide ${s}]`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`[slide ${s}]`, m.text()); });
  await page.goto(`http://127.0.0.1:${porta}/src/slides/slide-${s}.html`);
  await page.waitForFunction(() => window.__ready === true || window.__pronto === true, null, { timeout: 30000 });
  return page;
}
const shot = (page, t, file) => page.evaluate((tt) => window.seek(tt), t).then(() => page.screenshot(file ? { path: file, clip: { x: 0, y: 0, width: 1080, height: 1350 } } : { clip: { x: 0, y: 0, width: 1080, height: 1350 } }));

const [modo, a1, a2, a3] = process.argv.slice(2);
const srv = await servidor(); const porta = srv.address().port;
const browser = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined, args: ['--disable-gpu', '--disable-gpu-compositing', '--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none'] });
try {
  if (modo === 'stills') {
    const dir = path.join(ROOT, 'resultados', 'estatico'); fs.mkdirSync(dir, { recursive: true });
    for (const s of lista(a1)) { const page = await abrir(browser, porta, s); await shot(page, 0, path.join(dir, `slide-${s}.png`)); await page.close(); console.log('ok', `resultados/estatico/slide-${s}.png`); }
  } else if (modo === 'quadro') {
    const page = await abrir(browser, porta, pad(parseInt(a1, 10), 2)); await shot(page, parseFloat(a2), a3); await page.close(); console.log('ok', a3);
  } else if (modo === 'cues') {
    const out = { bpm: 120, batida_s: 0.5, compasso_s: 2, sampleRate: 48000, slides: [] }; let comp = 1;
    for (const s of todos()) {
      const page = await abrir(browser, porta, s); const sl = await page.evaluate(() => window.__slide); await page.close();
      const n = Math.round(sl.duration / 2);
      out.slides.push({ slide: parseInt(s, 10), duracao_s: sl.duration, compassos: n, compassos_da_musica: [comp, comp + n - 1], batidas: [...Array(sl.duration * 2).keys()].map((b) => b * 0.5), eventos: sl.cues || [] });
      comp += n;
    }
    out.compassos_total = comp - 1; fs.mkdirSync(path.join(ROOT, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'audio', 'beats.json'), JSON.stringify(out, null, 1)); console.log('audio/beats.json:', out.compassos_total, 'compassos,', out.slides.length, 'slides');
  } else if (modo === 'frames') {
    for (const s of lista(a1)) {
      const page = await abrir(browser, porta, s); const D = await page.evaluate(() => window.__slide.duration);
      const dir = path.join(ROOT, 'build', 'frames', `slide-${s}`); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      const N = Math.round(D * FPS); const ordem = [...Array(N).keys()].sort((x, y) => ((x * 7919) % N) - ((y * 7919) % N)); // fora de ordem: prova a função pura de t
      for (const f of ordem) await shot(page, f / FPS, path.join(dir, `${pad(f)}.png`));
      await page.close(); console.log(`slide ${s}: ${N} quadros`);
    }
  } else if (modo === 'video') {
    const fila = lista(a1);
    async function trabalha() {
      while (fila.length) {
        const s = fila.shift(); const page = await abrir(browser, porta, s); const D = await page.evaluate(() => window.__slide.duration); const n = Math.round(D * FPS);
        const guarda = path.join(ROOT, 'resultados', 'quadros', `slide-${s}`); fs.mkdirSync(guarda, { recursive: true });
        const mp4 = path.join(ROOT, 'resultados', `slide-${s}.mp4`); const wav = path.join(ROOT, 'audio', `slide-${s}.wav`);
        const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'png', '-i', '-'];
        if (fs.existsSync(wav)) args.push('-i', wav, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
        args.push('-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
          '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-r', '30', '-t', String(n / FPS), '-movflags', '+faststart', mp4);
        const ff = spawn('ffmpeg', args); let erro = ''; ff.stderr.on('data', (d) => (erro += d));
        const fim = new Promise((ok, ruim) => ff.on('close', (c) => (c === 0 ? ok() : ruim(new Error(erro)))));
        const t0 = Date.now();
        for (let i = 0; i < n; i++) {
          const buf = await shot(page, i / FPS);
          if (i % 15 === 0 || i === n - 1) fs.writeFileSync(path.join(guarda, `${pad(i)}.png`), buf);
          if (!ff.stdin.write(buf)) await new Promise((ok) => ff.stdin.once('drain', ok));
        }
        ff.stdin.end(); await page.close(); await fim;
        console.log('ok', `resultados/slide-${s}.mp4`, n, 'quadros', ((Date.now() - t0) / 1000).toFixed(0) + 's', fs.existsSync(wav) ? '' : '(sem áudio: rode scripts/musica.py antes)');
      }
    }
    await Promise.all([trabalha(), trabalha(), trabalha()]);
  } else console.log('uso: stills [all|02,03] | quadro NN t saida | cues | frames [all|02] | video [all|02]');
} finally { await browser.close(); srv.close(); }
