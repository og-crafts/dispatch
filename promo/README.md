# Dispatch promo video

A 42-second promo made with [Remotion](https://www.remotion.dev), in two cuts that share the same scenes:
`PromoWide` (1920×1080, 16:9) and `Promo` (1080×1920, 9:16). Scenes read `useWide()` to pick their layout. The
`OgImage` still is the website's link preview (`site/src/assets/og.png`).

- **Picture:** real screenshots of the web app (`../scripts/screenshots.mjs promo`, 2x), seen through a slow camera
  (`src/Window.tsx`) with a violet outline on the part that matters. The look is the app's Dispatch theme, dark:
  graphite, hairlines, one violet accent; Manrope and Geist Mono (both OFL).
- **Voice:** Kokoro-82M (Apache 2.0), voice `af_heart`, made on this machine by `scripts/make-voice.mjs` from
  `scripts/voice-lines.json`. The WAVs are committed in `assets/voice/`, so a render does not need the model.
- **Music:** soft and low, synthesized by `scripts/make-music.mjs` (68 BPM, D major, pad, keys, sub bass, a few
  bells, no drums), so there is nothing to license. It dips under the voice (`src/Promo.tsx`).
- **Captions:** `scripts/make-captions.mjs` writes `site/src/assets/video/dispatch-promo.vtt` from the same timing.

Story, one voice line per scene (`src/timing.ts`): the hook (you only wanted to check one endpoint), the things in
the way struck through, send a request, tests, runner, load test, docs, themes, no account / no sync / on your
machine, end card with dispatch.ogcrafts.cloud. Copy follows the repo rule: warm, problem-led, no other tool named
or compared, no claim beyond what the app does.

## Run
Node 20+ (on the dev box: `export PATH=$HOME/.local/node/bin:$PATH`).
```
npm install
(cd .. && npm run build && PLAYWRIGHT=<playwright dir> CHROMIUM=<chrome> node scripts/screenshots.mjs promo)
npm run assets   # music + fonts, logo and voice into public/ (gitignored)
npm run dev      # Remotion Studio
npm run render   # out/dispatch-promo-16x9.mp4 and out/dispatch-promo-9x16.mp4 (about 4 minutes)
npx remotion still OgImage ../site/src/assets/og.png
```
After a render, copy `out/dispatch-promo-16x9.mp4` to `../site/src/assets/video/` and refresh the poster:
`npx remotion still PromoWide ../site/src/assets/video/dispatch-promo-poster.jpg --frame=282 --image-format=jpeg --jpeg-quality=85`.

Changing a line: edit `scripts/voice-lines.json`, run `node scripts/make-voice.mjs` (install kokoro-js first, see the
script), put the printed lengths in `LINES` in `src/timing.ts` (Root checks that each line fits its scene), then
`node scripts/make-captions.mjs`.

Remotion is free for teams of up to 3; a company licence is needed beyond that (remotion.pro/license).
