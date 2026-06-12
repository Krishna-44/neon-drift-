/**
 * Preload bridge. Intentionally minimal — the game is self-contained in the
 * renderer and needs no privileged APIs. Exposes a tiny, read-only namespace
 * for environment detection (so the web build and desktop build can diverge
 * later without leaking Node into the page).
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('neondriftDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
