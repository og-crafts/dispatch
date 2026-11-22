// Scene lengths in frames (30 fps). Each voice line starts VOICE_AT frames into its scene and must end before the
// next cross-fade: frames - VOICE_AT - TRANSITION >= the line's length. LINES holds the lengths in seconds printed
// by scripts/make-voice.mjs; Root.tsx checks them.
export const FPS = 30
export const TRANSITION = 12
export const VOICE_AT = 8

export const LINES = {
  hook: 2.67, friction: 3.33, send: 3.8, tests: 3.63, runner: 4.03, load: 2.73, docs: 2.92, looks: 2.08, private: 3.38, outro: 6.65,
} as const
export type SceneId = keyof typeof LINES

export const SCENES: { id: SceneId; frames: number }[] = [
  { id: 'hook', frames: 110 },
  { id: 'friction', frames: 130 },
  { id: 'send', frames: 150 },
  { id: 'tests', frames: 135 },
  { id: 'runner', frames: 145 },
  { id: 'load', frames: 110 },
  { id: 'docs', frames: 115 },
  { id: 'looks', frames: 110 },
  { id: 'private', frames: 125 },
  { id: 'outro', frames: 240 },
]

export const TOTAL = SCENES.reduce((s, x) => s + x.frames, 0) - TRANSITION * (SCENES.length - 1)

// [start, end] frames of each voice line on the whole timeline (for ducking the music).
export const voiceSpans = (): [number, number][] => {
  let at = 0
  return SCENES.map(({ id, frames }) => {
    const span: [number, number] = [at + VOICE_AT, at + VOICE_AT + Math.ceil(LINES[id] * FPS)]
    at += frames - TRANSITION
    return span
  })
}

export const checkTiming = () => {
  SCENES.forEach(({ id, frames }, i) => {
    const room = frames - VOICE_AT - (i === SCENES.length - 1 ? 0 : TRANSITION)
    if (Math.ceil(LINES[id] * FPS) > room) throw new Error(`Voice line "${id}" (${LINES[id]} s) does not fit its scene (${room} frames).`)
  })
}
