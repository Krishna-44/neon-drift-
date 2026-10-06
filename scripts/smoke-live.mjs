// Post-deploy smoke test: opens the deployed game in headless Chromium (fake
// webcam, software WebGL), starts a keyboard/demo race and turns on the camera
// path, and fails on any page error or unexpected failed request.
// Usage: node smoke-live.mjs <url> [screenshotDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2];
const outDir = process.argv[3] ?? '.';
if (!url) {
  console.error('usage: node smoke-live.mjs <url> [screenshotDir]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// Optional assets the game probes for and falls back from when absent.
const OPTIONAL = [/\/hdri\/env\.hdr$/, /\/models\/car\.glb$/, /\/models\/hand_landmarker\.task$/, /favicon\.ico$/];
const problems = [];

const browser = await chromium.launch({
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});

async function openPage(label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => problems.push(`[${label}] page error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !OPTIONAL.some((re) => re.test(new URL(r.url()).pathname))) {
      problems.push(`[${label}] HTTP ${r.status()} ${r.url()}`);
    }
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[${label}] console.error: ${m.text().slice(0, 300)}`);
  });
  // A fresh Pages deploy can take a moment to propagate; retry until it serves.
  for (let attempt = 1; ; attempt++) {
    const res = await page.goto(url, { waitUntil: 'load' }).catch((e) => ({ ok: () => false, status: () => e.message }));
    if (res.ok()) break;
    if (attempt >= 12) throw new Error(`${url} did not load: ${res.status()}`);
    console.log(`[${label}] ${url} -> ${res.status()}, retrying in 10s`);
    await page.waitForTimeout(10_000);
  }
  await page.locator('button:visible:has-text("ENABLE CAMERA")').waitFor({ timeout: 30_000 });
  return page;
}

// 1) Demo + keyboard: menu → track select → race, holding the throttle.
const race = await openPage('race');
await race.screenshot({ path: join(outDir, '1-menu.png') });
await race.click('button:visible:has-text("USE DEMO + KEYBOARD")');
await race.click('text=RACE');
await race.click('button:visible:has-text("START RACE")');
await race.click('button:visible:has-text("GOT IT")', { timeout: 10_000 }).catch(() => {});
await race.waitForFunction(() => /POSITION/.test(document.body.innerText), null, { timeout: 30_000 });
await race.keyboard.down('ArrowUp');
await race.waitForTimeout(8_000);
await race.keyboard.up('ArrowUp');
await race.screenshot({ path: join(outDir, '2-race.png') });
console.log('[race] race HUD is up');

// 2) Camera path: loads the MediaPipe WASM runtime + hand model in the worker.
const cam = await openPage('camera');
await cam.click('button:visible:has-text("ENABLE CAMERA")');
await cam.waitForFunction(() => /hand tracking is live/i.test(document.body.innerText), null, { timeout: 60_000 });
await cam.waitForTimeout(5_000); // let the CV worker process a few frames
await cam.screenshot({ path: join(outDir, '3-camera.png') });
console.log('[camera] hand tracking is live');

await browser.close();

if (problems.length) {
  console.error(`Smoke test FAILED (${problems.length} problem(s)):\n` + problems.join('\n'));
  process.exit(1);
}
console.log(`Smoke test passed: ${url}`);
