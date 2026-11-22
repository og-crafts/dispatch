// Speaks scripts/voice-lines.json into assets/voice/<id>.wav with Kokoro-82M (Apache 2.0) on the CPU.
// kokoro-js is not a dependency of this project (it pulls in onnxruntime-node, about 200 MB). Install it once:
//   npm install --no-save kokoro-js@1.2.1 --onnxruntime-node-install-cuda=skip
// The first run downloads the model (onnx-community/Kokoro-82M-v1.0-ONNX, about 330 MB) from Hugging Face.
// Run: node scripts/make-voice.mjs [voice=af_heart] [speed=1]
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KokoroTTS } from 'kokoro-js'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'assets', 'voice')
const [voice = 'af_heart', speed = '1'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' })
for (const [id, text] of JSON.parse(readFileSync(join(here, 'voice-lines.json'), 'utf8'))) {
  const audio = await tts.generate(text, { voice, speed: Number(speed) })
  await audio.save(join(out, `${id}.wav`))
  console.log(id, (audio.audio.length / audio.sampling_rate).toFixed(2) + ' s')
}
console.log('Update the line lengths in src/timing.ts if they changed.')
