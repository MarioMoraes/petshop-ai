"""Testes da entrega viva: quadro 0 = PNG estático (diferença zero), emenda do loop (imagem e som), formato dos MP4.
  python3 scripts/testes-vivo.py            -> resultados/testes.json + resultados/testes/*.jpg
Lê audio/beats.json (durações), resultados/estatico/slide-NN.png, resultados/quadros/slide-NN/ e resultados/slide-NN.mp4."""
import json, subprocess, pathlib, numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.io import wavfile
RAIZ = pathlib.Path.cwd(); R = RAIZ / 'resultados'; (R / 'testes').mkdir(parents=True, exist_ok=True)
grade = json.load(open(RAIZ / 'audio' / 'beats.json'))
DUR = {s['slide']: s['duracao_s'] for s in grade['slides']}
def img(p): return np.asarray(Image.open(p).convert('RGB')).astype(int)
def decodifica(mp4, n):
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(mp4), '-vf', f'select=eq(n\\,{n}),scale=in_color_matrix=bt709:in_range=tv,format=rgb24', '-vframes', '1', '-f', 'rawvideo', '-'], capture_output=True).stdout
    return np.frombuffer(out, np.uint8).reshape(1350, 1080, 3).astype(int)
def psnr(a, b):
    m = ((a - b) ** 2).mean(); return 99.0 if m == 0 else 10 * np.log10(255 ** 2 / m)
rel = {}
for k, dur in sorted(DUR.items()):
    s = f'{k:02d}'; n = int(dur * 30)
    q0 = img(R / f'quadros/slide-{s}/0000.png'); est = img(R / f'estatico/slide-{s}.png'); qn = img(R / f'quadros/slide-{s}/{n - 1:04d}.png')
    d0 = np.abs(q0 - est).max(2); dl = np.abs(qn - q0)
    mp4 = R / f'slide-{s}.mp4'
    pr = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(mp4)], capture_output=True, text=True).stdout)
    v = [x for x in pr['streams'] if x['codec_type'] == 'video'][0]; a = [x for x in pr['streams'] if x['codec_type'] == 'audio']
    sr, w = wavfile.read(RAIZ / f'audio/slide-{s}.wav'); w = (w[:, 0] if w.ndim > 1 else w).astype(float) / 32768
    ww = np.concatenate([w, w]); L = len(w); M = int(2.0 * sr); J = int(0.01 * sr)
    degrau = lambda i: abs(ww[i] - ww[i - 1]); env = lambda i, j: np.sqrt((ww[i:j] ** 2).mean())
    rel[s] = {
        'quadro0_vs_png': {'pixels_diferentes': int((d0 > 0).sum()), 'dif_max': int(d0.max())},
        'mp4_quadro0_vs_png_psnr_db': round(psnr(decodifica(mp4, 0), est), 1),
        'loop_ultimo_vs_quadro0': {'pixels_diferentes': int((dl.max(2) > 0).sum()), 'dif_max': int(dl.max()), 'dif_media': round(float(dl.mean()), 4)},
        'audio_emenda': {'degrau_na_emenda': round(float(degrau(L)), 4), 'degrau_no_compasso_interno': round(float(degrau(M)), 4),
                         'rms_antes/depois_emenda': [round(float(env(L - J, L)), 3), round(float(env(L, L + J)), 3)], 'rms_antes/depois_compasso_interno': [round(float(env(M - J, M)), 3), round(float(env(M, M + J)), 3)]},
        'mp4': {'resolucao': f"{v['width']}x{v['height']}", 'fps': v['r_frame_rate'], 'quadros': int(v.get('nb_frames', 0)), 'pix_fmt': v['pix_fmt'], 'codec': v['codec_name'], 'audio': (f"{a[0]['codec_name']} {a[0]['sample_rate']} Hz" if a else 'SEM ÁUDIO'), 'duracao_s': round(float(pr['format']['duration']), 3)},
    }
json.dump(rel, open(R / 'testes.json', 'w'), ensure_ascii=False, indent=1)
ok = all(r['quadro0_vs_png']['pixels_diferentes'] == 0 and r['loop_ultimo_vs_quadro0']['pixels_diferentes'] == 0 for r in rel.values())
for s, r in rel.items(): print(s, 'q0=PNG', r['quadro0_vs_png']['pixels_diferentes'], 'px | loop', r['loop_ultimo_vs_quadro0']['pixels_diferentes'], 'px | PSNR', r['mp4_quadro0_vs_png_psnr_db'], '| som emenda', r['audio_emenda']['degrau_na_emenda'], 'vs interno', r['audio_emenda']['degrau_no_compasso_interno'], '|', r['mp4']['resolucao'], r['mp4']['quadros'], 'q', r['mp4']['audio'])
print('TODOS OS LOOPS E QUADROS 0 FECHAM' if ok else 'REVISAR: algum quadro 0 ou loop não fecha')

# ---- imagens dos testes
F = ImageFont.truetype('/System/Library/Fonts/SFNSMono.ttf', 16); FB = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 22)
W, H = 180, 225; ks = sorted(DUR); N = len(ks)
fundo = lambda w, h: Image.new('RGB', (w, h), (22, 22, 22))
s_ = fundo(N * (W + 10) + 140, 3 * (H + 10) + 90); d = ImageDraw.Draw(s_)
d.text((10, 10), 'Quadro 0 do vídeo = PNG estático (pixel por pixel)', font=FB, fill=(237, 233, 225))
for r_, nome in enumerate(['PNG estático', 'quadro 0 do vivo', 'diferença x50']): d.text((10, 50 + r_ * (H + 10) + H // 2), nome, font=F, fill=(180, 175, 165))
for i, k in enumerate(ks):
    s2 = f'{k:02d}'; a_ = Image.open(R / f'estatico/slide-{s2}.png').convert('RGB'); b_ = Image.open(R / f'quadros/slide-{s2}/0000.png').convert('RGB')
    dd = np.clip(np.abs(np.asarray(a_, int) - np.asarray(b_, int)) * 50, 0, 255).astype(np.uint8); x = 140 + i * (W + 10)
    for r_, im in enumerate([a_, b_, Image.fromarray(dd)]): s_.paste(im.resize((W, H)), (x, 45 + r_ * (H + 10)))
    t = rel[s2]['quadro0_vs_png']; d.text((x, 45 + 3 * (H + 10) - 4), f'{s2}: {t["pixels_diferentes"]} px', font=F, fill=(242, 81, 31) if t['pixels_diferentes'] else (150, 220, 150))
s_.save(R / 'testes/quadro0-igual-ao-png.jpg', quality=90)
s_ = fundo(N * (W + 10) + 140, 2 * (H + 10) + 2 * 90 + 100); d = ImageDraw.Draw(s_)
d.text((10, 10), 'Teste de loop: o último quadro emenda no quadro 0', font=FB, fill=(237, 233, 225))
for r_, nome in enumerate(['último quadro', 'quadro 0']): d.text((10, 50 + r_ * (H + 10) + H // 2), nome, font=F, fill=(180, 175, 165))
y0 = 45 + 2 * (H + 10)
d.text((10, y0 + 30), 'som: 60 ms\nantes | depois\nda emenda', font=F, fill=(180, 175, 165)); d.text((10, y0 + 120), 'mesma janela\nnum compasso\ninterno (2 s)', font=F, fill=(180, 175, 165))
for i, k in enumerate(ks):
    s2 = f'{k:02d}'; n = int(DUR[k] * 30); x = 140 + i * (W + 10)
    s_.paste(Image.open(R / f'quadros/slide-{s2}/{n - 1:04d}.png').convert('RGB').resize((W, H)), (x, 45))
    s_.paste(Image.open(R / f'quadros/slide-{s2}/0000.png').convert('RGB').resize((W, H)), (x, 45 + H + 10))
    sr, w = wavfile.read(RAIZ / f'audio/slide-{s2}.wav'); w = (w[:, 0] if w.ndim > 1 else w) / 32768
    ww = np.concatenate([w, w]); L = len(w); J = int(0.06 * sr)
    for j, centro in enumerate([L, int(2.0 * sr)]):
        seg = ww[centro - J:centro + J]; yb = y0 + 10 + j * 90 + 40
        d.line([(x + W // 2, yb - 38), (x + W // 2, yb + 38)], fill=(242, 81, 31), width=1)
        d.line([(x + ii * 8 * W / len(seg), yb - 36 * v_) for ii, v_ in enumerate(seg[::8])], fill=(237, 233, 225), width=1)
    t = rel[s2]['loop_ultimo_vs_quadro0']; d.text((x, y0 + 190), f'{s2}: {t["pixels_diferentes"]} px', font=F, fill=(242, 81, 31) if t['pixels_diferentes'] else (150, 220, 150))
s_.save(R / 'testes/loop-imagem-e-som.jpg', quality=90)
print('resultados/testes/quadro0-igual-ao-png.jpg · resultados/testes/loop-imagem-e-som.jpg')
