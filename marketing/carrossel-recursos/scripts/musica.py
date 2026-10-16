"""Música e efeitos do carrossel vivo, sintetizados em numpy. Rode de dentro da pasta do projeto, depois de `node scripts/render.mjs cues`.
Lê audio/beats.json (duração e acertos de cada slide, declarados no K.slide de cada HTML) e escreve audio/slide-NN.wav (-14 LUFS,
pico -1,8 dBTP), audio/musica-completa.wav e audio/loudness.json. Uma música só: cada slide pega os compassos seguintes e vira um loop
perfeito (caudas que passam do fim voltam pro começo; filtros processados em círculo, então a emenda não tem degrau).
Tipos de acerto: impacto (carimbo) · tchac (barra) · whoosh (deslizar, atravessar) · clique (pouso, frase, folha) · tecla (digitação) · pop · land.
Ajuste no topo: TOM (tônica menor), CLIMA ('quente' | 'frio'), e se quiser, as progressões."""
import json, pathlib, subprocess, re
import numpy as np
from scipy.signal import butter, lfilter, sosfilt, resample_poly
from scipy.ndimage import minimum_filter1d
from scipy.io import wavfile

RAIZ = pathlib.Path.cwd(); SAI = RAIZ / 'audio'; SAI.mkdir(exist_ok=True)
GRADE = json.load(open(SAI / 'beats.json'))
SR = 48000; BPM = GRADE.get('bpm', 120); BAT = 60 / BPM; COMP = 4 * BAT
TOM = 'D'          # tônica (menor). Transpõe tudo.
CLIMA = 'quente'   # 'quente': pad + piano elétrico + bumbo macio · 'frio': só pad e sino
rng = np.random.default_rng(20261008)

NOMES = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'Ab': 8, 'A': 9, 'Bb': 10, 'B': 11}
TRANSP = NOMES[TOM] - 2  # as vozes abaixo estão em ré menor
def hz(n):
    m = re.match(r'([A-G][b#]?)(\d)', n); midi = 12 * (int(m.group(2)) + 1) + NOMES[m.group(1)] + TRANSP
    return 440 * 2 ** ((midi - 69) / 12)
tt = lambda d: np.arange(int(d * SR)) / SR
def env_adsr(n, a=0.005, d=0.3, s=0.0, r=0.05, dur=None):
    t = np.arange(n) / SR; e = np.where(t < a, t / a, s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    if dur is not None: e = e * (1 - np.clip((t - dur) / r, 0, 1))
    return e
bp = lambda x, lo, hi, o=2: sosfilt(butter(o, [lo / (SR / 2), hi / (SR / 2)], 'band', output='sos'), x)
lp = lambda x, f, o=2: sosfilt(butter(o, f / (SR / 2), 'low', output='sos'), x)
hp = lambda x, f, o=2: sosfilt(butter(o, f / (SR / 2), 'high', output='sos'), x)

# ---------- instrumentos ----------
def piano(f, dur, vel=1.0):
    n = int((dur + 1.6) * SR); t = np.arange(n) / SR; I = 2.4 * np.exp(-t / 0.25) + 0.45
    x = np.sin(2 * np.pi * f * t + I * np.sin(2 * np.pi * f * t)) + 0.18 * np.sin(2 * np.pi * 2.0 * f * t) * np.exp(-t / 0.4)
    return 0.22 * vel * x * env_adsr(n, 0.004, 1.2, 0.0, 0.25, dur)
def pad(fs, dur):
    n = int((dur + 1.0) * SR); t = np.arange(n) / SR; x = np.zeros(n)
    for f in fs:
        for det in (-0.12, 0.0, 0.11):
            ff = f * 2 ** (det / 12)
            for k in range(1, 9): x += ((-1) ** (k + 1)) * np.sin(2 * np.pi * ff * k * t + det * 7) / k
    x = lp(x, 1400); return 0.012 * x * np.clip(t / 0.35, 0, 1) * np.clip(1 - (t - dur) / 0.8, 0, 1)
def baixo(f, dur, vel=1.0):
    n = int((dur + 0.3) * SR); t = np.arange(n) / SR
    x = 0.55 * np.sin(2 * np.pi * f * t) + 0.7 * np.sin(2 * np.pi * 2 * f * t) + 0.4 * np.sin(2 * np.pi * 3 * f * t) + 0.2 * np.sin(2 * np.pi * 4 * f * t) + 0.08 * np.sin(2 * np.pi * 6 * f * t)
    x = np.tanh(1.6 * x) / np.tanh(1.6); return 0.30 * vel * x * env_adsr(n, 0.006, 0.35, 0.55, 0.08, dur)
def bumbo(vel=1.0):
    t = tt(0.45); fr = 48 + 70 * np.exp(-t / 0.045); corpo = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / 0.22)
    corpo = hp(np.tanh(3.2 * corpo) / np.tanh(3.2), 45)
    tapa = bp(rng.standard_normal(len(t)), 800, 3500) * np.exp(-t / 0.012) * 0.35; cl = hp(rng.standard_normal(len(t)), 2500) * np.exp(-t / 0.004) * 0.4
    return 0.42 * vel * (corpo + tapa + cl)
def aro(vel=1.0):
    t = tt(0.25); return 0.24 * vel * (bp(rng.standard_normal(len(t)), 1200, 5000) * np.exp(-t / 0.05) + 0.6 * np.sin(2 * np.pi * 330 * t) * np.exp(-t / 0.03))
def chimbal(vel=1.0):
    t = tt(0.12); return 0.11 * vel * hp(rng.standard_normal(len(t)), 6000) * np.exp(-t / 0.03)
def sino(f, vel=1.0):
    t = tt(2.0); x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 3.01 * f * t) * np.exp(-t / 0.35) + 0.12 * np.sin(2 * np.pi * 5.2 * f * t) * np.exp(-t / 0.12)
    return 0.07 * vel * x * np.exp(-t / 0.7) * np.clip(t / 0.002, 0, 1)
# ---------- efeitos ----------
def impacto(tipo='carimbo', vel=1.0):
    t = tt(0.6)
    if tipo == 'carimbo':
        fr = 42 + 60 * np.exp(-t / 0.05); grave = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / 0.2)
        x = 0.9 * np.tanh(1.8 * grave) + 0.55 * bp(rng.standard_normal(len(t)), 350, 1800) * np.exp(-t / 0.035) + 0.35 * np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.06)
    elif tipo == 'land':
        fr = 40 + 40 * np.exp(-t / 0.06); grave = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / 0.25)
        x = 0.7 * np.tanh(1.5 * grave) + 0.3 * bp(rng.standard_normal(len(t)), 300, 1200) * np.exp(-t / 0.05)
    else:  # tchac: mais brilho, mais curto
        fr = 55 + 80 * np.exp(-t / 0.03); grave = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / 0.12)
        x = 0.6 * np.tanh(1.6 * grave) + 0.75 * bp(rng.standard_normal(len(t)), 1500, 7000) * np.exp(-t / 0.03) + 0.35 * np.sin(2 * np.pi * 240 * t) * np.exp(-t / 0.05)
    return 0.5 * vel * x
def whoosh(dur, pico=0.7, vel=1.0, f0=350, f1=2600):
    n = int(dur * SR); t = np.arange(n) / SR; u = t / dur; ruido = rng.standard_normal(n); out = np.zeros(n); bloco = 256
    for i in range(0, n, bloco):
        uc = (i + bloco / 2) / n; fc = f0 + (f1 - f0) * np.sin(np.pi * min(uc / (pico * 1.15), 1.0) / 2) * (1 - 0.6 * max(0, uc - pico) / (1 - pico + 1e-6))
        lo, hi = max(80, fc * 0.55), min(SR / 2 - 100, fc * 1.6); b, a = butter(2, [lo / (SR / 2), hi / (SR / 2)], 'band')
        out[i:i + bloco] = lfilter(b, a, ruido[max(0, i - 512):i + bloco])[-len(ruido[i:i + bloco]):]
    forma = np.where(u < pico, np.sin(np.pi / 2 * u / pico) ** 2, np.cos(np.pi / 2 * (u - pico) / (1 - pico)) ** 2)
    return 0.22 * vel * out * forma
def clique(f=1800, vel=1.0, tecla=False):
    t = tt(0.12); x = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.012) + 0.4 * hp(rng.standard_normal(len(t)), 3000) * np.exp(-t / 0.003) + 0.5 * np.sin(2 * np.pi * f / 4 * t) * np.exp(-t / 0.02)
    if tecla: x2 = np.zeros_like(x); dd = int(0.035 * SR); x2[dd:] = 0.45 * x[:-dd]; x = x + x2
    return 0.16 * vel * x
# ---------- composição (ré menor; TOM transpõe) ----------
ACORDES = {'Dm9': ('D2', ['F3', 'A3', 'C4', 'E4']), 'Bbmaj9': ('Bb1', ['D4', 'F4', 'A4', 'C5']), 'Gm9': ('G1', ['F3', 'Bb3', 'D4', 'A4']), 'C69': ('C2', ['E4', 'G4', 'A4', 'D5'])}
PROG = {4: ['Dm9', 'Bbmaj9', 'Gm9', 'C69'], 3: ['Dm9', 'Bbmaj9', 'C69'], 2: ['Dm9', 'C69']}  # cada trecho resolve de volta em Dm9: o loop fecha
MELODIAS = [[(0, 'A4'), (1, 'C5'), (2, 'D5')], [(0, 'F5'), (2, 'D5')], [(0, 'C5'), (1, 'A4'), (3, 'G4')], [(0, 'A4'), (2, 'D5')], [(0, 'D5'), (2, 'C5'), (3, 'A4')], [(1, 'F5'), (2, 'E5')], [(0, 'D5'), (2, 'A4')]]
PENTA = ['D5', 'F5', 'G5', 'A5', 'C6', 'D6', 'F6', 'G6']
SLIDES = GRADE['slides']; NS = len(SLIDES)

def musica_do_slide(k, dur):
    n = int(dur * SR); buf = np.zeros(n + 4 * SR)
    def poe(x, t): i = int(round(t * SR)); buf[i:i + len(x)] += x[:len(buf) - i]
    comps = max(2, int(round(dur / COMP))); capa, cta = k == 0, k == NS - 1
    for c, nome in enumerate(PROG[min(comps, 4)][:comps]):
        t0 = c * COMP; b, vozes = ACORDES[nome]; fs = [hz(v) for v in vozes]
        poe(pad(fs, COMP), t0)
        if CLIMA == 'quente':
            for bt, d, vel in ((0, 1.8, 1.0), (2, 1.6, 0.8)):
                for f in fs: poe(piano(f, d * BAT, vel), t0 + bt * BAT)
            fb = hz(b) * (2 if hz(b) < 60 else 1)
            if not capa or c % 2 == 0:
                for bt, d, v in ((0, 1.2, 1.0), (2, 0.7, 0.8), (3, 0.4, 0.6)): poe(baixo(fb * (2 if bt == 3 else 1), d * BAT, v), t0 + bt * BAT)
            for bt in (0, 2): poe(bumbo(0.75 if capa else 1.0), t0 + bt * BAT)
            if capa:
                for bt in (0.5, 1.5, 2.5, 3.5): poe(chimbal(0.5), t0 + bt * BAT)
            else:
                for bt in (1, 3): poe(aro(), t0 + bt * BAT)
                for bt in (0.5, 1.5, 2.5, 3.5): poe(chimbal(0.8 + 0.2 * (bt % 1 == 0.5)), t0 + bt * BAT)
        if k >= NS // 2 or CLIMA == 'frio':
            for bt, nota in MELODIAS[(k * 3 + c) % len(MELODIAS)]: poe(sino(hz(nota), 1.0 if cta else 0.7), t0 + bt * BAT)
    return buf, n

def sfx_do_slide(sl, buf):
    def poe(x, t): i = int(round(t * SR)); buf[i:i + len(x)] += x[:len(buf) - i]
    folha = 0
    for ev in sl.get('eventos', []):
        t, tipo, o = ev['t'], ev.get('tipo', ev.get('type', 'clique')), ev.get('o_que', ''); g = ev.get('gain', 1.0)
        if tipo == 'impacto': poe(impacto('carimbo', g), t)
        elif tipo == 'land': poe(impacto('land', g), t)
        elif tipo == 'tchac': poe(impacto('tchac', g), t)
        elif tipo == 'whoosh':
            if 'apag' in o: poe(whoosh(0.45, 0.45, 0.8 * g, 2500, 600), t)
            elif 'atravessa' in o or 'borda' in o: poe(whoosh(0.8, 0.45, g), t)
            else: poe(whoosh(0.5, 0.85, 0.6 * g, 500, 1800), t)
        elif tipo == 'tecla': poe(clique(1300, 0.9 * g, tecla=True), t)
        elif tipo == 'pop': poe(clique(900, 0.9 * g), t)
        else:
            if 'folha' in o or 'imprime' in o: poe(clique(hz(PENTA[folha % 8]), 0.75 * g), t); folha += 1
            elif 'pousa' in o and 'cartão' in o: poe(clique(700, 0.9 * g), t)
            elif 'frase' in o: poe(clique(2200, 0.5 * g), t)
            else: poe(clique(1800, 0.8 * g), t)

def prateleira(x, f0, ganho_db, tipo):
    A_ = 10 ** (ganho_db / 40); w = 2 * np.pi * f0 / SR; cw, sw = np.cos(w), np.sin(w); al = sw / 2 * np.sqrt(2)
    if tipo == 'grave':
        b = [A_ * ((A_ + 1) - (A_ - 1) * cw + 2 * np.sqrt(A_) * al), 2 * A_ * ((A_ - 1) - (A_ + 1) * cw), A_ * ((A_ + 1) - (A_ - 1) * cw - 2 * np.sqrt(A_) * al)]
        a = [(A_ + 1) + (A_ - 1) * cw + 2 * np.sqrt(A_) * al, -2 * ((A_ - 1) + (A_ + 1) * cw), (A_ + 1) + (A_ - 1) * cw - 2 * np.sqrt(A_) * al]
    else:
        b = [A_ * ((A_ + 1) + (A_ - 1) * cw + 2 * np.sqrt(A_) * al), -2 * A_ * ((A_ - 1) + (A_ + 1) * cw), A_ * ((A_ + 1) + (A_ - 1) * cw - 2 * np.sqrt(A_) * al)]
        a = [(A_ + 1) - (A_ - 1) * cw + 2 * np.sqrt(A_) * al, 2 * ((A_ - 1) - (A_ + 1) * cw), (A_ + 1) - (A_ - 1) * cw - 2 * np.sqrt(A_) * al]
    return lfilter(np.array(b) / a[0], np.array(a) / a[0], x)
def limita(x, teto_db=-1.8):
    teto = 10 ** (teto_db / 20); up = np.abs(resample_poly(x, 4, 1)); pico = up[:len(x) * 4].reshape(-1, 4).max(1)
    gi = np.minimum(1.0, teto / np.maximum(pico, 1e-9)); w = int(0.004 * SR); gl = minimum_filter1d(gi, size=2 * w + 1, mode='nearest')
    g = np.empty_like(gl); atual = 1.0; rel = 1 / (0.08 * SR)
    for n in range(len(gl)): atual = min(gl[n], atual + (1 - atual) * rel * 4); g[n] = atual
    return x * g
def lufs(path):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(path), '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', r)[-1]), float(re.findall(r'Peak:\s+(-?[\d.]+) dBFS', r)[-1])
def grava(path, x): wavfile.write(str(path), SR, (np.clip(np.stack([x, x], 1), -1, 1) * 32767).astype(np.int16))
def faixas(x):
    X = np.abs(np.fft.rfft(x)) ** 2; f = np.fft.rfftfreq(len(x), 1 / SR); tot = X.sum()
    return {'<120 Hz': round(100 * X[f < 120].sum() / tot, 1), '120 Hz-2 kHz': round(100 * X[(f >= 120) & (f < 2000)].sum() / tot, 1), '>2 kHz': round(100 * X[f >= 2000].sum() / tot, 1)}

completa, relatorio = [], {}
for k, sl in enumerate(SLIDES):
    dur = sl['duracao_s']; s = f"{sl['slide']:02d}"
    buf, n = musica_do_slide(k, dur); sfx_do_slide(sl, buf)
    x = buf[:n].copy(); resto = buf[n:]
    for j in range(0, len(resto), n): ped = resto[j:j + n]; x[:len(ped)] += ped          # loop: a cauda volta pro começo
    circ = lambda f, y: f(np.tile(y, 3))[len(y):2 * len(y)]                                 # filtros em círculo: sem degrau na emenda
    x = circ(lambda y: prateleira(prateleira(hp(y, 35), 110, -5.0, 'grave'), 3000, 5.0, 'agudo'), x)
    g = 0.5
    for _ in range(4):
        y = circ(lambda z: limita(z, -1.8), x * g); grava(SAI / f'slide-{s}.wav', y); i, tp = lufs(SAI / f'slide-{s}.wav'); g *= 10 ** ((-14.0 - i) / 20)
    y = circ(lambda z: limita(z, -1.8), x * g); grava(SAI / f'slide-{s}.wav', y); i, tp = lufs(SAI / f'slide-{s}.wav')
    relatorio[s] = {'duracao_s': dur, 'lufs': round(i, 2), 'pico_dbtp': round(tp, 2), 'energia': faixas(y)}
    completa.append(y); print(f'slide {s}  {dur} s  {i:.2f} LUFS  pico {tp:.2f} dBTP  {faixas(y)}')
grava(SAI / 'musica-completa.wav', np.concatenate(completa))
json.dump(relatorio, open(SAI / 'loudness.json', 'w'), ensure_ascii=False, indent=1)
