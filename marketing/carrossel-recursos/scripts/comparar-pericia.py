#!/usr/bin/env python3
"""comparar-pericia.py · põe lado a lado a perícia da referência e a dos nossos PNGs, com OK/REVISAR por linha.

uso:
  python3 scripts/comparar-pericia.py docs/pericia-x.json docs/pericia-nosso.json [--md docs/comparacao.md]

Tolerâncias: vazio ±12 pontos · margem ±16 px · entrelinha ±0,15 · razão maior/menor ±25 % · níveis ±1 ·
ocupação de foto ±12 pontos · cor ΔRGB ≤ 34 · ritmo dos fundos igual slide a slide (quando o número de slides bate).
REVISAR não é reprovação: é onde olhar.
"""
import json, sys
from pathlib import Path


def rgb(h):
    return [int(h[i:i + 2], 16) for i in (1, 3, 5)]


def drgb(a, b):
    return sum((x - y) ** 2 for x, y in zip(rgb(a), rgb(b))) ** 0.5


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    ref = json.loads(Path(sys.argv[1]).read_text())
    nos = json.loads(Path(sys.argv[2]).read_text())
    md = None
    if '--md' in sys.argv:
        md = Path(sys.argv[sys.argv.index('--md') + 1])
    R, N = ref['consolidado'], nos['consolidado']
    linhas = []

    def linha(nome, a, b, ok, fmt=str):
        linhas.append((nome, fmt(a), fmt(b), 'OK' if ok else 'REVISAR'))

    linha('vazio médio %', R['vazio_medio_pct'], N['vazio_medio_pct'], abs(R['vazio_medio_pct'] - N['vazio_medio_pct']) <= 12)
    g, h = R['grade'], N['grade']
    linha('alinhamento dominante', g['alinhamento_dominante'], h['alinhamento_dominante'], g['alinhamento_dominante'] == h['alinhamento_dominante'])
    if g['margem_esq_mediana'] and h['margem_esq_mediana']:
        linha('margem esquerda px', g['margem_esq_mediana'], h['margem_esq_mediana'], abs(g['margem_esq_mediana'] - h['margem_esq_mediana']) <= 16)
    if g['entrelinha_mediana'] and h['entrelinha_mediana']:
        linha('entrelinha', g['entrelinha_mediana'], h['entrelinha_mediana'], abs(g['entrelinha_mediana'] - h['entrelinha_mediana']) <= 0.15)
    er, en = R['escala'], N['escala']
    linha('níveis tipográficos', len(er), len(en), abs(len(er) - len(en)) <= 1)
    if len(er) >= 2 and len(en) >= 2:
        rr = er[0]['px_mediana'] / max(1, er[-1]['px_mediana']); rn = en[0]['px_mediana'] / max(1, en[-1]['px_mediana'])
        linha('razão maior/menor', rr, rn, abs(rr - rn) / rr <= 0.25, lambda v: f'{v:.1f}×')
        linha('maior nível px', er[0]['px_mediana'], en[0]['px_mediana'], abs(er[0]['px_mediana'] - en[0]['px_mediana']) / er[0]['px_mediana'] <= 0.2)
    ir, inn = R['imagens'], N['imagens']
    linha('slides com imagem', ir['slides_com_foto'], inn['slides_com_foto'], abs(ir['slides_com_foto'] - inn['slides_com_foto']) <= 1)
    linha('ocupação média da imagem %', ir['ocupacao_media_pct'], inn['ocupacao_media_pct'], abs(ir['ocupacao_media_pct'] - inn['ocupacao_media_pct']) <= 12)
    if ir.get('luminancia_media') is not None and inn.get('luminancia_media') is not None:
        linha('luminância da imagem', ir['luminancia_media'], inn['luminancia_media'], abs(ir['luminancia_media'] - inn['luminancia_media']) <= 0.15)
        linha('temperatura da imagem', ir['temperatura'], inn['temperatura'], ir['temperatura'] == inn['temperatura'])
    linha('textura do fundo', R['textura_fundo'], N['textura_fundo'], R['textura_fundo'] == N['textura_fundo'])
    rr_ = ''.join(r['fundo'][0] for r in R['ritmo']); rn_ = ''.join(r['fundo'][0] for r in N['ritmo'])
    linha('ritmo dos fundos', rr_, rn_, rr_ == rn_ if len(rr_) == len(rn_) else rr_[:min(len(rr_), len(rn_))] == rn_[:min(len(rr_), len(rn_))])
    linha('cantos IG invadidos', R['cantos_ig_invadidos'], N['cantos_ig_invadidos'], N['cantos_ig_invadidos'] == 0)
    # cores: pra cada papel da referência, a cor mais próxima nossa
    for papel in ('fundo', 'tinta', 'destaque'):
        cr = [c for c in R['paleta'] if papel in c['papeis']][:2]
        cn = [c for c in N['paleta'] if papel in c['papeis']]
        for c in cr:
            if cn:
                perto = min(cn, key=lambda d: drgb(c['hex'], d['hex']))
                linha(f'cor {papel} {c["hex"]}', c['hex'], perto['hex'], drgb(c['hex'], perto['hex']) <= 34)
            else:
                linha(f'cor {papel} {c["hex"]}', c['hex'], '–', False)

    larg = max(len(l[0]) for l in linhas)
    print(f"{'':{larg}}  {'referência':>14}  {'nosso':>14}")
    for nome, a, b, ok in linhas:
        print(f'{nome:{larg}}  {a:>14}  {b:>14}  {ok}')
    rev = sum(1 for l in linhas if l[3] == 'REVISAR')
    print(f'\n{len(linhas) - rev} OK · {rev} REVISAR')
    if md:
        out = ['| medida | referência | nosso | |', '|---|---|---|---|'] + [f'| {n} | {a} | {b} | {ok} |' for n, a, b, ok in linhas]
        md.write_text('\n'.join(out) + f'\n\n{len(linhas) - rev} OK · {rev} REVISAR\n')
        print('→', md)


if __name__ == '__main__':
    main()
