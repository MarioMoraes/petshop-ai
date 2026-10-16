"""Folha de contato + teste de miniatura dos slides estáticos. Rode de dentro da pasta do projeto.
  python3 scripts/folha.py                -> resultados/estatico/folha.png e miniatura.png
  python3 scripts/folha.py --lado refs/frames   -> + lado-a-lado.png (nosso slide N | quadro ref-*-NN.png da referência)
Precisa de Pillow (python3 sem -I). Lê resultados/estatico/slide-NN.png.
"""
import glob, os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.getcwd()
D = os.path.join(ROOT, 'resultados', 'estatico')
files = sorted(glob.glob(os.path.join(D, 'slide-*.png')))
if not files:
    sys.exit('nenhum resultados/estatico/slide-NN.png; rode node scripts/render.mjs stills')
F = lambda s: ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', s)
mini_only = '--miniatura' in sys.argv
ims = [Image.open(f).convert('RGB') for f in files]

# ---- folha de contato: todos os slides, 5 por linha
cols, sc, gap, lab = 5, 0.3, 14, 40
w, h = int(1080 * sc), int(1350 * sc)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * (w + gap) + gap, rows * (h + lab + gap) + gap), (24, 22, 20))
d = ImageDraw.Draw(sheet)
for k, im in enumerate(ims):
    x = gap + (k % cols) * (w + gap); y = gap + (k // cols) * (h + lab + gap)
    d.text((x + 4, y + 6), f'{k + 1:02d} · {os.path.basename(files[k])}', fill=(240, 235, 225), font=F(22))
    sheet.paste(im.resize((w, h), Image.LANCZOS), (x, y + lab))
sheet.save(os.path.join(D, 'folha.png'))

# ---- teste de miniatura: (a) feed a 390 px, 3 slides lado a lado; (b) grade de perfil 1:1 a 128 px
fw, fh = 390, int(390 * 1350 / 1080)
mini = Image.new('RGB', (1700, 1160), (18, 18, 18))
d = ImageDraw.Draw(mini)
d.text((24, 16), 'FEED · 390 px (como no celular) · capa, slide 2 e virada', fill=(235, 230, 220), font=F(24))
picks = [0, 1, max(0, len(ims) - 2)][:len(ims)]
for k, idx in enumerate(picks):
    mini.paste(ims[idx].resize((fw, fh), Image.LANCZOS), (24 + k * (fw + 20), 56))
d.text((24, 76 + fh), 'GRADE DO PERFIL · recorte 1:1 a 128 px · a capa é a primeira; o olho para nela?', fill=(235, 230, 220), font=F(24))
gx, gy, cell, g = 24, 116 + fh, 128, 4
for k in range(12):
    x = gx + (k % 6) * (cell + g); y = gy + (k // 6) * (cell + g)
    if k < len(ims):
        im = ims[k]; W, H = im.size; s = min(W, H)
        crop = im.crop(((W - s) // 2, (H - s) // 2, (W + s) // 2, (H + s) // 2)).resize((cell, cell), Image.LANCZOS)
        mini.paste(crop, (x, y))
    else:
        d.rectangle([x, y, x + cell, y + cell], fill=(60, 60, 60))
# margens e cantos: desenha as zonas proibidas sobre a capa pra conferência visual
cx, cy = 24 + 3 * (fw + 20), 56
capa = ims[0].resize((fw, fh), Image.LANCZOS).copy()
dd = ImageDraw.Draw(capa, 'RGBA')
m = int(72 * fw / 1080)
dd.rectangle([0, 0, fw, fh], outline=(255, 80, 60, 200), width=1)
dd.rectangle([m, m, fw - m, fh - m], outline=(255, 80, 60, 220), width=2)
dd.rectangle([fw - int(150 * fw / 1080), 0, fw, int(110 * fw / 1080)], fill=(255, 80, 60, 90))        # contador 1/N
dd.rectangle([fw - int(140 * fw / 1080), fh - int(140 * fw / 1080), fw, fh], fill=(255, 80, 60, 90))   # ícone de som
if cx + fw <= 1700:
    mini.paste(capa, (cx, cy))
    d.text((cx, cy + fh + 8), 'margem de 72 px e cantos do Instagram', fill=(235, 230, 220), font=F(20))
mini.save(os.path.join(D, 'miniatura.png'))
print(os.path.join(D, 'folha.png'), sheet.size); print(os.path.join(D, 'miniatura.png'), mini.size)

# ---- lado a lado com a referência (quando houver): nosso slide N | ref-*-NN.png
if '--lado' in sys.argv:
    ld = sys.argv[sys.argv.index('--lado') + 1]
    refs = sorted(f for f in glob.glob(os.path.join(ld, 'ref-*-[0-9][0-9].png')) if 'nosso' not in os.path.basename(f))
    pw = 400
    pares = []
    for k, im in enumerate(ims):
        r = next((f for f in refs if f.endswith(f'-{k + 1:02d}.png')), None)
        b = Image.open(r).convert('RGB') if r else None
        a2 = im.resize((pw, int(im.height * pw / im.width)), Image.LANCZOS)
        b2 = b.resize((pw, int(b.height * pw / b.width)), Image.LANCZOS) if b else None
        pares.append((a2, b2))
    ph = max(max(a.height, b.height if b else 0) for a, b in pares)
    cols = 2
    rows = (len(pares) + cols - 1) // cols
    L = Image.new('RGB', (cols * (2 * pw + 3 * gap) + gap, rows * (ph + lab + gap) + gap), (24, 22, 20))
    d = ImageDraw.Draw(L)
    for k, (a, b) in enumerate(pares):
        x = gap + (k % cols) * (2 * pw + 3 * gap); y = gap + (k // cols) * (ph + lab + gap)
        d.text((x + 4, y + 6), f'{k + 1:02d} · nosso', fill=(240, 235, 225), font=F(22))
        d.text((x + pw + gap + 4, y + 6), 'referência', fill=(240, 235, 225), font=F(22))
        L.paste(a, (x, y + lab))
        if b: L.paste(b, (x + pw + gap, y + lab))
    L.save(os.path.join(D, 'lado-a-lado.png'))
    print(os.path.join(D, 'lado-a-lado.png'), L.size)
