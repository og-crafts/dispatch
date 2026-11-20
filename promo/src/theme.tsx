import { loadFont } from '@remotion/fonts'
import { Easing, interpolate, staticFile, useVideoConfig } from 'remotion'

// Manrope (the Grove look's face, OFL) for words and Geist Mono (OFL, the site's mono) for the postmark and code.
loadFont({ family: 'Manrope', url: staticFile('fonts/manrope.woff2'), weight: '200 800' })
loadFont({ family: 'Geist Mono', url: staticFile('fonts/geist-mono-400.ttf'), weight: '400' })

// The app's Dispatch look, dark: graphite surfaces, hairlines, one violet accent (src/ui/app.css).
export const C = {
  bg: '#0f0f10',
  surface: '#161617',
  raised: '#232325',
  outline: 'rgba(237, 237, 237, .1)',
  ink: '#ededed',
  muted: '#a1a1a6',
  faint: '#85858b',
  violet: '#9a86ff',
  violetStrong: '#5b2ee0',
  good: '#4cc38a',
  warn: '#e2a336',
  yellow: '#FFC94D',
}
export const SANS = 'Manrope, system-ui, sans-serif'
export const MONO = '"Geist Mono", ui-monospace, monospace'

export const outExpo = Easing.bezier(0.16, 1, 0.3, 1)
export const inOut = Easing.bezier(0.65, 0, 0.35, 1)

// 0 → 1 from `start` over `dur` frames.
export const enter = (frame: number, start: number, dur = 18, easing = outExpo) =>
  interpolate(frame, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing })

// The same scenes render the 9:16 and the 16:9 cut; layout branches on this.
export const useWide = () => {
  const { width, height } = useVideoConfig()
  return width > height
}
