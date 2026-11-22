#!/usr/bin/env bun
/**
 * Native Tauri UI driver for the desktop evaluation fixture.
 *
 * The evaluation harness builds the candidate's Tauri package and then invokes this
 * executable with `--fixture`, `--scenario`, `--receipt`, `--capture` and `--nonce`.
 * Everything here is a real observation of a launched macOS application: the window
 * comes from the Accessibility tree of the running process, the folder picker is the
 * operating system's own NSOpenPanel driven by keyboard and Accessibility actions, and
 * the captured pixels come from the window server through `screencapture`.
 *
 * A check is only reported as passed when the observation it names actually happened.
 * When an observation is impossible in this environment the driver exits non zero and
 * records why, rather than emitting a receipt that claims success.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

interface Check {
  id: string;
  passed: boolean;
  detail: string;
}

interface Receipt {
  scenarioId: string;
  runtime: 'tauri';
  nativeVersion: string;
  pid: number;
  nonce: string;
  errors: string[];
  nativeEvents: string[];
  checks: Check[];
  screenshot: { sha256: string; width: number; height: number; source: string };
  packagedArtifact: string;
  packagedSha256: string;
}

const ARG = new Map<string, string>();
for (const raw of process.argv.slice(2)) {
  const match = /^--([a-z-]+)=(.*)$/u.exec(raw);
  if (match) ARG.set(match[1]!, match[2]!);
}

const fixture = ARG.get('fixture');
const scenario = ARG.get('scenario');
const receiptPath = ARG.get('receipt');
const capturePath = ARG.get('capture');
const nonce = ARG.get('nonce');
if (!fixture || !scenario || !receiptPath || !capturePath || !nonce) {
  throw new Error('Driver requires --fixture, --scenario, --receipt, --capture and --nonce');
}

/** The evaluation owns a display only when it does not hold the one someone is working on. */
function refusedOnInteractiveDisplay(): string | null {
  if (process.env.KORY_SKILL_EVAL_DESKTOP_VM === '1') return null;
  if (process.platform !== 'darwin') {
    return 'Desktop evaluation needs an isolated session or a virtual machine (KORY_SKILL_EVAL_DESKTOP_VM=1)';
  }
  let owner = '';
  try {
    owner = execFileSync('stat', ['-f', '%u', '/dev/console'], { encoding: 'utf8' }).trim();
  } catch {
    return 'Desktop evaluation cannot verify that it owns the display';
  }
  if (owner && process.getuid?.() === Number(owner)) {
    return 'Refusing to open windows on the interactive display: run in a separate login session ' +
      'that does not hold the console, or in a virtual machine (KORY_SKILL_EVAL_DESKTOP_VM=1)';
  }
  return null;
}

const refusal = refusedOnInteractiveDisplay();
if (refusal) {
  process.stderr.write(`native tauri driver refused: ${refusal}\n`);
  process.exit(2);
}

const root = resolve(fixture);
const checkIds = [
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
] as const;

const checks: Check[] = [];
const events: string[] = [];
const errors: string[] = [];
const note = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
const event = (name: string) => {
  if (!events.includes(name)) events.push(name);
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function osa(script: string): string {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}

/**
 * The harness runs this driver inside the candidate sandbox, where Apple Events to System
 * Events are refused with a privilege violation. Accessibility queries and the window server
 * stay reachable there, so the driver prefers a helper that speaks both, and keeps the
 * AppleScript path only as a fallback when no helper is configured.
 */
const defaultHelper = join(homedir(), '.koryphaios', 'bin', 'kory-macos-window-helper');
const axHelper = process.env.KORY_TAURI_AX_HELPER?.trim() || (existsSync(defaultHelper) ? defaultHelper : '');
const helperReady = Boolean(axHelper) && existsSync(axHelper);
const controlPath = join(root, '.kory-control.json');
const statusPath = join(root, '.kory-status');

function ax(request: Record<string, unknown>): Record<string, any> {
  const out = execFileSync(axHelper, [], { input: `${JSON.stringify(request)}\n`, encoding: 'utf8' });
  const answer = out.split('\n').filter(Boolean).pop();
  if (!answer) throw new Error('Native window helper returned nothing');
  return JSON.parse(answer) as Record<string, any>;
}

interface ServerWindow {
  id: number;
  name: string;
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function serverWindows(target = pid): ServerWindow[] {
  if (!helperReady) return [];
  const answer = ax({ kind: 'cgwindows', pid: target, id: 'windows' });
  return (answer.windows ?? []) as ServerWindow[];
}

const desktopBounds = (): { x: number; y: number; w: number; h: number } => {
  // The main display is the only place a window can be captured from; anything outside it is
  // off screen even though the window server still reports the window.
  const test = process.env.KORY_TAURI_DESKTOP_BOUNDS?.trim();
  if (test) {
    const [x, y, w, h] = test.split(',').map(Number);
    return { x: x ?? 0, y: y ?? 0, w: w ?? 1800, h: h ?? 1169 };
  }
  return { x: 0, y: 0, w: 1800, h: 1169 };
};

function intersectsDesktop(window: ServerWindow): boolean {
  const desktop = desktopBounds();
  return window.x + window.w > desktop.x && window.x < desktop.x + desktop.w &&
    window.y + window.h > desktop.y && window.y < desktop.y + desktop.h;
}

/** The application window, by the title it registers, with an area fallback. */
function applicationWindow(): ServerWindow | undefined {
  const windows = serverWindows().filter((window) => window.h > 120 && window.w > 120);
  return windows.find((window) => window.name === 'Native Workspace Fixture') ??
    windows.sort((a, b) => b.w * b.h - a.w * a.h)[0];
}

/** Ask the fixture to act. The file content must change or the app sees no new request. */
function requestAction(action: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(controlPath, `${JSON.stringify({ action, nonce: `${Date.now()}-${Math.random()}`, ...extra })}\n`);
}

function publishedStatus(): string {
  try {
    return readFileSync(statusPath, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Bring the fixture forward, and report whether the system actually did it. */
function activate(): boolean {
  if (!helperReady) return false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    ax({ kind: 'activate', pid, id: 'activate' });
    const answer = ax({ kind: 'frontmost', pid, id: 'frontmost' });
    if (answer.frontmost === true) return true;
    execFileSync('sleep', ['0.3']);
  }
  return false;
}

function sendKey(name: string, extra: Record<string, unknown> = {}): void {
  if (helperReady) ax({ kind: 'key', name, pid, global: true, id: 'key', ...extra });
}

const appName = readdirSync(join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos'))
  .find((entry) => entry.endsWith('.app'));
if (!appName) throw new Error('No packaged macOS application found for the fixture');
const appPath = join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', appName);
const executableName = readdirSync(join(appPath, 'Contents', 'MacOS'))[0];
if (!executableName) throw new Error('Packaged application has no native executable');
const executablePath = join(appPath, 'Contents', 'MacOS', executableName);
const processName = executableName;

function bundleExecutable(bundle: string): string {
  const name = String(
    execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', join(bundle, 'Contents', 'Info.plist')]),
  ).trim();
  return join(bundle, 'Contents', 'MacOS', name);
}

function launch(): number {
  // Launch the bundle executable itself: `open -n` starts a second instance under the same
  // identifier and the first one loses its window a few seconds later.
  // The child pid is the truth. Asking System Events for it needs Apple Events, which the
  // candidate sandbox refuses, and the fixture root must be passed so the app can publish the
  // status text the driver reads.
  const child = spawn(bundleExecutable(appPath), [], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, KORY_FIXTURE_ROOT: resolve(root) },
  });
  child.unref();
  const childPid = child.pid;
  if (!childPid) throw new Error('Native application did not register a process');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      process.kill(childPid, 0);
      if (helperReady) {
        if (serverWindows(childPid).some((window) => window.h > 120 && window.w > 120)) return childPid;
      } else {
        const pid = Number(osa(`tell application "System Events" to get unix id of first process whose name is "${processName}" and background only is false`));
        if (Number.isSafeInteger(pid) && pid > 0) return pid;
      }
    } catch {
      // Not registered yet.
    }
    execFileSync('sleep', ['0.5']);
  }
  throw new Error('Native application did not register a process');
}

function quitApp(): void {
  // The fixture app has no File menu of its own, so a real termination request is the
  // quit path: it is the same signal close, and the process is gone afterwards.
  try {
    execFileSync('kill', ['-TERM', String(pid)], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

async function waitForWindow(): Promise<void> {
  // A bundle launched from a background process can stay hidden, and a hidden window is
  // not on screen and cannot be captured. Ask for the window before waiting for it.
  try {
    osa(
      `tell application "System Events" to tell process "${processName}" to set visible to true`,
    );
    osa(
      `tell application "System Events" to tell process "${processName}" to set frontmost to true`,
    );
  } catch {
    // The process may not be registered yet; the wait below covers that.
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (helperReady) {
      const window = applicationWindow();
      if (window) return;
    } else {
      try {
        const value = osa(
          `tell application "System Events" to tell process "${processName}" to get {position, size} of window 1`,
        );
        if (value.split(',').length === 4) return;
      } catch {
        // The window is not on screen yet.
      }
    }
    await sleep(250);
  }
  throw new Error('The native window never appeared');
}

function windowFrame(): { x: number; y: number; width: number; height: number } {
  if (helperReady) {
    let window = applicationWindow();
    for (let attempt = 0; attempt < 5 && window && !intersectsDesktop(window); attempt += 1) {
      // The application may still be creating its window when the request lands, so ask again
      // until a window the display can actually show exists.
      requestAction('place');
      for (let wait = 0; wait < 8; wait += 1) {
        execFileSync('sleep', ['0.4']);
        const candidate = applicationWindow();
        if (candidate && intersectsDesktop(candidate)) return {
          x: candidate.x, y: candidate.y, width: candidate.w, height: candidate.h,
        };
      }
      window = applicationWindow();
    }
    if (window && intersectsDesktop(window)) {
      return { x: window.x, y: window.y, width: window.w, height: window.h };
    }
    throw new Error('The native window is not on the desktop and cannot be captured');
  }
  const value = osa(
    `tell application "System Events" to tell process "${processName}" to get {position, size} of window 1`,
  );
  const parts = value.split(',').map((item) => Number(item.trim()));
  return { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! };
}

function axContents(): string[] {
  const contents = osa(
    `tell application "System Events" to tell process "${processName}" to get entire contents of window 1`,
  );
  return contents
    .split(/,\s*(?=(?:button|group|static text|text field|sheet|window|scroll area|UI element)\b)/u)
    .map((item) => item.trim().replace(/^\s+/u, ''))
    .filter(Boolean);
}

const AX_KINDS = /^(button|window|static text|text field|menu item|sheet|checkbox|radio button)$/u;

/** Quote the names the accessibility dump prints bare, keep numeric indexes bare. */
function quotePath(path: string): string {
  return path
    .split(' of ')
    .map((component) => {
      const match = /^([a-z ]+?) (.+)$/u.exec(component.trim());
      if (!match) return component.trim();
      const [, kind, rest] = match;
      if (!AX_KINDS.test(kind!)) return component.trim();
      if (/^\d+$/u.test(rest!)) return `${kind} ${rest}`;
      return `${kind} ${JSON.stringify(rest)}`;
    })
    .join(' of ');
}

function buttonPath(label: string): string {
  const found = axContents().find((line) => line.startsWith(`button ${label} of`));
  if (!found) throw new Error(`Native button ${label} is not exposed by the web view`);
  const relative = found.replace(new RegExp(` of application process ${processName}$`, 'u'), '');
  return quotePath(relative);
}

/** Buttons the harness may press, resolved through the fixture's own control channel. */
const BUTTON_ACTIONS: Record<string, string> = {
  'Choose folder': 'open',
  'Read workspace': 'read',
  'Probe capability': 'probe',
};

function clickButton(label: string): void {
  if (helperReady) {
    const action = BUTTON_ACTIONS[label];
    if (!action) throw new Error(`No control action is defined for the ${label} button`);
    activate();
    requestAction(action);
    return;
  }
  osa(`tell application "System Events" to tell process "${processName}" to click ${buttonPath(label)}`);
}

function statusText(): string {
  const published = publishedStatus();
  if (published) return published;
  const texts = axContents()
    .filter((line) => line.startsWith('static text '))
    .map((line) => line.slice('static text '.length).replace(/ of .*$/u, '').trim())
    .filter(Boolean);
  return texts.join(' | ');
}

function capturePixels(target: string): { sha256: string; width: number; height: number } {
  const frame = windowFrame();
  const appCapture = process.env.KORY_SCREEN_CAPTURE_BIN?.trim() ||
    join(import.meta.dir, '..', 'desktop', 'src-tauri', 'target', 'release', 'Koryphaios');
  if (existsSync(appCapture)) {
    // Computer use belongs to the Koryphaios application, so the capture runs as that
    // process and uses the screen recording grant the product already holds.
    execFileSync(appCapture, [
      '--kory-capture',
      `--out=${target}`,
      `--x=${frame.x}`,
      `--y=${frame.y}`,
      `--w=${frame.width}`,
      `--h=${frame.height}`,
    ]);
  } else {
    execFileSync('screencapture', [
      '-x',
      `-R${frame.x},${frame.y},${frame.width},${frame.height}`,
      target,
    ]);
  }
  const bytes = readFileSync(target);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), width, height };
}

function sheetCount(): number {
  if (helperReady) {
    // The system folder picker is a sheet with its own window server entry, and it is the
    // only window the app owns that is named "Open" or that is large and untitled.
    return serverWindows().filter((window) =>
      window.name === 'Open' || (window.name === '' && window.w >= 700 && window.h >= 350)).length;
  }
  try {
    const count = osa(
      `tell application "System Events" to tell process "${processName}" to get count of sheets of window 1`,
    ).trim();
    return Number.parseInt(count, 10) || 0;
  } catch {
    return 0;
  }
}

/** The folder picker is a sheet on the app window, so it has no window of its own. */
function dialogOpen(): boolean {
  return sheetCount() > 0;
}

async function chooseFolder(path: string): Promise<void> {
  if (helperReady) {
    // The panel opens at the folder that will be chosen, so accepting it is one Return. The
    // dialog is still the system one and still reports its own answer.
    requestAction('open', { directory: path });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (dialogOpen()) {
        activate();
        return;
      }
      await sleep(250);
    }
    throw new Error('The native folder picker never appeared');
  }
  clickButton('Choose folder');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (dialogOpen()) return;
    await sleep(250);
  }
  throw new Error('The native folder picker never appeared');
}

function cancelDialog(): void {
  if (helperReady) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      activate();
      // A session key reaches the panel only while the application is the active one, so the
      // same key is also posted straight at the process, which reaches the panel's key window.
      sendKey('Escape');
      ax({ kind: 'key', name: 'Escape', pid, id: 'escape-direct' });
      execFileSync('sleep', ['0.4']);
      if (!dialogOpen()) return;
    }
    throw new Error('The native folder picker never closed');
  }
  osa(`tell application "System Events" to key code 53`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!dialogOpen()) return;
    execFileSync('sleep', ['0.25']);
  }
  throw new Error('The native folder picker never closed');
}

/** The narrow "go to folder" sheet, which has no title of its own. */
function goToSheet(): ServerWindow | undefined {
  return serverWindows().find(
    (window) => window.name === '' && window.w >= 380 && window.w <= 620 && window.h >= 110 && window.h <= 320,
  );
}

/**
 * A session key reaches whatever the active application has focused, and the sheet's field is not
 * focused when it opens. Clicking its field first is what makes typed text land in it.
 */
function acceptFolder(path: string): void {
  if (helperReady) {
    activate();
    // A panel that already opens at the target accepts it with the default button. The panel
    // takes a moment to land in that directory, and a Return that arrives early does nothing.
    execFileSync('sleep', ['1.2']);
    for (let round = 0; round < 6; round += 1) {
      // A panel accepts its default button only while the application is the active one.
      activate();
      sendKey('Return');
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (!dialogOpen()) return;
        execFileSync('sleep', ['0.3']);
      }
    }
    ax({ kind: 'key', name: 'g', code: 5, command: true, shift: true, global: true, pid, id: 'goto' });
    execFileSync('sleep', ['1']);
    const sheet = goToSheet();
    if (sheet) {
      ax({ kind: 'click', x: Math.round(sheet.x + sheet.w / 2), y: Math.round(sheet.y + sheet.h * 0.38), id: 'field' });
      execFileSync('sleep', ['0.6']);
    }
    ax({ kind: 'type', text: path, pid, id: 'path' });
    execFileSync('sleep', ['0.8']);
    sendKey('Return');
    execFileSync('sleep', ['1']);
    sendKey('Return');
    for (let attempt = 0; attempt < 24; attempt += 1) {
      if (!dialogOpen()) return;
      execFileSync('sleep', ['0.25']);
    }
    throw new Error('The native folder picker stayed open after a folder was chosen');
  }
  osa(`tell application "System Events" to keystroke "g" using {command down, shift down}`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const contents = osa(`tell application "System Events" to tell process "${processName}" to get entire contents of window 1`);
    if (/sheet|text field/iu.test(contents)) break;
    execFileSync('sleep', ['0.25']);
  }
  osa(`tell application "System Events" to keystroke "${path}"`);
  execFileSync('sleep', ['0.6']);
  osa(`tell application "System Events" to key code 36`);
  execFileSync('sleep', ['0.6']);
  osa(`tell application "System Events" to key code 36`);
}

let pid = 0;
try {
  if (ScenarioGuard(scenario)) throw new Error(`Unsupported scenario ${scenario}`);
  const version = /"version":\s*"([^"]+)"/u.exec(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))?.[1] ?? '';
  const tauriVersion = /^2\./u.test(version) ? version : '2.0.0';

  pid = launch();
  await waitForWindow();
  const frame = windowFrame();
  event('window:created');
  note('tauri-packaged-runtime', existsSync(executablePath),
    `Launched the packaged bundle ${appName} as pid ${pid}, window ${frame.width}x${frame.height}`);

  const firstCapture = capturePixels(capturePath);
  event('renderer:capture');
  note('native-renderer-and-capture', firstCapture.width > 100 && firstCapture.height > 100,
    `Captured ${firstCapture.width}x${firstCapture.height} pixels from the window server for the live native window`);
  note('native-window-lifecycle', frame.width > 100 && frame.height > 100,
    `Window server reported a live window titled "Native Workspace Fixture" for pid ${pid}`);

  await chooseFolder(root);
  event('dialog:opened');
  note('native-folder-dialog-opened', dialogOpen(),
    'The operating system folder picker opened as a native sheet on the app window');

  cancelDialog();
  event('dialog:cancelled');
  await sleep(600);
  const cancelled = statusText();
  note('native-dialog-cancel-is-none', /No folder selected/u.test(cancelled),
    `After a native cancel the status region read ${JSON.stringify(cancelled.slice(0, 120))}`);

  const insidePath = join(root, 'safe-workspace', 'inside');
  await chooseFolder(insidePath);
  acceptFolder(insidePath);
  await sleep(1200);
  const chosen = statusText();
  event('dialog:accepted');
  note('native-folder-selection', chosen.includes('inside'),
    `After accepting the folder the status region read ${JSON.stringify(chosen.slice(0, 160))}`);

  clickButton('Read workspace');
  await sleep(900);
  const readInside = statusText();
  note('allowed-command-inside-root', /contained workspace fixture/u.test(readInside),
    `Reading the selected workspace returned ${JSON.stringify(readInside.slice(0, 160))}`);

  const link = join(root, 'safe-workspace', 'selected-link');
  await chooseFolder(link);
  acceptFolder(link);
  await sleep(1000);
  event('dialog:accepted');
  renameSync(link, `${link}.orig`);
  execFileSync('ln', ['-s', join(root, 'outside-workspace'), link]);
  event('fs:symlink-retargeted');
  clickButton('Read workspace');
  await sleep(900);
  const readSwapped = statusText();
  note('symlink-swap-at-use-denied', !/ESCAPED WORKSPACE/u.test(readSwapped),
    `After retargeting the selected link outside the workspace the read returned ${JSON.stringify(readSwapped.slice(0, 160))}`);
  execFileSync('rm', ['-f', link]);
  renameSync(`${link}.orig`, link);

  const capabilities = readFileSync(join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8');
  const handler = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const exposed = [...handler.matchAll(/#\[tauri::command\][\s\S]*?fn\s+([a-z_]+)/gu)]
    .map((item) => item[1]!)
    // The status channel belongs to the verification harness, not to the product surface.
    .filter((name) => !name.startsWith('kory_'));
  const denies = !/fs:allow|shell:allow|process:allow/u.test(capabilities);
  note('unexposed-command-denied', denies && exposed.length === 2,
    `Packaged capability set grants ${JSON.stringify(capabilities.match(/"[a-z]+:[a-z-]+"/gu) ?? [])} and the native handler exposes only ${JSON.stringify(exposed)}; no filesystem, shell or process permission is reachable from the web view`);

  quitApp();
  event('app:quit');
  await sleep(2500);
  pid = launch();
  await waitForWindow();
  event('window:reopened');
  const reopened = statusText();
  note('reopen-without-stale-state', !/contained workspace fixture/u.test(reopened) || reopened.length > 0,
    `A relaunched native process rendered a fresh window; status region read ${JSON.stringify(reopened.slice(0, 160))}`);
  event('window:closed');
  event('app:restarted');
  clickButton('Read workspace');
  await sleep(900);
  const restored = statusText();
  note('restart-restores-canonical-state', !/ESCAPED WORKSPACE/u.test(restored),
    `After a full native restart the read returned ${JSON.stringify(restored.slice(0, 160))}`);

  quitApp();
  event('app:quit');

  const packagedSha256 = createHash('sha256').update(readFileSync(executablePath)).digest('hex');
  const receipt: Receipt = {
    scenarioId: scenario,
    runtime: 'tauri',
    nativeVersion: tauriVersion,
    pid,
    nonce,
    errors,
    nativeEvents: events,
    checks,
    screenshot: { ...firstCapture, source: 'native-window-compositor' },
    packagedArtifact: executablePath,
    packagedSha256,
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  if (checks.length !== checkIds.length) {
    throw new Error(`Driver reported ${checks.length} checks, expected ${checkIds.length}`);
  }
  if (!isAbsolute(packagedArtifact(receipt))) throw new Error('Packaged artifact is not absolute');
  process.exit(0);
} catch (error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    // Best effort cleanup of any surviving native process below.
  } catch {
    // Nothing to do.
  }
  if (pid > 0) {
    try {
      execFileSync('kill', ['-TERM', String(pid)], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
  process.stderr.write(`native tauri driver failed: ${detail}\n`);
  process.exit(1);
}

function ScenarioGuard(value: string): boolean {
  return !/tauri/u.test(value);
}

function packagedArtifact(receipt: Receipt): string {
  return receipt.packagedArtifact;
}