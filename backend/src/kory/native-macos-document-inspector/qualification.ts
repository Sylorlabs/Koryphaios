import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMac } from '../../runtime/platform';
import {
  assessNativeRedGreen,
  inspectNativeEvidence,
  nativeInspectorMatrix,
  nativeInspectorResizeMatrix,
  stateId,
  type InspectorState,
  type NativeCapture,
  type NativeImageObservation,
  type NativeObservation,
} from './evidence';

const FIXTURE = 'DocumentInspector.swift';
const OBSERVER = 'InspectorObserver.swift';
const PIXELS = 'PixelObserver.swift';
const DEVELOPER = '/Applications/Xcode-beta.app/Contents/Developer';
const APP_TITLE = 'Kory Native Document Inspector';
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

export interface NativeQualificationOptions {
  outputDirectory?: string;
  /** Must be externally approved, with a trusted out-of-band digest. */
  referencePath?: string;
  referenceSha256?: string;
}

export interface NativeQualificationReceipt {
  evidenceVersion: 1;
  nativeRuntime: 'AppKit/WindowServer/Accessibility';
  xcodeVersion: string;
  sources: Record<string, string>;
  /** Digest the exact on-disk binaries produced for this qualification run. */
  binarySha256: Record<string, string>;
  outputDirectory: string;
  capturedStates: number;
  captures: NativeCapture[];
  faultCapture: NativeCapture | null;
  runtimeFailures: string[];
  redGreenVerified: boolean;
  referenceAudit: {
    status: 'unavailable' | 'invalid' | 'compared';
    reason: string;
    meanPixelDifference: number | null;
  };
  pairedEvaluation: 'not-executed';
  promoted: false;
}

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function checkedSource(file: string): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) {
    throw new Error(`Evaluator source is missing, linked, or oversized: ${file}`);
  }
  return path;
}

function command(binary: string, args: string[], timeout = 20_000): string {
  const result = spawnSync(binary, args, {
    env: { ...process.env, DEVELOPER_DIR: DEVELOPER },
    encoding: 'utf8',
    timeout,
    maxBuffer: 4_000_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${binary} failed (exit=${result.status ?? 'unknown'}): ${String(
        result.error?.message ?? result.stderr ?? result.stdout,
      ).slice(-1000)}`,
    );
  }
  return result.stdout;
}

function compileNative(source: string, output: string, extra: string[] = []): void {
  command(
    '/usr/bin/xcrun',
    ['swiftc', '-swift-version', '5', '-O', ...extra, checkedSource(source), '-o', output],
    110_000,
  );
}

function compileApp(output: string, fault: boolean): string {
  const contents = join(output, `${fault ? 'Fault' : 'Healthy'}Inspector.app`, 'Contents');
  const binaryDir = join(contents, 'MacOS');
  mkdirSync(binaryDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>DocumentInspector</string>
  <key>CFBundleIdentifier</key><string>dev.koryphaios.inspector.fixture.${fault ? 'fault' : 'healthy'}</string>
  <key>CFBundleName</key><string>${APP_TITLE}</string>
   <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
   <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
  );
  const appBinary = join(binaryDir, 'DocumentInspector');
  compileNative(FIXTURE, appBinary, fault ? ['-D', 'INSPECTOR_FAULT'] : []);
  command('/usr/bin/plutil', ['-lint', join(contents, 'Info.plist')]);
  return appBinary;
}

export interface NativeInspectorBuildReceipt {
  xcodeVersion: string;
  sourceSha256: Record<string, string>;
  binarySha256: Record<string, string>;
  binaries: { healthy: string; fault: string; observer: string; pixels: string };
}

/** Compile and package both real AppKit apps and separate native observers. */
export function buildNativeInspectorBinaries(output: string): NativeInspectorBuildReceipt {
  if (!isMac()) throw new Error('Native inspector build requires macOS');
  const xcodeVersion = command('/usr/bin/xcrun', ['xcodebuild', '-version']).trim();
  if (!/^Xcode 27\.0\b/u.test(xcodeVersion))
    throw new Error(`Expected Xcode 27 beta, got: ${xcodeVersion}`);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const observer = join(output, 'native-observer');
  const pixels = join(output, 'native-pixel-observer');
  compileNative(OBSERVER, observer);
  compileNative(PIXELS, pixels);
  const healthy = compileApp(output, false);
  const fault = compileApp(output, true);
  const binaries = { healthy, fault, observer, pixels };
  return {
    xcodeVersion,
    sourceSha256: Object.fromEntries(
      [FIXTURE, OBSERVER, PIXELS].map((source) => [
        source,
        digest(readFileSync(checkedSource(source))),
      ]),
    ),
    binarySha256: Object.fromEntries(
      Object.entries(binaries).map(([name, path]) => [name, digest(readFileSync(path))]),
    ),
    binaries,
  };
}

class NativeApplication {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ready = new Set<number>();
  private readonly waiters = new Map<number, (error?: Error) => void>();
  private stdout = '';
  private lastFrame = '';
  private stderr = '';
  private exited = false;

  constructor(executable: string) {
    this.child = spawn(executable, [], {
      env: { ...process.env, DEVELOPER_DIR: DEVELOPER },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdout += chunk;
      let end = this.stdout.indexOf('\n');
      while (end >= 0) {
        const line = this.stdout.slice(0, end).trim();
        this.stdout = this.stdout.slice(end + 1);
        if (line.startsWith('FRAME ')) this.lastFrame = line.slice(0, 360);
        const match = /^READY (\d+)$/u.exec(line);
        if (match) {
          const revision = Number(match[1]);
          this.ready.add(revision);
          this.waiters.get(revision)?.();
        }
        end = this.stdout.indexOf('\n');
      }
      if (this.stdout.length > 16_000) this.stdout = this.stdout.slice(-16_000);
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-24_000);
    });
    this.child.once('exit', () => {
      this.exited = true;
      for (const [, resolve] of this.waiters)
        resolve(new Error(`Native fixture exited: ${this.stderr.slice(-800)}`));
    });
    this.child.once('error', (error) => {
      this.exited = true;
      for (const [, resolve] of this.waiters) resolve(error);
    });
  }

  get pid(): number {
    if (!this.child.pid) throw new Error('Native fixture process did not launch');
    return this.child.pid;
  }

  get layoutDiagnostics(): string[] {
    return this.stderr
      .split('\n')
      .filter((line) =>
        /Unable to simultaneously satisfy constraints|NSLayoutConstraint.*conflict/u.test(line),
      )
      .slice(0, 12)
      .map((line) => `Native AppKit Auto Layout warning: ${line.slice(0, 500)}`);
  }

  get latestFrameDiagnostic(): string {
    return this.lastFrame || 'Native fixture did not report a frame';
  }

  async wait(revision: number): Promise<void> {
    if (this.ready.has(revision)) return;
    if (this.exited) throw new Error(`Native fixture already exited: ${this.stderr.slice(-800)}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(revision);
        reject(
          new Error(`Timed out waiting for native READY ${revision}: ${this.stderr.slice(-800)}`),
        );
      }, 20_000);
      this.waiters.set(revision, (error) => {
        clearTimeout(timer);
        this.waiters.delete(revision);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async apply(state: InspectorState): Promise<void> {
    if (this.exited) throw new Error('Native fixture exited before state update');
    this.child.stdin.write(`${JSON.stringify(state)}\n`);
    await this.wait(state.revision);
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2_000);
      this.child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

/** Explain failed native stabilization using both observations, including vanished AX controls. */
export function describeNativeObservationChange(
  previous: NativeObservation,
  current: NativeObservation,
): {
  previousWindow: NativeObservation['window'];
  currentWindow: NativeObservation['window'];
  previousWindowNumber: number;
  currentWindowNumber: number;
  changedElements: string[];
  removedElements: string[];
  addedElements: string[];
  elementOrderChanged: boolean;
} {
  const before = new Map(
    previous.elements.map((element) => [element.identifier, JSON.stringify(element)]),
  );
  const after = new Map(
    current.elements.map((element) => [element.identifier, JSON.stringify(element)]),
  );
  return {
    previousWindow: previous.window,
    currentWindow: current.window,
    previousWindowNumber: previous.windowNumber,
    currentWindowNumber: current.windowNumber,
    changedElements: current.elements
      .filter(
        (element) =>
          before.has(element.identifier) &&
          before.get(element.identifier) !== JSON.stringify(element),
      )
      .map((element) => element.identifier),
    removedElements: previous.elements
      .filter((element) => !after.has(element.identifier))
      .map((element) => element.identifier),
    addedElements: current.elements
      .filter((element) => !before.has(element.identifier))
      .map((element) => element.identifier),
    elementOrderChanged: previous.elements.some(
      (element, index) => element.identifier !== current.elements[index]?.identifier,
    ),
  };
}

async function stabilizeObservation(
  app: NativeApplication,
  observer: string,
): Promise<{ observation: NativeObservation; samples: number }> {
  // AppKit can finish reporting READY before WindowServer and AX settle after
  // a dense resize. Preserve two identical independent samples, 150ms apart.
  const maxSamples = 16;
  let previous: NativeObservation | null = null;
  let previousFingerprint = '';
  let lastDiagnostic = '';
  const summarizeUnavailableObservation = (inspected: string): string => {
    try {
      const observation = JSON.parse(inspected) as Partial<NativeObservation>;
      return JSON.stringify({
        pid: observation.pid ?? null,
        windowNumber: observation.windowNumber ?? null,
        window: observation.window ?? null,
        accessibilityTrusted: observation.accessibilityTrusted ?? null,
        accessibilityWindowFound: observation.accessibilityWindowFound ?? null,
        elementCount: observation.elements?.length ?? 0,
        errors: observation.errors?.slice(0, 4) ?? [],
      });
    } catch {
      return inspected.slice(0, 1300);
    }
  };
  for (let sample = 1; sample <= maxSamples; sample++) {
    const inspected = command(observer, [String(app.pid)], 12_000);
    const observation = JSON.parse(inspected) as NativeObservation;
    if (observation.errors.some((message) => message.includes('Native macOS console session is locked'))) {
      throw new Error(`Native interactive session unavailable: ${observation.errors.join('; ')}`);
    }
    if (
      observation.pid !== app.pid ||
      observation.windowNumber <= 0 ||
      !observation.window ||
      !observation.accessibilityTrusted ||
      !observation.accessibilityWindowFound ||
      observation.errors.length
    ) {
      lastDiagnostic = `sample ${sample}/${maxSamples}: independent observation unavailable: ${summarizeUnavailableObservation(inspected)}`;
      previous = null;
      previousFingerprint = '';
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      continue;
    }
    // WindowServer and AX come from the separate observer process. Two matching
    // snapshots, 150ms apart, are required before taking an image of the UI.
    const fingerprint = JSON.stringify({
      window: observation.window,
      windowNumber: observation.windowNumber,
      elements: observation.elements,
    });
    if (previous && previousFingerprint === fingerprint) return { observation, samples: sample };
    if (previous) {
      lastDiagnostic = `sample ${sample}/${maxSamples}: independent observation changed: ${JSON.stringify(describeNativeObservationChange(previous, observation)).slice(0, 1300)}`;
    } else {
      lastDiagnostic = `sample ${sample}/${maxSamples}: waiting for second identical native observation`;
    }
    previous = observation;
    previousFingerprint = fingerprint;
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Native WindowServer/Accessibility layout unavailable or unstable for PID ${app.pid}: ${lastDiagnostic}; fixture: ${app.latestFrameDiagnostic}`,
  );
}

async function capture(
  app: NativeApplication,
  state: InspectorState,
  suffix: string,
  output: string,
  observer: string,
  pixels: string,
): Promise<NativeCapture> {
  const { observation, samples } = await stabilizeObservation(app, observer);
  const screenshot = join(output, 'captures', `${suffix}.png`);
  // Exclude the compositor's drop shadow so native screenshot bounds describe
  // the inspected window, including its actual title bar and native materials.
  command(
    '/usr/sbin/screencapture',
    ['-x', '-o', '-l', String(observation.windowNumber), '-t', 'png', screenshot],
    15_000,
  );
  if (!existsSync(screenshot)) throw new Error(`Native window screenshot missing: ${suffix}`);
  const contents = readFileSync(screenshot);
  if (contents.length < 1024 || !contents.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error(`Native window capture is not a valid PNG: ${suffix}`);
  }
  const image = JSON.parse(command(pixels, [screenshot], 12_000)) as NativeImageObservation;
  return {
    state,
    captureId: suffix,
    screenshot,
    sha256: digest(contents),
    observation,
    image,
    stabilizationSamples: samples,
    failures: inspectNativeEvidence(state, observation, image),
  };
}

function referenceAudit(
  options: NativeQualificationOptions,
  base: NativeCapture | undefined,
  pixels: string,
): NativeQualificationReceipt['referenceAudit'] {
  if (!options.referencePath || !options.referenceSha256) {
    return {
      status: 'unavailable',
      reason:
        'An independently approved 900x700/en/light/normal/standard reference and trusted digest were not provided.',
      meanPixelDifference: null,
    };
  }
  if (!base)
    return {
      status: 'invalid',
      reason: 'Matching-condition capture absent.',
      meanPixelDifference: null,
    };
  const reference = readFileSync(options.referencePath);
  if (
    digest(reference) !== options.referenceSha256 ||
    !reference.subarray(0, 8).equals(PNG_MAGIC)
  ) {
    return {
      status: 'invalid',
      reason: 'Reference PNG does not match the trusted digest.',
      meanPixelDifference: null,
    };
  }
  try {
    const details = JSON.parse(
      command(pixels, [base.screenshot, options.referencePath]),
    ) as NativeImageObservation;
    return {
      status: 'compared',
      reason:
        'Matching-size native PNG pixels measured. Independent visual approval of differences is still required.',
      meanPixelDifference: details.meanReferenceDifference,
    };
  } catch (error) {
    return { status: 'invalid', reason: String(error).slice(0, 600), meanPixelDifference: null };
  }
}

/**
 * Qualification tool, intentionally not yet a registered evaluator. Running
 * candidate/paired promotion requires independent approved-reference provenance
 * and a real native red/green pass. This function never promotes a gate.
 */
export async function qualifyNativeMacOSInspector(
  options: NativeQualificationOptions = {},
): Promise<NativeQualificationReceipt> {
  if (!isMac()) throw new Error('Native macOS qualification requires an actual macOS host');
  const output = options.outputDirectory ?? mkdtempSync(join(tmpdir(), 'kory-native-inspector-'));
  mkdirSync(join(output, 'captures'), { recursive: true, mode: 0o700 });
  const sources = Object.fromEntries(
    [FIXTURE, OBSERVER, PIXELS].map((source) => [
      source,
      digest(readFileSync(checkedSource(source))),
    ]),
  );
  const receipt: NativeQualificationReceipt = {
    evidenceVersion: 1,
    nativeRuntime: 'AppKit/WindowServer/Accessibility',
    xcodeVersion: '',
    sources,
    binarySha256: {},
    outputDirectory: output,
    capturedStates: 0,
    captures: [],
    faultCapture: null,
    runtimeFailures: [],
    redGreenVerified: false,
    referenceAudit: {
      status: 'unavailable',
      reason: 'Reference audit has not run.',
      meanPixelDifference: null,
    },
    pairedEvaluation: 'not-executed',
    promoted: false,
  };
  try {
    const build = buildNativeInspectorBinaries(output);
    receipt.xcodeVersion = build.xcodeVersion;
    receipt.binarySha256 = build.binarySha256;
    const { healthy, fault: broken, observer, pixels } = build.binaries;

    const app = new NativeApplication(healthy);
    try {
      await app.wait(0);
      for (const state of [...nativeInspectorMatrix(), ...nativeInspectorResizeMatrix()]) {
        await app.apply(state);
        const suffix =
          state.revision > 72 ? `resize-${state.revision}-${stateId(state)}` : stateId(state);
        const result = await capture(app, state, suffix, output, observer, pixels);
        receipt.captures.push(result);
      }
    } finally {
      // Include genuine constraint warnings even when the sequence aborted early.
      receipt.runtimeFailures.push(...app.layoutDiagnostics);
      await app.close();
    }
    receipt.capturedStates = receipt.captures.length;

    const fault = new NativeApplication(broken);
    try {
      await fault.wait(0);
      const state: InspectorState = {
        revision: 1,
        width: 620,
        height: 520,
        appearance: 'dark',
        language: 'de',
        content: 'max',
        textSize: 'large',
      };
      await fault.apply(state);
      receipt.faultCapture = await capture(
        fault,
        state,
        `fault-${stateId(state)}`,
        output,
        observer,
        pixels,
      );
    } finally {
      await fault.close();
    }
    const assessment = assessNativeRedGreen(receipt.captures, receipt.faultCapture);
    receipt.runtimeFailures.push(...assessment.failures);
    receipt.redGreenVerified =
      assessment.red && assessment.green && receipt.runtimeFailures.length === 0;
    receipt.referenceAudit = referenceAudit(
      options,
      receipt.captures.find((item) => item.captureId === '900x700-light-en-normal-standard'),
      pixels,
    );
  } catch (error) {
    receipt.runtimeFailures.push(
      `Native qualification failed closed: ${String(error).slice(0, 1400)}`,
    );
    receipt.referenceAudit = {
      status: 'unavailable',
      reason: 'Native capture sequence incomplete.',
      meanPixelDifference: null,
    };
  } finally {
    receipt.capturedStates = receipt.captures.length;
    writeFileSync(join(output, 'qualification.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return receipt;
}

if (import.meta.main) {
  const opts: NativeQualificationOptions = {};
  const args = process.argv.slice(2);
  let buildOnly = false;
  for (let i = 0; i < args.length;) {
    if (args[i] === '--build-only') {
      buildOnly = true;
      i += 1;
      continue;
    }
    if (!args[i + 1]) throw new Error(`Missing value for native inspector argument: ${args[i]}`);
    if (args[i] === '--output') opts.outputDirectory = args[i + 1];
    else if (args[i] === '--reference') opts.referencePath = args[i + 1];
    else if (args[i] === '--reference-sha256') opts.referenceSha256 = args[i + 1];
    else throw new Error(`Unknown native qualification argument: ${args[i]}`);
    i += 2;
  }
  if (buildOnly) {
    if (opts.referencePath || opts.referenceSha256)
      throw new Error('Reference auditing requires native screenshot qualification');
    const output =
      opts.outputDirectory ?? mkdtempSync(join(tmpdir(), 'kory-native-inspector-build-'));
    const build = buildNativeInspectorBinaries(output);
    writeFileSync(join(output, 'build.json'), `${JSON.stringify(build, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        { outputDirectory: output, ...build, runtimeCapture: 'not-executed', promotion: 'blocked' },
        null,
        2,
      ),
    );
  } else {
    const result = await qualifyNativeMacOSInspector(opts);
    console.log(
      JSON.stringify(
        {
          outputDirectory: result.outputDirectory,
          capturedStates: result.capturedStates,
          redGreenVerified: result.redGreenVerified,
          referenceAudit: result.referenceAudit,
          runtimeFailures: result.runtimeFailures.slice(0, 15),
          promotion: 'blocked',
        },
        null,
        2,
      ),
    );
    if (!result.redGreenVerified || result.referenceAudit.status !== 'compared')
      process.exitCode = 1;
  }
}
