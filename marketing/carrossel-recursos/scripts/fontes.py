#!/usr/bin/env python3
"""fontes.py · baixa fontes livres pro projeto e escreve o CSS que as declara.

uso (na pasta do projeto):
  python3 scripts/fontes.py --google "Inter" "DM Serif Display" --fontshare switzer satoshi
  python3 scripts/fontes.py --google "Inter:wght@400;700"          # eixos explícitos (sintaxe do Google Fonts)
  python3 scripts/fontes.py --local ~/Fontes/MinhaFonte-Bold.ttf    # copia um arquivo seu e declara
  opções: --destino assets/fonts   --css src/kit/fontes.css   --limpar (apaga o fontes.css antes)

sai:
  assets/fonts/<arquivos>     os arquivos da fonte (woff/ttf), locais: o render não depende de rede
  src/kit/fontes.css          um @font-face por arquivo, apontando pros arquivos locais

depois: em src/kit/marca.css aponte as vozes pras famílias baixadas, por exemplo
  :root { --alta: 'Switzer'; --quieta: 'Switzer'; --mono: 'JetBrains Mono'; --tracking-alta: -0.03em; }

Licenças: Google Fonts distribui só fontes livres (OFL, Apache, UFL); Fontshare (Switzer, Satoshi,
General Sans, Cabinet Grotesk...) usa a ITF Free Font License, livre pra uso comercial. Fontes
pagas (Söhne, GT America, Tiempos...) não entram aqui: veja a tabela de equivalentes em
references/10-atlas-de-fontes.md.
"""
import argparse, re, shutil, sys, urllib.request, urllib.parse
from pathlib import Path

UA_WOFF = 'Mozilla/5.0 (Windows NT 6.1; rv:12.0) Gecko/20100101 Firefox/12.0'  # Google devolve woff estático
BLOCO = re.compile(r'@font-face\s*{(.*?)}', re.S)


def baixar(url, destino):
    req = urllib.request.Request(url, headers={'User-Agent': UA_WOFF})
    with urllib.request.urlopen(req, timeout=60) as r:
        destino.write_bytes(r.read())


def css_de(url, ua=UA_WOFF):
    req = urllib.request.Request(url, headers={'User-Agent': ua})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('utf-8')


def slug(s):
    return re.sub(r'[^A-Za-z0-9]+', '', s)


def blocos(css):
    """lê os @font-face do CSS → [{familia, estilo, peso, urls:[(url, formato)]}]"""
    out = []
    for m in BLOCO.finditer(css):
        corpo = m.group(1)
        fam = re.search(r"font-family:\s*['\"]?([^;'\"]+)", corpo)
        est = re.search(r'font-style:\s*(\w+)', corpo)
        pes = re.search(r'font-weight:\s*([\d ]+)', corpo)
        urls = re.findall(r"url\(['\"]?([^)'\"]+)['\"]?\)\s*format\(['\"]?(\w+)", corpo)
        if not fam or not urls:
            continue
        out.append({'familia': fam.group(1).strip(), 'estilo': (est.group(1) if est else 'normal'),
                    'peso': (pes.group(1).strip() if pes else '400'), 'urls': urls})
    return out


def google(familia):
    """tenta vários eixos e junta tudo que o Google devolveu (famílias estáticas respondem só a alguns)"""
    if ':' in familia:
        tentativas = [familia]
    else:
        tentativas = [f'{familia}:ital,wght@0,100..900;1,100..900', f'{familia}:wght@100..900',
                      f'{familia}:ital,wght@0,100..800;1,100..800', f'{familia}:wght@100..800', f'{familia}:wght@200..800',
                      f'{familia}:ital,wght@0,300..700;1,300..700', f'{familia}:wght@300..700',
                      f'{familia}:ital,wght@0,400;0,700;1,400;1,700', f'{familia}:ital@0;1', f'{familia}:wght@400;700', familia]
    css, ok = [], 0
    for t in tentativas:
        url = 'https://fonts.googleapis.com/css2?family=' + urllib.parse.quote(t, safe=':@,;.') + '&display=swap'
        try:
            css.append(css_de(url)); ok += 1
            if ',' in t and 'ital' in t and '..' in t:
                break  # a tentativa mais completa (variável com itálico) já traz tudo
        except Exception:
            continue
    if not ok:
        raise SystemExit(f'Google Fonts não achou "{familia}" (confira o nome em fonts.google.com)')
    return '\n'.join(css)


def fontshare(nome):
    for f in (f'{nome}@1,2', nome):
        url = 'https://api.fontshare.com/v2/css?f[]=' + urllib.parse.quote(f, safe='@,') + '&display=swap'
        try:
            return css_de(url)
        except Exception:
            continue
    raise SystemExit(f'Fontshare não achou "{nome}" (confira o nome em fontshare.com)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--google', nargs='*', default=[])
    ap.add_argument('--fontshare', nargs='*', default=[])
    ap.add_argument('--local', nargs='*', default=[])
    ap.add_argument('--destino', default='assets/fonts')
    ap.add_argument('--css', default='src/kit/fontes.css')
    ap.add_argument('--limpar', action='store_true')
    a = ap.parse_args()
    destino = Path(a.destino); destino.mkdir(parents=True, exist_ok=True)
    css_path = Path(a.css); css_path.parent.mkdir(parents=True, exist_ok=True)
    rel = Path(('../' * (len(css_path.parent.parts))) + a.destino)  # de src/kit/ pra assets/fonts/

    declaracoes = []
    familias = {}
    vistos = set()
    for fam in a.google:
        for b in blocos(google(fam)):
            chave = (b['familia'], b['estilo'], b['peso'])
            if chave in vistos:
                continue
            vistos.add(chave)
            url, fmt = b['urls'][0]
            ext = {'woff2': 'woff2', 'woff': 'woff', 'truetype': 'ttf', 'opentype': 'otf'}.get(fmt, 'woff')
            nome = f"{slug(b['familia'])}-{b['estilo']}-{b['peso'].replace(' ', '-')}.{ext}"
            if not (destino / nome).exists():
                baixar(url, destino / nome)
            declaracoes.append((b['familia'], b['estilo'], b['peso'], nome, fmt))
            familias.setdefault(b['familia'], set()).add(b['peso'])
    for nome in a.fontshare:
        for b in blocos(fontshare(nome)):
            urls = dict((f, u) for u, f in b['urls'])
            fmt = 'truetype' if 'truetype' in urls else ('woff2' if 'woff2' in urls else 'woff')
            url = urls[fmt]
            url = 'https:' + url if url.startswith('//') else url
            ext = {'woff2': 'woff2', 'woff': 'woff', 'truetype': 'ttf'}[fmt]
            arq = f"{slug(b['familia'])}-{b['estilo']}-{b['peso'].replace(' ', '-')}.{ext}"
            if not (destino / arq).exists():
                baixar(url, destino / arq)
            declaracoes.append((b['familia'], b['estilo'], b['peso'], arq, fmt))
            familias.setdefault(b['familia'], set()).add(b['peso'])
    for caminho in a.local:
        src = Path(caminho).expanduser()
        if not src.exists():
            raise SystemExit(f'não achei {src}')
        shutil.copy2(src, destino / src.name)
        fam = re.split(r'[-_]', src.stem)[0]
        estilo = 'italic' if re.search(r'italic|oblique', src.stem, re.I) else 'normal'
        fmt = {'.ttf': 'truetype', '.otf': 'opentype', '.woff': 'woff', '.woff2': 'woff2'}.get(src.suffix.lower(), 'truetype')
        declaracoes.append((fam, estilo, '100 900', src.name, fmt))
        familias.setdefault(fam, set()).add('100 900 (confira: arquivo local)')

    linhas = ['/* gerado por scripts/fontes.py · fontes locais, sem rede no render */']
    for fam, estilo, peso, arq, fmt in declaracoes:
        linhas.append(f"@font-face {{ font-family: '{fam}'; font-style: {estilo}; font-weight: {peso}; "
                      f"src: url('{rel / arq}') format('{fmt}'); }}")
    anterior = '' if (a.limpar or not css_path.exists()) else css_path.read_text() + '\n'
    css_path.write_text(anterior + '\n'.join(linhas) + '\n')

    print(f'{len(declaracoes)} arquivo(s) em {destino}/ · CSS em {css_path}')
    for fam, pesos in familias.items():
        print(f"  '{fam}': pesos {', '.join(sorted(pesos))}")
    print('agora, em src/kit/marca.css:  :root { --alta: \'' + (next(iter(familias)) if familias else 'Família') +
          "'; --quieta: '...'; --mono: '...'; }")


if __name__ == '__main__':
    main()
