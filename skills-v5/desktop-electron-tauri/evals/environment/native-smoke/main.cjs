'use strict';

// Independent environment smoke test, not a V5 scenario result or scorer receipt.
const { app, BrowserWindow } = require('electron');
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');

const outputDir = process.env.KORY_ELECTRON_SMOKE_OUTPUT_DIR;
if (!outputDir || !isAbsolute(outputDir)) {
  throw Error('KORY_ELECTRON_SMOKE_OUTPUT_DIR must be an absolute directory');
}
mkdirSync(outputDir, { recursive: true });
const profile = join(outputDir, 'user-data');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

const events = [];
const errors = [];
let observation = null;
app.on('before-quit', () => events.push('before-quit'));
app.on('will-quit', () => events.push('will-quit'));
app.on('quit', () => {
  events.push('quit');
  const passed =
    errors.length === 0 &&
    observation?.visible === true &&
    observation?.nativeWindowHandleBytes > 0 &&
    observation?.isolatedRenderer === true &&
    observation?.screenshot?.length > 1000 &&
    observation?.windowCountAfterClose === 0 &&
    events.includes('window-open') &&
    events.includes('window-close');
  writeFileSync(
    join(outputDir, 'receipt.json'),
    JSON.stringify(
      {
        probeKind: 'standalone-electron-gui-smoke-not-qualification',
        passed,
        pid: process.pid,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        events,
        errors,
        observation,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
});

app
  .whenReady()
  .then(async () => {
    events.push('ready');
    const win = new BrowserWindow({
      width: 640,
      height: 440,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    events.push('window-open');
    await win.loadFile(join(__dirname, 'window.html'));
    win.show();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const renderer = await win.webContents.executeJavaScript(`({
    title: document.title,
    markerVisible: document.querySelector('#marker')?.getBoundingClientRect().width > 0,
    node: typeof require
  })`);
    const png = (await win.webContents.capturePage()).toPNG();
    const pngPath = join(outputDir, 'window.png');
    writeFileSync(pngPath, png);
    observation = {
      visible: win.isVisible(),
      nativeWindowHandleBytes: win.getNativeWindowHandle().length,
      windowCountAtCapture: BrowserWindow.getAllWindows().length,
      isolatedRenderer:
        renderer.title === 'Kory Electron V5 Native Smoke' &&
        renderer.markerVisible === true &&
        renderer.node === 'undefined',
      screenshot: {
        path: pngPath,
        length: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
        source: 'webContents.capturePage',
      },
    };
    const closed = new Promise((resolve) => win.once('closed', resolve));
    win.close();
    await closed;
    events.push('window-close');
    observation.windowCountAfterClose = BrowserWindow.getAllWindows().length;
    app.quit();
  })
  .catch((error) => {
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
    app.quit();
  });
setTimeout(() => {
  errors.push('Timed out waiting for Electron GUI startup');
  app.quit();
}, 20_000).unref();
