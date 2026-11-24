#!/usr/bin/env node
/** Packaged startup and actual WebView-to-Rust IPC smoke; no native UI driver. */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '.build/target/debug/bundle/macos/Koryphaios V5 Tauri Scenario 2.app');
const EXECUTABLE = join(APP, 'Contents/MacOS/kory-tauri-v5-scenario2');

function inspectPackage() {
  const plist = join(APP, 'Contents/Info.plist');
  const id = execFileSync(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist],
    { encoding: 'utf8', timeout: 3_000 },
  ).trim();
  const executableName = execFileSync(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist],
    { encoding: 'utf8', timeout: 3_000 },
  ).trim();
  const fileType = execFileSync('/usr/bin/file', ['-b', EXECUTABLE], {
    encoding: 'utf8',
    timeout: 3_000,
  }).trim();
  if (
    id !== 'dev.koryphaios.v5.tauri.scenario2' ||
    executableName !== 'kory-tauri-v5-scenario2' ||
    !fileType.includes('Mach-O') ||
    !fileType.includes('arm64')
  ) {
    throw new Error('Packaged executable identity/architecture invalid');
  }
  return { bundleId: id, fileType, executable: realpathSync(EXECUTABLE) };
}

const readLog = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
};

function liveProcessMatches(pid) {
  try {
    const path = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 3_000,
    }).trim();
    return realpathSync(path) === realpathSync(EXECUTABLE);
  } catch {
    return false;
  }
}

async function launch({ parent, state, log, expectedRoot, expectedReads }) {
  const safeEnv = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
      .filter((key) => typeof process.env[key] === 'string')
      .map((key) => [key, process.env[key]]),
  );
  const child = spawn(EXECUTABLE, [], {
    cwd: parent,
    env: {
      ...safeEnv,
      KORY_V5_NATIVE_PARENT: parent,
      KORY_V5_NATIVE_STATE: state,
      KORY_V5_NATIVE_LOG: log,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  const before = readLog(log).length;
  try {
    for (let elapsed = 0; elapsed < 12_000; elapsed += 250) {
      const entries = readLog(log)
        .slice(before)
        .filter((event) => event.pid === child.pid);
      const startup = entries.find((event) => event.kind === 'startup');
      const ipc = entries.find((event) => event.kind === 'state-query');
      const reads = entries.filter((event) => event.kind === 'read');
      const observedReads = expectedReads.every(({ relative, outcome }) =>
        reads.some(
          (event) => event.detail?.relative === relative && event.detail?.outcome === outcome,
        ),
      );
      if (startup && ipc && observedReads && liveProcessMatches(child.pid)) {
        const actualRoot = ipc.detail?.root ?? null;
        if (actualRoot !== expectedRoot) {
          throw new Error('Native IPC returned unexpected restored root: ' + actualRoot);
        }
        return {
          pid: child.pid,
          executable: realpathSync(EXECUTABLE),
          host: 'macOS packaged Tauri',
          observed: [
            'real Mach-O process',
            'Rust setup event',
            'WebView-to-Rust state-query IPC',
            'WebView-to-Rust filesystem IPC',
          ],
          events: [startup, ipc, ...reads],
        };
      }
      if (child.exitCode !== null) {
        throw new Error('Packaged app exited before sending native IPC: ' + stderr);
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    throw new Error('Timed out awaiting packaged WebView IPC: ' + stderr);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise((done) => child.once('close', done)),
      new Promise((done) => setTimeout(done, 3_000)),
    ]);
    if (liveProcessMatches(child.pid)) {
      child.kill('SIGKILL');
      throw new Error('Packaged Tauri process did not quit');
    }
  }
}

export async function packagedSmoke() {
  if (!existsSync(EXECUTABLE)) throw new Error('Build the packaged .app before the smoke');
  const packageIdentity = inspectPackage();
  const runDir = mkdtempSync(join(tmpdir(), 'kory-tauri-packaged-smoke-'));
  const requestedParent = join(runDir, 'sacrificial');
  const requestedRoot = join(requestedParent, 'selected');
  mkdirSync(requestedRoot, { recursive: true });
  // Normalize macOS /var to /private/var, matching Rust fs::canonicalize.
  const parent = realpathSync(requestedParent);
  const root = realpathSync(requestedRoot);
  writeFileSync(join(root, 'marker.txt'), 'ALLOW');
  const outside = join(runDir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'DENY');
  const linked = join(root, 'linked.txt');
  symlinkSync(join(root, 'marker.txt'), linked);
  const state = join(runDir, 'state');
  const log = join(runDir, 'events.jsonl');
  const cleanStart = await launch({
    parent,
    state,
    log,
    expectedRoot: null,
    expectedReads: [
      { relative: 'marker.txt', outcome: 'denied' },
      { relative: 'linked.txt', outcome: 'denied' },
    ],
  });

  // Externally seeded state is NOT evidence of OS folder selection.
  writeFileSync(state, root);
  const seededRestart = await launch({
    parent,
    state,
    log,
    expectedRoot: root,
    expectedReads: [
      { relative: 'marker.txt', outcome: 'allowed' },
      { relative: 'linked.txt', outcome: 'allowed' },
    ],
  });

  // Retarget the symlink outside the authorized root, then perform real
  // WebView-to-Rust IPC in a third packaged process with restored state.
  unlinkSync(linked);
  symlinkSync(join(outside, 'secret.txt'), linked);
  const retargetedRestart = await launch({
    parent,
    state,
    log,
    expectedRoot: root,
    expectedReads: [
      { relative: 'marker.txt', outcome: 'allowed' },
      { relative: 'linked.txt', outcome: 'denied' },
    ],
  });
  const report = {
    classification: 'partial-packaged-startup-and-ipc',
    nativeDeviceVerified: false,
    scenarioQualified: false,
    dialogOrSelectionVerified: false,
    origin: 'real packaged arm64 binary, native Rust log, and process identity',
    seededState: true,
    executableSha256: createHash('sha256').update(readFileSync(EXECUTABLE)).digest('hex'),
    packageIdentity,
    runDir,
    cleanStart,
    seededRestart,
    retargetedRestart,
  };
  writeFileSync(join(runDir, 'partial-native-result.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await packagedSmoke(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          classification: 'native-smoke-failed',
          nativeDeviceVerified: false,
          error: String(error.message),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
