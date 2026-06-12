// Downloads the MediaPipe HandLandmarker model (~7.8 MB) into public/models/
// so hand tracking works fully offline. Run via `npm run setup`.
// If this file is absent at runtime, the app transparently falls back to
// Google's CDN and caches the model in the browser Cache API.
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'public', 'models');
const file = join(dir, 'hand_landmarker.task');

if (existsSync(file) && statSync(file).size > 1_000_000) {
  console.log('[fetch-model] model already present:', file);
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
console.log('[fetch-model] downloading hand_landmarker.task ...');
const res = await fetch(MODEL_URL);
if (!res.ok || !res.body) {
  console.error(`[fetch-model] download failed (HTTP ${res.status}). The app will fall back to the CDN at runtime.`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
console.log(`[fetch-model] saved ${(statSync(file).size / 1e6).toFixed(1)} MB -> ${file}`);
