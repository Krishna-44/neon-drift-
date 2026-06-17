// Downloads a CC0 neon HDRI (Poly Haven) into public/hdri/env.hdr for realistic
// reflections. Run via `npm run setup`. Poly Haven assets are CC0 (no attribution
// required). If absent at runtime, the game falls back to a procedural neon env.
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HDRI_URL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/neon_photostudio_2k.hdr';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'public', 'hdri');
const file = join(dir, 'env.hdr');

if (existsSync(file) && statSync(file).size > 500_000) {
  console.log('[fetch-hdri] already present:', file);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
console.log('[fetch-hdri] downloading neon HDRI (CC0, Poly Haven)…');
const res = await fetch(HDRI_URL);
if (!res.ok || !res.body) {
  console.error(`[fetch-hdri] failed (HTTP ${res.status}). The game will use the procedural environment instead.`);
  process.exit(0); // non-fatal — procedural fallback exists
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
console.log(`[fetch-hdri] saved ${(statSync(file).size / 1e6).toFixed(1)} MB -> ${file}`);
