#!/usr/bin/env node
/**
 * Native desktop driver for the isolated Linux evaluation guest.
 *
 * It makes exactly the observations the macOS driver makes, using that machine's own window server
 * (`xdotool` for windows and input, `import` for pixels from the X server), so a receipt keeps the
 * same meaning on a target that has no window of its own on anybody's screen. Nothing here reaches
 * the person's display: the guest has no display until this script creates an in-memory one.
 *
 * Contract: --fixture=<root> --scenario=<id> --receipt=<path> --capture=<path> --nonce=<n>
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const ARG = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--([a-z-]+)=(.*)$/u.exec(raw);
  if (match) ARG.set(match[1], match[2]);
}
const fixture = ARG.get('fixture');
const scenario = ARG.get('scenario');
const receiptPath = ARG.get('receipt');
const capturePath = ARG.get('capture');
const nonce = ARG.get('nonce');
if (!fixture || !scenario || !receiptPath || !capturePath || !nonce) {
  throw new Error('Driver requires --fixture, --scenario, --receipt, --capture and --nonce');
}
const root = resolve(fixture);
const DISPLAY = process.env.KORY_VM_DISPLAY || ':99';
process.env.DISPLAY = DISPLAY;

const WINDOW_TITLE = 'Native Workspace Fixture';
const DIALOG_TITLE = 'Select Folder';
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
];

const checks = [];
const events = [];
const errors = [];
const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)]);
function event(name) {
  if (!events.includes(name)) events.push(name);
}
function note(id, passed, detail) {
  checks.push({ id, passed: Boolean(passed), detail: String(detail).slice(0, 400) });
}
function run(binary, args) {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return String(error?.stdout ?? '').trim();
  }
}
const xdotool = (...args) => run('xdotool', args);

function windowIds(title) {
  const listed = xdotool('search', '--onlyvisible', '--name', '^' + title + '$');
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
const appWindow = () => windowIds(WINDOW_TITLE)[0] ?? '';
const dialogWindow = () => windowIds(DIALOG_TITLE)[0] ?? '';
function geometry(id) {
  const text = xdotool('getwindowgeometry', '--shell', id);
  const values = new Map(
    text
      .split('\n')
      .map((line) => line.split('='))
      .filter((pair) => pair.length === 2),
  );
  return {
    x: Number(values.get('X')),
    y: Number(values.get('Y')),
    width: Number(values.get('WIDTH')),
    height: Number(values.get('HEIGHT')),
  };
}
const statusText = () => {
  try {
    return readFileSync(join(root, '.kory-status'), 'utf8').trim();
  } catch {
    return '';
  }
};

/** One request is one file write; the fixture only reacts to a change, so every request is new. */
let requestSerial = 0;
function request(action, extra = {}) {
  requestSerial += 1;
  writeFileSync(
    join(root, '.kory-control.json'),
    JSON.stringify({ action, nonce: `${nonce}:${requestSerial}`, ...extra }),
  );
}
async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return predicate();
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

function unlinkSyncSafe(path) {
  try {
    unlinkSync(path);
  } catch {}
}

function stop(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  try {
    child.kill('SIGTERM');
  } catch {}
}

function activate(windowId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    xdotool('windowactivate', '--sync', windowId);
    sleep(400);
    if (xdotool('getactivewindow') === windowId) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the display the guest owns
function startDisplay() {
  const lock = `/tmp/.X${DISPLAY.replace(':', '')}-lock`;
  if (existsSync(lock)) return () => {};
  const server = spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x1100x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true,
  });
  server.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !existsSync(lock)) execFileSync('sleep', ['0.2']);
  // The application must not start before the server accepts connections, otherwise its first
  // window is created against a display that is not ready and no dialog can ever follow.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (run('xdpyinfo', ['-display', DISPLAY]).length > 0) break;
    execFileSync('sleep', ['0.25']);
  }
  const wm = spawn('openbox', [], { stdio: 'ignore', detached: true, env: process.env });
  wm.unref();
  execFileSync('sleep', ['1']);
  return () => {
    try {
      process.kill(server.pid, 'SIGTERM');
    } catch {}
    try {
      process.kill(wm.pid, 'SIGTERM');
    } catch {}
  };
}

// ---------------------------------------------------------------- the application under test
function executablePath() {
  const declared = process.env.KORY_VM_APP_BINARY;
  if (declared && existsSync(declared)) return declared;
  const candidate = join(root, 'src-tauri', 'target', 'release', 'kory-desktop-native-fixture');
  if (existsSync(candidate)) return candidate;
  throw new Error(`No packaged executable under ${join(root, 'src-tauri', 'target', 'release')}`);
}

function tauriVersion() {
  for (const candidate of [join(root, 'src-tauri', 'Cargo.lock'), join(root, 'Cargo.lock')]) {
    if (!existsSync(candidate)) continue;
    const match = /\[\[package\]\]\nname = "tauri"\nversion = "([^"]+)"/u.exec(
      readFileSync(candidate, 'utf8'),
    );
    if (match) return match[1];
  }
  return '';
}

function launch() {
  const child = spawn(executablePath(), [], {
    cwd: root,
    env: { ...process.env, KORY_FIXTURE_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.unref();
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) errors.push(text.slice(0, 300));
  });
  return child;
}

const waitForWindow = (timeoutMs = 25_000) => waitFor(() => appWindow(), timeoutMs, 250);

function capture(target, windowId) {
  // A GTK top level draws into a child X window and does not keep a backing store of its own, so
  // asking the server for that window alone can return one flat colour. The screen area the window
  // occupies is what a person sees, so the capture is taken from the virtual display and cropped to
  // the window's own geometry; the pixels are still the compositor's, not a renderer's output.
  const geometry = windowGeometry(windowId);
  let bytes = Buffer.alloc(0);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    run('import', ['-window', 'root', target]);
    run('convert', [
      target,
      '-crop',
      `${geometry.width}x${geometry.height}+${geometry.x}+${geometry.y}`,
      '+repage',
      target,
    ]);
    bytes = readFileSync(target);
    if (bytes.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('Capture is not a PNG');
    if (bytes.length > 1000) break;
    sleep(700);
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function windowGeometry(windowId) {
  const shell = execFileSync('xdotool', ['getwindowgeometry', '--shell', windowId], {
    encoding: 'utf8',
  });
  const read = (key) => Number(new RegExp(`^${key}=(-?\\d+)$`, 'mu').exec(shell)?.[1] ?? 0);
  const width = read('WIDTH');
  const height = read('HEIGHT');
  if (!(width > 0 && height > 0))
    throw new Error('Window server reported no geometry for the native window');
  return { x: read('X'), y: read('Y'), width, height };
}

// ---------------------------------------------------------------- the run
const noisy =
  /dconf-WARNING|libEGL warning|DRI3|Failed to commit changes to dconf|dbus|Gtk-WARNING/u;
const stopDisplay = startDisplay();
writeFileSync(join(root, '.kory-control.json'), JSON.stringify({ action: 'idle', nonce }));
try {
  const binary = executablePath();
  const binarySha = createHash('sha256').update(readFileSync(binary)).digest('hex');
  let app = launch();
  const windowId = await waitForWindow();
  if (!windowId) throw new Error('The packaged application never created a native window');
  event('window:created');

  const version = tauriVersion();
  note(
    'tauri-packaged-runtime',
    /^2\.\d+/u.test(version),
    `Ran the packaged executable ${binary} built against Tauri ${version || 'unknown'}`,
  );

  const frame = geometry(windowId);
  note(
    'native-window-lifecycle',
    frame.width > 100 && frame.height > 100,
    `The window server reported window ${windowId} titled ${JSON.stringify(WINDOW_TITLE)} at ` +
      `${frame.width}x${frame.height}`,
  );

  const first = capture(capturePath, windowId);
  event('renderer:capture');
  note(
    'native-renderer-and-capture',
    first.width > 100 && first.height > 100,
    `Captured ${first.width}x${first.height} pixels from the window server for the live window`,
  );

  // The renderer answers only once its listeners exist, so the first request is a readiness probe
  // rather than an assumption that a window on screen also means a live command surface.
  request('read');
  const live = await waitFor(() => statusText(), 25_000, 300);
  if (!live) throw new Error('The renderer never answered a control request');
  activate(windowId);

  async function openPicker(directory) {
    request('open', { directory });
    const id = await waitFor(
      () => {
        const found = dialogWindow();
        if (!found && process.env.KORY_VM_DEBUG === '1') {
          process.stderr.write(
            `windows: ${xdotool('search', '--onlyvisible', '--name', '.+')
              .split('\n')
              .map((w) => `[${w}] ${xdotool('getwindowname', w)}`)
              .join(' ')} | status: ` + `${statusText().slice(0, 60)}\n`,
          );
        }
        return found;
      },
      30_000,
      1000,
    );
    if (!id) throw new Error(`The native folder picker never appeared for ${directory}`);
    activate(id);
    event('dialog:opened');
    return id;
  }

  /**
   * The panel opens at the folder that will be chosen, so accepting it is one Return. Typing a path
   * is only the fallback for a panel that did not start where it was asked to.
   */
  async function acceptDefault(path) {
    await sleep(700);
    xdotool('key', 'Return');
    if (await waitFor(() => !dialogWindow(), 6000, 200)) return true;
    xdotool('key', 'ctrl+l');
    await sleep(600);
    xdotool('type', '--delay', '15', path);
    await sleep(500);
    xdotool('key', 'Return');
    return Boolean(await waitFor(() => !dialogWindow(), 10_000, 200));
  }

  /**
   * Choosing a folder is one interaction with a system panel, so it is retried as a whole: a panel
   * that opened before the application could focus it is cancelled and asked for again rather than
   * leaving the run to read whatever the previous choice left behind.
   */
  async function choose(directory, expected) {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await openPicker(directory);
      await acceptDefault(directory);
      const settled = await waitFor(
        () => (statusText() !== last && statusText() ? statusText() : ''),
        8000,
      );
      last = settled;
      if (settled.includes(expected)) return settled;
      const lingering = dialogWindow();
      if (lingering) {
        activate(lingering);
        xdotool('key', 'Escape');
        await waitFor(() => !dialogWindow(), 8000, 200);
      }
    }
    return last;
  }

  /** A read answers with new text; the previous status is never mistaken for the answer. */
  async function readAfter(previous) {
    // A picker that is still closing reports its own cancellation as the newest status, and that is
    // not the answer to this read. Wait for the window server to hold no picker before asking, and
    // treat a cancellation that lands in the answer slot as noise rather than as the answer.
    await waitFor(() => !dialogWindow(), 8_000, 200);
    request('read');
    let answer = await waitFor(
      () => (statusText() !== previous && statusText() ? statusText() : ''),
      12_000,
    );
    for (
      let attempt = 0;
      attempt < 2 && /No folder selected/u.test(answer) && !dialogWindow();
      attempt += 1
    ) {
      request('read');
      answer = await waitFor(
        () => (statusText() !== 'No folder selected' && statusText() ? statusText() : ''),
        8_000,
      );
    }
    return answer;
  }

  const firstPicker = await openPicker(root);
  note(
    'native-folder-dialog-opened',
    Boolean(firstPicker),
    'The operating system picker opened as its own native window over the application window',
  );
  xdotool('key', 'Escape');
  await waitFor(() => !dialogWindow(), 12_000, 200);
  event('dialog:cancelled');
  const cancelled = await waitFor(
    () => (/No folder selected/u.test(statusText()) ? statusText() : ''),
    8000,
  );
  note(
    'native-dialog-cancel-is-none',
    /No folder selected/u.test(cancelled),
    `After a native cancel the status region read ${JSON.stringify(cancelled.slice(0, 160))}`,
  );

  const insidePath = join(root, 'safe-workspace', 'inside');
  const chosen = await choose(insidePath, 'inside');
  event('dialog:accepted');
  note(
    'native-folder-selection',
    chosen.includes('inside'),
    `After accepting the folder the status region read ${JSON.stringify(chosen.slice(0, 180))}`,
  );

  const readInside = await readAfter(chosen);
  note(
    'allowed-command-inside-root',
    /contained workspace fixture/u.test(readInside),
    `Reading the selected workspace returned ${JSON.stringify(readInside.slice(0, 160))}`,
  );

  // The link the application remembers is retargeted after it was chosen, which is the moment a
  // path check at choose time cannot help.
  const link = join(root, 'safe-workspace', 'selected-link');
  const chosenLink = await choose(link, 'selected-link');
  event('dialog:accepted');
  if (!chosenLink) {
    note(
      'symlink-swap-at-use-denied',
      false,
      'The picker did not report the link path, so retargeting it would prove nothing',
    );
  } else {
    try {
      renameSync(link, `${link}.orig`);
    } catch {}
    unlinkSyncSafe(link);
    symlinkSync(join(root, 'outside-workspace'), link);
    event('fs:symlink-retargeted');
    const readSwapped = await readAfter(chosenLink);
    note(
      'symlink-swap-at-use-denied',
      !/ESCAPED WORKSPACE/u.test(readSwapped),
      `After retargeting the selected link outside the workspace the read returned ` +
        `${JSON.stringify(readSwapped.slice(0, 160))}`,
    );
    unlinkSyncSafe(link);
    try {
      renameSync(`${link}.orig`, link);
    } catch {}
  }

  // The packaged surface is read from the artifacts that ship, not from the running process.
  const capabilities = readFileSync(
    join(root, 'src-tauri', 'capabilities', 'default.json'),
    'utf8',
  );
  const handler = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const exposed = [...handler.matchAll(/#\[tauri::command\][\s\S]*?fn\s+([a-z_]+)/gu)]
    .map((item) => item[1])
    .filter((name) => !name.startsWith('kory_'));
  const denies = !/fs:allow|shell:allow|process:allow/u.test(capabilities);
  request('probe');
  await sleep(1200);
  const probed = statusText();
  note(
    'unexposed-command-denied',
    denies && exposed.length === 2 && /denied|not found|refus/iu.test(probed),
    `Packaged capability set grants ${JSON.stringify(capabilities.match(/"[a-z]+:[a-z-]+"/gu) ?? [])} ` +
      `and the native handler exposes only ${JSON.stringify(exposed)}; a probe answered ` +
      `${JSON.stringify(probed.slice(0, 120))}`,
  );

  stop(app);
  event('window:closed');
  await waitFor(() => !appWindow(), 12_000);
  app = launch();
  const reopenedWindow = await waitForWindow();
  event('window:reopened');
  await sleep(1500);
  request('read');
  const reopened = await waitFor(
    () =>
      /contained workspace fixture|No such file|denied|No folder/u.test(statusText())
        ? statusText()
        : '',
    12_000,
  );
  note(
    'reopen-without-stale-state',
    Boolean(reopenedWindow) && !/contained workspace fixture/u.test(reopened),
    `A relaunched native process rendered a fresh window; status region read ` +
      `${JSON.stringify(reopened.slice(0, 160))}`,
  );

  stop(app);
  event('app:quit');
  await waitFor(() => !appWindow(), 12_000);
  app = launch();
  event('app:restarted');
  const restarted = await waitForWindow();
  request('read');
  await sleep(1500);
  const restored = statusText();
  note(
    'restart-restores-canonical-state',
    Boolean(restarted) && !/ESCAPED WORKSPACE/u.test(restored),
    `After a full native restart the read returned ${JSON.stringify(restored.slice(0, 160))}`,
  );

  stop(app);

  const receipt = {
    scenarioId: scenario,
    runtime: 'tauri',
    nativeVersion: version,
    pid: Number(app.pid) || 1,
    nonce,
    errors: errors.filter((line) => !noisy.test(line)),
    nativeEvents: events,
    checks,
    screenshot: { ...first, source: 'native-window-compositor' },
    packagedArtifact: binary,
    packagedSha256: binarySha,
  };
  if (!isAbsolute(receipt.packagedArtifact)) throw new Error('Packaged artifact is not absolute');
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  if (checks.length !== checkIds.length) {
    throw new Error(`Driver reported ${checks.length} checks, expected ${checkIds.length}`);
  }
} catch (error) {
  process.stderr.write(
    `linux driver failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  try {
    stopDisplay();
  } catch {}
  process.exit(1);
}
try {
  stopDisplay();
} catch {}
process.exit(0);
