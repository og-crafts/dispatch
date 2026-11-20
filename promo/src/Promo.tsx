import { Audio } from '@remotion/media'
import { interpolate, Sequence, staticFile, useVideoConfig } from 'remotion'
import { linearTiming, TransitionSeries } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import './theme'
import { Docs, Friction, Hook, Load, Looks, Outro, Private, Runner, Send, Tests } from './scenes'
import { SCENES, TRANSITION, VOICE_AT, voiceSpans } from './timing'

const VIEWS = { hook: Hook, friction: Friction, send: Send, tests: Tests, runner: Runner, load: Load, docs: Docs, looks: Looks, private: Private, outro: Outro }

// Ten scenes, each with one voice line (assets/voice/<id>.wav, Kokoro "af_heart"), cross-faded, over a soft
// synthesized music bed (scripts/make-music.mjs) that dips while the voice speaks.
export const Promo = () => {
  const { durationInFrames } = useVideoConfig()
  const spans = voiceSpans()
  const ducked = (f: number) => spans.some(([a, b]) => f >= a - 6 && f <= b + 6)
  return (
    <>
      <TransitionSeries>
        {SCENES.flatMap(({ id, frames }, i) => {
          const View = VIEWS[id]
          const seq = (
            <TransitionSeries.Sequence key={id} name={id} durationInFrames={frames}>
              <View />
              <Sequence from={VOICE_AT} layout="none">
                <Audio name={`Voice ${id}`} src={staticFile(`voice/${id}.wav`)} volume={1} />
              </Sequence>
            </TransitionSeries.Sequence>
          )
          return i === 0 ? [seq] : [<TransitionSeries.Transition key={`t${id}`} presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION })} />, seq]
        })}
      </TransitionSeries>
      <Audio
        name="Music"
        src={staticFile('audio/music.wav')}
        durationInFrames={durationInFrames}
        volume={(f) => {
          const edge = interpolate(f, [0, 15, durationInFrames - 45, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
          return edge * (ducked(f) ? 0.2 : 0.32)
        }}
      />
    </>
  )
}
