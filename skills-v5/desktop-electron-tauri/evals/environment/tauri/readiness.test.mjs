import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  inspectEnvironment, inspectReceipt, REQUIRED_NATIVE_EVENTS,
} from './readiness.mjs';

let sandbox;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'kory-tauri-proof-'));
});
after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const hash = (content) => createHash('sha256').update(content).digest('hex');
const challenge = 'test-challenge-8c774ca9b4df4f9ca1c2';
const mkTool = (name) => {
  const path = join(sandbox, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
};
const healthyProbe = (path, args) => {
  if (!path) return { ok: false, detail: 'not found' };
  const name = path.split('/').pop();
  if (name === 'rustc') return { ok: true, detail: 'rustc 1.97.1' };
  if (name === 'cargo') return { ok: true, detail: 'cargo 1.97.1' };
  if (name === 'tauri') return { ok: true, detail: 'tauri-cli 2.11.4' };
  return { ok: false, detail: 'unknown tool' };
};
const mkEnvironment = (args = {}) => ({
  env: { PATH: sandbox, ...args },
  repoRoot: join(sandbox, 'not-installed-project'),
  run: healthyProbe,
  platform: 'darwin',
  arch: 'arm64',
});

test('installed native app or Rust compiler alone cannot unlock Tauri proof', () => {
  mkTool('rustc');
  mkTool('cargo');
  const report = inspectEnvironment(mkEnvironment());
  assert.equal(report.rust.ok, true);
  assert.equal(report.cargo.ok, true);
  assert.equal(report.cli.v2, false);
  assert.equal(report.nativeAttemptReady, false);
  assert.equal(report.nativeDeviceVerified, false);
  assert.match(report.blockers.join('\n'), /Tauri v2 CLI missing/);
  assert.match(report.blockers.join('\n'), /native driver unavailable/);
});

test('native attempt readiness still cannot claim packaged device verification', () => {
  mkTool('tauri');
  const driver = mkTool('driver');
  const report = inspectEnvironment(mkEnvironment({
    KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER: driver,
  }));
  assert.equal(report.cli.v2, true);
  assert.equal(report.driver.available, true);
  assert.equal(report.nativeAttemptReady, true);
  assert.equal(report.nativeDeviceVerified, false);
});

test('v1 CLI and invalid configured override fail closed', () => {
  const driver = mkTool('driver');
  const base = mkEnvironment({ KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER: driver });
  const v1 = inspectEnvironment({
    ...base,
    run: (path, args) => path?.endsWith('/tauri')
      ? { ok: true, detail: 'tauri-cli 1.6.0' }
      : healthyProbe(path, args),
  });
  assert.equal(v1.nativeAttemptReady, false);
  assert.equal(v1.cli.v2, false);

  const overridden = inspectEnvironment(mkEnvironment({
    KORY_SKILL_EVAL_TAURI_CLI: '/missing/tauri',
    KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER: driver,
  }));
  assert.equal(overridden.cli.v2, false);
  assert.match(overridden.blockers.join('\n'), /Configured Tauri CLI unavailable/);
});

test('driver must be an external regular executable, not a symlink', () => {
  const driver = mkTool('driver-real');
  const alias = join(sandbox, 'driver-link');
  symlinkSync(driver, alias);
  const symbolic = inspectEnvironment(mkEnvironment({
    KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER: alias,
  }));
  assert.equal(symbolic.driver.available, false);
  assert.match(symbolic.driver.detail, /symbolic-link/);

  const nonexecutable = join(sandbox, 'driver-inert');
  writeFileSync(nonexecutable, 'inert');
  chmodSync(nonexecutable, 0o644);
  const blocked = inspectEnvironment(mkEnvironment({
    KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER: nonexecutable,
  }));
  assert.equal(blocked.driver.available, false);
  assert.match(blocked.driver.detail, /not executable/);
});

test('bundled script cannot be installed as its own trusted native driver', () => {
  const report = inspectEnvironment(mkEnvironment({
    KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER: new URL('./readiness.mjs', import.meta.url).pathname,
  }));
  assert.equal(report.driver.available, false);
  assert.match(report.driver.detail, /inside the bundled skills/);
});

function receiptFixture() {
  const executable = mkTool('fake-package-executable');
  const image = Buffer.alloc(128, 0);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image, 0);
  image.write('IHDR', 12);
  image.writeUInt32BE(1024, 16);
  image.writeUInt32BE(768, 20);
  const capture = join(sandbox, 'fake-capture.png');
  writeFileSync(capture, image);
  const now = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    scenarioId: 'desktop-electron-tauri-full-task-2-individual',
    runtime: 'tauri',
    launchMode: 'packaged',
    challenge,
    startedAt: now, finishedAt: now,
    nativeEvents: REQUIRED_NATIVE_EVENTS.map((kind, atMs) => {
      const entry = { kind, atMs };
      if (kind === 'packaged-launch' || kind === 'app-quit') entry.pid = 4100;
      if (kind === 'packaged-relaunch' || kind === 'state-restored'
        || kind === 'native-capture') entry.pid = 4101;
      if (kind === 'dialog-cancel') { entry.outcome = 'cancelled'; entry.selection = null; }
      if (kind === 'dialog-select' || kind === 'state-restored') {
        entry.workspaceRoot = join(sandbox, 'selected-root');
      }
      if (kind === 'allowed-read') entry.outcome = 'allowed';
      if (kind === 'escaped-read-denied') entry.outcome = 'denied';
      if (kind === 'native-capture') entry.source = 'os-compositor';
      return entry;
    }),
    package: { executablePath: executable, sha256: hash('#!/bin/sh\nexit 0\n') },
    capture: { path: capture, sha256: hash(image) },
  };
  return receipt;
}

test('even a fabricated but internally consistent native receipt never turns green', () => {
  const receipt = receiptFixture();
  const verdict = inspectReceipt(receipt, { expectedChallenge: challenge });
  assert.equal(verdict.classification, 'structural-only');
  assert.equal(verdict.nativeDeviceVerified, false);
  assert.match(verdict.issues.join('\n'), /cannot independently prove/);
});

test('receipt rejects a mismatched challenge and stale evidence', () => {
  const receipt = receiptFixture();
  const mismatch = inspectReceipt(receipt, { expectedChallenge: challenge + '-other' });
  assert.equal(mismatch.classification, 'rejected');
  assert.match(mismatch.issues.join('\n'), /challenge/);
  receipt.startedAt = '2020-01-01T00:00:00.000Z';
  const stale = inspectReceipt(receipt, { expectedChallenge: challenge });
  assert.equal(stale.classification, 'rejected');
  assert.match(stale.issues.join('\n'), /stale/);
});

test('receipt rejects absent denial or impossible event ordering', () => {
  const receipt = receiptFixture();
  receipt.nativeEvents = receipt.nativeEvents.filter(({ kind }) => kind !== 'escaped-read-denied');
  const absent = inspectReceipt(receipt, { expectedChallenge: challenge });
  assert.equal(absent.classification, 'rejected');
  assert.match(absent.issues.join('\n'), /escaped-read-denied/);

  const swapped = receiptFixture();
  swapped.nativeEvents[1].atMs = 999;
  assert.equal(inspectReceipt(swapped, { expectedChallenge: challenge }).classification, 'rejected');
});

test('receipt rejects tampered binary or screenshot artifact', () => {
  const receipt = receiptFixture();
  writeFileSync(receipt.package.executablePath, '#!/bin/sh\nexit 9\n');
  const tampered = inspectReceipt(receipt, { expectedChallenge: challenge });
  assert.equal(tampered.classification, 'rejected');
  assert.match(tampered.issues.join('\n'), /executable hash mismatch/);

  const other = receiptFixture();
  writeFileSync(other.capture.path, Buffer.from('no-pixels'));
  const badImage = inspectReceipt(other, { expectedChallenge: challenge });
  assert.equal(badImage.classification, 'rejected');
  assert.match(badImage.issues.join('\n'), /capture hash mismatch|desktop PNG/);
});

test('receipt rejects synthetic image substituted through a symlink', () => {
  const receipt = receiptFixture();
  const alias = join(sandbox, 'image-link.png');
  symlinkSync(receipt.capture.path, alias);
  receipt.capture.path = alias;
  const verdict = inspectReceipt(receipt, { expectedChallenge: challenge });
  assert.equal(verdict.classification, 'rejected');
  assert.match(verdict.issues.join('\n'), /symbolic-link/);
});


test('larger packaged executable is fingerprinted without assuming tiny binaries', () => {
  const receipt = receiptFixture();
  const largeBinary = Buffer.alloc(11 * 1024 * 1024, 0x4d);
  writeFileSync(receipt.package.executablePath, largeBinary);
  chmodSync(receipt.package.executablePath, 0o755);
  receipt.package.sha256 = hash(largeBinary);
  const verdict = inspectReceipt(receipt, { expectedChallenge: challenge });
  assert.equal(verdict.classification, 'structural-only');
  assert.equal(verdict.nativeDeviceVerified, false);
});

test('strict CLI preflight reports a blocked status, not a device pass', () => {
  const harness = new URL('./readiness.mjs', import.meta.url);
  const run = spawnSync(process.execPath, [harness.pathname, '--strict'], {
    env: { PATH: sandbox }, encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  const result = JSON.parse(run.stdout);
  assert.equal(result.nativeAttemptReady, false);
  assert.equal(result.nativeDeviceVerified, false);
  assert.ok(result.blockers.some((entry) => entry.includes('native driver')));
});


test('receipt rejects cancelled dialogue coerced to a home path', () => {
  const receipt = receiptFixture();
  const cancel = receipt.nativeEvents.find((entry) => entry.kind === 'dialog-cancel');
  cancel.selection = '/Users/example';
  const result = inspectReceipt(receipt, { expectedChallenge: challenge });
  assert.equal(result.classification, 'rejected');
  assert.match(result.issues.join('\n'), /dialog cancellation/);
});

test('receipt rejects relaunch with same process and lost restored root', () => {
  const receipt = receiptFixture();
  const relaunched = receipt.nativeEvents.find((entry) => entry.kind === 'packaged-relaunch');
  relaunched.pid = 4100;
  const restored = receipt.nativeEvents.find((entry) => entry.kind === 'state-restored');
  restored.workspaceRoot = '/unrelated/root';
  const result = inspectReceipt(receipt, { expectedChallenge: challenge });
  assert.equal(result.classification, 'rejected');
  assert.match(result.issues.join('\n'), /process identity/);
  assert.match(result.issues.join('\n'), /restored root/);
});


test('receipt CLI exits nonzero even when every declared check is structurally consistent', () => {
  const receipt = receiptFixture();
  const file = join(sandbox, 'receipt.json');
  writeFileSync(file, JSON.stringify(receipt));
  const harness = new URL('./readiness.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [
    harness.pathname, '--receipt', file, '--challenge', challenge,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.classification, 'structural-only');
  assert.equal(verdict.nativeDeviceVerified, false);
});
