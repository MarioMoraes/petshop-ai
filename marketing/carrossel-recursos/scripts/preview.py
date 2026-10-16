"""Gera preview.html na raiz do projeto com os slides em ordem (PNG do estático e/ou MP4 do vivo).
  python3 scripts/preview.py            (lê resultados/estatico/*.png e resultados/*.mp4; lê legenda.txt se existir)
Abra via servidor local (python3 -m http.server) pra os MP4 tocarem.
"""
import glob, html, os
ROOT = os.getcwd()
pngs = sorted(glob.glob('resultados/estatico/slide-*.png'))
mp4s = sorted(glob.glob('resultados/slide-*.mp4'))
cap = open('legenda.txt').read().strip() if os.path.exists('legenda.txt') else ''
nome = os.path.basename(ROOT)
def strip(items, kind):
    if not items: return ''
    tags = ''.join(f'<figure><img src="{p}" loading="lazy"><figcaption>{i+1:02d}</figcaption></figure>' if kind == 'png' else
                   f'<figure><video src="{p}" muted loop playsinline controls preload="metadata"></video><figcaption>{i+1:02d}</figcaption></figure>' for i, p in enumerate(items))
    return f'<h2>{"Estático" if kind == "png" else "Vivo"}</h2><div class="strip">{tags}</div>'
botao = '<button onclick="document.querySelectorAll(\'video\').forEach(v=>{v.muted=false;v.currentTime=0;v.play()})">Tocar todos com som</button>' if mp4s else ''
legenda = ('<h2>Legenda</h2><pre>' + html.escape(cap) + '</pre>') if cap else ''
page = f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>{html.escape(nome)} · preview</title>
<style>body{{margin:0;padding:24px;background:#141414;color:#eee;font:14px/1.4 -apple-system,Inter,Helvetica,sans-serif}}
h1{{font-size:18px;font-weight:600;margin:0 0 6px}} h2{{font-size:13px;font-weight:600;color:#999;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.1em}}
.strip{{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px}} figure{{margin:0;flex:0 0 auto}}
img,video{{width:390px;aspect-ratio:4/5;display:block;border-radius:6px;background:#222}} figcaption{{color:#777;font-size:12px;margin-top:4px}}
pre{{white-space:pre-wrap;max-width:780px;color:#ccc;font:13px/1.5 inherit;border-top:1px solid #333;padding-top:12px;margin-top:18px}}
button{{margin:8px 0;background:#F75320;border:0;color:#fff;padding:8px 14px;border-radius:6px;font-weight:600;cursor:pointer}}</style></head>
<body><h1>{html.escape(nome)}</h1><p style="color:#888;margin:0">{len(pngs)} slides estáticos · {len(mp4s)} vivos · 390 px como no celular</p>
{strip(pngs, "png")}{strip(mp4s, "mp4")}
{botao}
{legenda}
</body></html>'''
open('preview.html', 'w').write(page)
print('preview.html', len(pngs), 'png', len(mp4s), 'mp4')
