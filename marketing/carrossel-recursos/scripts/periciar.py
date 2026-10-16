#!/usr/bin/env python3
"""periciar.py · mede uma referência (pasta de imagens ou um vídeo) e escreve a perícia em números.

uso (na pasta do projeto):
  python3 scripts/periciar.py refs/referencia-x                 # pasta com os slides (jpg/png/webp, qualquer tamanho)
  python3 scripts/periciar.py refs/referencia.mp4 --passo 0.5   # vídeo: um quadro a cada 0,5 s
  opções: --saida docs   --frames refs/frames   --sem-ocr   --nome ref

sai:
  refs/frames/ref-<nome>-NN.png   os quadros normalizados a 1080 px de largura (a altura segue a proporção original)
  refs/frames/pericia-NN.jpg      o mesmo quadro com as medidas desenhadas por cima (texto, foto, formas, margem, cantos)
  refs/frames/tipo-NN-k.png       recortes a 2x das maiores linhas de texto: é aqui que se identifica a fonte, no olho
  refs/frames/folha-pericia.jpg   todas as sobreposições numa folha só
  docs/pericia.json               todos os números
  docs/pericia.md                 as tabelas que o guia-de-estilo cita

O que a ferramenta mede: paleta (hex e cobertura, com papel de cada cor), texto (linhas, tamanho estimado em px,
níveis, caixa, alinhamento, margem, entrelinha, cor), preenchimento (quanto da tela tem tinta, foto e vazio),
imagem (onde está, quanto ocupa, se sangra, luz, saturação, temperatura, grão), textura do fundo, formas chapadas
(barras, pílulas, círculos, cartões: cor, tamanho, raio), cantos do Instagram, e o que se repete de slide em slide
(a anatomia fixa). O que ela NÃO vê, e fica pro olho: qual é a fonte (olhe os recortes tipo-NN-k.png e o atlas),
como a imagem foi feita (foto, 3D, ilustração, colagem), o dispositivo de cada slide e a ideia que organiza tudo.
"""
import argparse, json, math, re, shutil, subprocess, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

W = 1080
AQUI = Path(__file__).resolve().parent
EXT_IMG = {'.jpg', '.jpeg', '.png', '.webp'}
EXT_VID = {'.mp4', '.mov', '.webm', '.m4v', '.mkv'}


# ---------- cor ----------
def hexa(c):
    return '#%02X%02X%02X' % tuple(int(round(float(v))) for v in c)


def lum(c):
    def f(u):
        u = u / 255
        return u / 12.92 if u <= 0.03928 else ((u + 0.055) / 1.055) ** 2.4
    r, g, b = c
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def contraste(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def sat(c):
    mx, mn = max(c), min(c)
    return 0.0 if mx == 0 else (mx - mn) / mx


def dist(a, b):
    return float(np.sqrt(((np.asarray(a, float) - np.asarray(b, float)) ** 2).sum()))


def kmeans(px, k=6, it=14, seed=1):
    """k-means simples em RGB; devolve [(cor, cobertura)] ordenado por cobertura, parecidos fundidos"""
    rng = np.random.default_rng(seed)
    px = np.asarray(px, np.float32)
    if len(px) == 0:
        return []
    if len(px) > 30000:
        px = px[rng.choice(len(px), 30000, replace=False)]
    k = min(k, len(px))
    c = px[rng.choice(len(px), k, replace=False)].copy()
    for _ in range(it):
        lab = ((px[:, None, :] - c[None, :, :]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            s = px[lab == j]
            if len(s):
                c[j] = s.mean(0)
    lab = ((px[:, None, :] - c[None, :, :]) ** 2).sum(-1).argmin(1)
    cov = np.bincount(lab, minlength=k) / len(px)
    grupos = [(c[j], cov[j]) for j in range(k) if cov[j] > 0]
    fundiu = True
    while fundiu:
        fundiu = False
        for i in range(len(grupos)):
            for j in range(i + 1, len(grupos)):
                if dist(grupos[i][0], grupos[j][0]) < 22:
                    ci, wi = grupos[i]; cj, wj = grupos[j]
                    grupos[i] = ((ci * wi + cj * wj) / (wi + wj), wi + wj)
                    grupos.pop(j); fundiu = True
                    break
            if fundiu:
                break
    return sorted(grupos, key=lambda g: -g[1])


# ---------- entrada ----------
def proporcao(w, h):
    r = w / h
    for nome, v in [('4:5', 0.8), ('1:1', 1.0), ('9:16', 9 / 16), ('3:4', 0.75), ('16:9', 16 / 9), ('2:3', 2 / 3)]:
        if abs(r - v) < 0.02:
            return f'{nome} ({r:.2f})'
    return f'{w}:{h} ({r:.2f})'


def coletar(entrada, frames, passo):
    p = Path(entrada).expanduser()
    if p.is_file() and p.suffix.lower() in EXT_VID:
        frames.mkdir(parents=True, exist_ok=True)
        for f in frames.glob('bruto-*.png'):
            f.unlink()
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(p), '-vf', f'fps=1/{passo}',
                        str(frames / 'bruto-%03d.png')], check=True)
        return sorted(frames.glob('bruto-*.png')), True
    if p.is_file():
        return [p], False
    arqs = sorted(f for f in p.iterdir() if f.suffix.lower() in EXT_IMG and not f.name.startswith('.')
                  and not re.match(r'(folha|pericia|tipo-|contato|miniatura|preview|galeria)', f.name, re.I))
    so_slides = [f for f in arqs if re.match(r'slide[-_ ]?\d', f.name, re.I)]
    if so_slides:
        arqs = so_slides
    if not arqs:
        raise SystemExit(f'nenhuma imagem em {p}')
    return arqs, False


def normalizar(path, i, frames, nome):
    im = Image.open(path).convert('RGB')
    w0, h0 = im.size
    h = int(round(h0 * W / w0))
    im = im.resize((W, h), Image.LANCZOS)
    out = frames / f'ref-{nome}-{i:02d}.png'
    im.save(out)
    return im, (w0, h0), out


# ---------- OCR ----------
def ocr(caminhos, build):
    fonte = AQUI / 'ocr.swift'
    bin_ = build / 'ocr'
    if not bin_.exists() and fonte.exists() and shutil.which('swiftc'):
        build.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(['swiftc', '-O', str(fonte), '-o', str(bin_)], capture_output=True, text=True)
        if r.returncode:
            print('OCR: swiftc não compilou, vou rodar interpretado:', r.stderr[:200])
    if bin_.exists():
        cmd = [str(bin_)]
    elif fonte.exists() and shutil.which('swift'):
        cmd = ['swift', str(fonte)]
    else:
        print('OCR indisponível (sem swift): sigo sem as caixas de texto')
        return {}
    r = subprocess.run(cmd + [str(c) for c in caminhos], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        print('OCR falhou:', r.stderr[:300])
        return {}


# ---------- máscaras ----------
def mascara_foto(a):
    """blocos de 24 px com muitas cores e muito gradiente = foto; muitas cores e pouco gradiente = degradê"""
    H = a.shape[0]
    B = 24
    g = a.astype(np.float32)
    grad = np.zeros(a.shape[:2], np.float32)
    grad[:-1, :] += np.abs(np.diff(g, axis=0)).mean(axis=2)
    grad[:, :-1] += np.abs(np.diff(g, axis=1)).mean(axis=2)
    q = a // 32
    code = q[..., 0] * 64 + q[..., 1] * 8 + q[..., 2]
    ny, nx = H // B, W // B
    foto = np.zeros((ny, nx), bool)
    liso_colorido = np.zeros((ny, nx), bool)
    for by in range(ny):
        for bx in range(nx):
            sl = (slice(by * B, (by + 1) * B), slice(bx * B, (bx + 1) * B))
            cores = len(np.unique(code[sl]))
            gm = float(grad[sl].mean())
            if cores >= 8 and gm > 4.0:
                foto[by, bx] = True
            elif cores >= 5 and gm <= 4.0:
                liso_colorido[by, bx] = True
    foto = ndi.binary_opening(foto, iterations=1)
    cand = foto | liso_colorido
    rot, n = ndi.label(cand)
    foto_final = np.zeros_like(foto)
    degrade = np.zeros_like(foto)
    for k in range(1, n + 1):
        comp = rot == k
        if (comp & foto).sum() >= max(2, 0.25 * comp.sum()):
            foto_final |= comp
        elif comp.sum() >= 0.08 * ny * nx:
            degrade |= comp
    foto_final = ndi.binary_closing(foto_final, iterations=3)
    foto_final = ndi.binary_fill_holes(foto_final)

    def expande(m):
        full = np.zeros((H, W), bool)
        mm = np.kron(m, np.ones((B, B), bool))
        full[:mm.shape[0], :mm.shape[1]] = mm
        return full
    return expande(foto_final), expande(degrade)


def mascara_caixas(caixas, H, folga=0):
    m = np.zeros((H, W), bool)
    for c in caixas:
        x0, y0 = max(0, int(c['x'] - folga)), max(0, int(c['y'] - folga))
        x1, y1 = min(W, int(c['x'] + c['w'] + folga)), min(H, int(c['y'] + c['h'] + folga))
        m[y0:y1, x0:x1] = True
    return m


# ---------- texto ----------
def linhas_de(caixas, H):
    out = []
    for c in caixas:
        t = c['texto'].strip()
        if not t or c.get('conf', 1) < 0.3 or c['h'] < 9:
            continue
        letras = [ch for ch in t if ch.isalpha()]
        caps = sum(ch.isupper() for ch in letras) / max(1, len(letras))
        desc = any(ch in 'gjpqyçQ' for ch in t)
        asc = any(ch.isupper() or ch in 'bdfhklt0123456789' for ch in t)
        if caps > 0.8 and not desc:
            px = c['h'] / 0.72
        elif desc and asc:
            px = c['h'] / 0.98
        elif desc:
            px = c['h'] / 0.84
        else:
            px = c['h'] / 0.80
        out.append({'x': round(c['x']), 'y': round(c['y']), 'w': round(c['w']), 'h': round(c['h']),
                    'texto': t, 'px': int(round(px)), 'caps': round(caps, 2), 'palavras': len(t.split())})
    return out


def niveis_de(tamanhos):
    """agrupa tamanhos (px) em níveis: novo nível quando cai abaixo de 78% do maior do grupo"""
    grupos = []
    for s in sorted(set(tamanhos), reverse=True):
        if grupos and s >= grupos[-1][0] * 0.78:
            grupos[-1].append(s)
        else:
            grupos.append([s])
    return grupos


def niveis_consolidados(tamanhos, maximo=6):
    """como niveis_de, mais frouxo (70%) e fundindo vizinhos até sobrar no máximo `maximo` níveis"""
    grupos = []
    for s in sorted(set(tamanhos), reverse=True):
        if grupos and s >= grupos[-1][0] * 0.70:
            grupos[-1].append(s)
        else:
            grupos.append([s])
    while len(grupos) > maximo:
        i = min(range(len(grupos) - 1), key=lambda i: grupos[i][-1] / grupos[i + 1][0])
        grupos[i] = grupos[i] + grupos[i + 1]; grupos.pop(i + 1)
    return grupos


def nivel_de(px, grupos):
    for i, g in enumerate(grupos):
        if px in g:
            return i + 1
    return len(grupos)


def alinhamento(linhas):
    if not linhas:
        return 'nenhum', None, None
    esq = np.array([l['x'] for l in linhas]); dirs = np.array([l['x'] + l['w'] for l in linhas])
    cen = np.array([l['x'] + l['w'] / 2 for l in linhas])
    be = np.bincount((esq // 16).astype(int)); n_esq = be.max(); m_esq = int(be.argmax() * 16 + 8)
    bd = np.bincount(((W - dirs) // 16).clip(0).astype(int)); n_dir = bd.max(); m_dir = int(bd.argmax() * 16 + 8)
    n_cen = int((np.abs(cen - W / 2) < 22).sum())
    if n_cen >= max(n_esq, n_dir) and n_cen >= 2:
        return 'centro', m_esq, m_dir
    if n_dir > n_esq:
        return 'direita', m_esq, m_dir
    return 'esquerda', m_esq, m_dir


def entrelinha(linhas):
    vals = []
    ls = sorted(linhas, key=lambda l: l['y'])
    for a, b in zip(ls, ls[1:]):
        if abs(a['px'] - b['px']) <= 0.25 * a['px'] and b['y'] > a['y']:
            sobre = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x'])
            r = (b['y'] - a['y']) / a['px']
            if sobre > 0 and 0.75 <= r <= 2.2:
                vals.append(r)
    return round(float(np.median(vals)), 2) if vals else None


def cor_do_texto(a, l):
    H = a.shape[0]
    x0, y0, x1, y1 = max(0, l['x']), max(0, l['y']), min(W, l['x'] + l['w']), min(H, l['y'] + l['h'])
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    dentro = a[y0:y1, x0:x1].reshape(-1, 3)
    f = 8
    anel = np.zeros((H, W), bool)
    anel[max(0, y0 - f):min(H, y1 + f), max(0, x0 - f):min(W, x1 + f)] = True
    anel[y0:y1, x0:x1] = False
    fundo = np.median(a[anel].reshape(-1, 3), axis=0) if anel.any() else dentro.mean(0)
    grupos = kmeans(dentro, k=3, it=8)
    if not grupos:
        return None
    tinta = max(grupos, key=lambda g: dist(g[0], fundo))
    return tinta[0], fundo


# ---------- formas ----------
def formas_de(a, cor, foto, caixas_m, minimo=0.006):
    H = a.shape[0]
    m = (np.abs(a.astype(np.int16) - np.asarray(cor, np.int16)).sum(-1) < 60) & ~foto
    m = ndi.binary_opening(m, iterations=2)
    rot, n = ndi.label(m)
    out = []
    for k in range(1, n + 1):
        comp = rot == k
        area = int(comp.sum())
        if area < minimo * W * H:
            continue
        ys, xs = np.where(comp)
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
        bw, bh = x1 - x0, y1 - y0
        cheio = area / (bw * bh)
        if cheio < 0.5:
            continue  # mancha irregular (sobra de foto ou degradê), não é forma desenhada
        if caixas_m[y0:y1, x0:x1].mean() > 0.85 and area < 0.03 * W * H:
            continue  # é a própria letra em cor de destaque, não uma forma
        # raio do canto: anda na diagonal a partir do canto superior esquerdo até achar a forma
        d = 0
        while d < min(bw, bh) // 2 and not comp[y0 + d, x0 + d]:
            d += 1
        raio = int(round(d / 0.293)) if d > 1 else 0
        raio = min(raio, min(bw, bh) // 2)
        if cheio >= 0.92 and raio <= 6:
            tipo = 'retângulo'
        elif 0.72 <= cheio <= 0.86 and abs(bw - bh) < 0.12 * max(bw, bh):
            tipo = 'círculo'
        elif cheio >= 0.80:
            tipo = 'pílula' if bw > 1.8 * bh and raio >= bh * 0.4 else 'retângulo arredondado'
        else:
            tipo = 'forma'
        sangra = x0 <= 2 or y0 <= 2 or x1 >= W - 2 or y1 >= H - 2
        out.append({'tipo': tipo, 'x': x0, 'y': y0, 'w': bw, 'h': bh, 'raio': (None if tipo == 'forma' else raio), 'area_pct': round(100 * area / (W * H), 1), 'sangra': sangra})
    return sorted(out, key=lambda f: -f['area_pct'])[:8]


# ---------- um quadro ----------
def periciar_quadro(im, caixas, idx):
    a = np.asarray(im)
    H = a.shape[0]
    foto, degrade = mascara_foto(a)
    linhas = linhas_de(caixas, H)
    caixas_m = mascara_caixas(linhas, H, folga=4)
    plano = ~foto & ~caixas_m
    sub = (slice(None, None, 4), slice(None, None, 4))

    # paleta do que é chapado (fora da foto e fora do texto)
    px_plano = a[sub][plano[sub]]
    paleta = kmeans(px_plano, k=6) if len(px_plano) > 200 else []
    borda = np.concatenate([a[0:12, :].reshape(-1, 3), a[-12:, :].reshape(-1, 3), a[:, 0:12].reshape(-1, 3), a[:, -12:].reshape(-1, 3)])
    borda_plana = np.concatenate([plano[0:12, :].ravel(), plano[-12:, :].ravel(), plano[:, 0:12].ravel(), plano[:, -12:].ravel()])
    if paleta:
        if borda_plana.mean() > 0.3:
            bm = np.median(borda[borda_plana], axis=0)
            fundo = min(paleta, key=lambda g: dist(g[0], bm))[0]
        else:
            fundo = paleta[0][0]
    else:
        fundo = np.median(a[sub].reshape(-1, 3), axis=0)
    fundo_tipo = 'claro' if lum(fundo) > 0.35 else ('escuro' if lum(fundo) < 0.12 else 'médio')

    # cor do texto por linha (e a tinta dominante nos dois primeiros níveis)
    grupos = niveis_de([l['px'] for l in linhas])
    cores_txt = []
    for l in linhas:
        l['nivel'] = nivel_de(l['px'], grupos)
        r = cor_do_texto(a, l)
        if r:
            l['cor'] = hexa(r[0]); l['sat'] = round(sat(r[0]), 2); l['contraste'] = round(contraste(r[0], r[1]), 1)
            cores_txt.append((r[0], l['px'] * l['w']))
    tinta = None
    if cores_txt:
        grupos_cor = []
        for c, peso in cores_txt:
            for g in grupos_cor:
                if dist(g[0], c) < 34:
                    g[1] += peso; break
            else:
                grupos_cor.append([c, peso])
        tinta = max(grupos_cor, key=lambda g: g[1])[0]

    # destaque: a cor chapada mais saturada com cobertura entre 0,3% e 35%, que não é o fundo
    destaque = None
    cand = [(c, w) for c, w in paleta if sat(c) >= 0.32 and 0.003 <= w <= 0.35 and dist(c, fundo) > 40 and lum(c) < 0.85]
    if cand:
        destaque = max(cand, key=lambda g: sat(g[0]) * (0.5 + min(g[1], 0.2) / 0.2))[0]
    for l in linhas:  # palavra gigante em cor saturada também é destaque
        if l['nivel'] == 1 and l.get('sat', 0) >= 0.4 and destaque is None:
            destaque = np.array([int(l['cor'][i:i + 2], 16) for i in (1, 3, 5)], float)

    papel = []
    for c, w in paleta:
        nome = 'fundo' if dist(c, fundo) < 1 else ('destaque' if destaque is not None and dist(c, destaque) < 1 else
               ('tinta' if tinta is not None and dist(c, tinta) < 40 else ('neutro claro' if lum(c) > 0.5 else 'neutro escuro')))
        papel.append({'hex': hexa(c), 'cobertura_pct': round(100 * w * plano[sub].mean(), 1), 'papel': nome, 'saturacao': round(sat(c), 2)})

    # preenchimento
    tinta_m = (np.abs(a.astype(np.int16) - np.asarray(fundo, np.int16)).sum(-1) > 90) & ~foto
    tinta_m = ndi.binary_opening(tinta_m, iterations=1)
    conteudo = tinta_m | foto | caixas_m
    ys, xs = np.where(conteudo)
    if len(ys):
        bandas = {'topo': int(ys.min()), 'pe': int(H - ys.max()), 'esq': int(xs.min()), 'dir': int(W - xs.max())}
    else:
        bandas = {'topo': H, 'pe': 0, 'esq': W, 'dir': 0}
    preench = {'foto_pct': round(100 * foto.mean(), 1), 'texto_pct': round(100 * caixas_m.mean(), 1),
               'tinta_pct': round(100 * (tinta_m & ~caixas_m).mean(), 1), 'vazio_pct': round(100 * (1 - conteudo.mean()), 1),
               'bandas_vazias_px': bandas, 'degrade_pct': round(100 * degrade.mean(), 1)}

    # imagem
    imagem = None
    if foto.mean() > 0.02:
        ys, xs = np.where(foto)
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
        pxf = a[foto].astype(np.float32)
        g = np.asarray(im.convert('L'), np.float32)
        alta = g - ndi.gaussian_filter(g, 1.2)
        lap = ndi.laplace(ndi.gaussian_filter(g, 0.8))
        imagem = {'bbox': [x0, y0, x1 - x0, y1 - y0], 'ocupa_pct': round(100 * foto.mean(), 1),
                  'sangra': {'topo': y0 <= 2, 'pe': y1 >= H - 2, 'esq': x0 <= 2, 'dir': x1 >= W - 2},
                  'luminancia': round(float(pxf.mean() / 255), 2),
                  'saturacao': round(float(np.mean([sat(p) for p in pxf[::97]])), 2),
                  'temperatura': 'quente' if pxf[:, 0].mean() - pxf[:, 2].mean() > 12 else ('fria' if pxf[:, 2].mean() - pxf[:, 0].mean() > 12 else 'neutra'),
                  'grao': round(float(alta[foto].std()), 1), 'nitidez': round(float(lap[foto].var()), 0),
                  'texto_sobre_foto': bool((caixas_m & foto).sum() > 0.5 * caixas_m.sum()) if caixas_m.any() else False}

    # textura do fundo chapado
    g = np.asarray(im.convert('L'), np.float32)
    alta = g - ndi.gaussian_filter(g, 1.5)
    plano_e = ndi.binary_erosion(plano, iterations=14)
    textura_std = float(alta[plano_e].std()) if plano_e.sum() > 2000 else (float(alta[plano].std()) if plano.any() else 0.0)
    textura = 'liso' if textura_std < 1.0 else ('grão leve' if textura_std < 2.6 else 'textura visível')

    # formas
    formas = []
    if destaque is not None:
        formas += [dict(f, cor=hexa(destaque)) for f in formas_de(a, destaque, foto, caixas_m)]
    for c, w in paleta:
        if dist(c, fundo) > 40 and (destaque is None or dist(c, destaque) > 40) and w >= 0.015 and (tinta is None or dist(c, tinta) > 40 or w > 0.08):
            formas += [dict(f, cor=hexa(c)) for f in formas_de(a, c, foto, caixas_m, minimo=0.015) if f['tipo'] != 'forma']
    formas = sorted(formas, key=lambda f: -f['area_pct'])[:8]

    # cantos do Instagram (contador em cima à direita, som embaixo à direita)
    zonas = [('contador', 880, 0, W, 150), ('som', 940, H - 140, W, H)]
    cantos = []
    for nome, zx0, zy0, zx1, zy1 in zonas:
        for l in linhas:
            if l['x'] + l['w'] > zx0 and l['x'] < zx1 and l['y'] + l['h'] > zy0 and l['y'] < zy1:
                cantos.append({'zona': nome, 'texto': l['texto'][:30]})

    ali, m_esq, m_dir = alinhamento(linhas)
    tipo = 'foto' if foto.mean() >= 0.55 else ('misto' if foto.mean() >= 0.12 else 'chapado')
    return {
        'quadro': idx, 'altura': H, 'tipo': tipo, 'fundo': {'hex': hexa(fundo), 'tom': fundo_tipo, 'textura': textura, 'textura_std': round(textura_std, 2)},
        'tinta': hexa(tinta) if tinta is not None else None, 'destaque': hexa(destaque) if destaque is not None else None,
        'contraste_fundo_tinta': round(contraste(fundo, tinta), 1) if tinta is not None else None,
        'paleta': papel, 'texto': {'linhas': len(linhas), 'palavras': sum(l['palavras'] for l in linhas), 'maior_px': max([l['px'] for l in linhas], default=0),
                                   'menor_px': min([l['px'] for l in linhas], default=0), 'niveis': [sorted(g, reverse=True) for g in grupos],
                                   'alinhamento': ali, 'margem_esq': m_esq, 'margem_dir': m_dir, 'entrelinha': entrelinha(linhas),
                                   'caps_media': round(float(np.mean([l['caps'] for l in linhas])), 2) if linhas else None,
                                   'max_palavras_linha': max([l['palavras'] for l in linhas], default=0),
                                   'topo_primeira': min([l['y'] for l in linhas], default=None), 'pe_ultima': max([l['y'] + l['h'] for l in linhas], default=None)},
        'linhas': linhas, 'preenchimento': preench, 'imagem': imagem, 'formas': formas, 'cantos_ig': cantos,
        '_masks': (foto, caixas_m),
    }


# ---------- desenho ----------
def fonte_pil(tam):
    for p in ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf']:
        try:
            return ImageFont.truetype(p, tam)
        except Exception:
            pass
    return ImageFont.load_default()


def desenhar(im, q, out):
    foto, _ = q['_masks']
    H = q['altura']
    base = im.convert('RGBA')
    veu = Image.new('RGBA', base.size, (0, 0, 0, 0))
    vd = ImageDraw.Draw(veu)
    if foto.any():
        m = Image.fromarray((foto * 255).astype(np.uint8))
        cor = Image.new('RGBA', base.size, (255, 0, 160, 70))
        veu.paste(cor, (0, 0), m)
    cores_nivel = {1: (0, 200, 90), 2: (0, 150, 255), 3: (255, 170, 0), 4: (170, 90, 255)}
    for l in q['linhas']:
        c = cores_nivel.get(l['nivel'], (120, 120, 120))
        vd.rectangle([l['x'], l['y'], l['x'] + l['w'], l['y'] + l['h']], outline=c + (255,), width=3)
        vd.text((l['x'], max(0, l['y'] - 18)), f"{l['px']}px n{l['nivel']}", fill=c + (255,), font=fonte_pil(16))
    for f in q['formas']:
        vd.rectangle([f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']], outline=(255, 120, 0, 255), width=4)
        vd.text((f['x'] + 6, f['y'] + 6), f"{f['tipo']} {f['w']}×{f['h']}" + (f" r{f['raio']}" if f['raio'] is not None else ''), fill=(255, 120, 0, 255), font=fonte_pil(16))
    for zx0, zy0, zx1, zy1 in [(880, 0, W, 150), (940, H - 140, W, H)]:
        vd.rectangle([zx0, zy0, zx1 - 1, zy1 - 1], outline=(230, 0, 0, 255), width=3)
    me = q['texto']['margem_esq']
    if me:
        vd.line([me, 0, me, H], fill=(0, 200, 90, 160), width=2)
    b = q['preenchimento']['bandas_vazias_px']
    vd.rectangle([b['esq'], b['topo'], W - b['dir'], H - b['pe']], outline=(255, 255, 255, 140), width=2)
    comp = Image.alpha_composite(base, veu)
    d = ImageDraw.Draw(comp)
    p = q['preenchimento']
    rod = (f"#{q['quadro']:02d} {q['tipo']} · fundo {q['fundo']['hex']} {q['fundo']['tom']} {q['fundo']['textura']} · tinta {q['tinta']} · destaque {q['destaque']} · "
           f"foto {p['foto_pct']}% texto {p['texto_pct']}% vazio {p['vazio_pct']}% · {q['texto']['linhas']} linhas, maior {q['texto']['maior_px']}px, {q['texto']['alinhamento']}, margem {q['texto']['margem_esq']}")
    d.rectangle([0, H - 34, W, H], fill=(0, 0, 0, 200))
    d.text((8, H - 28), rod[:170], fill=(255, 255, 255), font=fonte_pil(15))
    comp.convert('RGB').save(out, quality=88)


def recortes_tipo(im, q, frames, nome):
    vistos, k, saidas = set(), 0, []
    for l in sorted(q['linhas'], key=lambda l: -l['px']):
        if l['nivel'] in vistos or k >= 3:
            continue
        vistos.add(l['nivel']); k += 1
        f = max(8, l['px'] // 6)
        c = im.crop((max(0, l['x'] - f), max(0, l['y'] - f), min(W, l['x'] + l['w'] + f), min(q['altura'], l['y'] + l['h'] + f)))
        c = c.resize((c.width * 2, c.height * 2), Image.LANCZOS)
        out = frames / f'tipo-{nome}-{q["quadro"]:02d}-{k}.png'
        c.save(out); saidas.append(str(out))
    return saidas


def folha(quadros_jpg, out):
    ims = [Image.open(p) for p in quadros_jpg]
    if not ims:
        return
    tw = 360
    cols = min(4, len(ims))
    th = int(ims[0].height * tw / ims[0].width)
    rows = math.ceil(len(ims) / cols)
    f = Image.new('RGB', (cols * tw + (cols + 1) * 12, rows * th + (rows + 1) * 12), (24, 24, 24))
    for i, im in enumerate(ims):
        f.paste(im.resize((tw, int(im.height * tw / im.width))), (12 + (i % cols) * (tw + 12), 12 + (i // cols) * (th + 12)))
    f.save(out, quality=86)


# ---------- consolidação ----------
def consolidar(qs):
    n = len(qs)
    # paleta
    cores = []
    for q in qs:
        for c in q['paleta']:
            rgb = np.array([int(c['hex'][i:i + 2], 16) for i in (1, 3, 5)], float)
            for g in cores:
                if dist(g['rgb'], rgb) < 26:
                    g['rgb'] = (g['rgb'] * g['n'] + rgb) / (g['n'] + 1); g['n'] += 1; g['cob'] += c['cobertura_pct']; g['papeis'].add(c['papel']); g['slides'].add(q['quadro'])
                    break
            else:
                cores.append({'rgb': rgb, 'n': 1, 'cob': c['cobertura_pct'], 'papeis': {c['papel']}, 'slides': {q['quadro']}})
    for q in qs:
        for chave in ('tinta', 'destaque'):
            if q[chave]:
                rgb = np.array([int(q[chave][i:i + 2], 16) for i in (1, 3, 5)], float)
                for g in cores:
                    if dist(g['rgb'], rgb) < 30:
                        g['papeis'].add(chave); g['slides'].add(q['quadro']); break
                else:
                    cores.append({'rgb': rgb, 'n': 1, 'cob': 0, 'papeis': {chave}, 'slides': {q['quadro']}})
    paleta = [{'hex': hexa(g['rgb']), 'papeis': sorted(g['papeis']), 'em_slides': len(g['slides']), 'cobertura_media_pct': round(g['cob'] / max(1, len(g['slides'])), 1)}
              for g in sorted(cores, key=lambda g: (-len(g['slides']), -g['cob']))]
    # escala tipográfica
    todas = [(l['px'], l, q['quadro']) for q in qs for l in q['linhas']]
    grupos = niveis_consolidados([t[0] for t in todas])
    escala = []
    for i, g in enumerate(grupos):
        ls = [t for t in todas if t[0] in g]
        exemplo = max(ls, key=lambda t: len(t[1]['texto']))[1]['texto']
        escala.append({'nivel': i + 1, 'px_mediana': int(np.median([t[0] for t in ls])), 'px_min': min(g), 'px_max': max(g),
                       'linhas': len(ls), 'em_slides': len({t[2] for t in ls}), 'caps_media': round(float(np.mean([t[1]['caps'] for t in ls])), 2),
                       'cores': sorted({t[1].get('cor') for t in ls if t[1].get('cor')})[:4], 'exemplo': exemplo[:60]})
    # grade
    margens = [q['texto']['margem_esq'] for q in qs if q['texto']['alinhamento'] == 'esquerda' and q['texto']['margem_esq']]
    topos = [q['texto']['topo_primeira'] for q in qs if q['texto']['topo_primeira'] is not None]
    pes = [q['altura'] - q['texto']['pe_ultima'] for q in qs if q['texto']['pe_ultima'] is not None]
    ents = [q['texto']['entrelinha'] for q in qs if q['texto']['entrelinha']]
    alis = [q['texto']['alinhamento'] for q in qs]
    grade = {'margem_esq_mediana': int(np.median(margens)) if margens else None, 'margem_esq_desvio': int(np.std(margens)) if margens else None,
             'topo_primeiro_texto_mediana': int(np.median(topos)) if topos else None, 'pe_ultimo_texto_mediana': int(np.median(pes)) if pes else None,
             'entrelinha_mediana': round(float(np.median(ents)), 2) if ents else None,
             'alinhamento_dominante': max(set(alis), key=alis.count) if alis else None,
             'margens_vazias_medianas': {k: int(np.median([q['preenchimento']['bandas_vazias_px'][k] for q in qs])) for k in ('topo', 'pe', 'esq', 'dir')}}
    # anatomia fixa (textos repetidos na mesma posição)
    rep = {}
    for q in qs:
        for l in q['linhas']:
            chave = re.sub(r'\W+', ' ', l['texto'].lower()).strip()
            if len(chave) < 2:
                continue
            rep.setdefault(chave, []).append((q['quadro'], l['x'], l['y'], l['px']))
    anatomia = []
    for chave, oc in rep.items():
        slides = {o[0] for o in oc}
        if len(slides) >= max(2, round(0.5 * n)) and np.std([o[2] for o in oc]) < 40:
            anatomia.append({'texto': chave, 'em_slides': len(slides), 'x': int(np.median([o[1] for o in oc])), 'y': int(np.median([o[2] for o in oc])), 'px': int(np.median([o[3] for o in oc]))})
    anatomia.sort(key=lambda a: a['y'])
    # ritmo
    ritmo = [{'quadro': q['quadro'], 'tipo': q['tipo'], 'fundo': q['fundo']['tom'], 'hex': q['fundo']['hex'], 'foto_pct': q['preenchimento']['foto_pct'],
              'texto_pct': q['preenchimento']['texto_pct'], 'vazio_pct': q['preenchimento']['vazio_pct'], 'linhas': q['texto']['linhas'], 'maior_px': q['texto']['maior_px']} for q in qs]
    imagens = [q['imagem'] for q in qs if q['imagem']]
    fotos = {'slides_com_foto': len(imagens), 'ocupacao_media_pct': round(float(np.mean([i['ocupa_pct'] for i in imagens])), 1) if imagens else 0,
             'sangra_sempre': all(all(i['sangra'].values()) for i in imagens) if imagens else None,
             'luminancia_media': round(float(np.mean([i['luminancia'] for i in imagens])), 2) if imagens else None,
             'saturacao_media': round(float(np.mean([i['saturacao'] for i in imagens])), 2) if imagens else None,
             'temperatura': max({i['temperatura'] for i in imagens}, key=[i['temperatura'] for i in imagens].count) if imagens else None,
             'grao_medio': round(float(np.mean([i['grao'] for i in imagens])), 1) if imagens else None,
             'texto_sobre_foto': sum(1 for i in imagens if i['texto_sobre_foto'])}
    texturas = [q['fundo']['textura'] for q in qs if q['tipo'] != 'foto']
    return {'paleta': paleta, 'escala': escala, 'grade': grade, 'anatomia_fixa': anatomia, 'ritmo': ritmo, 'imagens': fotos,
            'textura_fundo': max(set(texturas), key=texturas.count) if texturas else None,
            'formas_total': sum(len(q['formas']) for q in qs), 'cantos_ig_invadidos': sum(len(q['cantos_ig']) for q in qs),
            'vazio_medio_pct': round(float(np.mean([q['preenchimento']['vazio_pct'] for q in qs])), 1)}


def escrever_md(qs, cons, meta, out):
    L = []
    L.append(f"# Perícia da referência · {meta['entrada']}\n")
    L.append(f"{len(qs)} quadro(s) · tamanho original {meta['tamanho_original'][0]}×{meta['tamanho_original'][1]} (proporção {meta['proporcao']}) · "
             f"{'vídeo, um quadro a cada ' + str(meta['passo']) + ' s' if meta['video'] else 'imagens paradas'} · normalizado a 1080 px de largura.\n")
    if meta['tamanho_original'][0] < 600:
        L.append(f"**Atenção: a referência veio pequena ({meta['tamanho_original'][0]} px de largura).** Os números de texto e as cores são aproximados; peça a imagem original se puder.\n")
    L.append("Números medidos pela ferramenta. O que é olho (fonte, como a imagem foi feita, dispositivo, ideia) vai no guia-de-estilo, com os recortes `tipo-*.png` como prova.\n")
    L.append("## Slide a slide\n")
    L.append("| # | tipo | fundo | tinta | destaque | foto % | texto % | vazio % | linhas | maior px | níveis (px) | alinh. | margem | formas | cantos IG |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for q in qs:
        p = q['preenchimento']; t = q['texto']
        niv = ' · '.join(str(g[0]) for g in t['niveis'][:4])
        L.append(f"| {q['quadro']} | {q['tipo']} | `{q['fundo']['hex']}` {q['fundo']['tom']}, {q['fundo']['textura']} | `{q['tinta']}` | `{q['destaque']}` | {p['foto_pct']} | {p['texto_pct']} | {p['vazio_pct']} | {t['linhas']} | {t['maior_px']} | {niv} | {t['alinhamento']} | {t['margem_esq']} | "
                 f"{', '.join(f['tipo'] for f in q['formas'][:3]) or '–'} | {len(q['cantos_ig']) or '–'} |")
    L.append("\n## Paleta consolidada\n")
    L.append("| hex | papel | em quantos slides | cobertura média % |")
    L.append("|---|---|---|---|")
    for c in cons['paleta'][:10]:
        L.append(f"| `{c['hex']}` | {', '.join(c['papeis'])} | {c['em_slides']} | {c['cobertura_media_pct']} |")
    L.append("\n## Escala tipográfica (tamanho estimado pela altura da linha; confira no recorte)\n")
    L.append("| nível | px (mediana) | faixa | linhas | slides | caixa alta | cores | exemplo |")
    L.append("|---|---|---|---|---|---|---|---|")
    for e in cons['escala'][:6]:
        L.append(f"| {e['nivel']} | {e['px_mediana']} | {e['px_min']}–{e['px_max']} | {e['linhas']} | {e['em_slides']} | {e['caps_media']} | {' '.join('`' + c + '`' for c in e['cores'])} | {e['exemplo']} |")
    if len(cons['escala']) >= 2:
        L.append(f"\nRazão maior/menor nível: **{cons['escala'][0]['px_mediana'] / max(1, cons['escala'][-1]['px_mediana']):.1f}×** · níveis distintos: **{len(cons['escala'])}**.")
    g = cons['grade']
    L.append("\n## Grade e espaçamento\n")
    L.append(f"- Alinhamento dominante: **{g['alinhamento_dominante']}** · margem esquerda do texto: **{g['margem_esq_mediana']} px** (desvio {g['margem_esq_desvio']}).")
    L.append(f"- Primeiro texto começa em y≈{g['topo_primeiro_texto_mediana']} px; último texto termina a {g['pe_ultimo_texto_mediana']} px do pé.")
    L.append(f"- Entrelinha mediana (em múltiplos do tamanho): **{g['entrelinha_mediana']}**.")
    m = g['margens_vazias_medianas']
    L.append(f"- Bandas vazias medianas (nada desenhado): topo {m['topo']} · pé {m['pe']} · esquerda {m['esq']} · direita {m['dir']} px.")
    L.append("\n## Preenchimento (curva slide a slide)\n")
    L.append("| # | tipo | fundo | foto % | texto % | vazio % | linhas | maior px |")
    L.append("|---|---|---|---|---|---|---|---|")
    for r in cons['ritmo']:
        L.append(f"| {r['quadro']} | {r['tipo']} | {r['fundo']} `{r['hex']}` | {r['foto_pct']} | {r['texto_pct']} | {r['vazio_pct']} | {r['linhas']} | {r['maior_px']} |")
    L.append(f"\nVazio médio: **{cons['vazio_medio_pct']}%**. Ritmo dos fundos: {' → '.join(r['fundo'][0] for r in cons['ritmo'])} (c=claro, e=escuro, m=médio).")
    f = cons['imagens']
    L.append("\n## Imagens\n")
    if f['slides_com_foto']:
        L.append(f"- {f['slides_com_foto']} slide(s) com imagem · ocupação média **{f['ocupacao_media_pct']}%** · sangra nos quatro lados em todos: {f['sangra_sempre']}.")
        L.append(f"- Luminância média {f['luminancia_media']} (0 escuro, 1 claro) · saturação média {f['saturacao_media']} · temperatura **{f['temperatura']}** · grão {f['grao_medio']} (≤2 liso, 2–5 filme leve, >5 grão forte).")
        L.append(f"- Texto sobre a imagem em {f['texto_sobre_foto']} slide(s).")
        L.append("- Como a imagem foi feita (foto, 3D, ilustração, colagem, captura de tela), luz, lente e pose: olhe o quadro e escreva no guia.")
    else:
        L.append("- Nenhuma área de imagem detectada: a referência é chapada (texto, formas e cor).")
    L.append(f"\n## Textura do fundo\n\n- {cons['textura_fundo']} (desvio da alta frequência por slide no JSON).")
    L.append("\n## Formas chapadas\n")
    vistas = 0
    for q in qs:
        for fm in q['formas'][:3]:
            raio = f", raio ≈{fm['raio']} px" if fm['raio'] is not None else ''
            L.append(f"- slide {q['quadro']}: {fm['tipo']} `{fm['cor']}` {fm['w']}×{fm['h']} px em ({fm['x']},{fm['y']}){raio}, {fm['area_pct']}% da tela{', sangra' if fm['sangra'] else ''}")
            vistas += 1
    if not vistas:
        L.append("- nenhuma forma chapada grande.")
    L.append("\n## Anatomia fixa (o que repete na mesma posição)\n")
    if cons['anatomia_fixa']:
        for a in cons['anatomia_fixa']:
            L.append(f"- “{a['texto']}” em {a['em_slides']} slide(s), x≈{a['x']} y≈{a['y']}, {a['px']} px")
    else:
        L.append("- nada se repete textualmente (ou a referência tem um quadro só).")
    L.append(f"\n## Cantos do Instagram\n\n- Linhas de texto invadindo a zona do contador ou do som: **{cons['cantos_ig_invadidos']}**.")
    L.append("\n## Recortes pra identificar a fonte\n")
    for q in qs:
        if q.get('recortes'):
            L.append(f"- slide {q['quadro']}: " + ', '.join(f"`{Path(r).name}`" for r in q['recortes']))
    L.append("\nUse `references/10-atlas-de-fontes.md`: serifa ou grotesca, contraste, largura, altura de x, terminais; escolha a equivalente livre e baixe com `scripts/fontes.py`.\n")
    Path(out).write_text('\n'.join(L) + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('entrada')
    ap.add_argument('--saida', default='docs')
    ap.add_argument('--frames', default='refs/frames')
    ap.add_argument('--passo', type=float, default=0.5)
    ap.add_argument('--nome', default='ref')
    ap.add_argument('--sem-ocr', action='store_true')
    a = ap.parse_args()
    frames = Path(a.frames); frames.mkdir(parents=True, exist_ok=True)
    saida = Path(a.saida); saida.mkdir(parents=True, exist_ok=True)
    arqs, video = coletar(a.entrada, frames, a.passo)
    ims, pngs, tam0 = [], [], None
    for i, f in enumerate(arqs, 1):
        im, t0, png = normalizar(f, i, frames, a.nome)
        ims.append(im); pngs.append(png); tam0 = tam0 or t0
    caixas = {} if a.sem_ocr else ocr(pngs, Path('build'))
    qs, jpgs = [], []
    for i, (im, png) in enumerate(zip(ims, pngs), 1):
        cx = caixas.get(str(png), caixas.get(str(png.resolve()), {})).get('caixas', [])
        q = periciar_quadro(im, cx, i)
        q['recortes'] = recortes_tipo(im, q, frames, a.nome)
        jpg = frames / f'pericia-{a.nome}-{i:02d}.jpg'
        desenhar(im, q, jpg); jpgs.append(jpg)
        q['arquivo'] = str(png)
        qs.append(q)
        print(f"#{i:02d} {q['tipo']:7s} fundo {q['fundo']['hex']} {q['fundo']['tom']:6s} tinta {q['tinta']} destaque {q['destaque']} · foto {q['preenchimento']['foto_pct']}% texto {q['preenchimento']['texto_pct']}% vazio {q['preenchimento']['vazio_pct']}% · {q['texto']['linhas']} linhas, maior {q['texto']['maior_px']}px, {q['texto']['alinhamento']}")
    folha(jpgs, frames / f'folha-pericia-{a.nome}.jpg')
    cons = consolidar(qs)
    meta = {'entrada': a.entrada, 'video': video, 'passo': a.passo, 'tamanho_original': tam0, 'proporcao': proporcao(*tam0), 'quadros': len(qs)}
    for q in qs:
        q.pop('_masks', None)
    def puro(o):
        if isinstance(o, (np.integer,)): return int(o)
        if isinstance(o, (np.floating,)): return float(o)
        if isinstance(o, np.ndarray): return o.tolist()
        if isinstance(o, (np.bool_,)): return bool(o)
        raise TypeError(str(type(o)))
    (saida / f'pericia-{a.nome}.json').write_text(json.dumps({'meta': meta, 'consolidado': cons, 'quadros': qs}, ensure_ascii=False, indent=1, default=puro))
    escrever_md(qs, cons, meta, saida / f'pericia-{a.nome}.md')
    print(f"\n→ {saida}/pericia-{a.nome}.md · {saida}/pericia-{a.nome}.json · {frames}/folha-pericia-{a.nome}.jpg · recortes tipo-{a.nome}-NN-k.png")


if __name__ == '__main__':
    main()
