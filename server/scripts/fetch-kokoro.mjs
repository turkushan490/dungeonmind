// Downloads the Kokoro model into /app/models at image build time, so the narrator works offline.
// If this fails (no network), the model downloads to /data/models on first use instead.
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

env.cacheDir = process.env.KOKORO_MODEL_DIR || '/app/models';
const tts = await KokoroTTS.from_pretrained(process.env.KOKORO_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
const audio = await tts.generate('The narrator is ready.', { voice: 'bm_fable' });
console.log(`Kokoro ready: ${audio.audio.length} samples at ${audio.sampling_rate} Hz in ${env.cacheDir}`);
