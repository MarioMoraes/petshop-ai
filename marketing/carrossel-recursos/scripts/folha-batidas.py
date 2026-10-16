"""Folha de contato por batida de um slide vivo: um quadro a cada 0,5 s, com o tempo embaixo.
  python3 scripts/folha-batidas.py resultados/quadros/slide-02 resultados/folhas/slide-02-batidas.jpg
Lê os PNGs guardados pelo render (0000.png, 0015.png, …). Rode com python3 que tenha Pillow."""
import sys, os
from PIL import Image, ImageDraw, ImageFont
src, out = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
fs = sorted(f for f in os.listdir(src) if f.endswith('.png') and int(f[:4]) % 15 == 0)
W, H = 270, 338
cols = 8 if len(fs) > 12 else 6
rows = (len(fs) + cols - 1) // cols
F = ImageFont.truetype('/System/Library/Fonts/SFNSMono.ttf', 18)
s = Image.new('RGB', (cols * (W + 8) + 8, rows * (H + 30) + 8), (24, 24, 24)); d = ImageDraw.Draw(s)
for i, f in enumerate(fs):
    im = Image.open(os.path.join(src, f)).convert('RGB').resize((W, H), Image.LANCZOS)
    x, y = 8 + (i % cols) * (W + 8), 8 + (i // cols) * (H + 30)
    s.paste(im, (x, y)); t = int(f[:4]) / 30
    d.text((x + 4, y + H + 5), f'{t:.1f} s  batida {int(round(t * 2)) + 1}', font=F, fill=(237, 233, 225))
s.save(out, quality=88); print(out, len(fs))
