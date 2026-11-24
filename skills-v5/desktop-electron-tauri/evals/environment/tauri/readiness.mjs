#!/usr/bin/env node
/**
 * Read-only host probes and deliberately limited receipt inspection for Tauri V5.
 * No fixture writes, native automation, evaluation ledger writes, or qualification.
 * A syntactically consistent receipt is ALWAYS "structural-only", never device proof.
 */
import { spawnSync } from 'node:child_process';
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
import { createHash } from 'node:crypto';
import { dirname, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = resolve(HERE, '../../../..');
const SCENARIO_ID = 'desktop-electron-tauri-full-task-2-individual';
const VERSION = 1;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Ordered milestones for the independent native driver to account for. */
export const REQUIRED_NATIVE_EVENTS = Object.freeze([
  'packaged-launch',
  'dialog-cancel',
  'dialog-select',
  'allowed-read',
  'symlink-retarget',
  'escaped-read-denied',
  'dialog-reopen',
  'app-quit',
  'packaged-relaunch',
  'state-restored',
  'native-capture',
]);

function shortened(value) {
  return String(value ?? '')
    .trim()
    .slice(0, 300);
}

function executable(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function platformExecutableNames(name, platform) {
  return platform === 'win32' ? [name + '.exe', name + '.cmd', name] : [name];
}

function onPath(name, env, platform) {
  for (const folder of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const filename of platformExecutableNames(name, platform)) {
      const candidate = join(folder, filename);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

function commandProbe(command, args) {
  if (!command) return { ok: false, detail: 'not found' };
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 4000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (result.error) return { ok: false, detail: shortened(result.error.message) };
  return {
    ok: result.status === 0,
    detail: shortened(result.stdout || result.stderr || 'no version output'),
  };
}

function outside(path, scope) {
  const rel = relative(scope, path);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

function safeFile(path, { requireExternal = false, scope = SKILLS_ROOT } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) return 'absolute path required';
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return 'symbolic-link proof path rejected';
    if (!info.isFile()) return 'regular file required';
    if (requireExternal && !outside(realpathSync(path), scope)) {
      return 'artifact is inside the bundled skills directory';
    }
    return null;
  } catch {
    return 'file missing or unreadable';
  }
}

function safeDriver(path, scope) {
  if (!path) return { available: false, detail: 'KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER unset' };
  const issue = safeFile(path, { requireExternal: true, scope });
  if (issue) return { available: false, detail: issue, path };
  if (!executable(path)) return { available: false, detail: 'driver is not executable', path };
  // A trust check cannot be replaced by an absolute pathname alone.
  if ((statSync(path).mode & 0o022) !== 0) {
    return { available: false, detail: 'driver is group/world writable', path };
  }
  return { available: true, path, detail: 'executable exists; trust and behavior unverified' };
}

function tauriVersion(output) {
  // Accept both native CLI outputs: "tauri-cli 2.x.y" and "tauri 2.x.y".
  return /^(?:tauri(?:-cli)?\s+)?(2\.\d+\.\d+)(?:\b|$)/iu.test(output);
}

export function inspectEnvironment({
  repoRoot = resolve(HERE, '../../../../..'),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  run = commandProbe,
} = {}) {
  const blockers = [];
  const rustBin = onPath('rustc', env, platform);
  const cargoBin = onPath('cargo', env, platform);
  const rust = run(rustBin, ['--version']);
  const cargo = run(cargoBin, ['--version']);

  const override = env.KORY_SKILL_EVAL_TAURI_CLI?.trim();
  const candidates = override
    ? [override]
    : [
        join(repoRoot, 'desktop', 'node_modules', '.bin', 'tauri'),
        join(repoRoot, 'node_modules', '.bin', 'tauri'),
        onPath('tauri', env, platform),
      ];
  const cliPath = candidates.find((candidate) => candidate && executable(candidate)) ?? null;
  const cliProbe = run(cliPath, ['--version']);
  const cliV2 = cliProbe.ok && tauriVersion(cliProbe.detail);
  const driver = safeDriver(env.KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER?.trim(), SKILLS_ROOT);
  const cargoTauri = run(cargoBin, ['tauri', '--version']);
  const cargoTauriV2 = cargoTauri.ok && tauriVersion(cargoTauri.detail);

  if (!rust.ok) blockers.push('Rust compiler missing or not responding');
  if (!cargo.ok) blockers.push('Cargo missing or not responding');
  if (!cliV2) {
    blockers.push(
      override
        ? 'Configured Tauri CLI unavailable or does not report v2'
        : 'Tauri v2 CLI missing (project-local and PATH)',
    );
  }
  if (!driver.available) blockers.push('Trusted external Tauri native driver unavailable');
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    blockers.push('Unsupported desktop host');
  }
  return {
    schemaVersion: VERSION,
    scenarioId: SCENARIO_ID,
    checkedAt: new Date().toISOString(),
    host: { platform, arch },
    rust: { path: rustBin, ...rust },
    cargo: { path: cargoBin, ...cargo },
    cli: { path: cliPath, ...cliProbe, v2: Boolean(cliV2) },
    cargoTauri: { ...cargoTauri, v2: Boolean(cargoTauriV2), diagnosticOnly: true },
    driver,
    nativeAttemptReady: blockers.length === 0,
    nativeDeviceVerified: false,
    blockers,
  };
}

function safeReadArtifact(path, label, issues) {
  const problem = safeFile(path, { requireExternal: true });
  if (problem) {
    issues.push(label + ': ' + problem);
    return null;
  }
  try {
    const size = statSync(path).size;
    if (size <= 0 || size > MAX_FILE_BYTES) {
      issues.push(label + ': unreasonable file size');
      return null;
    }
    return readFileSync(path);
  } catch {
    issues.push(label + ': cannot read artifact');
    return null;
  }
}

// Stream binary fingerprints: packaged apps can be much larger than JSON receipts.
// Structural inspection never interprets the bytes as an actual launched process.
function fingerprintArtifact(path, label, issues, maxBytes) {
  const issue = safeFile(path, { requireExternal: true });
  if (issue) {
    issues.push(label + ': ' + issue);
    return null;
  }
  let fd;
  try {
    const info = statSync(path);
    if (info.size <= 0 || info.size > maxBytes) {
      issues.push(label + ': unreasonable file size');
      return null;
    }
    const digest = createHash('sha256');
    const header = Buffer.alloc(32);
    const chunk = Buffer.alloc(128 * 1024);
    let bytes = 0;
    fd = openSync(path, 'r');
    while (true) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      if (bytes < header.length) {
        chunk.copy(header, bytes, 0, Math.min(n, header.length - bytes));
      }
      digest.update(chunk.subarray(0, n));
      bytes += n;
      if (bytes > maxBytes) {
        issues.push(label + ': artifact grew beyond limit while reading');
        return null;
      }
    }
    if (bytes !== info.size) {
      issues.push(label + ': artifact changed while reading');
      return null;
    }
    return { sha256: digest.digest('hex'), header, bytes };
  } catch {
    issues.push(label + ': unable to fingerprint artifact');
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Self-reported event fields may be forged. This inspects internal consistency
 * only. A native qualifier must independently run/witness a trusted OS driver.
 */
export function inspectReceipt(receipt, { expectedChallenge, receiptPath } = {}) {
  const issues = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return {
      classification: 'rejected',
      nativeDeviceVerified: false,
      issues: ['receipt must be an object'],
    };
  }
  if (receipt.schemaVersion !== VERSION) issues.push('schema version mismatch');
  if (receipt.scenarioId !== SCENARIO_ID) issues.push('scenario mismatch');
  if (receipt.runtime !== 'tauri' || receipt.launchMode !== 'packaged') {
    issues.push('packaged Tauri runtime not declared');
  }
  if (
    typeof expectedChallenge !== 'string' ||
    expectedChallenge.length < 16 ||
    receipt.challenge !== expectedChallenge
  ) {
    issues.push('fresh external challenge missing or mismatched');
  }
  if (receiptPath && safeFile(receiptPath, { requireExternal: true })) {
    issues.push('receipt path must be a regular external file');
  }

  const started = Date.parse(receipt.startedAt);
  const finished = Date.parse(receipt.finishedAt);
  const now = Date.now();
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    finished < started ||
    started > now + 30000 ||
    finished > now + 30000 ||
    now - started > 15 * 60 * 1000
  ) {
    issues.push('receipt is stale, future-dated, or temporally inconsistent');
  }

  const events = receipt.nativeEvents;
  if (!Array.isArray(events)) {
    issues.push('native events must be an ordered array');
  } else {
    let cursor = -1;
    let lastTime = -1;
    for (const event of REQUIRED_NATIVE_EVENTS) {
      const matches = events.filter((entry) => entry?.kind === event);
      if (matches.length !== 1) {
        issues.push('missing or duplicated event: ' + event);
        continue;
      }
      const position = events.findIndex((entry) => entry?.kind === event);
      const atMs = matches[0].atMs;
      if (!Number.isInteger(atMs) || atMs < 0 || position <= cursor || atMs < lastTime) {
        issues.push('event sequence invalid: ' + event);
      }
      cursor = position;
      lastTime = atMs;
    }

    const event = (kind) => events.find((entry) => entry?.kind === kind);
    const initialPid = event('packaged-launch')?.pid;
    const restartedPid = event('packaged-relaunch')?.pid;
    if (
      !Number.isSafeInteger(initialPid) ||
      initialPid <= 1 ||
      !Number.isSafeInteger(restartedPid) ||
      restartedPid <= 1 ||
      initialPid === restartedPid ||
      event('app-quit')?.pid !== initialPid ||
      event('state-restored')?.pid !== restartedPid ||
      event('native-capture')?.pid !== restartedPid
    ) {
      issues.push('native process identity or relaunch linkage invalid');
    }
    if (
      event('dialog-cancel')?.outcome !== 'cancelled' ||
      event('dialog-cancel')?.selection !== null
    ) {
      issues.push('dialog cancellation must be explicit, with null selection');
    }
    const selectedRoot = event('dialog-select')?.workspaceRoot;
    if (
      typeof selectedRoot !== 'string' ||
      !isAbsolute(selectedRoot) ||
      event('state-restored')?.workspaceRoot !== selectedRoot
    ) {
      issues.push('restored root is missing or differs from selected root');
    }
    if (
      event('allowed-read')?.outcome !== 'allowed' ||
      event('escaped-read-denied')?.outcome !== 'denied'
    ) {
      issues.push('allowed and denied command outcomes missing');
    }
    if (event('native-capture')?.source !== 'os-compositor') {
      issues.push('OS compositor capture source missing');
    }
  }

  const binaryPath = receipt.package?.executablePath;
  const binary = fingerprintArtifact(binaryPath, 'packaged executable', issues, MAX_PACKAGE_BYTES);
  if (binary) {
    if (!executable(binaryPath)) issues.push('packaged executable lacks execute permission');
    if (receipt.package?.sha256 !== binary.sha256) issues.push('packaged executable hash mismatch');
  }
  const capturePath = receipt.capture?.path;
  const capture = fingerprintArtifact(capturePath, 'native capture', issues, MAX_CAPTURE_BYTES);
  if (capture) {
    if (receipt.capture?.sha256 !== capture.sha256) issues.push('capture hash mismatch');
    const header = capture.header;
    if (
      capture.bytes < 32 ||
      !header.subarray(0, 8).equals(PNG_SIGNATURE) ||
      header.toString('ascii', 12, 16) !== 'IHDR' ||
      header.readUInt32BE(16) < 320 ||
      header.readUInt32BE(20) < 200
    ) {
      issues.push('native capture is not a plausible desktop PNG');
    }
  }

  return {
    classification: issues.length ? 'rejected' : 'structural-only',
    nativeDeviceVerified: false,
    issues: issues.length
      ? issues
      : ['Self-reported receipts cannot independently prove native device execution'],
  };
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function usage() {
  process.stderr.write(
    'Usage: node readiness.mjs [--strict] [--receipt /absolute/receipt.json --challenge value]\n',
  );
}

const calledAsProgram =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (calledAsProgram) {
  const argv = process.argv.slice(2);
  const allowed = new Set(['--strict', '--receipt', '--challenge']);
  if (
    argv.some((arg) => arg.startsWith('--') && !allowed.has(arg)) ||
    argv.includes('--help') ||
    argv.includes('-h')
  ) {
    usage();
    process.exitCode = 64;
  } else if (argv.includes('--receipt')) {
    const path = argv[argv.indexOf('--receipt') + 1];
    const challenge = argv[argv.indexOf('--challenge') + 1];
    let verdict;
    try {
      if (!path || !challenge || !existsSync(path)) throw new Error('receipt/challenge missing');
      const receiptBytes = safeReadArtifact(path, 'receipt', []);
      if (!receiptBytes) throw new Error('receipt missing or unsafe');
      verdict = inspectReceipt(JSON.parse(receiptBytes.toString('utf8')), {
        expectedChallenge: challenge,
        receiptPath: path,
      });
    } catch (error) {
      verdict = {
        classification: 'rejected',
        nativeDeviceVerified: false,
        issues: [String(error.message)],
      };
    }
    print(verdict);
    // A receipt alone can never satisfy a native qualification gate.
    process.exitCode = 2;
  } else {
    const result = inspectEnvironment();
    print(result);
    if (argv.includes('--strict') && !result.nativeAttemptReady) process.exitCode = 2;
  }
}
