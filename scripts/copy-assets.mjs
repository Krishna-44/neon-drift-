// Copies MediaPipe WASM runtime from node_modules into public/ so the app
// serves everything from its own origin (works offline and under Electron's
// app:// protocol). Runs automatically on `npm install` (postinstall).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dst = join(root, 'public', 'mediapipe', 'wasm');

try {
  if (!existsSync(src)) {
    console.warn('[copy-assets] @mediapipe/tasks-vision wasm dir not found yet — skipping (will copy on next install).');
    process.exit(0);
  }
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log('[copy-assets] MediaPipe WASM runtime copied to public/mediapipe/wasm');
} catch (err) {
  console.warn('[copy-assets] non-fatal:', err?.message ?? err);
  process.exit(0);
}
