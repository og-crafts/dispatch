import { AbsoluteFill, Img, staticFile } from 'remotion'
import { C, SANS } from './theme'
import { Window } from './Window'

// The site's link preview (site/src/assets/og.png, 1200×630): npx remotion still OgImage ../site/src/assets/og.png
export const Og = () => (
  <AbsoluteFill style={{ background: C.bg, fontFamily: SANS, color: C.ink, flexDirection: 'row', alignItems: 'center', padding: '0 0 0 70px', gap: 50 }}>
    <div style={{ width: 470, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Img src={staticFile('icon.svg')} style={{ width: 64, height: 64 }} />
        <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: '-0.03em' }}>Dispatch</div>
      </div>
      <div style={{ fontSize: 60, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.04, marginTop: 40 }}>
        Open it.<br />Send the request.<br /><span style={{ color: C.accent }}>That&rsquo;s it.</span>
      </div>
      <div style={{ fontSize: 26, color: C.muted, marginTop: 28, lineHeight: 1.4 }}>No account, no cloud. Free and open source.</div>
    </div>
    <div style={{ marginRight: -60 }}>
      <Window shots={['light-request']} width={720} height={500} from={{ x: 420, y: 110, w: 820, h: 620 }} to={{ x: 420, y: 110, w: 820, h: 620 }} />
    </div>
  </AbsoluteFill>
)
