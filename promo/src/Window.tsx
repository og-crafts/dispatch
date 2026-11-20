import { Img, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { C, enter, inOut } from './theme'

// A real screenshot of the app (1440×900 logical, captured at 2x) in a rounded frame, seen through a slow camera
// that moves from rect `from` to rect `to` (logical px). Rects are widened to the frame's aspect and kept inside
// the shot. `marks` draws an amber outline around parts of the shot from a given frame.
export type Rect = { x: number; y: number; w: number; h: number }
export const FULL: Rect = { x: 0, y: 0, w: 1440, h: 900 }
const SW = 1440
const SH = 900

const fit = (r: Rect, aspect: number): Rect => {
  let w = r.w
  let h = r.h
  if (w / h < aspect) w = h * aspect
  else h = w / aspect
  if (w > SW) { w = SW; h = w / aspect }
  if (h > SH) { h = SH; w = h * aspect }
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  return { x: Math.min(Math.max(0, cx - w / 2), SW - w), y: Math.min(Math.max(0, cy - h / 2), SH - h), w, h }
}

const mix = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
})

export const Window = ({
  shots, width, height, from, to, moveStart = 12, moveFrames = 70, marks = [], crossfade = [],
}: {
  shots: string[]
  width: number
  height: number
  from: Rect
  to: Rect
  moveStart?: number
  moveFrames?: number
  marks?: { rect: Rect; at: number }[]
  crossfade?: number[] // frame at which shots[i + 1] fades in over shots[i]
}) => {
  const frame = useCurrentFrame()
  const aspect = width / height
  const t = interpolate(frame, [moveStart, moveStart + moveFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: inOut })
  const cam = mix(fit(from, aspect), fit(to, aspect), t)
  const s = width / cam.w
  const layer = (src: string, opacity: number) => (
    <Img
      key={src}
      src={staticFile(`shots/${src}.png`)}
      style={{ position: 'absolute', left: 0, top: 0, width: SW * s, height: SH * s, opacity, transform: `translate(${-cam.x * s}px, ${-cam.y * s}px)` }}
    />
  )
  return (
    <div
      style={{
        position: 'relative', width, height, borderRadius: 22, overflow: 'hidden', background: C.surface,
        border: `1px solid ${C.outline}`, boxShadow: '0 30px 80px rgba(0, 0, 0, .55), 0 2px 6px rgba(0, 0, 0, .4)',
      }}
    >
      {shots.map((src, i) => layer(src, i === 0 ? 1 : enter(frame, crossfade[i - 1] ?? 0, 14, inOut)))}
      {marks.map(({ rect, at }, i) => {
        const a = enter(frame, at, 14)
        const pad = 6
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: (rect.x - cam.x - pad) * s, top: (rect.y - cam.y - pad) * s,
              width: (rect.w + pad * 2) * s, height: (rect.h + pad * 2) * s, borderRadius: 10 * Math.min(s, 2),
              border: `${Math.max(3, 2.2 * s)}px solid ${C.accent}`, opacity: a, transform: `scale(${1.06 - 0.06 * a})`,
              boxShadow: '0 0 0 4000px rgba(10, 10, 12, ' + 0.28 * a + ')',
            }}
          />
        )
      })}
    </div>
  )
}
