import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findExecutableOnPath } from '../runtime/platform';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';

const ELECTRON = 'desktop-electron-tauri-full-task-1-individual';
const TAURI = 'desktop-electron-tauri-full-task-2-individual';
type DesktopScenario = typeof ELECTRON | typeof TAURI;
// Qualification is tied to the extracted native runtime, not an arbitrary
// executable named "electron" with a plausible --version response.
const PINNED_ELECTRON_VERSION = '42.9.0';

const NATIVE_CHECKS = {
  [ELECTRON]: [
    'electron-runtime',
    'real-renderer-isolated',
    'unexposed-ipc-denied',
    'first-save-once',
    'second-save-once',
    'third-save-once',
    'renderer-reload-save-once',
    'simultaneous-windows-save-once',
    'no-stale-window-listeners',
    'window-lifecycle',
    'real-window-capture',
    'app-quit',
  ],
  [TAURI]: [
    'tauri-packaged-runtime',
    'native-window-lifecycle',
    'native-renderer-and-capture',
    'native-folder-dialog-opened',
    'native-dialog-cancel-is-none',
    'native-folder-selection',
    'allowed-command-inside-root',
    'symlink-swap-at-use-denied',
    'unexposed-command-denied',
    'reopen-without-stale-state',
    'restart-restores-canonical-state',
  ],
} as const;

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CONTRACT_FILE = '.kory-eval/desktop-fixture.json';
const MAX_CAPTURE = 10_000_000;
const ELECTRON_EVENTS = [
  'open:cycle-1', 'close:cycle-1', 'open:cycle-2', 'close:cycle-2',
  'open:cycle-3', 'close:cycle-3', 'open:concurrent-a', 'open:concurrent-b',
  'close:concurrent-a', 'close:concurrent-b', 'before-quit', 'will-quit',
];
const TAURI_EVENTS = [
  'window:created', 'window:closed', 'window:reopened',
  'dialog:opened', 'dialog:cancelled', 'dialog:accepted',
  'fs:symlink-retargeted', 'app:quit', 'app:restarted', 'renderer:capture',
];

const ELECTRON_MAIN = String.raw`
// Intentional defect: each opened window installs another process-wide listener.
const { app, BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');

function openSettingsWindow(onSave) {
  const win = new BrowserWindow({
    width: 520, height: 360, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, preload: join(__dirname, 'preload.cjs'),
    },
  });
  ipcMain.on('settings:save', (_event, settings) => {
    onSave(settings);
    // A previous listener still tries to use this window after it is closed.
    win.webContents.send('settings:saved', { ok: true });
  });
  void win.loadFile(join(__dirname, 'settings.html'));
  return win;
}

module.exports = { openSettingsWindow };
if (require.main === module) {
  app.whenReady().then(() => openSettingsWindow(() => {}));
  app.on('window-all-closed', () => app.quit());
}
`;

const ELECTRON_PRELOAD = String.raw`
const { contextBridge, ipcRenderer } = require('electron');
// Existing renderer API: preserve save(settings) and onSaved(callback).
contextBridge.exposeInMainWorld('settings', {
  save: (settings) => ipcRenderer.send('settings:save', settings),
  onSaved: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('settings:saved', listener);
    return () => ipcRenderer.removeListener('settings:saved', listener);
  },
});
`;

const ELECTRON_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Native Settings</title>
<style>body{font:18px system-ui;background:#17243a;color:#fff;padding:30px}
button{padding:15px 24px;border:0;border-radius:8px;background:#8fe6c4;color:#102019}
#status{margin-top:22px}</style></head><body>
<main><h1>Settings</h1><button id="save" type="button">Save settings</button>
<p id="status" role="status">Ready</p></main><script src="renderer.js"></script>
</body></html>`;

const ELECTRON_RENDERER = String.raw`
document.querySelector('#save').addEventListener('click', () => {
  window.settings.save({ theme: 'night', source: 'native-settings-button' });
});
window.settings.onSaved(() => {
  document.querySelector('#status').textContent = 'Saved';
});
`;

const ELECTRON_TYPES = String.raw`
// The preload contract must remain available to the renderer after a repair.
export interface SettingsPayload {
  theme: string;
  source: string;
}
export interface SettingsSaveResult { ok: boolean }
declare global {
  interface Window {
    settings: {
      save(settings: SettingsPayload): void;
      onSaved(callback: (result: SettingsSaveResult) => void): () => void;
    };
  }
}
`;

// This driver is authored by the evaluator and written outside the candidate workspace
// immediately before a run. It uses Electron's real BrowserWindow, IPC and compositor.
const ELECTRON_PROBE = String.raw`
const { app, BrowserWindow, ipcMain } = require('electron');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = process.argv.find((arg) => arg.startsWith('--kory-root='))?.slice(12);
const output = process.argv.find((arg) => arg.startsWith('--kory-report='))?.slice(14);
const screenshot = process.argv.find((arg) => arg.startsWith('--kory-capture='))?.slice(15);
const nonce = process.argv.find((arg) => arg.startsWith('--kory-nonce='))?.slice(13);
const userData = process.argv.find((arg) => arg.startsWith('--kory-user-data='))?.slice(17);
if (!root || !output || !screenshot || !nonce || !userData) {
  throw Error('Missing native probe arguments');
}
// Keep Electron's profile out of the developer's regular app data.
app.setPath('userData', userData);
const checks = [];
const logs = [];
const windows = [];
const errors = [];
let captured = null;
let quitSeen = false;
let finalWritten = false;
let mainFinished = false;
let earlyQuitAttempts = 0;

function check(id, passed, detail) {
  checks.push({ id, passed: passed === true, detail: String(detail).slice(0, 320) });
}
function report() {
  if (finalWritten) return;
  finalWritten = true;
  const receipt = {
    scenarioId: 'desktop-electron-tauri-full-task-1-individual',
    nonce,
    runtime: 'electron', nativeVersion: process.versions.electron,
    platformVersion: process.versions.chrome, pid: process.pid,
    checks, screenshot: captured,
    nativeEvents: windows, nativeQuitObserved: quitSeen,
    earlyQuitAttempts, errors,
  };
  writeFileSync(output, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
}
async function pause(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); }
async function ready(win) {
  if (win.webContents.isLoading()) {
    await Promise.race([
      new Promise((resolve, reject) => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.once('did-fail-load', (_ev, code) => reject(new Error('renderer load ' + code)));
      }),
      pause(8000).then(() => { throw Error('renderer load timeout'); }),
    ]);
  }
  win.show();
  await pause(160);
}
async function clickAndCount(win, owner, id) {
  const before = logs.length;
  const ui = await win.webContents.executeJavaScript(
    '(() => { const button = document.querySelector("#save"); if (!button || !button.getClientRects().length) return false; button.click(); return true; })()'
  );
  await pause(180);
  const entries = logs.slice(before);
  const status = await win.webContents.executeJavaScript(
    'document.querySelector("#status")?.textContent'
  );
  check(id, ui === true && entries.length === 1 && entries[0].owner === owner &&
    entries[0].settings?.source === 'native-settings-button' && status === 'Saved',
    'UI=' + ui + '; status=' + status + '; handler writes=' + entries.length +
      '; owners=' + entries.map((x) => x.owner));
}
async function main() {
  const { openSettingsWindow } = require(join(root, 'app', 'main.cjs'));
  if (typeof openSettingsWindow !== 'function') throw Error('missing exported native window factory');
  const runner = (id) => {
    const win = openSettingsWindow((settings) => logs.push({ owner: id, settings }));
    if (!(win instanceof BrowserWindow)) throw Error('window factory did not return BrowserWindow');
    windows.push('open:' + id);
    win.on('closed', () => windows.push('close:' + id));
    return win;
  };
  for (let i = 1; i <= 3; i++) {
    const win = runner('cycle-' + i);
    await ready(win);
    if (i === 1) {
      const web = await win.webContents.executeJavaScript(
        '({ keys: Object.keys(window.settings || {}).sort(), node: typeof require, ipc: typeof window.ipcRenderer, arbitrary: typeof window.settings?.invoke, title: document.title, visible: document.querySelector("#save")?.getBoundingClientRect().width > 0, denied: (() => { try { window.settings.invoke("forbidden:command"); return false; } catch (error) { return error instanceof TypeError; } })() })'
      );
      const prefs = win.webContents.getLastWebPreferences?.();
      const nativeHandle = win.getNativeWindowHandle();
      check('real-renderer-isolated', web.visible && web.title === 'Native Settings' &&
        web.node === 'undefined' && prefs?.contextIsolation === true &&
        prefs?.nodeIntegration === false && prefs?.sandbox === true &&
        prefs?.webSecurity !== false && win.isVisible() && nativeHandle.length >= 4,
        'Visible native BrowserWindow handle=' + nativeHandle.length + '; isolated renderer DOM');
      check('unexposed-ipc-denied', web.denied && web.ipc === 'undefined' &&
        web.arbitrary === 'undefined' &&
        JSON.stringify(web.keys) === JSON.stringify(['onSaved','save']),
        'Renderer rejected unexposed IPC; bridge methods: ' + JSON.stringify(web.keys));
      const image = await win.webContents.capturePage();
      const png = image.toPNG();
      const size = image.getSize();
      const pixels = image.toBitmap();
      const sampled = new Set();
      const stride = Math.max(4, Math.floor(pixels.length / 2048 / 4) * 4);
      for (let offset = 0; offset + 4 <= pixels.length; offset += stride) {
        sampled.add(pixels.readUInt32LE(offset));
      }
      writeFileSync(screenshot, png, { flag: 'wx', mode: 0o600 });
      captured = { sha256: createHash('sha256').update(png).digest('hex'),
        width: size.width, height: size.height, source: 'webContents.capturePage' };
      check('real-window-capture', png.length > 1000 && size.width >= 300 &&
        size.height >= 200 && pixels.length >= size.width * size.height * 4 &&
        sampled.size >= 4 && png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
        'Electron compositor PNG ' + size.width + 'x' + size.height +
          '; sampled pixel colors=' + sampled.size);
    }
    await clickAndCount(win, 'cycle-' + i, ['first-save-once','second-save-once','third-save-once'][i - 1]);
    if (i === 3) {
      const loaded = new Promise((resolve, reject) => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.once('did-fail-load', (_event, code) => reject(Error('reload failed: ' + code)));
      });
      win.webContents.reload();
      await Promise.race([loaded, pause(8000).then(() => { throw Error('renderer reload timeout'); })]);
      // The reload completion event was already consumed above. Registering a
      // second did-finish-load waiter after it fires races with isLoading().
      await pause(160);
      await clickAndCount(win, 'cycle-3', 'renderer-reload-save-once');
    }
    win.close();
    await pause(100);
    if (!win.isDestroyed()) errors.push('window ' + i + ' still exists after close');
    if (ipcMain.listenerCount('settings:save') !== 0) {
      errors.push('window ' + i + ' leaked IPC save listeners');
    }
  }
  const a = runner('concurrent-a');
  const b = runner('concurrent-b');
  await ready(a);
  await ready(b);
  const before = logs.length;
  await a.webContents.executeJavaScript('document.querySelector("#save").click()');
  await b.webContents.executeJavaScript('document.querySelector("#save").click()');
  await pause(250);
  const both = logs.slice(before);
  check('simultaneous-windows-save-once', both.length === 2 &&
    both.filter((x) => x.owner === 'concurrent-a').length === 1 &&
    both.filter((x) => x.owner === 'concurrent-b').length === 1,
    'Two UI clicks caused ' + both.length + ' writes');
  a.close();
  b.close();
  await pause(130);
  check('no-stale-window-listeners', ipcMain.listenerCount('settings:save') === 0 &&
    errors.length === 0, 'IPC listeners after all closes: ' + ipcMain.listenerCount('settings:save'));
  check('window-lifecycle', BrowserWindow.getAllWindows().length === 0 &&
    windows.filter((x) => x.startsWith('open:')).length === 5 &&
    windows.filter((x) => x.startsWith('close:')).length === 5,
    'native events: ' + windows.join(','));
  check('electron-runtime', process.versions.electron === '42.9.0' &&
    !!process.versions.chrome && app.getPath('userData') === userData,
    'Electron=' + process.versions.electron + '; Chromium=' + process.versions.chrome);
}
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  // Closing the final window during a repeated-open test must not terminate
  // the independent native verifier before its concurrent-window phase.
  if (!mainFinished) {
    earlyQuitAttempts++;
    event.preventDefault();
    return;
  }
  windows.push('before-quit');
});
app.on('will-quit', () => windows.push('will-quit'));
app.on('quit', () => {
  quitSeen = true;
  if (!mainFinished) errors.push('native verifier quit before completing lifecycle checks');
  check('app-quit', windows.includes('before-quit') && windows.includes('will-quit'),
    'native app quit callbacks observed');
  report();
});
process.on('uncaughtException', (e) => { errors.push('uncaught: ' + e.message); });
process.on('unhandledRejection', (e) => { errors.push('rejection: ' + String(e)); });
app.whenReady().then(main).catch((e) => { errors.push('probe: ' + e.message); })
  .then(() => { mainFinished = true; })
  .finally(() => { setTimeout(() => app.quit(), 200); });
setTimeout(() => { errors.push('probe watchdog timeout'); app.quit(); }, 30000).unref();
`;

const TAURI_RUST = String.raw`
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

// Intentional defect: the command trusts a path chosen earlier by the webview.
#[tauri::command]
fn read_workspace(path: String) -> Result<String, String> {
    let root = if path.is_empty() {
        std::env::var("HOME").unwrap_or_default() // Cancel becomes privileged home.
    } else { path };
    std::fs::read_to_string(PathBuf::from(root).join("workspace.txt"))
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn choose_workspace(app: tauri::AppHandle) -> Result<String, String> {
    // This is a REAL native folder picker; it must return a typed cancellation.
    Ok(app.dialog().file().blocking_pick_folder()
        .map(|selection| selection.to_string()).unwrap_or_default())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_workspace, choose_workspace])
        .run(tauri::generate_context!())
        .expect("Tauri native runtime failed");
}
`;

const TAURI_HTML = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Workspace selection</title><style>
body{font:18px system-ui;background:#26354d;color:white;padding:28px}
button{padding:12px;margin:8px;background:#b1dfd0;color:#101b19;border:0;border-radius:8px}
</style></head><body><main><h1>Native workspace</h1>
<button id="choose" type="button">Choose folder</button>
<button id="read" type="button">Read workspace</button>
<p id="status" role="status">No folder selected</p>
</main><script src="renderer.js"></script></body></html>`;

const TAURI_RENDERER = String.raw`
const invoke = window.__TAURI__.core.invoke;
const status = document.querySelector('#status');
let chosenPath = localStorage.getItem('workspace') || '';
document.querySelector('#choose').addEventListener('click', async () => {
  const selected = await invoke('choose_workspace');
  chosenPath = selected || ''; // BUG: a cancel loses the difference between none and empty.
  localStorage.setItem('workspace', chosenPath);
  status.textContent = chosenPath || 'No folder selected';
});
document.querySelector('#read').addEventListener('click', async () => {
  try { status.textContent = await invoke('read_workspace', { path: chosenPath }); }
  catch (error) { status.textContent = String(error); }
});
`;

const TAURI_MANIFEST = JSON.stringify({
  $schema: 'https://schema.tauri.app/config/2',
  productName: 'Kory Native Workspace Fixture',
  version: '0.1.0',
  identifier: 'dev.koryphaios.eval.desktopworkspace',
  build: { frontendDist: '../ui' },
  app: {
    withGlobalTauri: true,
    windows: [{ label: 'main', title: 'Native Workspace Fixture', width: 640, height: 420 }],
    security: {
      csp: "default-src 'self'; connect-src ipc: http://ipc.localhost; script-src 'self'; style-src 'self' 'unsafe-inline'",
    },
  },
  bundle: { active: true, targets: 'all' },
}, null, 2) + '\n';

const TAURI_CARGO = `[package]
name = "kory-desktop-native-fixture"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2" }

[dependencies]
tauri = { version = "2" }
tauri-plugin-dialog = "2"
`;

const TUTORIAL = {
  [ELECTRON]: 'Electron main, isolated preload and renderer; fix repeated-window IPC listener ownership.',
  [TAURI]: 'Tauri v2 Rust command + native picker; enforce canonical root at use time and typed cancellation.',
};

const NEAR_NEIGHBOR = {
  [ELECTRON]: 'android-compose',
  [TAURI]: 'ios-swiftui',
};

export const DESKTOP_RUNTIME_SCENARIOS = { electron: ELECTRON, tauri: TAURI } as const;

function command(binary: string, args: string[], cwd?: string, timeout = 12_000) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout,
    windowsHide: true,
    maxBuffer: 512_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  return {
    status: result.status,
    pid: result.pid ?? null,
    stdout: String(result.stdout ?? ''),
    error: (result.error?.message ?? String(result.stderr ?? '')).slice(-1200),
  };
}

/** An explicit launcher is authoritative; otherwise look in local toolchains and PATH. */
function electronBinary(): string {
  const override = process.env.KORY_SKILL_EVAL_ELECTRON_BINARY?.trim();
  if (override) return override;
  const localBins = [
    resolve(import.meta.dir, '../../../node_modules/.bin'),
    resolve(import.meta.dir, '../../../desktop/node_modules/.bin'),
  ];
  return (
    findExecutableOnPath('electron', [...localBins, process.env.PATH ?? ''].join(delimiter)) ??
    'electron'
  );
}

/** Prefer the installed project CLI before searching unrelated global Tauri versions. */
function tauriCliBinary(): string {
  const override = process.env.KORY_SKILL_EVAL_TAURI_CLI?.trim();
  if (override) return override;
  const bundledBin = resolve(import.meta.dir, '../../../desktop/node_modules/.bin');
  return (
    findExecutableOnPath('tauri', [bundledBin, process.env.PATH ?? ''].join(delimiter)) ?? 'tauri'
  );
}


function hasExecutable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Reject shell/JS wrappers that can print a matching version without a GUI. */
function hasNativeExecutableHeader(path: string): boolean {
  if (!hasExecutable(path)) return false;
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const header = Buffer.alloc(4);
      if (readSync(fd, header, 0, header.length, 0) !== header.length) return false;
      const magic = header.toString('hex');
      // Mach-O (both endiannesses, universal), ELF and Windows PE executable.
      return ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface',
        'cafebabe', 'bebafeca', '7f454c46'].includes(magic) ||
        (header[0] === 0x4d && header[1] === 0x5a);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** An installed product app is not a toolchain that can launch an arbitrary fixture. */
export function desktopRuntimeReadiness(scenarioId: DesktopScenario): string[] {
  const blockers: string[] = [];
  if (scenarioId === ELECTRON) {
    const bin = electronBinary();
    if (!hasNativeExecutableHeader(bin)) {
      blockers.push('A callable pinned Electron desktop runtime is unavailable: ' +
        'set KORY_SKILL_EVAL_ELECTRON_BINARY to the absolute path of a native executable');
    } else {
      const checked = command(bin, ['--version']);
      if (checked.status !== 0 || checked.stdout.trim() !== `v${PINNED_ELECTRON_VERSION}`) {
        blockers.push('A callable pinned Electron desktop runtime is unavailable (requires ' +
          PINNED_ELECTRON_VERSION + '): ' + (checked.error || checked.stdout.trim()));
      }
    }
  } else if (scenarioId === TAURI) {
    for (const [label, binary, args] of [
      ['Rust cargo', 'cargo', ['--version']],
      ['Tauri v2 CLI', tauriCliBinary(), ['--version']],
    ] as const) {
      const probed = command(binary, [...args]);
      if (probed.status !== 0 || !/\d+\.\d+/u.test(probed.stdout)) {
        blockers.push(label + ' unavailable: ' + probed.error);
      } else if (label === 'Tauri v2 CLI' && !/\b2\.\d+/u.test(probed.stdout)) {
        blockers.push('Requires the Tauri v2 native CLI, found ' + probed.stdout.trim());
      }
    }
    const driver = process.env.KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER?.trim() ?? '';
    if (!hasExecutable(driver)) {
      blockers.push(
        'Native Tauri window/dialog automation and OS compositor capture unavailable: ' +
          'set KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER to a trusted executable outside the fixture.',
      );
    }
  } else {
    blockers.push('Unknown desktop evaluation scenario');
  }
  return blockers;
}

/** Write deliberately failing but real desktop source code; never create a green report. */
export function materializeDesktopFixture(root: string, scenarioId: DesktopScenario): void {
  const blockers = desktopRuntimeReadiness(scenarioId);
  if (blockers.length) throw new Error('Native desktop runtime unavailable: ' + blockers.join('; '));
  writeFixtureFile(root, CONTRACT_FILE, JSON.stringify({
    scenarioId, skill: 'desktop-electron-tauri', kind: 'native-desktop-v5',
    boundary: scenarioId === ELECTRON ? 'electron-main-preload-renderer' : 'tauri-rust-webview',
    broader: 'native-interface', nearNeighbor: NEAR_NEIGHBOR[scenarioId],
    facet: 'application-security',
    instructions: TUTORIAL[scenarioId],
    cannotSubstitute: ['headless-browser', 'mock-ipc', 'unit-only-rust', 'synthetic-screenshot'],
  }, null, 2) + '\n');
  if (scenarioId === ELECTRON) {
    writeFixtureFile(root, 'app/package.json', '{"name":"kory-electron-fixture","private":true,"main":"main.cjs"}\n');
    writeFixtureFile(root, 'app/main.cjs', ELECTRON_MAIN);
    writeFixtureFile(root, 'app/preload.cjs', ELECTRON_PRELOAD);
    writeFixtureFile(root, 'app/settings.html', ELECTRON_HTML);
    writeFixtureFile(root, 'app/renderer.js', ELECTRON_RENDERER);
    writeFixtureFile(root, 'app/settings.d.ts', ELECTRON_TYPES);
  } else {
    writeFixtureFile(root, 'package.json', '{"name":"kory-tauri-fixture","private":true,"scripts":{"tauri":"tauri"}}\n');
    writeFixtureFile(root, 'src-tauri/Cargo.toml', TAURI_CARGO);
    writeFixtureFile(root, 'src-tauri/build.rs', 'fn main() { tauri_build::build() }\n');
    writeFixtureFile(root, 'src-tauri/src/main.rs', 'fn main() { kory_desktop_native_fixture::run(); }\n');
    writeFixtureFile(root, 'src-tauri/src/lib.rs', TAURI_RUST);
    writeFixtureFile(root, 'src-tauri/tauri.conf.json', TAURI_MANIFEST);
    writeFixtureFile(root, 'src-tauri/capabilities/default.json', JSON.stringify({
      identifier: 'default', windows: ['main'], permissions: ['core:default', 'dialog:allow-open'],
    }, null, 2) + '\n');
    writeFixtureFile(root, 'ui/index.html', TAURI_HTML);
    writeFixtureFile(root, 'ui/renderer.js', TAURI_RENDERER);
    writeFixtureFile(root, 'safe-workspace/inside/workspace.txt', 'contained workspace fixture\n');
    writeFixtureFile(root, 'outside-workspace/workspace.txt', 'ESCAPED WORKSPACE: MUST NEVER READ\n');
    // The native driver retargets this directory link after folder selection.
    // Both paths live in the disposable fixture, never in the actual workspace.
    symlinkSync('inside', join(resolve(root), 'safe-workspace', 'selected-link'), 'dir');
  }
  writeFixtureFile(root, 'README.md', `# Native desktop evaluation\n\n${TUTORIAL[scenarioId]}\n\n` +
    'The scorer starts a real desktop process and requires independent native window, ' +
    'renderer and security-boundary observations. Do not edit .kory-eval/desktop-fixture.json.\n');
}

function regularFile(root: string, path: string, limit = 1_000_000): string {
  if (isAbsolute(path) || path.split(/[\\/]/u).some((part) => !part || part === '..' || part === '.')) {
    throw new Error('Unsafe evidence path');
  }
  let current = resolve(root);
  if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) {
    throw new Error('Unsafe evidence root');
  }
  const parts = path.split(/[\\/]/u);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new Error('Evidence path traverses a symlink or non-directory');
    }
    if (index === parts.length - 1 && (!stat.isFile() || stat.size < 1 || stat.size > limit)) {
      throw new Error('Missing, empty or oversized native evidence');
    }
  }
  return current;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function nativePng(path: string): { hash: string; width: number; height: number } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1000 || stat.size > MAX_CAPTURE) {
    throw Error('Native screenshot missing or invalid');
  }
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw Error('Native capture is not a PNG');
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') throw Error('Invalid PNG header');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 300 || height < 200 || width > 8192 || height > 8192) {
    throw Error('Native capture dimensions invalid');
  }
  return { hash: sha256(bytes), width, height };
}

export interface DesktopRuntimeCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface DesktopRuntimeResult {
  passed: boolean;
  checks: DesktopRuntimeCheck[];
  blockers: string[];
  evidence: string[];
  /** Native runtime and screenshot provenance, not model-authored claims. */
  nativeVersion: string | null;
}

interface NativeReceipt {
  /** Fresh challenge tying native process output to this particular invocation. */
  nonce?: string;
  scenarioId: string;
  runtime: string;
  nativeVersion: string;
  platformVersion?: string;
  pid: number;
  checks: DesktopRuntimeCheck[];
  screenshot: { sha256: string; width: number; height: number; source: string } | null;
  nativeEvents: string[];
  nativeQuitObserved?: boolean;
  errors: string[];
  packagedArtifact?: string;
  packagedSha256?: string;
}

function validateReceipt(
  receipt: NativeReceipt,
  screenshot: string,
  scenarioId: DesktopScenario,
  root: string,
  nonce?: string,
  expectedElectronPid?: number | null,
): DesktopRuntimeResult {
  const failures: string[] = [];
  if (receipt.scenarioId !== scenarioId) failures.push('Receipt scenario mismatch');
  if (receipt.runtime !== (scenarioId === ELECTRON ? 'electron' : 'tauri')) {
    failures.push('Incorrect native runtime');
  }
  if (typeof receipt.nativeVersion !== 'string' ||
      !(scenarioId === TAURI ? /^2\.\d+(?:\.\d+)?/u : /^\d+\.\d+(?:\.\d+)?/u)
        .test(receipt.nativeVersion) ||
      !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) {
    failures.push('Missing native process identity and version');
  }
  if (scenarioId === ELECTRON) {
    if (receipt.nativeVersion !== PINNED_ELECTRON_VERSION ||
        typeof receipt.platformVersion !== 'string' ||
        !/^\d+\.\d+\.\d+\.\d+$/u.test(receipt.platformVersion)) {
      failures.push('Electron/Chromium version does not match the pinned native runtime');
    }
    if (!nonce || receipt.nonce !== nonce || !expectedElectronPid ||
        receipt.pid !== expectedElectronPid) {
      failures.push('Electron native process identity or verifier challenge mismatch');
    }
  }
  const expected = NATIVE_CHECKS[scenarioId];
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== expected.length ||
      new Set(receipt.checks.map((c) => c.id)).size !== expected.length ||
      expected.some((id) => !receipt.checks.some((c) => c.id === id))) {
    failures.push('Native verification check inventory is incomplete or duplicated');
  }
  if (!Array.isArray(receipt.errors) || receipt.errors.length) {
    failures.push('Native process errors recorded: ' +
      (Array.isArray(receipt.errors) ? receipt.errors.slice(0, 4).join('; ') : 'invalid error list'));
  }
  if (!Array.isArray(receipt.nativeEvents) || !receipt.nativeEvents.length) {
    failures.push('No native window lifecycle events');
  } else if (scenarioId === ELECTRON) {
    const events = receipt.nativeEvents;
    const fixedLifecycle = ELECTRON_EVENTS.slice(0, 6);
    const concurrent = ['open:concurrent-a', 'open:concurrent-b',
      'close:concurrent-a', 'close:concurrent-b'];
    const fixedPrefix = JSON.stringify(events.slice(0, fixedLifecycle.length)) ===
      JSON.stringify(fixedLifecycle);
    const concurrentWindowEvents = events.slice(fixedLifecycle.length, -2);
    const concurrentSet = [...concurrentWindowEvents].sort();
    const expectedConcurrentSet = [...concurrent].sort();
    const quitEvents = events.slice(-2);
    if (!fixedPrefix || JSON.stringify(concurrentSet) !== JSON.stringify(expectedConcurrentSet) ||
        JSON.stringify(quitEvents) !== JSON.stringify(['before-quit', 'will-quit'])) {
      failures.push('Electron window open/close/quit event sequence is incomplete or invalid: ' +
        events.join(','));
    }
  } else if (scenarioId === TAURI &&
      TAURI_EVENTS.some((event) => !receipt.nativeEvents.includes(event))) {
    failures.push('Tauri native window, dialog, symlink swap, restart or capture events missing');
  } else if (scenarioId === TAURI) {
    const events = receipt.nativeEvents;
    const eventOrder: Array<[string, string]> = [
      ['window:created', 'window:closed'],
      ['window:closed', 'window:reopened'],
      ['dialog:opened', 'dialog:accepted'],
      ['dialog:opened', 'dialog:cancelled'],
      ['dialog:accepted', 'fs:symlink-retargeted'],
      ['app:quit', 'app:restarted'],
    ];
    if (eventOrder.some(([first, second]) => events.indexOf(first) >= events.indexOf(second))) {
      failures.push('Native Tauri dialog/window/restart observations are out of order');
    }
  }
  if (scenarioId === ELECTRON && receipt.nativeQuitObserved !== true) {
    failures.push('No native Electron app quit callback');
  }
  try {
    const actual = nativePng(screenshot);
    if (receipt.screenshot?.sha256 !== actual.hash ||
        receipt.screenshot.width !== actual.width || receipt.screenshot.height !== actual.height ||
        !SHA256_HEX.test(receipt.screenshot.sha256) ||
        receipt.screenshot.source !== (scenarioId === ELECTRON
          ? 'webContents.capturePage' : 'native-window-compositor')) {
      failures.push('Captured pixels lack independent native compositor provenance');
    }
  } catch (error) {
    failures.push('Native screenshot verification: ' + String(error));
  }
  if (scenarioId === TAURI) {
    if (!nonce || receipt.nonce !== nonce) {
      failures.push('Native Tauri driver challenge mismatch');
    }
    try {
      const candidate = receipt.packagedArtifact ?? '';
      if (!isAbsolute(candidate) ||
          !resolve(candidate).startsWith(resolve(root) + sep) ||
          receipt.packagedSha256 !== sha256(readFileSync(regularFile(root, relative(root, candidate), 250_000_000)))) {
        failures.push('Packaged native Tauri executable identity mismatch');
      }
    } catch {
      failures.push('Packaged native Tauri executable missing or unsafe');
    }
  }
  const safeChecks = Array.isArray(receipt.checks)
    ? receipt.checks.filter((item) => item && typeof item.id === 'string' &&
        typeof item.passed === 'boolean' && typeof item.detail === 'string')
    : [];
  const count = expected.filter((id) => safeChecks.some((c) => c.id === id && c.passed)).length;
  const passed = failures.length === 0 && count === expected.length;
  return {
    passed,
    checks: safeChecks,
    blockers: failures,
    evidence: [
      `${scenarioId}: native ${receipt.runtime} ${receipt.nativeVersion}, PID ${receipt.pid}`,
      ...safeChecks.map((check) => `${check.id}: ${check.passed ? 'pass' : 'fail'} — ${check.detail}`),
      ...failures,
    ],
    nativeVersion: receipt.nativeVersion,
  };
}

function readReceipt(path: string): NativeReceipt {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 80_000) {
    throw Error('Missing or oversized native runtime receipt');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as NativeReceipt;
}

function runElectron(root: string): DesktopRuntimeResult {
  const directory = mkdtempSync(join(tmpdir(), 'kory-native-electron-probe-'));
  try {
    const output = join(directory, 'receipt.json');
    const screenshot = join(directory, 'native.png');
    const userData = join(directory, 'user-data');
    const nonce = randomUUID();
    mkdirSync(userData, { mode: 0o700 });
    writeFileSync(join(directory, 'package.json'), '{"name":"kory-native-probe","main":"probe.cjs"}\n');
    writeFileSync(join(directory, 'probe.cjs'), ELECTRON_PROBE);
    const executable = electronBinary();
    const executed = command(executable, [directory,
      `--kory-root=${resolve(root)}`, `--kory-report=${output}`, `--kory-capture=${screenshot}`,
      `--kory-nonce=${nonce}`, `--kory-user-data=${userData}`],
    undefined, 42_000);
    if (executed.status !== 0) throw Error('Real Electron execution failed: ' + executed.error);
    const receipt = readReceipt(output);
    return validateReceipt(receipt, screenshot, ELECTRON, root, nonce, executed.pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Native Tauri driver contract: build a real bundle, drive the OS dialog and restart,
 * capture pixels through the native compositor, and return a receipt for each check.
 * Browser-only/WebDriver DOM emulation cannot satisfy the capture source or native events.
 */
function runTauri(root: string): DesktopRuntimeResult {
  const driver = process.env.KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER!.trim();
  if (resolve(driver) === resolve(root) || resolve(driver).startsWith(resolve(root) + sep)) {
    throw Error('Tauri verifier must be outside the candidate fixture');
  }
  const directory = mkdtempSync(join(tmpdir(), 'kory-native-tauri-probe-'));
  try {
    const compiled = command(tauriCliBinary(),
      ['build'], root, 600_000);
    if (compiled.status !== 0) throw Error('Real Tauri package build failed: ' + compiled.error);
    const output = join(directory, 'receipt.json');
    const screenshot = join(directory, 'native.png');
    const nonce = randomUUID();
    const invoked = command(driver, [
      `--fixture=${resolve(root)}`, `--scenario=${TAURI}`,
      `--receipt=${output}`, `--capture=${screenshot}`,
      `--nonce=${nonce}`,
    ], undefined, 160_000);
    if (invoked.status !== 0) throw Error('Native Tauri UI driver failed: ' + invoked.error);
    const receipt = readReceipt(output);
    return validateReceipt(receipt, screenshot, TAURI, root, nonce);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sourceContract(root: string, id: DesktopScenario): boolean {
  try {
    const result = JSON.parse(readFixtureText(root, CONTRACT_FILE)) as Record<string, unknown>;
    return result.scenarioId === id && result.kind === 'native-desktop-v5' &&
      result.skill === 'desktop-electron-tauri' && result.broader === 'native-interface' &&
      result.nearNeighbor === NEAR_NEIGHBOR[id] &&
      result.facet === 'application-security' &&
      result.boundary === (id === ELECTRON ? 'electron-main-preload-renderer' : 'tauri-rust-webview') &&
      JSON.stringify(result.cannotSubstitute) ===
        JSON.stringify(['headless-browser', 'mock-ipc', 'unit-only-rust', 'synthetic-screenshot']);
  } catch {
    return false;
  }
}

export function runDesktopRuntime(root: string, scenarioId: DesktopScenario): DesktopRuntimeResult {
  if (!sourceContract(root, scenarioId)) {
    return { passed: false, checks: [], nativeVersion: null,
      blockers: ['Native fixture identity or immutable contract has been altered'],
      evidence: ['Fixture contract integrity failed before launching a desktop process'] };
  }
  const blockers = desktopRuntimeReadiness(scenarioId);
  if (blockers.length) {
    return { passed: false, checks: [], blockers, nativeVersion: null, evidence: blockers };
  }
  try {
    const files = scenarioId === ELECTRON
      ? ['app/package.json', 'app/main.cjs', 'app/preload.cjs', 'app/settings.html',
        'app/renderer.js', 'app/settings.d.ts']
      : ['src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/src/lib.rs',
        'src-tauri/src/main.rs', 'src-tauri/tauri.conf.json',
        'src-tauri/capabilities/default.json', 'ui/index.html', 'ui/renderer.js'];
    for (const file of files) regularFile(root, file);
    return scenarioId === ELECTRON ? runElectron(root) : runTauri(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { passed: false, checks: [], nativeVersion: null,
      blockers: [message], evidence: [`Native desktop execution unavailable or failed: ${message}`] };
  }
}

function score(root: string, id: DesktopScenario): SkillEvalDeterministicScore {
  const outcome = runDesktopRuntime(root, id);
  const required = NATIVE_CHECKS[id].length;
  // Untrusted/absent native evidence contributes no verification credit.
  const met = outcome.blockers.length ? 0 :
    NATIVE_CHECKS[id].filter((check) => outcome.checks.some((item) => item.id === check && item.passed)).length;
  return { passed: outcome.passed,
    quality: outcome.passed ? 1 : met / required,
    verification: outcome.passed ? 1 : met / required,
    integrityFailure: outcome.blockers.some((blocker) =>
      /integrity|unsafe|altered|mismatch|symlink|non-directory/iu.test(blocker)),
    evidence: outcome.evidence };
}

export const DESKTOP_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  { id: 'desktop-electron-tauri/electron-native-ipc-lifecycle@1', realRuntime: true,
    get readinessBlockers() { return desktopRuntimeReadiness(ELECTRON); },
    matches: (scenario) => scenario.id === ELECTRON,
    materialize: (destination) => materializeDesktopFixture(destination, ELECTRON) },
  { id: 'desktop-electron-tauri/tauri-native-dialog-boundary@1', realRuntime: true,
    get readinessBlockers() { return desktopRuntimeReadiness(TAURI); },
    matches: (scenario) => scenario.id === TAURI,
    materialize: (destination) => materializeDesktopFixture(destination, TAURI) },
];

export const DESKTOP_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  { id: 'desktop-electron-tauri/electron-native-scorer@1', scenarioIds: [ELECTRON],
    score: ({ workingDirectory }) => score(workingDirectory, ELECTRON) },
  { id: 'desktop-electron-tauri/tauri-native-scorer@1', scenarioIds: [TAURI],
    score: ({ workingDirectory }) => score(workingDirectory, TAURI) },
];
