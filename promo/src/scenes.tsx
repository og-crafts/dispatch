import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { C, enter, MONO, SANS, useWide } from './theme'
import { FULL, Rect, Window } from './Window'

const Bg = ({ children }: { children: React.ReactNode }) => (
  <AbsoluteFill style={{ background: C.bg, fontFamily: SANS, color: C.ink }}>{children}</AbsoluteFill>
)

// Text that rises into place.
const Rise = ({ at, children, style }: { at: number; children: React.ReactNode; style?: React.CSSProperties }) => {
  const a = enter(useCurrentFrame(), at, 20)
  return <div style={{ opacity: a, transform: `translateY(${(1 - a) * 24}px)`, ...style }}>{children}</div>
}

// ---------- 1. Hook ----------
export const Hook = () => {
  const frame = useCurrentFrame()
  const wide = useWide()
  const url = '{{base}}/orders/1'
  const typed = url.slice(0, Math.floor(interpolate(frame, [30, 62], [0, url.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })))
  const caret = Math.floor(frame / 15) % 2 === 0
  return (
    <Bg>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: wide ? 160 : 90, gap: wide ? 64 : 80 }}>
        <Rise at={4}>
          <div style={{ fontSize: wide ? 92 : 104, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.05, textAlign: 'center', maxWidth: wide ? 1400 : 900 }}>
            You only wanted to check <span style={{ color: C.accent }}>one endpoint.</span>
          </div>
        </Rise>
        <Rise at={22}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '22px 30px', borderRadius: 18, background: C.surface, border: `1px solid ${C.outline}`, fontFamily: MONO, fontSize: wide ? 38 : 42, minWidth: wide ? 760 : 860 }}>
            <span style={{ color: C.good, fontWeight: 700 }}>GET</span>
            <span>{typed}<span style={{ opacity: caret ? 1 : 0, color: C.accent }}>▍</span></span>
          </div>
        </Rise>
      </AbsoluteFill>
    </Bg>
  )
}

// ---------- 2. Friction: the things in the way, struck through ----------
export const Friction = () => {
  const frame = useCurrentFrame()
  const wide = useWide()
  const items = [['Log in first', 12], ['Wait for the sync', 38], ['Pick a plan', 70]] as const
  return (
    <Bg>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: wide ? 34 : 44 }}>
        {items.map(([text, at]) => {
          const a = enter(frame, at, 16)
          const strike = enter(frame, at + 14, 14)
          return (
            <div key={text} style={{ position: 'relative', opacity: a * (1 - 0.55 * strike), transform: `translateY(${(1 - a) * 20}px)`, fontSize: wide ? 84 : 92, fontWeight: 700, letterSpacing: '-0.02em', color: C.muted }}>
              {text}
              <div style={{ position: 'absolute', left: -12, top: '54%', height: 8, borderRadius: 4, background: C.accent, width: `calc(${strike * 100}% + ${strike * 24}px)` }} />
            </div>
          )
        })}
      </AbsoluteFill>
    </Bg>
  )
}

// ---------- Feature scene: caption + window ----------
type Feature = {
  eyebrow: string
  title: React.ReactNode
  body: string
  shots: string[]
  from?: Rect
  to: Rect
  tallTo?: Rect // the 9:16 cut's tighter end rect
  tallFrom?: Rect
  marks?: { rect: Rect; at: number }[]
  crossfade?: number[]
  label?: (frame: number) => string | null
}

const FeatureScene = ({ f }: { f: Feature }) => {
  const frame = useCurrentFrame()
  const wide = useWide()
  const win = enter(frame, 4, 26)
  const label = f.label?.(frame)
  const caption = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 22 : 24 }}>
      <Rise at={2}><div style={{ fontSize: wide ? 30 : 36, fontWeight: 600, color: C.accent }}>{f.eyebrow}</div></Rise>
      <Rise at={8}><div style={{ fontSize: wide ? 76 : 88, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.04 }}>{f.title}</div></Rise>
      <Rise at={16}><div style={{ fontSize: wide ? 32 : 38, lineHeight: 1.4, color: C.muted, maxWidth: wide ? 560 : 900 }}>{f.body}</div></Rise>
      {label ? <div style={{ alignSelf: 'flex-start', marginTop: 8, padding: '10px 20px', borderRadius: 999, border: `1px solid ${C.outline}`, background: C.surface, fontSize: wide ? 28 : 34, fontWeight: 600 }}>{label}</div> : null}
    </div>
  )
  const w = wide ? 1180 : 960
  const h = wide ? 738 : 1200
  const box = (
    <div style={{ opacity: win, transform: `translateY(${(1 - win) * 40}px) scale(${0.97 + 0.03 * win})` }}>
      <Window
        shots={f.shots} width={w} height={h}
        from={wide ? (f.from ?? FULL) : (f.tallFrom ?? f.to)}
        to={wide ? f.to : (f.tallTo ?? f.to)}
        marks={f.marks} crossfade={f.crossfade}
      />
    </div>
  )
  return (
    <Bg>
      {wide ? (
        <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', padding: '0 80px 0 110px', gap: 70 }}>
          <div style={{ flex: 1 }}>{caption}</div>
          {box}
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ alignItems: 'center', padding: '140px 60px 0', gap: 64 }}>
          <div style={{ alignSelf: 'stretch' }}>{caption}</div>
          {box}
        </AbsoluteFill>
      )}
    </Bg>
  )
}

// Rects in the 1440×900 screenshots (see ../scripts/screenshots.mjs).
const POSTMARK: Rect = { x: 431, y: 501, w: 478, h: 24 }

export const Send = () => (
  <FeatureScene f={{
    eyebrow: 'Dispatch', title: <>Open it.<br />Send the request.</>, body: 'No sign-up, no login. The response is right there.',
    shots: ['light-request'], to: { x: 420, y: 150, w: 800, h: 580 },
    tallFrom: { x: 415, y: 60, w: 1015, h: 660 }, tallTo: { x: 420, y: 160, w: 620, h: 560 },
    marks: [{ rect: POSTMARK, at: 70 }],
  }} />
)

export const Tests = () => (
  <FeatureScene f={{
    eyebrow: 'Scripts and tests', title: 'Check every response.', body: 'A few lines of JavaScript after a request. Each test shows as passed or failed.',
    shots: ['light-scripts'], to: { x: 420, y: 240, w: 1010, h: 320 },
    tallFrom: { x: 420, y: 240, w: 700, h: 480 }, tallTo: { x: 425, y: 280, w: 580, h: 310 },
    marks: [{ rect: { x: 462, y: 296, w: 520, h: 18 }, at: 40 }, { rect: { x: 745, y: 503, w: 130, h: 22 }, at: 78 }],
  }} />
)

export const Runner = () => (
  <FeatureScene f={{
    eyebrow: 'Runner', title: 'Run it for every row.', body: 'A whole collection, once per row of a CSV or JSON file. The same run works in CI.',
    shots: ['dark-runner'], to: { x: 440, y: 105, w: 780, h: 470 },
    tallFrom: { x: 440, y: 105, w: 700, h: 700 }, tallTo: { x: 440, y: 110, w: 560, h: 520 },
    marks: [{ rect: { x: 444, y: 150, w: 512, h: 26 }, at: 64 }],
  }} />
)

export const Load = () => (
  <FeatureScene f={{
    eyebrow: 'Load testing', title: 'See how it holds up.', body: 'Up to 200 virtual users, with pass and fail limits you set.',
    shots: ['dark-load'], to: { x: 440, y: 200, w: 970, h: 380 },
    tallFrom: { x: 440, y: 200, w: 760, h: 380 }, tallTo: { x: 440, y: 270, w: 480, h: 300 },
    marks: [{ rect: { x: 447, y: 232, w: 300, h: 36 }, at: 50 }],
  }} />
)

export const Docs = () => (
  <FeatureScene f={{
    eyebrow: 'Docs', title: 'Docs from your collection.', body: 'Written from your requests and saved examples. Secret values are left out.',
    shots: ['light-docs'], to: { x: 430, y: 120, w: 720, h: 470 },
    tallFrom: { x: 430, y: 120, w: 860, h: 760 }, tallTo: { x: 430, y: 200, w: 600, h: 560 },
  }} />
)

const LOOKS = ['Dispatch, light', 'Dispatch, dark', 'Grove, light', 'Grove, dark']
const LOOK_AT = [26, 50, 74]
export const Looks = () => (
  <FeatureScene f={{
    eyebrow: 'Themes', title: 'Pick your look.', body: 'Each look has a light and a dark side.',
    shots: ['light-request', 'dark-request', 'grove-request', 'grove-dark-request'], crossfade: LOOK_AT,
    to: FULL, tallFrom: { x: 0, y: 0, w: 760, h: 900 }, tallTo: { x: 0, y: 0, w: 760, h: 900 },
    label: (frame) => LOOKS[LOOK_AT.filter((a) => frame >= a + 7).length],
  }} />
)

// ---------- Private ----------
export const Private = () => {
  const wide = useWide()
  const rows = [
    ['No account', 'Nothing to sign up for, nothing to log in to.', 10],
    ['No sync', 'There is no cloud copy of your work.', 34],
    ['On your machine', 'Collections are plain files you can keep in git.', 58],
  ] as const
  return (
    <Bg>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 46 : 64, padding: wide ? 0 : '0 90px' }}>
        {rows.map(([title, body, at]) => (
          <Rise key={title} at={at}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
              <div style={{ width: wide ? 76 : 88, height: wide ? 76 : 88, borderRadius: 999, background: 'rgba(255, 176, 32, .14)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              </div>
              <div>
                <div style={{ fontSize: wide ? 64 : 72, fontWeight: 800, letterSpacing: '-0.02em' }}>{title}</div>
                <div style={{ fontSize: wide ? 32 : 36, color: C.muted, marginTop: 4 }}>{body}</div>
              </div>
            </div>
          </Rise>
        ))}
        </div>
      </AbsoluteFill>
    </Bg>
  )
}

// ---------- Outro ----------
export const Outro = () => {
  const frame = useCurrentFrame()
  const wide = useWide()
  const logo = enter(frame, 4, 26)
  return (
    <Bg>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: wide ? 30 : 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 34, opacity: logo, transform: `scale(${0.9 + 0.1 * logo})` }}>
          <Img src={staticFile('icon.svg')} style={{ width: wide ? 150 : 170, height: wide ? 150 : 170 }} />
          <div>
            <div style={{ fontSize: wide ? 120 : 132, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1 }}>Dispatch</div>
            <div style={{ fontSize: wide ? 36 : 40, color: C.muted, marginTop: 8, fontWeight: 600 }}>by OGCrafts</div>
          </div>
        </div>
        <Rise at={40} style={{ marginTop: wide ? 30 : 50 }}>
          <div style={{ fontSize: wide ? 48 : 56, fontWeight: 700, textAlign: 'center' }}>Free and open source</div>
        </Rise>
        <Rise at={62}>
          <div style={{ fontSize: wide ? 36 : 40, color: C.muted, textAlign: 'center' }}>Windows · macOS · Linux · in your browser</div>
        </Rise>
        <Rise at={96} style={{ marginTop: wide ? 26 : 44 }}>
          <div style={{ fontFamily: MONO, fontSize: wide ? 40 : 46, padding: '18px 34px', borderRadius: 16, border: `1px solid ${C.outline}`, background: C.surface, color: C.ink }}>
            dispatch.ogcrafts.cloud
          </div>
        </Rise>
      </AbsoluteFill>
    </Bg>
  )
}
