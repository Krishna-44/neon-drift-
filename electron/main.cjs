/**
 * Electron desktop shell for NEONDRIFT GP.
 *
 * Serves the built `dist/` over a localhost http server (so the MediaPipe WASM
 * worker + model fetch behave exactly as on the web, which file:// breaks),
 * opens a frameless-ish game window, auto-grants camera permission, and
 * supports a headless `--smoke` self-test that runs a synthetic race and exits
 * 0/1 for CI.
 *
 * Zero extra runtime deps — uses Node's built-in http/fs only.
 */
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const SMOKE = process.argv.includes('--smoke');
const DEV = process.argv.includes('--dev');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.task': 'application/octet-stream', '.map': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function startServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) {
      reject(new Error(`Build not found at ${DIST}. Run "npm run build" first.`));
      return;
    }
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        let filePath = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
        if (!filePath.startsWith(DIST)) {
          res.writeHead(403).end();
          return;
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          filePath = path.join(DIST, 'index.html'); // SPA fallback
        }
        const ext = path.extname(filePath);
        res.writeHead(200, {
          'content-type': MIME[ext] || 'application/octet-stream',
          // COOP/COEP enable SIMD threads for the WASM backend.
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'credentialless',
        });
        fs.createReadStream(filePath).pipe(res);
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
}

async function createWindow() {
  let port;
  try {
    port = await startServer();
  } catch (err) {
    console.error('[electron] ' + err.message);
    app.exit(1);
    return;
  }

  // Auto-grant camera (the whole point of the app).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'camera');
  });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#04060d',
    title: 'NEONDRIFT GP',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
    },
  });

  const query = SMOKE ? '?smoke=1' : '';
  await win.loadURL(`http://127.0.0.1:${port}/${query}`);
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });

  if (SMOKE) {
    runSmoke(win);
  }
}

async function runSmoke(win) {
  const deadline = Date.now() + 35000;
  const poll = async () => {
    let result = 'running';
    try {
      result = await win.webContents.executeJavaScript('window.__smokeResult || "pending"');
    } catch {
      /* page still loading */
    }
    if (result && result !== 'running' && result !== 'pending') {
      let parsed;
      try {
        parsed = JSON.parse(result);
      } catch {
        parsed = { pass: false, raw: result };
      }
      console.log('[smoke] ' + JSON.stringify(parsed));
      app.exit(parsed.pass ? 0 : 1);
      return;
    }
    if (Date.now() > deadline) {
      console.error('[smoke] TIMEOUT — last result: ' + result);
      app.exit(1);
      return;
    }
    setTimeout(poll, 750);
  };
  poll();
}

// Disable GPU-blocklist so software GL works in headless CI for the smoke test.
if (SMOKE) app.disableHardwareAcceleration();

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
