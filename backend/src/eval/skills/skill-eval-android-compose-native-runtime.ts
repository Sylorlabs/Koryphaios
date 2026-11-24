import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findExecutableOnPath } from '../../runtime/platform';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { fixtureTextEquals, readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';

const EDIT = 'android-compose-full-task-1-individual';
const FEED = 'android-compose-full-task-2-individual';
type AndroidScenario = typeof EDIT | typeof FEED;
export const ANDROID_COMPOSE_NATIVE_SCENARIOS = { edit: EDIT, feed: FEED } as const;

const BASE = join(import.meta.dir, 'fixtures/android-compose-v5');
const CONTRACT = '.kory-eval/android-native-contract.json';
const PACKAGE = 'com.kory.eval';
const APP_SOURCE = 'app/src/main/java/com/kory/eval';
const TEST_SOURCE = 'app/src/androidTest/java/com/kory/eval';
const SOURCE_FILES = ['EditFeature.kt', 'FeedFeature.kt'] as const;
const FIXED_FILES = [
  'settings.gradle.kts',
  'build.gradle.kts',
  'gradle.properties',
  'app/build.gradle.kts',
  'app/src/main/AndroidManifest.xml',
  APP_SOURCE + '/MainActivity.kt',
  APP_SOURCE + '/EvaluationState.kt',
  'README.md',
] as const;

const PHASES = {
  [EDIT]: [
    'primeOfflineAndRotate',
    'resumeAfterProcessDeathAndRetry',
    'persistedCommitAcrossSecondProcessDeath',
  ],
  [FEED]: ['prependRetryNavigationFocusAndFont'],
} as const;

const MAX_KOTLIN_FILES = 24;
const MAX_KOTLIN_BYTES = 1_000_000;
const MAX_COMMAND_OUTPUT = 3_000_000;
const CAPTURE_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface AndroidNativeCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface AndroidNativeResult {
  passed: boolean;
  integrityFailure: boolean;
  checks: AndroidNativeCheck[];
  blockers: string[];
  deviceSerial: string | null;
  evidence: string[];
  /** An actual native build + instrumented Android runtime, never a component simulation. */
  proof: 'native-device' | 'unavailable';
  screenshotSha256: string | null;
  limitations: string[];
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface ReadyTools {
  gradle: string;
  adb: string;
  sdk: string;
  javaHome?: string;
  serial: string;
  emulator: boolean;
}

function textCommand(
  binary: string,
  args: string[],
  cwd?: string,
  timeout = 12_000,
  extraEnv: Record<string, string | undefined> = {},
): CommandResult {
  const result = spawnSync(binary, args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_COMMAND_OUTPUT,
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  return {
    code: result.status,
    stdout: String(result.stdout ?? '').slice(-MAX_COMMAND_OUTPUT),
    stderr: String(result.stderr ?? result.error?.message ?? '').slice(-2000),
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

function concise(result: CommandResult): string {
  return (result.stderr.trim() || result.stdout.trim() || 'no output').slice(-700);
}

function regular(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Refuse shell-script shims posing as an installed adb or emulator. */
function nativeBinary(path: string): boolean {
  if (!regular(path)) return false;
  try {
    const first = readFileSync(path).subarray(0, 4).toString('hex');
    // ELF, Mach-O (both endian variants), and Windows PE.
    return (
      ['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(
        first,
      ) || first.startsWith('4d5a')
    );
  } catch {
    return false;
  }
}

function toolPaths(): { sdk: string; adb: string; gradle: string; javaHome?: string } {
  const configuredSdk =
    process.env.KORY_SKILL_EVAL_ANDROID_SDK_ROOT ||
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT;
  // SDK discovery belongs to the caller's environment; do not guess an
  // OS-specific path or modify the SDK owned by another installer.
  const sdk = configuredSdk ? resolve(configuredSdk) : '';
  return {
    sdk,
    adb: sdk ? join(sdk, 'platform-tools', 'adb') : '',
    gradle:
      process.env.KORY_SKILL_EVAL_ANDROID_GRADLE || findExecutableOnPath('gradle') || 'gradle',
    javaHome: process.env.KORY_SKILL_EVAL_ANDROID_JAVA_HOME || process.env.JAVA_HOME,
  };
}

/** The emulator console response must identify exactly the requested disposable AVD. */
export function androidEmulatorAvdMatches(receipt: string, expected: string): boolean {
  const lines = receipt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return expected.length > 0 && lines.length === 2 && lines[0] === expected && lines[1] === 'OK';
}

function inspectReadiness(): { blockers: string[]; tools: ReadyTools | null } {
  const blockers: string[] = [];
  const paths = toolPaths();
  if (!paths.sdk)
    blockers.push(
      'Android SDK root not configured: set KORY_SKILL_EVAL_ANDROID_SDK_ROOT or ANDROID_HOME',
    );
  const java = paths.javaHome ? join(paths.javaHome, 'bin', 'java') : 'java';
  const javaVersion = textCommand(java, ['-version'], undefined, 6_000);
  if (
    javaVersion.code !== 0 ||
    !/\bversion "?(?:1[7-9]|2[0-7])(?:\.|")/u.test(javaVersion.stderr + javaVersion.stdout)
  ) {
    blockers.push('JDK 17-27 unavailable: ' + concise(javaVersion));
  }
  if (
    paths.sdk &&
    !regular(join(paths.sdk, 'platforms/android-37.0/android.jar')) &&
    !regular(join(paths.sdk, 'platforms/android-37/android.jar'))
  ) {
    blockers.push('Android API 37 platform is unavailable under ' + paths.sdk);
  }
  if (paths.sdk && !regular(join(paths.sdk, 'build-tools/36.0.0/aapt2'))) {
    blockers.push('Android build-tools 36.0.0 unavailable under ' + paths.sdk);
  }
  const requiredAvd = process.env.KORY_SKILL_EVAL_ANDROID_AVD_NAME?.trim();
  if (
    requiredAvd &&
    paths.sdk &&
    !regular(
      join(
        paths.sdk,
        'system-images/android-37.0/google_apis_playstore/arm64-v8a/source.properties',
      ),
    )
  ) {
    blockers.push(
      'Required Android API 37 Google Play arm64 system image is unavailable under ' +
        paths.sdk +
        '; install it only after reviewing the sdkmanager license prompt',
    );
  }
  const gradle = textCommand(paths.gradle, ['--version'], undefined, 10_000, {
    JAVA_HOME: paths.javaHome,
  });
  if (gradle.code !== 0 || !/\bGradle 9\.6(?:\.0)?\b/u.test(gradle.stdout)) {
    blockers.push('Gradle 9.6.0 unavailable: ' + concise(gradle));
  }
  if (!paths.adb || !nativeBinary(paths.adb)) {
    blockers.push('A real Android platform-tools adb binary is unavailable at ' + paths.adb);
    return { blockers, tools: null };
  }
  const adbVersion = textCommand(paths.adb, ['version']);
  if (
    adbVersion.code !== 0 ||
    !/Android Debug Bridge version \d+\.\d+\.\d+/u.test(adbVersion.stdout)
  ) {
    blockers.push('Installed adb failed its native version probe: ' + concise(adbVersion));
    return { blockers, tools: null };
  }

  const devices = textCommand(paths.adb, ['devices', '-l'], undefined, 10_000);
  if (devices.code !== 0) {
    blockers.push('adb devices failed: ' + concise(devices));
    return { blockers, tools: null };
  }
  const online = [...devices.stdout.matchAll(/^([^\s]+)\s+device(?:\s|$)/gmu)].map((m) => m[1]!);
  const requested = process.env.KORY_SKILL_EVAL_ANDROID_SERIAL?.trim();
  const serial = requested
    ? online.includes(requested)
      ? requested
      : null
    : online.length === 1
      ? online[0]!
      : null;
  if (!serial) {
    blockers.push(
      requested
        ? 'Requested Android device is not connected and authorized: ' + requested
        : 'Exactly one booted Android device is required (or set KORY_SKILL_EVAL_ANDROID_SERIAL): ' +
            (online.join(', ') || 'none'),
    );
    return { blockers, tools: null };
  }
  const shell = (args: string[]) =>
    textCommand(paths.adb, ['-s', serial, 'shell', ...args], undefined, 10_000);
  const boot = shell(['getprop', 'sys.boot_completed']);
  if (boot.code !== 0 || boot.stdout.trim() !== '1')
    blockers.push('Android device is not fully booted: ' + concise(boot));
  const api = shell(['getprop', 'ro.build.version.sdk']);
  if (api.code !== 0 || !/^\d+$/u.test(api.stdout.trim()) || Number(api.stdout.trim()) < 26)
    blockers.push('Android device must run API >= 26: ' + concise(api));
  const qemu = shell(['getprop', 'ro.kernel.qemu']);
  const emulator = qemu.code === 0 && qemu.stdout.trim() === '1';
  if (emulator) {
    const binary = join(paths.sdk, 'emulator', 'emulator');
    if (!nativeBinary(binary)) blockers.push('Android emulator binary unavailable at ' + binary);
    if (requiredAvd) {
      const identity = textCommand(paths.adb, ['-s', serial, 'emu', 'avd', 'name']);
      if (
        identity.code !== 0 ||
        identity.timedOut ||
        !androidEmulatorAvdMatches(identity.stdout, requiredAvd)
      ) {
        blockers.push(
          'Selected Android emulator is not the required dedicated AVD ' +
            requiredAvd +
            ': ' +
            concise(identity),
        );
      }
    }
  } else if (process.env.KORY_SKILL_EVAL_ANDROID_AVD_NAME?.trim()) {
    blockers.push('Named Android AVD guard requires an emulator, not a physical device');
  } else if (process.env.KORY_SKILL_EVAL_ANDROID_ALLOW_PHYSICAL !== '1') {
    blockers.push('Physical Android devices require KORY_SKILL_EVAL_ANDROID_ALLOW_PHYSICAL=1');
  }
  const packages = shell(['pm', 'list', 'packages', 'com.google.android.marvin.talkback']);
  if (
    packages.code !== 0 ||
    !packages.stdout.includes('package:com.google.android.marvin.talkback')
  )
    blockers.push('TalkBack package is missing on the selected Android device');
  const enabled = shell(['settings', 'get', 'secure', 'enabled_accessibility_services']);
  const access = shell(['settings', 'get', 'secure', 'accessibility_enabled']);
  if (
    enabled.code !== 0 ||
    !enabled.stdout.toLowerCase().includes('com.google.android.marvin.talkback') ||
    access.code !== 0 ||
    access.stdout.trim() !== '1'
  )
    blockers.push('TalkBack accessibility service is not enabled on the Android device');
  if (!emulator && process.env.KORY_SKILL_EVAL_ANDROID_ALLOW_DEVICE_SETTINGS !== '1')
    blockers.push(
      'Physical device font scale changes require KORY_SKILL_EVAL_ANDROID_ALLOW_DEVICE_SETTINGS=1',
    );
  return {
    blockers,
    tools: blockers.length ? null : { ...paths, serial, emulator },
  };
}

/** This reports blockers only. It never claims instrumentation was executed. */
export function androidComposeNativeReadiness(scenarioId: AndroidScenario): string[] {
  if (scenarioId !== EDIT && scenarioId !== FEED) return ['Unknown Android Compose scenario'];
  return inspectReadiness().blockers;
}

function fixedContent(relativePath: string, scenarioId: AndroidScenario): string {
  const source = readFileSync(join(BASE, relativePath), 'utf8');
  return relativePath === 'app/build.gradle.kts'
    ? source.replace('__SCENARIO__', scenarioId === EDIT ? 'edit' : 'feed')
    : source;
}

function contractContent(scenarioId: AndroidScenario): string {
  return (
    JSON.stringify(
      {
        scenarioId,
        skill: 'android-compose',
        kind: 'native-android-compose-v5',
        broader: 'native-interface',
        nearNeighbor: scenarioId === EDIT ? 'desktop-electron-tauri' : 'ios-swiftui',
        boundary: 'android-jetpack-compose-gradle-instrumentation',
        componentSimulationIsNativeEvidence: false,
        testOwnership: 'evaluator-injected-external-isolated-project',
        pairedBlindEvaluation: 'separate-orchestration-required',
      },
      null,
      2,
    ) + '\n'
  );
}

/** Useful for candidate authoring even when readiness is blocked; never starts a device. */
export function materializeAndroidComposeNativeFixture(
  root: string,
  scenarioId: AndroidScenario,
): void {
  if (scenarioId !== EDIT && scenarioId !== FEED)
    throw new Error('Unknown Android Compose scenario');
  for (const path of FIXED_FILES) writeFixtureFile(root, path, fixedContent(path, scenarioId));
  for (const source of SOURCE_FILES) {
    writeFixtureFile(
      root,
      APP_SOURCE + '/' + source,
      readFileSync(join(BASE, APP_SOURCE, source), 'utf8'),
    );
  }
  writeFixtureFile(root, CONTRACT, contractContent(scenarioId));
}

function candidateFiles(root: string): Array<{ relativePath: string; content: string }> {
  const dir = APP_SOURCE;
  const parts = dir.split('/');
  let current = resolve(root);
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe Kotlin source directory: ' + current);
  }
  const files: Array<{ relativePath: string; content: string }> = [];
  const collect = (relativeDir: string): void => {
    if (files.length > MAX_KOTLIN_FILES) throw new Error('Candidate Kotlin file count exceeded');
    for (const entry of readdirSync(join(root, relativeDir)).sort()) {
      const relativePath = relativeDir + '/' + entry;
      const stat = lstatSync(join(root, relativePath));
      if (stat.isSymbolicLink()) throw new Error('Symlink inside candidate Kotlin source');
      if (stat.isDirectory()) {
        if (relativePath.split('/').length > dir.split('/').length + 3)
          throw new Error('Excessive Kotlin source nesting');
        collect(relativePath);
      } else if (stat.isFile() && entry.endsWith('.kt')) {
        const content = readFixtureText(root, relativePath);
        files.push({ relativePath, content });
        if (
          files.length > MAX_KOTLIN_FILES ||
          files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) >
            MAX_KOTLIN_BYTES
        )
          throw new Error('Candidate Kotlin source budget exceeded');
      } else {
        throw new Error('Unexpected file in candidate Kotlin sources: ' + relativePath);
      }
    }
  };
  collect(dir);
  for (const source of SOURCE_FILES) {
    if (!files.some((file) => file.relativePath === dir + '/' + source))
      throw new Error('Missing candidate screen: ' + source);
  }
  return files;
}

function sourceIntegrity(root: string, scenarioId: AndroidScenario): string | null {
  if (!fixtureTextEquals(root, CONTRACT, contractContent(scenarioId)))
    return 'Android native fixture identity or boundary contract was altered';
  for (const path of FIXED_FILES) {
    if (!fixtureTextEquals(root, path, fixedContent(path, scenarioId)))
      return 'Immutable Android Gradle/manifest/evaluator support changed: ' + path;
  }
  return null;
}

function apkIsReal(path: string): boolean {
  if (!regular(path)) return false;
  const stat = lstatSync(path);
  if (stat.size < 8_192 || stat.size > 150_000_000) return false;
  return readFileSync(path)
    .subarray(0, 4)
    .equals(Buffer.from([80, 75, 3, 4]));
}

function adbCommand(tools: ReadyTools, args: string[], timeout = 20_000): CommandResult {
  return textCommand(tools.adb, ['-s', tools.serial, ...args], undefined, timeout);
}

function instrument(
  tools: ReadyTools,
  method: string,
  scenarioId: AndroidScenario,
): AndroidNativeCheck {
  const clazz = scenarioId === EDIT ? 'EditNativeTest' : 'FeedNativeTest';
  const testName = PACKAGE + '.' + clazz + '#' + method;
  const launch = adbCommand(tools, [
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    PACKAGE + '/.MainActivity',
  ]);
  if (launch.code !== 0 || launch.timedOut || !/^Status:\s*ok\s*$/mu.test(launch.stdout)) {
    return {
      id: 'android-activity-launch/' + method,
      passed: false,
      detail:
        'Native test failed: evaluator could not relaunch MainActivity after the isolated process boundary: ' +
        concise(launch),
    };
  }
  const result = adbCommand(
    tools,
    [
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      '-e',
      'class',
      testName,
      PACKAGE + '.test/androidx.test.runner.AndroidJUnitRunner',
    ],
    150_000,
  );
  const log = result.stdout;
  // AndroidJUnitRunner reports testcase status in addition to am instrument's
  // shell exit code. Never accept the latter or a generic "OK" alone.
  const testSeen = log
    .split(/\r?\n/u)
    .some((line) => line.trim() === 'INSTRUMENTATION_STATUS: test=' + method);
  const completed = [...log.matchAll(/^INSTRUMENTATION_STATUS_CODE:\s*(-?\d+)\s*$/gmu)].map(
    (match) => Number(match[1]),
  );
  const ok =
    result.code === 0 &&
    !result.timedOut &&
    testSeen &&
    completed.filter((value) => value === 0).length === 1 &&
    !completed.some((value) => value < 0) &&
    /INSTRUMENTATION_CODE:\s*-1\b/u.test(log) &&
    /OK \(1 test\)/u.test(log) &&
    !/FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/u.test(log);
  return {
    id: 'android-instrumentation/' + method,
    passed: ok,
    detail: ok
      ? 'AndroidJUnitRunner on ' +
        tools.serial +
        ': test finished with status 0 and one passed test'
      : 'Native test failed: ' + (log.slice(-1100).trim() || concise(result)),
  };
}

function forceStop(tools: ReadyTools, after: string): AndroidNativeCheck {
  const stop = adbCommand(tools, ['shell', 'am', 'force-stop', PACKAGE]);
  const pid = adbCommand(tools, ['shell', 'pidof', PACKAGE]);
  // pidof exits 1 when no process exists; that is the expected result.
  // A missing/broken pidof also prints no PID, so its exit code matters.
  const ok = stop.code === 0 && pid.code === 1 && pid.stdout.trim() === '';
  return {
    id: 'android-process-stop/' + after,
    passed: ok,
    detail: ok
      ? 'Android force-stop completed; no app PID remains'
      : 'Could not verify killed app process: ' + concise(stop) + '; PID: ' + concise(pid),
  };
}

function record(checks: AndroidNativeCheck[], id: string, result: CommandResult): boolean {
  const passed = result.code === 0 && !result.timedOut;
  checks.push({
    id,
    passed,
    detail: passed ? 'Native command succeeded' : concise(result),
  });
  return passed;
}

function blocked(
  message: string,
  integrityFailure = false,
  deviceSerial: string | null = null,
  checks: AndroidNativeCheck[] = [],
): AndroidNativeResult {
  return {
    passed: false,
    integrityFailure,
    blockers: [message],
    checks,
    deviceSerial,
    evidence: ['Native verification unavailable: ' + message],
    proof: 'unavailable',
    screenshotSha256: null,
    limitations: [
      'Component simulations do not count as native proof.',
      'TalkBack speech/manual traversal and Switch Access evidence are unavailable.',
      'Paired blind evaluation not performed.',
    ],
  };
}

/**
 * Builds candidate Kotlin source as an Android app using evaluator-controlled
 * Gradle/manifest/test sources, installs real APKs, runs native AndroidJUnitRunner
 * with independent process deaths and captures the Android compositor.
 */
export function runAndroidComposeNativeRuntime(
  root: string,
  scenarioId: AndroidScenario,
): AndroidNativeResult {
  if (scenarioId !== EDIT && scenarioId !== FEED)
    return blocked('Unknown Android Compose scenario');
  const invalid = sourceIntegrity(root, scenarioId);
  if (invalid) return blocked(invalid, true);
  let sources: ReturnType<typeof candidateFiles>;
  try {
    sources = candidateFiles(root);
  } catch (error) {
    return blocked('Unsafe or incomplete Kotlin sources: ' + String(error), true);
  }
  const readiness = inspectReadiness();
  if (readiness.blockers.length || !readiness.tools)
    return blocked(readiness.blockers.join('; ') || 'Android toolchain unavailable');
  const tools = readiness.tools;
  const work = mkdtempSync(join(tmpdir(), 'kory-compose-native-v5-'));
  const checks: AndroidNativeCheck[] = [];
  let fontScale: string | null = null;
  let screenshotSha256: string | null = null;
  try {
    // The candidate never controls Gradle configuration, test runner, test
    // sources, app manifest or evaluator support. Only Kotlin UI sources move.
    for (const path of FIXED_FILES) writeFixtureFile(work, path, fixedContent(path, scenarioId));
    for (const file of sources) writeFixtureFile(work, file.relativePath, file.content);
    const driver = scenarioId === EDIT ? 'EditNativeTest.kt' : 'FeedNativeTest.kt';
    writeFixtureFile(
      work,
      TEST_SOURCE + '/' + driver,
      readFileSync(join(BASE, 'evaluator', driver), 'utf8'),
    );
    const gradleEnv = {
      JAVA_HOME: tools.javaHome,
      ANDROID_HOME: tools.sdk,
      ANDROID_SDK_ROOT: tools.sdk,
      GRADLE_USER_HOME: join(work, '.gradle-home'),
    };
    mkdirSync(gradleEnv.GRADLE_USER_HOME, { recursive: true });
    const compile = textCommand(
      tools.gradle,
      ['--no-daemon', '--console=plain', ':app:assembleDebug', ':app:assembleDebugAndroidTest'],
      work,
      480_000,
      gradleEnv,
    );
    if (!record(checks, 'gradle-compose-app-and-test-build', compile))
      return blocked(
        'Real Android Gradle build failed: ' + concise(compile),
        false,
        tools.serial,
        checks,
      );
    const app = join(work, 'app/build/outputs/apk/debug/app-debug.apk');
    const test = join(work, 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
    const apks = apkIsReal(app) && apkIsReal(test);
    checks.push({
      id: 'built-real-apks',
      passed: apks,
      detail: apks
        ? 'App and evaluator instrumentation APKs are nonempty ZIP archives'
        : 'Expected Android application or test APK is missing or malformed',
    });
    if (!apks)
      return blocked(
        'Gradle did not produce valid app and instrumentation APKs',
        false,
        tools.serial,
        checks,
      );
    if (
      !record(checks, 'install-native-app', adbCommand(tools, ['install', '-r', '-t', app], 70_000))
    ) {
      return blocked('Native app install failed', false, tools.serial, checks);
    }
    if (
      !record(
        checks,
        'install-instrumentation',
        adbCommand(tools, ['install', '-r', '-t', test], 70_000),
      )
    ) {
      return blocked('Instrumentation APK install failed', false, tools.serial, checks);
    }

    // adb install -r preserves SharedPreferences. Without a clean start, a
    // second candidate may inherit the preceding candidate's draft/account,
    // or a successful run may fail when rerun because text input is appended.
    // Clearing this isolated evaluator app also force-stops an older instance.
    const reset = adbCommand(tools, ['shell', 'pm', 'clear', PACKAGE], 35_000);
    const clean = reset.code === 0 && !reset.timedOut && reset.stdout.trim() === 'Success';
    checks.push({
      id: 'native-app-data-isolation',
      passed: clean,
      detail: clean
        ? 'Android package manager cleared persisted app data before instrumentation'
        : 'Could not verify a clean Android application state: ' + concise(reset),
    });
    if (!clean)
      return blocked('Android package data isolation failed', false, tools.serial, checks);

    if (scenarioId === FEED) {
      const current = adbCommand(tools, ['shell', 'settings', 'get', 'system', 'font_scale']);
      if (current.code !== 0 || !/^\d+(?:\.\d+)?$/u.test(current.stdout.trim()))
        return blocked('Unable to inspect device system font scale', false, tools.serial, checks);
      fontScale = current.stdout.trim();
      if (
        !record(
          checks,
          'native-font-scale-1.5',
          adbCommand(tools, ['shell', 'settings', 'put', 'system', 'font_scale', '1.5']),
        )
      ) {
        return blocked('Could not set native 1.5 font scale', false, tools.serial, checks);
      }
    }

    for (const method of PHASES[scenarioId]) {
      const outcome = instrument(tools, method, scenarioId);
      checks.push(outcome);
      if (!outcome.passed) return blocked(outcome.detail, false, tools.serial, checks);
      if (scenarioId === EDIT && method !== 'persistedCommitAcrossSecondProcessDeath') {
        const stop = forceStop(tools, method);
        checks.push(stop);
        if (!stop.passed) return blocked(stop.detail, false, tools.serial, checks);
      }
    }
    const launch = adbCommand(tools, [
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      PACKAGE + '/.MainActivity',
    ]);
    const started =
      launch.code === 0 &&
      !launch.timedOut &&
      /^Status:\s*ok\s*$/mu.test(launch.stdout) &&
      launch.stdout.includes(PACKAGE + '/.MainActivity');
    checks.push({
      id: 'native-activity-start',
      passed: started,
      detail: started
        ? 'Android activity manager confirmed the Compose activity launched'
        : 'Android activity manager did not confirm a successful launch: ' + concise(launch),
    });
    if (!started)
      return blocked(
        'Android Activity launch failed: ' + concise(launch),
        false,
        tools.serial,
        checks,
      );
    const capture = spawnSync(tools.adb, ['-s', tools.serial, 'exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      timeout: 20_000,
      maxBuffer: 12_000_000,
    });
    const png = Buffer.isBuffer(capture.stdout) ? capture.stdout : Buffer.alloc(0);
    const captured =
      capture.status === 0 && png.length > 1000 && png.subarray(0, 8).equals(CAPTURE_SIGNATURE);
    if (captured) screenshotSha256 = createHash('sha256').update(png).digest('hex');
    checks.push({
      id: 'android-real-screen-capture',
      passed: captured,
      detail: captured
        ? 'adb screencap: ' + png.length + ' bytes; sha256 ' + screenshotSha256
        : 'Android system compositor screenshot was not captured',
    });
    const passed = checks.every((check) => check.passed);
    return {
      passed,
      integrityFailure: false,
      checks,
      blockers: passed ? [] : ['One or more native verification checks failed'],
      deviceSerial: tools.serial,
      proof: passed ? 'native-device' : 'unavailable',
      screenshotSha256,
      evidence: [
        'Actual Android Jetpack Compose app and independent AndroidJUnitRunner instrumentation on ' +
          tools.serial +
          ' (' +
          (tools.emulator ? 'emulator' : 'physical device') +
          ').',
        ...checks.map(
          (check) => (check.passed ? 'PASS ' : 'FAIL ') + check.id + ': ' + check.detail,
        ),
        'TalkBack package/service state was checked and native accessibility nodes were inspected. ' +
          'TalkBack speech/manual traversal and Switch Access were not observed.',
        'Component simulation: not used. Paired blinded variant evaluation: not performed.',
      ],
      limitations: [
        'Actual TalkBack speech and manual assistive-technology traversal remain unverified.',
        'Switch Access was not exercised and has no evidence from this run.',
        'A separate paired same-model skill/no-skill blind evaluation is still required for V5 promotion.',
        'Physical hardware-specific integrations were not exercised by these fixtures.',
      ],
    };
  } catch (error) {
    return blocked(
      'Native Android runner exception: ' + String(error),
      false,
      tools.serial,
      checks,
    );
  } finally {
    if (fontScale !== null) {
      // Always restore the system setting, including on a failed instrument run.
      const restored = adbCommand(tools, [
        'shell',
        'settings',
        'put',
        'system',
        'font_scale',
        fontScale,
      ]);
      if (restored.code !== 0) {
        // Avoid silently claiming successful device cleanup; console is local only.
        console.error('Android native eval: failed to restore font_scale: ' + concise(restored));
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

function score(root: string, id: AndroidScenario): SkillEvalDeterministicScore {
  const result = runAndroidComposeNativeRuntime(root, id);
  const met = result.blockers.length ? 0 : result.checks.filter((check) => check.passed).length;
  const fraction = result.passed ? 1 : met / Math.max(1, result.checks.length);
  return {
    passed: result.passed,
    quality: fraction,
    verification: fraction,
    integrityFailure: result.integrityFailure,
    evidence: [...result.evidence, ...result.blockers.map((blocker) => 'BLOCKED ' + blocker)],
  };
}

/** Standalone sidecar; parent must wire these into the central V5 registry. */
export const ANDROID_COMPOSE_NATIVE_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'android-compose/native-edit-process-recreation@2',
    realRuntime: true,
    get readinessBlockers() {
      return androidComposeNativeReadiness(EDIT);
    },
    matches: (scenario) => scenario.id === EDIT,
    materialize: (destination) => materializeAndroidComposeNativeFixture(destination, EDIT),
  },
  {
    id: 'android-compose/native-feed-lazy-identity@2',
    realRuntime: true,
    get readinessBlockers() {
      return androidComposeNativeReadiness(FEED);
    },
    matches: (scenario) => scenario.id === FEED,
    materialize: (destination) => materializeAndroidComposeNativeFixture(destination, FEED),
  },
];

export const ANDROID_COMPOSE_NATIVE_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'android-compose/native-edit-scorer@2',
    scenarioIds: [EDIT],
    score: ({ workingDirectory }) => score(workingDirectory, EDIT),
  },
  {
    id: 'android-compose/native-feed-scorer@2',
    scenarioIds: [FEED],
    score: ({ workingDirectory }) => score(workingDirectory, FEED),
  },
];
