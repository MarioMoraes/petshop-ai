// Trilha do reel, sintetizada em código: original, sem direito autoral de terceiros.
// House leve a 120 BPM — cada corte do reel cai num tempo em Lá menor (F – G – Em – Am), com whoosh e impacto em cada
// troca de cena. `cortes` são os instantes das trocas, lidos da própria página,
// então a trilha acompanha o vídeo se a duração de uma cena mudar.
import { writeFileSync } from 'node:fs'

const SR = 44100
const BPM = 120
const BEAT = 60 / BPM
const BAR = BEAT * 4
const CHORDS = [
  [41, [53, 57, 60, 64]], // Fmaj7
  [43, [55, 59, 62, 67]], // G
  [40, [52, 55, 59, 62]], // Em7
  [45, [57, 60, 64, 67]], // Am7
]
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12)

export function gerarTrilha({ duracao, cortes, arquivo }) {
  const n = Math.ceil(duracao * SR)
  const L = new Float32Array(n), R = new Float32Array(n)
  const add = (i, v, pan = 0) => {
    if (i < 0 || i >= n) return
    L[i] += v * (1 - Math.max(0, pan))
    R[i] += v * (1 + Math.min(0, pan))
  }
  let seed = 1
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1

  // quanto da música toca em cada momento: entra aos poucos, respira na conversa, abre no fim
  const ultimo = cortes[cortes.length - 1]
  const conversa = [cortes[1], cortes[2]]
  const energia = (t) => {
    if (t < BAR) return 0
    if (t >= conversa[0] && t < conversa[1]) return 1
    if (t >= ultimo) return 3
    return 2
  }
  const temBateria = (t) => t >= BAR

  // sidechain: tudo que não é bumbo abaixa um pouco a cada batida
  const kickTimes = []
  for (let t = BAR; t < duracao - BAR * 0.5; t += BEAT) kickTimes.push(t)
  const duck = new Float32Array(n).fill(1)
  for (const k of kickTimes) {
    const s = Math.floor(k * SR)
    for (let j = 0; j < SR * BEAT && s + j < n; j++) duck[s + j] = Math.min(duck[s + j], 1 - 0.55 * Math.exp(-j / SR / 0.11))
  }

  // ── bumbo
  for (const k of kickTimes) {
    const s = Math.floor(k * SR)
    let ph = 0
    for (let j = 0; j < SR * 0.45; j++) {
      const t = j / SR
      const f = 46 + 110 * Math.exp(-t / 0.035)
      ph += (2 * Math.PI * f) / SR
      add(s + j, 0.7 * Math.sin(ph) * Math.exp(-t / 0.16) + (j < 60 ? 0.25 * noise() * (1 - j / 60) : 0))
    }
  }

  // ── palma nos tempos 2 e 4, fora da conversa
  for (const k of kickTimes) {
    const beat = Math.round((k - BAR) / BEAT) % 4
    if ((beat !== 1 && beat !== 3) || energia(k) < 2) continue
    const s = Math.floor(k * SR)
    let lp = 0, prev = 0
    for (let j = 0; j < SR * 0.25; j++) {
      const t = j / SR
      const x = noise()
      lp += 0.35 * (x - lp)
      const bp = lp - prev; prev = lp
      const env = Math.exp(-t / 0.07) * (t < 0.02 ? 0.6 + 0.4 * Math.sin(t * 900) : 1)
      add(s + j, 0.32 * bp * env * 2, (j % 2 ? 0.15 : -0.15))
    }
  }

  // ── chimbal em colcheias, o contratempo mais forte
  for (let t = BAR; t < duracao - BAR * 0.5; t += BEAT / 2) {
    const off = Math.round((t - BAR) / (BEAT / 2)) % 2 === 1
    const e = energia(t)
    const vol = (off ? 0.16 : 0.06) * (e === 1 ? 0.7 : 1)
    const s = Math.floor(t * SR)
    let prev = 0
    for (let j = 0; j < SR * (off ? 0.09 : 0.04); j++) {
      const x = noise()
      const hp = x - prev; prev = x
      add(s + j, vol * hp * Math.exp(-j / SR / (off ? 0.035 : 0.015)), 0.25)
    }
  }

  // ── baixo: colcheias na fundamental, com oitava no contratempo
  for (let bar = 1; bar * BAR < duracao - BAR * 0.5; bar++) {
    const [root] = CHORDS[bar % 4]
    for (let e8 = 0; e8 < 8; e8++) {
      const t0 = bar * BAR + e8 * (BEAT / 2)
      if (energia(t0) === 0) continue
      const f = hz(root + (e8 % 2 ? 12 : 0))
      const s = Math.floor(t0 * SR)
      const len = BEAT / 2 * 0.9
      let ph = 0
      for (let j = 0; j < SR * len; j++) {
        const t = j / SR
        ph += (2 * Math.PI * f) / SR
        const env = Math.min(1, t / 0.005) * Math.exp(-t / 0.18)
        const v = Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph)
        add(s + j, 0.3 * v * env * duck[s + j] ** 1.4)
      }
    }
  }

  // ── pad: serras desafinadas, filtro passa-baixa, um acorde por compasso
  for (let bar = 0; bar * BAR < duracao; bar++) {
    const [, notes] = CHORDS[bar % 4]
    const t0 = bar * BAR
    const s = Math.floor(t0 * SR)
    const len = BAR + 0.4
    const corte = energia(t0 + 0.01) === 3 ? 2600 : energia(t0 + 0.01) === 1 ? 1100 : 1700
    const a = 1 - Math.exp((-2 * Math.PI * corte) / SR)
    notes.forEach((m, vi) => {
      for (const [det, pan] of [[-0.11, -0.6], [0.11, 0.6]]) {
        const f = hz(m + det)
        let ph = vi * 0.13, y1 = 0, y2 = 0
        for (let j = 0; j < SR * len; j++) {
          const t = j / SR
          ph += f / SR; ph -= Math.floor(ph)
          const saw = 2 * ph - 1
          y1 += a * (saw - y1); y2 += a * (y1 - y2)
          const env = Math.min(1, t / 0.35) * Math.min(1, (len - t) / 0.4)
          add(s + j, 0.045 * y2 * env * duck[s + j] ** 0.8, pan)
        }
      }
    })
  }

  // ── arpejo em semicolcheias com eco, só quando a música está aberta
  const arpL = new Float32Array(n), arpR = new Float32Array(n)
  const PADRAO = [0, 2, 1, 3, 2, 1, 3, 2]
  for (let bar = 1; bar * BAR < duracao - BAR * 0.5; bar++) {
    const [, notes] = CHORDS[bar % 4]
    for (let s16 = 0; s16 < 16; s16++) {
      const t0 = bar * BAR + s16 * (BEAT / 4)
      const e = energia(t0)
      if (e < 2 || (e === 2 && s16 % 2)) continue
      const f = hz(notes[PADRAO[s16 % 8]] + 12)
      const s = Math.floor(t0 * SR)
      let ph = 0
      for (let j = 0; j < SR * 0.25; j++) {
        const t = j / SR
        ph += f / SR; ph -= Math.floor(ph)
        const tri = 4 * Math.abs(ph - 0.5) - 1
        const v = 0.07 * tri * Math.exp(-t / 0.07) * (s16 % 4 === 0 ? 1.2 : 0.85)
        if (s + j < n) { arpL[s + j] += v; arpR[s + j] += v }
      }
    }
  }
  const dly = Math.floor(BEAT * 0.75 * SR)
  for (let i = 0; i < n; i++) {
    const dl = i >= dly ? arpR[i - dly] * 0.38 : 0
    const dr = i >= dly ? arpL[i - dly] * 0.38 : 0
    arpL[i] += dl; arpR[i] += dr
    L[i] += arpL[i] * 0.9; R[i] += arpR[i] * 0.6
  }

  // ── troca de cena: whoosh de ruído que sobe e desce, e um impacto grave no meio
  for (const c of cortes) {
    const s = Math.floor((c - 0.7) * SR)
    let lp = 0, lp2 = 0
    for (let j = 0; j < SR * 1.4; j++) {
      const t = j / SR
      const x = (t - 0.7) / 0.7
      const env = Math.max(0, 1 - x * x) ** 2
      const f = 300 + 5200 * Math.max(0, 1 - Math.abs(x)) ** 1.5
      const a = 1 - Math.exp((-2 * Math.PI * f) / SR)
      lp += a * (noise() - lp); lp2 += a * (lp - lp2)
      add(s + j, 0.55 * lp2 * env, Math.sin(t * 3.2) * 0.6)
    }
    const b = Math.floor(c * SR)
    let ph = 0
    for (let j = 0; j < SR * 0.9; j++) {
      const t = j / SR
      ph += (2 * Math.PI * (38 + 60 * Math.exp(-t / 0.08))) / SR
      add(b + j, 0.55 * Math.sin(ph) * Math.exp(-t / 0.35))
    }
  }

  // ── master: entra em 0,3 s, sai nos 2,5 s finais, satura de leve e normaliza
  let peak = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const g = Math.min(1, t / 0.3) * Math.min(1, (duracao - t) / 2.5)
    L[i] = Math.tanh(L[i] * 1.1) * g
    R[i] = Math.tanh(R[i] * 1.1) * g
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
  }
  const norm = 0.89 / peak
  const buf = Buffer.alloc(44 + n * 4)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(L[i] * norm * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(R[i] * norm * 32767), 46 + i * 4)
  }
  writeFileSync(arquivo, buf)
}
