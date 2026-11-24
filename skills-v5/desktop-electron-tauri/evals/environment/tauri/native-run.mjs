#!/usr/bin/env node
/**
 * Supervised execution of a separately reviewed Tauri v2 scenario driver.
 * A driver receipt alone cannot qualify the scenario. This runner records
 * independent, live macOS process/window observations and always leaves
 * final scorer promotion to the independent evaluator.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, lstatSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectEnvironment, inspectReceipt } from './readiness.mjs';
import {
  examinePackagedApp,
  macWitnessSupport,
  processAlive,
  witnessMacWindow,
} from './native-macos.mjs';

const SCENARIO_ID = 'desktop-electron-tauri-full-task-2-individual';
const CHECKPOINTS = Object.freeze(['packaged-launch', 'app-quit', 'packaged-relaunch', 'complete']);
const MAX_DRIVER_BYTES = 32 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const MAX_STDOUT_LINE_BYTES = 16 * 1024;
const MAX_RUN_MS = 10 * 60 * 1000;

async function hashDriver(path) {
  const info = statSync(path);
  if (!info.isFile() || info.size === 0 || info.size > MAX_DRIVER_BYTES) {
    throw new Error('Driver file size is outside the accepted range');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** A pin is required because executable file mode alone does not establish trust. */
export async function assessNativePrerequisites({
  environment = inspectEnvironment(),
  host = macWitnessSupport(),
  env = process.env,
  fingerprint = hashDriver,
} = {}) {
  const blockers = [...environment.blockers, ...host.blockers];
  const expectedHash = env.KORY_SKILL_EVAL_TAURI_REVIEWED_DRIVER_SHA256?.trim();
  if (!/^[0-9a-f]{64}$/.test(expectedHash ?? '')) {
    blockers.push('SHA-256 pin of independently reviewed native driver missing or malformed');
  }
  let actualHash;
  if (environment.driver?.available && /^[0-9a-f]{64}$/.test(expectedHash ?? '')) {
    try {
      actualHash = await fingerprint(environment.driver.path);
      if (actualHash !== expectedHash)
        blockers.push('Native driver differs from reviewed SHA-256 pin');
    } catch (error) {
      blockers.push(`Unable to fingerprint native driver: ${error.message}`);
    }
  }
  return {
    status: blockers.length ? 'blocked' : 'ready-to-attempt',
    nativeDeviceVerified: false,
    nativeWindowObserved: false,
    blockers,
    driverSha256: actualHash ?? null,
    environment,
  };
}

/**
 * The driver must stop at each checkpoint and await one JSON acknowledgement.
 * OS observations are collected by this process; the driver's own log is never
 * used as evidence of a live window, executable identity, or compositor image.
 */
export class NativeCheckpointVerifier {
  constructor({
    challenge,
    runDir,
    examine = examinePackagedApp,
    observe = witnessMacWindow,
    alive = processAlive,
    inspect = inspectReceipt,
  }) {
    this.challenge = challenge;
    this.runDir = runDir;
    this.examine = examine;
    this.observe = observe;
    this.alive = alive;
    this.inspect = inspect;
    this.cursor = 0;
    this.packagedApp = null;
    this.first = null;
    this.second = null;
    this.finished = null;
  }

  async accept(message) {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      message.checkpoint !== CHECKPOINTS[this.cursor]
    ) {
      throw new Error(
        `Unexpected driver checkpoint; expected ${CHECKPOINTS[this.cursor] ?? 'end'}`,
      );
    }
    const kind = message.checkpoint;
    if (kind === 'packaged-launch' || kind === 'packaged-relaunch') {
      if (!Number.isSafeInteger(message.pid) || message.pid <= 1) {
        throw new Error('Driver supplied invalid native process ID');
      }
      const app = this.examine(message.executablePath, this.runDir);
      if (this.packagedApp && app.executablePath !== this.packagedApp.executablePath) {
        throw new Error('Packaged executable changed between launches');
      }
      if (this.first && message.pid === this.first.pid) {
        throw new Error('Relaunch must use a different native process ID');
      }
      const observation = await this.observe({
        pid: message.pid,
        packagedApp: app,
        runDir: this.runDir,
        captureName: kind === 'packaged-launch' ? 'launch.png' : 'relaunch.png',
      });
      if (
        observation.pid !== message.pid ||
        !observation.capturePath ||
        observation.source !== 'macos-system-events-and-screencapture'
      ) {
        throw new Error('Independent OS window observation incomplete');
      }
      const expectedCapture = join(
        this.runDir,
        kind === 'packaged-launch' ? 'launch.png' : 'relaunch.png',
      );
      if (observation.capturePath !== expectedCapture)
        throw new Error('Unexpected OS capture destination');
      this.packagedApp = app;
      if (kind === 'packaged-launch') this.first = observation;
      else this.second = observation;
    } else if (kind === 'app-quit') {
      if (message.pid !== this.first.pid || this.alive(this.first.pid)) {
        throw new Error('Original native process has not fully exited');
      }
    } else {
      // Exactly one receipt is permitted at a known location outside the repo.
      const receiptPath = join(this.runDir, 'receipt.json');
      if (message.receiptPath !== receiptPath || !isAbsolute(receiptPath)) {
        throw new Error('Driver completion must identify the isolated receipt path');
      }
      const entry = lstatSync(receiptPath);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.size <= 0 ||
        entry.size > MAX_RECEIPT_BYTES
      ) {
        throw new Error('Native receipt missing, unsafe, or too large');
      }
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      const verdict = this.inspect(receipt, {
        expectedChallenge: this.challenge,
        receiptPath,
      });
      if (verdict.classification !== 'structural-only') {
        throw new Error('Native driver receipt rejected: ' + verdict.issues.join('; '));
      }
      if (
        receipt.package?.executablePath !== this.packagedApp.executablePath ||
        receipt.capture?.path !== this.second.capturePath ||
        receipt.capture?.sha256 !== this.second.sha256
      ) {
        throw new Error('Driver receipt artifacts differ from independently witnessed run');
      }
      const event = (name) => receipt.nativeEvents.find((entry) => entry.kind === name);
      if (
        event('packaged-launch')?.pid !== this.first.pid ||
        event('app-quit')?.pid !== this.first.pid ||
        event('packaged-relaunch')?.pid !== this.second.pid
      ) {
        throw new Error('Driver receipt process IDs differ from witnessed processes');
      }
      this.finished = {
        status: 'native-window-observed',
        nativeWindowObserved: true,
        nativeDeviceVerified: false,
        scenarioQualified: false,
        receiptClassification: verdict.classification,
        independentObservations: [this.first, this.second],
        receiptPath,
        unresolved: [
          'Dialog, command-denial, and state-restoration outcomes are reported by the external driver; independent evaluator review remains required',
          'Screenshots need visual review; compositor capture alone does not prove displayed content',
        ],
      };
    }
    this.cursor++;
    return { checkpoint: kind, proceed: true, challenge: this.challenge };
  }

  get complete() {
    return this.cursor === CHECKPOINTS.length && this.finished !== null;
  }
}

export function limitedDriverEnvironment(env) {
  // Never forward application/API credentials or arbitrary KORY_*/CI secrets.
  const allow = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'CARGO_TARGET_DIR',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  return Object.fromEntries(
    allow.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name]]),
  );
}

/** Execute and acknowledge an external reviewed driver's live checkpoints. */
export function driveNativeDriver({
  driverPath,
  cliPath,
  runDir,
  challenge,
  verifier,
  env = process.env,
  timeoutMs = MAX_RUN_MS,
  spawnProcess = spawn,
}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnProcess(
      driverPath,
      [
        '--scenario',
        SCENARIO_ID,
        '--tauri-cli',
        cliPath,
        '--challenge',
        challenge,
        '--run-dir',
        runDir,
      ],
      {
        cwd: runDir,
        env: limitedDriverEnvironment(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: true,
      },
    );
    let buffer = '';
    let stderr = '';
    let failure = null;
    let queue = Promise.resolve();
    const killDriver = () => {
      try {
        if (Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already exited */
        }
      }
    };
    const fail = (error) => {
      if (failure) return;
      failure = error;
      killDriver();
    };
    const timeout = setTimeout(
      () => fail(new Error(`Native driver exceeded ${timeoutMs} ms`)),
      timeoutMs,
    );
    timeout.unref?.();
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk) => {
      if (failure) return;
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_STDOUT_LINE_BYTES) {
        fail(new Error('Native driver sent oversized/unframed stdout'));
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        queue = queue
          .then(async () => {
            if (failure) return;
            if (!line || Buffer.byteLength(line) > MAX_STDOUT_LINE_BYTES) {
              throw new Error('Driver must emit one bounded JSON object per line');
            }
            const acknowledgement = await verifier.accept(JSON.parse(line));
            child.stdin.write(JSON.stringify(acknowledgement) + '\n');
          })
          .catch(fail);
      }
    });
    child.on('error', fail);
    child.on('close', async (code, signal) => {
      clearTimeout(timeout);
      await queue;
      if (failure) return rejectRun(failure);
      if (code !== 0 || signal) {
        return rejectRun(
          new Error(`Native driver exited ${code ?? signal}: ${stderr.trim() || 'no stderr'}`),
        );
      }
      if (buffer.trim())
        return rejectRun(new Error('Native driver emitted an incomplete JSON line'));
      if (!verifier.complete)
        return rejectRun(
          new Error('Native driver exited without completing the live checkpoint protocol'),
        );
      resolveRun(verifier.finished);
    });
  });
}

export async function runNativeAttempt({ env = process.env } = {}) {
  const prereq = await assessNativePrerequisites({ env, environment: inspectEnvironment({ env }) });
  if (prereq.status === 'blocked') return { ...prereq, exitCode: 2 };
  const runDir = mkdtempSync(join(tmpdir(), 'kory-tauri-native-'));
  const challenge = randomBytes(32).toString('hex');
  const verifier = new NativeCheckpointVerifier({ challenge, runDir });
  try {
    const result = await driveNativeDriver({
      driverPath: prereq.environment.driver.path,
      cliPath: prereq.environment.cli.path,
      runDir,
      challenge,
      verifier,
      env,
    });
    return { ...result, runDir, driverSha256: prereq.driverSha256, exitCode: 3 };
  } catch (error) {
    return {
      status: 'native-attempt-failed',
      exitCode: 1,
      nativeDeviceVerified: false,
      nativeWindowObserved: Boolean(verifier.first),
      scenarioQualified: false,
      runDir,
      error: String(error.message),
    };
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.length !== 2) {
    process.stderr.write(
      'Usage: node native-run.mjs (configuration through KORY_SKILL_EVAL_TAURI_* variables)\n',
    );
    process.exitCode = 64;
  } else {
    const result = await runNativeAttempt();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.exitCode;
  }
}
