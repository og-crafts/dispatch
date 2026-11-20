// Synthesizes the promo's music bed into public/audio/music.wav: soft and low, to sit under the voice.
// 68 BPM, D major, no drums: a slow warm pad, a quiet electric-piano comp, a sub bass and a few bell notes.
// Everything is generated here (deterministic), so there is nothing to license.
// Run: node scripts/make-music.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SR = 44100
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio')
mkdirSync(OUT, { recursive: true })
const TAU = Math.PI * 2
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12)

const LENGTH = 46 // seconds; the video is about 41 s and fades the bed out at its end
const L = new Float32Array(LENGTH * SR)
const R = new Float32Array(LENGTH * SR)

const add = (start, length, fn, gain = 1, pan = 0) => {
  const s0 = Math.round(start * SR)
  const n = Math.round(length * SR)
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4)
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4)
  for (let i = 0; i < n && s0 + i < L.length; i++) {
    const v = fn(i / SR)
    L[s0 + i] += v * gl
    R[s0 + i] += v * gr
  }
}

// Warm pad: detuned soft partials, slow swell in and out, with a slow shimmer.
const pad = (f, len) => (t) => {
  const a = Math.min(1, t / 1.6) * Math.min(1, Math.max(0, (len - t) / 1.6))
  let v = 0
  for (const d of [-0.08, 0, 0.08]) {
    const ff = f * 2 ** (d / 12)
    v += Math.sin(TAU * ff * t) + 0.18 * Math.sin(TAU * 2 * ff * t + 0.3)
  }
  return a * (v / 3) * (0.85 + 0.15 * Math.sin(TAU * 0.11 * t))
}

// Electric-piano-like key: sine with a soft bell partial that dies fast.
const key = (f) => (t) => {
  const a = t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) * 1.6)
  return a * (Math.sin(TAU * f * t) + 0.22 * Math.sin(TAU * 2 * f * t) * Math.exp(-t * 4) + 0.06 * Math.sin(TAU * 7 * f * t) * Math.exp(-t * 14))
}

const sub = (f, len) => (t) => {
  const a = Math.min(1, t / 0.08) * Math.min(1, Math.max(0, (len - t) / 0.4))
  return a * (Math.sin(TAU * f * t) + 0.1 * Math.sin(TAU * 2 * f * t))
}

const bell = (f) => (t) => {
  const a = t < 0.005 ? t / 0.005 : Math.exp(-(t - 0.005) * 1.4)
  return a * (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2.76 * f * t) * Math.exp(-t * 5))
}

// 68 BPM, 4/4: one bar is about 3.53 s. 13 bars ≈ 46 s.
const BEAT = 60 / 68
const BAR = 4 * BEAT
// Dmaj9 – Bm9 – Gmaj9 – Asus4/A, voiced low and close.
const CHORDS = [
  { root: 38, tones: [50, 54, 57, 61, 64] },
  { root: 35, tones: [50, 54, 57, 59, 61] },
  { root: 31, tones: [50, 54, 55, 59, 62] },
  { root: 33, tones: [50, 52, 55, 57, 61] },
]
const bars = Math.ceil(LENGTH / BAR)
for (let bar = 0; bar < bars; bar++) {
  const t0 = bar * BAR
  const last = bar === bars - 1
  const c = last ? CHORDS[0] : CHORDS[bar % 4]
  const len = last ? LENGTH - t0 : BAR + 0.8
  // Pad on the chord tones (one octave down for the lowest two), slightly spread in stereo.
  c.tones.forEach((n, i) => add(t0, len, pad(hz(i < 2 ? n - 12 : n), len), 0.055, (i - 2) * 0.25))
  // Sub bass from bar 2.
  if (bar >= 1) add(t0, len, sub(hz(c.root), len), 0.16)
  // Keys: a gentle comp on beat 1 and the "and" of 2, from bar 1; softer before the voice gets going.
  if (bar >= 1 && !last) {
    const g = bar < 2 ? 0.05 : 0.075
    for (const [b, set] of [[0, [1, 2, 4]], [1.5, [2, 3, 4]]]) {
      set.forEach((ti, j) => add(t0 + b * BEAT + j * 0.018, 3, key(hz(c.tones[ti] + 12)), g, j % 2 ? 0.3 : -0.3))
    }
  }
  // A few high bell notes, sparse, every other bar from bar 3.
  if (bar >= 3 && bar % 2 === 1 && !last) {
    const notes = [[0.5, 81], [2, 78], [3, 76]]
    notes.forEach(([b, n]) => add(t0 + b * BEAT, 4, bell(hz(n)), 0.035, 0.35))
  }
  if (last) add(t0, 5, bell(hz(74)), 0.05, 0)
}

// A soft one-pole low-pass over everything keeps it warm and out of the voice's way.
const lowpass = (ch, cutoff) => {
  const a = 1 - Math.exp((-TAU * cutoff) / SR)
  let y = 0
  for (let i = 0; i < ch.length; i++) { y += a * (ch[i] - y); ch[i] = y }
}
lowpass(L, 2600)
lowpass(R, 2600)

// Fade in over 2 s and out over the last 3 s, then normalise to a modest peak.
for (let i = 0; i < L.length; i++) {
  const t = i / SR
  const g = Math.min(1, t / 2) * Math.min(1, (LENGTH - t) / 3)
  L[i] *= g; R[i] *= g
}
let max = 1e-9
for (let i = 0; i < L.length; i++) max = Math.max(max, Math.abs(L[i]), Math.abs(R[i]))
const peak = 0.7
const n = L.length
const data = Buffer.alloc(44 + n * 4)
data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVEfmt ', 8)
data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(SR, 24)
data.writeUInt32LE(SR * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40)
for (let i = 0; i < n; i++) {
  data.writeInt16LE(Math.round((L[i] / max) * peak * 32767), 44 + i * 4)
  data.writeInt16LE(Math.round((R[i] / max) * peak * 32767), 46 + i * 4)
}
writeFileSync(join(OUT, 'music.wav'), data)
console.log(`music.wav: ${LENGTH} s`)
