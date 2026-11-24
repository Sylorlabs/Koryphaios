/**
 * macOS-only OS witness for a packaged Tauri scenario. Native UI automation
 * must be performed by an independently reviewed external driver. This module
 * independently checks the actual process and samples compositor pixels.
 * Other operating systems require their own witness; there is no fallback.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export const SCENARIO_BUNDLE_ID = 'dev.koryphaios.v5.tauri.scenario2';
const MAC_TOOLS = Object.freeze({
  plutil: '/usr/bin/plutil',
  ps: '/bin/ps',
  osascript: '/usr/bin/osascript',
  screencapture: '/usr/sbin/screencapture',
});
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MACHO_MAGICS = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]);

function command(bin, args, timeout = 5000) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${basename(bin)}: ${String(result.error?.message || result.stderr || `exit ${result.status}`)
        .trim()
        .slice(0, 350)}`,
    );
  }
  return result.stdout.trim();
}

export function macWitnessSupport({ platform = process.platform } = {}) {
  const blockers = [];
  if (platform !== 'darwin') blockers.push('Native window witness currently supports macOS only');
  if (platform === 'darwin') {
    for (const [name, bin] of Object.entries(MAC_TOOLS)) {
      if (!existsSync(bin)) blockers.push(`macOS ${name} utility unavailable`);
    }
  }
  return { available: blockers.length === 0, blockers };
}

function inside(path, root) {
  const subpath = relative(root, path);
  return (
    subpath !== '' && subpath !== '..' && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath)
  );
}

/** Verify bundle identity and actual Mach-O bytes; executable names are not proof. */
export function examinePackagedApp(executablePath, runDir, { execute = command } = {}) {
  if (typeof executablePath !== 'string' || !isAbsolute(executablePath)) {
    throw new Error('Packaged executable must have an absolute path');
  }
  const info = lstatSync(executablePath);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error('Packaged executable must be a regular, non-symlink file');
  accessSync(executablePath, constants.X_OK);
  const actual = realpathSync(executablePath);
  const root = realpathSync(runDir);
  if (!inside(actual, root))
    throw new Error('Packaged executable must be inside the isolated run directory');
  const macosDir = dirname(actual);
  if (
    basename(macosDir) !== 'MacOS' ||
    basename(dirname(macosDir)) !== 'Contents' ||
    !dirname(dirname(macosDir)).endsWith('.app')
  ) {
    throw new Error('Expected a packaged .app/Contents/MacOS executable');
  }
  const plist = join(dirname(macosDir), 'Info.plist');
  if (!lstatSync(plist).isFile()) throw new Error('Missing application Info.plist');
  const bundleId = execute(MAC_TOOLS.plutil, [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    '-o',
    '-',
    plist,
  ]);
  const bundleExecutable = execute(MAC_TOOLS.plutil, [
    '-extract',
    'CFBundleExecutable',
    'raw',
    '-o',
    '-',
    plist,
  ]);
  if (bundleId !== SCENARIO_BUNDLE_ID || bundleExecutable !== basename(actual)) {
    throw new Error('Packaged app bundle identity differs from the scenario contract');
  }
  const head = Buffer.alloc(4);
  const fd = openSync(actual, 'r');
  let count;
  try {
    count = readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  if (count !== 4) throw new Error('Packaged executable has no binary header');
  const magic = head.toString('hex');
  if (!MACHO_MAGICS.has(magic)) throw new Error('Packaged executable is not Mach-O');
  return { executablePath: actual, bundleId, appPath: dirname(dirname(macosDir)) };
}

export function processAlive(pid, { kill = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  } // EPERM/unknown => still alive; fail closed.
}

function processMatches(pid, executablePath, { execute = command } = {}) {
  if (!processAlive(pid)) throw new Error(`Packaged process ${pid} is not alive`);
  // macOS ps 'comm' reports the executable path without its command arguments.
  const reported = execute(MAC_TOOLS.ps, ['-ww', '-p', String(pid), '-o', 'comm=']);
  let canonical;
  try {
    canonical = realpathSync(reported);
  } catch {
    throw new Error('Cannot resolve running process executable from ps');
  }
  if (canonical !== executablePath)
    throw new Error('Running process executable differs from packaged artifact');
}

function geometryScript(pid) {
  // PID is a validated integer; no externally supplied string enters AppleScript.
  return `tell application "System Events"
  set matches to (application processes whose unix id is ${pid})
  if (count of matches) is not 1 then error "Packaged app process missing"
  set selectedProcess to item 1 of matches
  set frontmost of selectedProcess to true
  if (count of windows of selectedProcess) < 1 then error "No native application window"
  set selectedWindow to front window of selectedProcess
  set pos to position of selectedWindow
  set dims to size of selectedWindow
  return (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of dims as text) & "," & (item 2 of dims as text)
end tell`;
}

/** An independent, live macOS process/window observation. */
export async function witnessMacWindow({
  pid,
  packagedApp,
  runDir,
  captureName,
  execute = command,
}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid native process ID');
  if (!['launch.png', 'relaunch.png'].includes(captureName))
    throw new Error('Invalid native capture name');
  processMatches(pid, packagedApp.executablePath, { execute });
  let coords;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const geometry = execute(MAC_TOOLS.osascript, ['-e', geometryScript(pid)], 5000);
      const match = /^(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(geometry);
      if (!match) throw new Error('Invalid native window geometry');
      coords = match.slice(1).map(Number);
      if (coords[2] < 320 || coords[3] < 200 || coords[2] > 8192 || coords[3] > 8192) {
        throw new Error('Native window size outside expected bounds');
      }
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((done) => setTimeout(done, 500));
    }
  }
  if (!coords) throw new Error(`Native window inaccessible: ${lastError?.message}`);
  processMatches(pid, packagedApp.executablePath, { execute });
  const capturePath = join(runDir, captureName);
  execute(MAC_TOOLS.screencapture, ['-x', '-R' + coords.join(','), capturePath], 10000);
  const stat = statSync(capturePath);
  if (!stat.isFile() || stat.size < 512 || stat.size > 128 * 1024 * 1024) {
    throw new Error('Native compositor capture missing or implausible');
  }
  const image = readFileSync(capturePath);
  if (
    !image.subarray(0, 8).equals(PNG_MAGIC) ||
    image.toString('ascii', 12, 16) !== 'IHDR' ||
    image.readUInt32BE(16) < 320 ||
    image.readUInt32BE(20) < 200
  ) {
    throw new Error('Native compositor capture has invalid PNG geometry');
  }
  processMatches(pid, packagedApp.executablePath, { execute });
  return {
    pid,
    capturePath,
    sha256: createHash('sha256').update(image).digest('hex'),
    windowRect: coords,
    source: 'macos-system-events-and-screencapture',
  };
}
