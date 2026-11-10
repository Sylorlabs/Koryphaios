import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REQUIRED_NATIVE_EVENTS } from './readiness.mjs';
import {
  examinePackagedApp, macWitnessSupport, processAlive, SCENARIO_BUNDLE_ID,
} from './native-macos.mjs';
import {
  assessNativePrerequisites, driveNativeDriver, limitedDriverEnvironment, NativeCheckpointVerifier,
} from './native-run.mjs';

let sandbox;
before(() => { sandbox = mkdtempSync(join(tmpdir(), 'kory-tauri-native-test-')); });
after(() => { rmSync(sandbox, { recursive: true, force: true }); });

const hash = (data) => createHash('sha256').update(data).digest('hex');
const challenge = 'test-native-challenge-85057ccb201b41c29d63e05f';

function driver() {
  const path = join(sandbox, 'externally-reviewed-driver');
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return path;
}

test('lack of a native witness platform is an explicit blocker', () => {
  const result = macWitnessSupport({ platform: 'linux' });
  assert.equal(result.available, false);
  assert.match(result.blockers.join('\n'), /macOS only/);
});

test('permission errors never masquerade as a stopped native process', () => {
  assert.equal(processAlive(2020, { kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }), true);
  assert.equal(processAlive(2020, { kill: () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); } }), false);
});

test('trusted driver receives no API keys or unrelated application secrets', () => {
  const restricted = limitedDriverEnvironment({
    PATH: '/usr/bin', HOME: '/Users/runner', OPENAI_API_KEY: 'hidden',
    KORY_SKILL_EVAL_TAURI_REVIEWED_DRIVER_SHA256: 'hidden',
    GITHUB_TOKEN: 'hidden', AWS_SECRET_ACCESS_KEY: 'hidden',
  });
  assert.deepEqual(restricted, { PATH: '/usr/bin', HOME: '/Users/runner' });
});

test('reviewed hash pin required, mismatched pin refused, exact pin is only attempt readiness', async () => {
  const path = driver();
  const probe = {
    blockers: [], driver: { available: true, path },
    cli: { path: '/path/to/real/tauri' }, nativeAttemptReady: true,
  };
  const host = { blockers: [], available: true };
  const missing = await assessNativePrerequisites({ environment: probe, host, env: {} });
  assert.equal(missing.status, 'blocked');
  assert.match(missing.blockers.join('\n'), /SHA-256 pin/);
  const wrong = await assessNativePrerequisites({
    environment: probe, host, env: { KORY_SKILL_EVAL_TAURI_REVIEWED_DRIVER_SHA256: 'f'.repeat(64) },
  });
  assert.equal(wrong.status, 'blocked');
  assert.match(wrong.blockers.join('\n'), /differs from reviewed/);
  const correct = await assessNativePrerequisites({
    environment: probe, host,
    env: { KORY_SKILL_EVAL_TAURI_REVIEWED_DRIVER_SHA256: hash('#!/bin/sh\nexit 0\n') },
  });
  assert.equal(correct.status, 'ready-to-attempt');
  assert.equal(correct.nativeDeviceVerified, false);
  assert.equal(correct.nativeWindowObserved, false);
});

test('packaged identity probe rejects shell binaries, wrong bundle IDs and symlink aliases', () => {
  const runDir = join(sandbox, 'packaged');
  const binDir = join(runDir, 'TauriProbe.app', 'Contents', 'MacOS');
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, 'native-probe');
  const plist = join(runDir, 'TauriProbe.app', 'Contents', 'Info.plist');
  writeFileSync(plist, 'plist fixture');
  const execute = (_, args) => args.includes('CFBundleIdentifier')
    ? SCENARIO_BUNDLE_ID : 'native-probe';
  writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
  assert.throws(() => examinePackagedApp(binary, runDir, { execute }), /not Mach-O/);
  writeFileSync(binary, Buffer.from('feedfacf00000000', 'hex'), { mode: 0o700 });
  assert.equal(examinePackagedApp(binary, runDir, { execute }).bundleId, SCENARIO_BUNDLE_ID);
  assert.throws(() => examinePackagedApp(binary, runDir, {
    execute: (_, args) => args.includes('CFBundleIdentifier') ? 'unrelated.app' : 'native-probe',
  }), /bundle identity/);
  const alias = join(runDir, 'fake-binary-link');
  symlinkSync(binary, alias);
  assert.throws(() => examinePackagedApp(alias, runDir, { execute }), /non-symlink/);
  assert.throws(() => examinePackagedApp(binary, join(sandbox, 'unrelated'), { execute }), /ENOENT|isolated/);
});

function makeSimulatedProtocol({ alive = () => false } = {}) {
  const runDir = join(sandbox, 'protocol');
  mkdirSync(runDir, { recursive: true });
  const executable = join(sandbox, 'simulated-binary');
  const binary = Buffer.from('#!/bin/sh\nexit 0\n');
  writeFileSync(executable, binary, { mode: 0o700 });
  const observations = [];
  const observe = async ({ pid, runDir: root, captureName }) => {
    const image = Buffer.alloc(1024, 0);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image, 0);
    image.write('IHDR', 12);
    image.writeUInt32BE(1024, 16);
    image.writeUInt32BE(768, 20);
    const capturePath = join(root, captureName);
    writeFileSync(capturePath, image);
    const result = {
      pid, capturePath, sha256: hash(image),
      source: 'macos-system-events-and-screencapture',
    };
    observations.push(result);
    return result;
  };
  const verifier = new NativeCheckpointVerifier({
    challenge, runDir, examine: () => ({ executablePath: executable }),
    observe, alive,
  });
  return { verifier, executable, binary, runDir, observations };
}

function simulatedReceipt({ executable, binary, capture, runDir }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, scenarioId: 'desktop-electron-tauri-full-task-2-individual',
    runtime: 'tauri', launchMode: 'packaged', challenge,
    startedAt: now, finishedAt: now,
    nativeEvents: REQUIRED_NATIVE_EVENTS.map((kind, atMs) => {
      const row = { kind, atMs };
      if (kind === 'packaged-launch' || kind === 'app-quit') row.pid = 4101;
      if (kind === 'packaged-relaunch' || kind === 'state-restored' || kind === 'native-capture') row.pid = 4102;
      if (kind === 'dialog-cancel') { row.outcome = 'cancelled'; row.selection = null; }
      if (kind === 'dialog-select' || kind === 'state-restored') row.workspaceRoot = join(runDir, 'workspace');
      if (kind === 'allowed-read') row.outcome = 'allowed';
      if (kind === 'escaped-read-denied') row.outcome = 'denied';
      if (kind === 'native-capture') row.source = 'os-compositor';
      return row;
    }),
    package: { executablePath: executable, sha256: hash(binary) },
    capture: { path: capture.capturePath, sha256: capture.sha256 },
  };
}

async function upToRelaunch(fixture) {
  const { verifier, executable } = fixture;
  await verifier.accept({ checkpoint: 'packaged-launch', executablePath: executable, pid: 4101 });
  await verifier.accept({ checkpoint: 'app-quit', pid: 4101 });
  await verifier.accept({ checkpoint: 'packaged-relaunch', executablePath: executable, pid: 4102 });
}

test('synthetic driver output cannot qualify a scenario even when all receipt fields fit', async () => {
  const fixture = makeSimulatedProtocol();
  await upToRelaunch(fixture);
  const receiptPath = join(fixture.runDir, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify(simulatedReceipt({
    executable: fixture.executable, binary: fixture.binary,
    capture: fixture.observations[1], runDir: fixture.runDir,
  })));
  await fixture.verifier.accept({ checkpoint: 'complete', receiptPath });
  assert.equal(fixture.verifier.complete, true);
  assert.equal(fixture.verifier.finished.nativeWindowObserved, true);
  assert.equal(fixture.verifier.finished.nativeDeviceVerified, false);
  assert.equal(fixture.verifier.finished.scenarioQualified, false);
  assert.match(fixture.verifier.finished.unresolved.join('\n'), /independent evaluator review/);
});

test('driver checkpoints enforce app exit before relaunch', async () => {
  const fixture = makeSimulatedProtocol({ alive: () => true });
  await fixture.verifier.accept({
    checkpoint: 'packaged-launch', executablePath: fixture.executable, pid: 4101,
  });
  await assert.rejects(fixture.verifier.accept({ checkpoint: 'app-quit', pid: 4101 }), /not fully exited/);
});

test('driver cannot relabel the first process as a relaunch', async () => {
  const fixture = makeSimulatedProtocol();
  await fixture.verifier.accept({
    checkpoint: 'packaged-launch', executablePath: fixture.executable, pid: 4101,
  });
  await fixture.verifier.accept({ checkpoint: 'app-quit', pid: 4101 });
  await assert.rejects(fixture.verifier.accept({
    checkpoint: 'packaged-relaunch', executablePath: fixture.executable, pid: 4101,
  }), /different native process ID/);
});

test('driver cannot substitute its own screenshot or mismatched receipt identity', async () => {
  const fixture = makeSimulatedProtocol();
  await upToRelaunch(fixture);
  const fake = simulatedReceipt({
    executable: fixture.executable, binary: fixture.binary,
    capture: fixture.observations[1], runDir: fixture.runDir,
  });
  fake.nativeEvents.find((entry) => entry.kind === 'native-capture').source = 'webview-canvas';
  const receiptPath = join(fixture.runDir, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify(fake));
  await assert.rejects(fixture.verifier.accept({ checkpoint: 'complete', receiptPath }), /receipt rejected/);
});

test('checkpoint order is enforced before trusting driver reported outcomes', async () => {
  const fixture = makeSimulatedProtocol();
  await assert.rejects(fixture.verifier.accept({
    checkpoint: 'complete', receiptPath: join(fixture.runDir, 'receipt.json'),
  }), /expected packaged-launch/);
});

test('untrusted executable printing complete cannot bypass the checkpoint witness', async () => {
  const fixture = makeSimulatedProtocol();
  const path = join(sandbox, 'fake-driver');
  writeFileSync(path, '#!/bin/sh\nprintf \'%s\\n\' \'{"checkpoint":"complete"}\'\n', { mode: 0o700 });
  await assert.rejects(driveNativeDriver({
    driverPath: path, cliPath: '/not-a-real-cli', runDir: fixture.runDir,
    challenge, verifier: fixture.verifier, timeoutMs: 5000,
  }), /expected packaged-launch/);
});

test('real host preflight returns blocked with exit 2 and does not emit a device pass', () => {
  const script = new URL('./native-run.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], {
    env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 2);
  const response = JSON.parse(result.stdout);
  assert.equal(response.status, 'blocked');
  assert.equal(response.nativeDeviceVerified, false);
  assert.match(response.blockers.join('\n'), /native driver|SHA-256 pin/);
});
