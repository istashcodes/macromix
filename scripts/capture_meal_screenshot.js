/**
 * Automated App Screenshot Harness for Macromix
 * Launches headless Chrome, loads the app, simulates meal entry,
 * waits for real Gemini extraction & UI update, then captures a high-res mobile screenshot.
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 5088;
const DEBUG_PORT = 9226;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ARTIFACT_DIR = '/Users/satish.s/.gemini/antigravity/brain/bbdedf7f-d6a6-4362-a87c-7cd181d6635f';
const OUTPUT_FILE = path.join(ARTIFACT_DIR, 'meal_log_screenshot.png');

// 1. Simple static HTTP server for the repo files
function startServer() {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  const server = http.createServer((req, res) => {
    let filePath = path.join(REPO_ROOT, req.url.split('?')[0]);
    if (filePath.endsWith('/') || filePath === REPO_ROOT) filePath = path.join(REPO_ROOT, 'index.html');

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[Server] Local server running on http://127.0.0.1:${PORT}`);
      resolve(server);
    });
  });
}

// 2. Launch headless Chrome with CDP
function launchChrome() {
  const tmpDir = `/tmp/macromix-cdp-${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${tmpDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=430,932',
    '--disable-gpu'
  ]);

  return { chromeProc, tmpDir };
}

// 3. Simple CDP Client using built-in WebSocket & fetch
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.callbacks = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && this.callbacks.has(msg.id)) {
            const { resolve, reject } = this.callbacks.get(msg.id);
            this.callbacks.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        } catch (e) {}
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return res.result ? res.result.value : null;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function run() {
  const targetUrl = process.env.TARGET_URL || `http://127.0.0.1:${PORT}/`;
  let server = null;
  if (!process.env.TARGET_URL) {
    server = await startServer();
  }
  const { chromeProc, tmpDir } = launchChrome();

  try {
    // Wait for Chrome CDP to be available
    let wsUrl = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 400));
      try {
        const resp = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
        const pages = await resp.json();
        const page = pages.find(p => p.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch (e) {}
    }

    if (!wsUrl) throw new Error('Could not connect to Chrome DevTools Protocol');
    console.log('[Chrome] Connected to CDP:', wsUrl);

    const client = new CDPClient(wsUrl);
    await client.connect();

    await client.send('Page.enable');
    await client.send('DOM.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 412,
      height: 915,
      deviceScaleFactor: 2,
      mobile: true
    });

    console.log('[Page] Navigating to ' + targetUrl + '...');
    await client.send('Page.navigate', { url: targetUrl });
    await new Promise(r => setTimeout(r, 1500));

    // Preset user session to skip onboarding and set initial targets
    await client.evaluate(`
      localStorage.setItem('macromix_user_handle', 'satish');
      localStorage.setItem('macromix_targets', JSON.stringify({
        calories: 2200, protein_g: 160, carbs_g: 220, fat_g: 70, fiber_g: 30
      }));
    `);

    // Reload page with active session
    await client.send('Page.navigate', { url: targetUrl });
    await new Promise(r => setTimeout(r, 2000));

    console.log('[Action] Entering meal: "2 boiled eggs, sourdough toast, and black coffee"...');
    await client.evaluate(`
      const input = document.getElementById('manual-text-input');
      if (input) {
        input.value = "2 boiled eggs, sourdough toast, and black coffee";
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const btn = document.getElementById('btn-submit-log');
      if (btn) btn.click();
    `);

    // Poll until meal is logged or timeout
    console.log('[Action] Waiting for Gemini meal analysis and UI render...');
    let logged = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const status = await client.evaluate(`
        ({
          isProcessing: typeof isProcessingLog !== 'undefined' ? isProcessingLog : false,
          logsCount: (typeof currentLogs !== 'undefined' && currentLogs) ? currentLogs.length : 0,
          calVal: document.getElementById('val-cal')?.textContent || '',
          micStatus: document.getElementById('mic-status-text')?.textContent || '',
          mealCards: document.querySelectorAll('#meal-logs-container .meal-card').length
        })
      `);

      console.log(`[Status ${attempt + 1}s]`, JSON.stringify(status));
      if (status.mealCards > 0 || (status.calVal && status.calVal !== '0' && !status.isProcessing)) {
        logged = true;
        break;
      }
      if (status.micStatus && status.micStatus.includes('Could not analyze')) {
        throw new Error(`Meal analysis failed in browser: ${status.micStatus}`);
      }
    }

    // Additional settling time for smooth circles animation
    await new Promise(r => setTimeout(r, 1200));

    console.log('[Screenshot] Capturing screenshot...');
    const ssResult = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    });

    const buffer = Buffer.from(ssResult.data, 'base64');
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, buffer);
    console.log(`[Success] Screenshot saved to ${OUTPUT_FILE} (${buffer.length} bytes)`);

    client.close();
  } finally {
    chromeProc.kill('SIGTERM');
    if (server) server.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

run().then(() => {
  console.log('[Done] Capture script completed successfully.');
  process.exit(0);
}).catch(err => {
  console.error('[Error]', err);
  process.exit(1);
});
