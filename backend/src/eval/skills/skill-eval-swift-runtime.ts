import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { canonicalizePath, hostOS, isMac } from '../../runtime/platform';
import { writeFixtureFile } from './skill-eval-fixture-helpers';

interface SwiftToolchain {
  developerDir?: string;
  sdkRoot?: string;
}

interface SwiftRun {
  passed: boolean;
  evidence: string;
}

interface SwiftReadiness {
  reasons: string[];
  evidence: string;
}

const callerToolchain = (): SwiftToolchain => ({
  developerDir: process.env.DEVELOPER_DIR,
  sdkRoot: process.env.SDKROOT,
});

function resolveDirectory(value: string, variable: 'DEVELOPER_DIR' | 'SDKROOT'): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value))
    throw new Error(`${variable} must be an absolute directory path without control characters`);
  let directory: string;
  try {
    directory = canonicalizePath(value);
    if (!statSync(directory).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`${variable} must name an existing directory`);
  }
  if (
    variable === 'SDKROOT' &&
    (!/^MacOSX.*\.sdk$/u.test(basename(directory)) ||
      !existsSync(join(directory, 'SDKSettings.json')))
  )
    throw new Error('SDKROOT must name a macOS SDK directory with SDKSettings.json');
  return directory;
}

function resolveToolchain(selection: SwiftToolchain): SwiftToolchain {
  if (!isMac()) throw new Error('Swift fixture runtime requires macOS with xcrun/Swift installed');
  // An explicit selection (including {}) overrides ambient SDKROOT. The
  // default callerToolchain() already supplies the caller's environment.
  const sdkRoot = selection.sdkRoot;
  return {
    ...(selection.developerDir !== undefined
      ? { developerDir: resolveDirectory(selection.developerDir, 'DEVELOPER_DIR') }
      : {}),
    ...(sdkRoot !== undefined ? { sdkRoot: resolveDirectory(sdkRoot, 'SDKROOT') } : {}),
  };
}

const environment = (root: string): NodeJS.ProcessEnv => ({
  PATH: '/usr/bin:/bin',
  HOME: root,
  TMPDIR: root,
  TEMP: root,
  TMP: root,
  LANG: 'C',
  LC_ALL: 'C',
});

/** The readiness control and candidate harness use exactly the same compiler contract. */
export function runSwiftProgram(
  root: string,
  sources: string[],
  binary: string,
  receipt: string,
  selection: SwiftToolchain = callerToolchain(),
): SwiftRun {
  let toolchain: SwiftToolchain;
  try {
    toolchain = resolveToolchain(selection);
  } catch (error) {
    return { passed: false, evidence: `Swift runtime unavailable: ${String(error)}` };
  }
  const compile = spawnSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-parse-as-library',
      '-strict-concurrency=complete',
      '-warnings-as-errors',
      ...(toolchain.sdkRoot !== undefined ? ['-sdk', toolchain.sdkRoot] : []),
      ...sources,
      '-o',
      binary,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      // Cold SDK module compilation takes 20–40 seconds on the Mac CLT host.
      timeout: 90_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1_000_000,
      env: {
        ...environment(root),
        ...(toolchain.developerDir !== undefined ? { DEVELOPER_DIR: toolchain.developerDir } : {}),
      },
    },
  );
  if (compile.error || compile.signal || compile.status !== 0)
    return {
      passed: false,
      evidence: `swiftc failed: ${compile.error?.message ?? compile.signal ?? compile.status}\n${`${compile.stdout ?? ''}\n${compile.stderr ?? ''}`.slice(-6000)}`,
    };
  const execute = spawnSync(binary, [], {
    cwd: root,
    encoding: 'utf8',
    timeout: 12_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1_000_000,
    env: environment(root),
  });
  const received = (execute.stdout ?? '').split(/\r?\n/u).includes(receipt);
  return {
    passed: !execute.error && !execute.signal && execute.status === 0 && received,
    evidence: `swiftc passed\nSwift runtime: ${execute.error?.message ?? execute.signal ?? execute.status}\n${`${execute.stdout ?? ''}\n${execute.stderr ?? ''}`.slice(-6000)}${received ? '' : `\nMissing runtime receipt: ${receipt}`}`,
  };
}

const preflights = new Map<string, SwiftReadiness>();

/** A version banner cannot prove SDK compatibility, strict concurrency or executable startup. */
export function swiftRuntimeReadiness(
  selection: SwiftToolchain = callerToolchain(),
): SwiftReadiness {
  let toolchain: SwiftToolchain;
  try {
    toolchain = resolveToolchain(selection);
  } catch (error) {
    const evidence = `Swift runtime unavailable: ${String(error)}`;
    return { reasons: [evidence], evidence };
  }
  const key = JSON.stringify([hostOS(), process.arch, toolchain.developerDir, toolchain.sdkRoot]);
  const cached = preflights.get(key);
  if (cached) return cached;
  const root = mkdtempSync(join(tmpdir(), 'kory-swift-preflight-'));
  try {
    writeFixtureFile(
      root,
      'Probe.swift',
      `import Foundation
actor Probe { func value() -> Int { 42 } }
@main struct Ready {
  static func main() async throws {
    try await Task.sleep(for: .milliseconds(1))
    let value = await Probe().value()
    guard value == 42, !ProcessInfo.processInfo.processName.isEmpty else { fatalError("Swift probe failed") }
    print("KORY_SWIFT_READY")
  }
}
`,
    );
    const run = runSwiftProgram(
      root,
      [join(root, 'Probe.swift')],
      join(root, 'probe'),
      'KORY_SWIFT_READY',
      toolchain,
    );
    const result = {
      reasons: run.passed ? [] : [`Swift runtime unavailable: ${run.evidence}`],
      evidence: run.evidence,
    };
    // Cache failures too: catalog reads must not keep recompiling a broken default SDK.
    preflights.set(key, result);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
