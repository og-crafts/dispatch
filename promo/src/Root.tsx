import { Composition, Still } from 'remotion'
import { Og } from './Og'
import { Promo } from './Promo'
import { checkTiming, FPS, TOTAL } from './timing'

checkTiming()

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Promo" component={Promo} durationInFrames={TOTAL} fps={FPS} width={1080} height={1920} />
    <Composition id="PromoWide" component={Promo} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
    <Still id="OgImage" component={Og} width={1200} height={630} />
  </>
)
