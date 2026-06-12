/**
 * NEONDRIFT GP — entry point.
 *
 * Two roles, selected by URL: the default game, or a lightweight spectator
 * view (`?spectate=1`) that renders the live telemetry feed from another tab
 * or the relay server. Boots the App, surfaces fatal errors to the user, and
 * exposes the instance on window for the Electron smoke test.
 */
import { App } from './game/App';
import { SpectatorApp } from './net/SpectatorApp';

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app mount point missing');

  const params = new URLSearchParams(location.search);
  if (params.get('spectate') === '1') {
    const spectator = new SpectatorApp(root, params.get('room') ?? 'local-race', params.get('relay') ?? undefined);
    await spectator.start();
    (window as any).__spectator = spectator;
    return;
  }

  const app = new App(root);
  (window as any).__neondrift = app;
  await app.start();

  // Electron smoke test: auto-run a short synthetic race and report success.
  if (params.get('smoke') === '1') {
    (window as any).__smokeResult = 'running';
  }
}

boot().catch((err) => {
  console.error('[NEONDRIFT] fatal boot error:', err);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML =
      `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;font-family:sans-serif;color:#ff3b5c;background:#04060d;text-align:center;padding:24px">` +
      `<h2 style="color:#00f0ff">NEONDRIFT GP failed to start</h2>` +
      `<pre style="color:#7da6bd;max-width:80vw;white-space:pre-wrap">${String(err?.stack ?? err)}</pre></div>`;
  }
});
