import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';

const NAV = 'ios-swiftui-full-task-1-individual';
const DOC = 'ios-swiftui-full-task-2-individual';
type IOSScenario = typeof NAV | typeof DOC;
export const IOS_SWIFTUI_NATIVE_SCENARIOS = { navigation: NAV, documents: DOC } as const;
const BASE = join(import.meta.dir, 'fixtures/ios-swiftui-v5');
const SOURCE = 'Sources';
const CONTRACT = '.kory-eval/ios-swiftui-native-contract.json';
const CANDIDATE = ['DetailFeature.swift', 'DocumentFeature.swift'] as const;
const FIXED = ['KoryApp.swift', 'NavigationSupport.swift', 'DocumentSupport.swift'] as const;
const PROJECT = 'KoryIOSFixture.xcodeproj/project.pbxproj';
const SCHEME = 'KoryIOSFixture.xcodeproj/xcshareddata/xcschemes/KoryIOSFixture.xcscheme';
const EVALUATOR = 'evaluator/IOSNativeUITests.swift';
const PLIST = 'evaluator/Info.plist';
const NAV_TESTS = [
  'testNavigationRace',
  'testCancelAndRevisit',
  'testOfflineAndRetry',
  'testLifecycleAndRestoration',
  'testAccessibilityAndLargeType',
] as const;
const DOC_TESTS = [
  'testConcurrentSceneIsolation',
  'testAutosaveAndDocumentScopedUndo',
  'testFailedDiskSaveAndRecovery',
  'testDiscardAndReopenScene',
  'testProcessDeathAndDiskRestoration',
  'testPerSceneFocusAndAccessibleLargeType',
] as const;
const CAPTURE_NAMES: Readonly<Record<string, readonly string[]>> = {
  testNavigationRace: ['navigation-race-B-before-A'],
  testCancelAndRevisit: ['cancelled-previous-generation'],
  testOfflineAndRetry: ['accessible-offline-error', 'recovered-after-retry'],
  testLifecycleAndRestoration: [
    'background-foreground',
    'navigation-restored-after-process-relaunch',
  ],
  testAccessibilityAndLargeType: ['large-type-and-accessibility-tree'],
  testConcurrentSceneIsolation: ['two-real-ipad-windows'],
  testAutosaveAndDocumentScopedUndo: ['document-scoped-undo'],
  testFailedDiskSaveAndRecovery: ['disk-save-failed-and-dirty', 'disk-save-recovered'],
  testDiscardAndReopenScene: ['scene-discard-reopened'],
  testProcessDeathAndDiskRestoration: ['documents-reopened-after-process-death'],
  testPerSceneFocusAndAccessibleLargeType: ['ipad-keyboard-accessible-windows'],
};
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SWIFT_BYTES = 500_000;
const DEFAULT_DEVELOPER = '/Applications/Xcode-beta.app/Contents/Developer';
// xcrun is Apple's system-level selector, not an executable under DEVELOPER_DIR.
// DEVELOPER_DIR in run() pins which Xcode installation xcrun delegates to.
const XCRUN = '/usr/bin/xcrun';

export interface IOSNativeResult {
  passed: boolean;
  integrityFailure: boolean;
  scenarioId: IOSScenario;
  deviceUDID: string | null;
  checks: { id: string; passed: boolean; detail: string }[];
  blockers: string[];
  evidence: string[];
  screenshots: { absolutePath: string; sha256: string }[];
  proof: 'xcode-ios-simulator' | 'unavailable';
  limitations: string[];
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

function run(
  binary: string,
  args: string[],
  cwd?: string,
  timeout = 12_000,
  developer?: string,
): CommandResult {
  const processResult = spawnSync(binary, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: 3_000_000,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      DEVELOPER_DIR: developer ?? process.env.DEVELOPER_DIR ?? DEFAULT_DEVELOPER,
    },
  });
  return {
    code: processResult.status,
    stdout: String(processResult.stdout ?? '').slice(-3_000_000),
    stderr: String(processResult.stderr ?? '').slice(-3_000_000),
    error: processResult.error ? String(processResult.error) : null,
  };
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function fixedBytes(path: string): Buffer {
  return readFileSync(join(BASE, path));
}

function contractContent(id: IOSScenario): string {
  const integrity = [
    ...FIXED.map((name) => SOURCE + '/' + name),
    PROJECT,
    SCHEME,
    EVALUATOR,
    PLIST,
  ];
  return (
    JSON.stringify(
      {
        scenarioId: id,
        skill: 'ios-swiftui',
        kind: 'native-xcode-27-swiftui-xcuitest-v5',
        broader: 'native-interface',
        nearNeighbor: id === NAV ? 'android-compose' : 'desktop-electron-tauri',
        boundary: 'real-ios-27-simulator-windowgroup-navigation-and-xcuitest',
        appAndEvaluatorOwnership: 'fixed-evaluator-injected-into-independent-build',
        candidateEditableFiles: CANDIDATE.map((name) => SOURCE + '/' + name),
        evaluatedOnPhysicalDevice: false,
        pairedBlindEvaluation: 'separate-orchestration-required',
        fixedSHA256: Object.fromEntries(integrity.map((name) => [name, sha256(fixedBytes(name))])),
      },
      null,
      2,
    ) + '\n'
  );
}

/** A candidate sees support code and editable Swift, never tests or repaired solutions. */
export function materializeIOSSwiftUIFixture(destination: string, id: IOSScenario): void {
  if (id !== NAV && id !== DOC) throw new Error('Unknown iOS SwiftUI scenario');
  for (const name of [...FIXED, ...CANDIDATE]) {
    writeFixtureFile(
      destination,
      SOURCE + '/' + name,
      fixedBytes(SOURCE + '/' + name).toString('utf8'),
    );
  }
  writeFixtureFile(destination, CONTRACT, contractContent(id));
  writeFixtureFile(
    destination,
    'README.md',
    'Native SwiftUI iOS 27 evaluation for ' +
      id +
      '\n' +
      'Edit Sources/DetailFeature.swift for navigation, or Sources/DocumentFeature.swift for documents.\n' +
      'The evaluator injects its Xcode project, XCUITest oracle, and simulator controls outside this workspace.\n',
  );
}

function safeRegular(root: string, relative: string): Buffer | null {
  let current = resolve(root);
  const stat = lstatSync(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  for (const segment of relative.split('/')) {
    if (!segment || segment === '..' || segment === '.') return null;
    current = join(current, segment);
    if (!existsSync(current)) return null;
    const part = lstatSync(current);
    if (part.isSymbolicLink()) return null;
    if (segment !== basename(relative) && !part.isDirectory()) return null;
  }
  const final = lstatSync(current);
  return final.isFile() && final.size <= MAX_SWIFT_BYTES ? readFileSync(current) : null;
}

function sourceIntegrity(root: string, id: IOSScenario): string | null {
  try {
    const roots = readdirSync(root).sort();
    if (roots.length !== 3 || roots.join('|') !== '.kory-eval|README.md|Sources')
      return 'Unexpected candidate root files, test bundles, or evaluator overrides';
    if (readdirSync(join(root, '.kory-eval')).join('|') !== basename(CONTRACT))
      return 'Unexpected candidate evaluator receipts or contract files';
    if (!safeRegular(root, 'README.md')) return 'Unsafe or missing candidate README';
    const contract = safeRegular(root, CONTRACT);
    if (!contract || contract.toString('utf8') !== contractContent(id))
      return 'iOS evaluator immutable scenario contract changed or linked';
    for (const name of FIXED) {
      const path = SOURCE + '/' + name;
      const candidate = safeRegular(root, path);
      if (!candidate || !candidate.equals(fixedBytes(path)))
        return 'iOS evaluator-owned immutable app support changed or linked: ' + path;
    }
    const sources = readdirSync(join(root, SOURCE)).sort();
    if (
      sources.length !== FIXED.length + CANDIDATE.length ||
      sources.some(
        (name) =>
          !(FIXED as readonly string[]).includes(name) &&
          !(CANDIDATE as readonly string[]).includes(name),
      )
    )
      return 'Unexpected files within fixed SwiftUI candidate Sources directory';
    for (const name of CANDIDATE) {
      const content = safeRegular(root, SOURCE + '/' + name);
      if (!content || !content.length)
        return 'Missing, oversized, or linked candidate Swift source: ' + name;
      if (
        name !== (id === NAV ? CANDIDATE[0] : CANDIDATE[1]) &&
        !content.equals(fixedBytes(SOURCE + '/' + name))
      )
        return 'Unrelated scenario Swift source changed: ' + name;
    }
    if (existsSync(join(root, 'evaluator')) || existsSync(join(root, 'KoryIOSFixture.xcodeproj')))
      return 'Candidate workspace must not contain evaluator tests, Xcode project, or repairs';
    return null;
  } catch (error) {
    return 'Invalid or unsafe iOS candidate snapshot: ' + String(error);
  }
}

interface ReadyIOS {
  developer: string;
  udid: string;
  osVersion: string;
  name: string;
}

function inspectReadiness(id: IOSScenario): { blockers: string[]; ready: ReadyIOS | null } {
  const blockers: string[] = [];
  if (id !== NAV && id !== DOC) return { blockers: ['Unknown iOS scenario'], ready: null };
  const developer =
    process.env.KORY_IOS_EVAL_DEVELOPER_DIR || process.env.DEVELOPER_DIR || DEFAULT_DEVELOPER;
  const udid =
    id === NAV ? process.env.KORY_IOS_EVAL_IPHONE_UDID : process.env.KORY_IOS_EVAL_IPAD_UDID;
  if (!udid || !/^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(udid))
    blockers.push(
      'Select an exact, already booted ' +
        (id === NAV ? 'iPhone' : 'iPad') +
        ' UDID using KORY_IOS_EVAL_' +
        (id === NAV ? 'IPHONE' : 'IPAD') +
        '_UDID',
    );
  const version = run(
    join(developer, 'usr/bin/xcodebuild'),
    ['-version'],
    undefined,
    15_000,
    developer,
  );
  if (version.code !== 0 || !/\bXcode 27\./.test(version.stdout))
    blockers.push(
      'Xcode 27 unavailable at selected developer directory: ' +
        (version.error || version.stderr.slice(-200)),
    );
  const list = run(
    XCRUN,
    ['simctl', 'list', '-j', 'devices', 'booted'],
    undefined,
    15_000,
    developer,
  );
  let found: ReadyIOS | null = null;
  if (list.code !== 0)
    blockers.push(
      'Cannot enumerate native booted simulators: ' + (list.error || list.stderr.slice(-200)),
    );
  else {
    try {
      const rows = (
        JSON.parse(list.stdout) as {
          devices: Record<
            string,
            Array<{
              udid: string;
              name: string;
              state: string;
              isAvailable: boolean;
              deviceTypeIdentifier: string;
            }>
          >;
        }
      ).devices;
      for (const [runtime, devices] of Object.entries(rows)) {
        for (const device of devices) {
          if (udid !== device.udid) continue;
          if (
            runtime !== 'com.apple.CoreSimulator.SimRuntime.iOS-27-0' ||
            device.state !== 'Booted' ||
            !device.isAvailable ||
            !device.deviceTypeIdentifier.includes(id === NAV ? 'iPhone-' : 'iPad-')
          ) {
            blockers.push(
              'Selected device must be an available, booted iOS 27.0 ' +
                (id === NAV ? 'iPhone' : 'iPad') +
                ' simulator',
            );
          } else found = { developer, udid: device.udid, name: device.name, osVersion: '27.0' };
        }
      }
      if (udid && !found && !blockers.some((message) => message.includes('Selected device')))
        blockers.push('Selected simulator UDID is not booted in the iOS 27.0 runtime');
    } catch (error) {
      blockers.push('Invalid native simulator device enumeration: ' + String(error));
    }
  }
  return { blockers, ready: blockers.length === 0 ? found : null };
}

export function iosSwiftUINativeReadiness(id: IOSScenario): string[] {
  return inspectReadiness(id).blockers;
}

interface XCDevice {
  deviceId: string;
  osVersion: string;
  platform: string;
  deviceName: string;
}

interface XCTreeNode {
  nodeType?: string;
  nodeIdentifier?: string;
  name?: string;
  result?: string;
  children?: XCTreeNode[];
}

interface XCTSummary {
  result?: string;
  totalTestCount?: number;
  passedTests?: number;
  skippedTests?: number;
  failedTests?: number;
  expectedFailures?: number;
  devicesAndConfigurations?: { device: XCDevice }[];
  testFailures?: { testIdentifierString?: string; failureText?: string }[];
}

interface XCTTests {
  devices?: XCDevice[];
  testNodes?: XCTreeNode[];
}

function xcresultJson<T>(
  developer: string,
  bundle: string,
  section: 'summary' | 'tests',
): { value: T | null; failure: string | null } {
  const command = run(
    XCRUN,
    ['xcresulttool', 'get', 'test-results', section, '--path', bundle],
    undefined,
    30_000,
    developer,
  );
  if (command.code !== 0)
    return { value: null, failure: 'Apple xcresulttool ' + section + ': ' + concise(command) };
  try {
    return { value: JSON.parse(command.stdout) as T, failure: null };
  } catch {
    return { value: null, failure: 'Native xcresulttool supplied malformed ' + section + ' JSON' };
  }
}

function concise(command: CommandResult): string {
  return (command.error || command.stderr || command.stdout || 'no output').trim().slice(-750);
}

function treeTests(nodes: readonly XCTreeNode[]): XCTreeNode[] {
  return nodes.flatMap((node) => [
    ...(node.nodeType === 'Test Case' ? [node] : []),
    ...treeTests(node.children ?? []),
  ]);
}

function sameDevice(device: XCDevice, target: ReadyIOS): boolean {
  return (
    device.deviceId === target.udid &&
    device.osVersion === target.osVersion &&
    device.platform === 'iOS Simulator' &&
    device.deviceName === target.name
  );
}

/** Live proof is always obtained through Apple's tool inspecting the actual .xcresult bundle. */
export function verifyIOSXCTestBundle(
  bundle: string,
  target: ReadyIOS,
  scenario: IOSScenario,
  names: readonly string[],
): { checks: IOSNativeResult['checks']; failures: string[]; passed: boolean } {
  const checks: IOSNativeResult['checks'] = [];
  const failures: string[] = [];
  if (
    !existsSync(bundle) ||
    !lstatSync(bundle).isDirectory() ||
    lstatSync(bundle).isSymbolicLink() ||
    !bundle.endsWith('.xcresult')
  )
    return { passed: false, checks, failures: ['Missing real native Xcode .xcresult bundle'] };
  const summary = xcresultJson<XCTSummary>(target.developer, bundle, 'summary');
  const tests = xcresultJson<XCTTests>(target.developer, bundle, 'tests');
  if (!summary.value || !tests.value)
    return {
      passed: false,
      checks,
      failures: [summary.failure, tests.failure].filter((value): value is string => !!value),
    };
  const expected = names.map(
    (name) => (scenario === NAV ? 'NavigationUITests/' : 'DocumentUITests/') + name + '()',
  );
  const cases = treeTests(tests.value.testNodes ?? []);
  const actual = cases.map((item) => item.nodeIdentifier ?? '');
  const exactCases =
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((item) => actual.includes(item));
  checks.push({
    id: 'native-xctest-identifiers',
    passed: exactCases,
    detail: 'Executed ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected),
  });
  const summaryDevice = summary.value.devicesAndConfigurations ?? [];
  const deviceCheck =
    summaryDevice.length === 1 &&
    sameDevice(summaryDevice[0]!.device, target) &&
    (tests.value.devices ?? []).length === 1 &&
    sameDevice(tests.value.devices![0]!, target);
  checks.push({
    id: 'native-ios-27-device',
    passed: deviceCheck,
    detail: JSON.stringify(summaryDevice.map((item) => item.device)),
  });
  const allPassed =
    summary.value.result === 'Passed' &&
    summary.value.totalTestCount === expected.length &&
    summary.value.passedTests === expected.length &&
    summary.value.failedTests === 0 &&
    summary.value.skippedTests === 0 &&
    summary.value.expectedFailures === 0 &&
    cases.every((item) => item.result === 'Passed');
  checks.push({
    id: 'native-xctest-all-passed',
    passed: allPassed,
    detail:
      'Native XCTest: ' +
      JSON.stringify({
        result: summary.value.result,
        passed: summary.value.passedTests,
        failed: summary.value.failedTests,
        skipped: summary.value.skippedTests,
        expectedFailures: summary.value.expectedFailures,
      }),
  });
  for (const failure of summary.value.testFailures ?? []) {
    failures.push(
      (failure.testIdentifierString ?? 'native test') +
        ': ' +
        (failure.failureText ?? 'XCTest failure').slice(0, 950),
    );
  }
  return { checks, failures, passed: checks.every((check) => check.passed) };
}

function pngValid(file: string): { valid: boolean; sha256: string; detail: string } {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 || stat.size > 30_000_000)
      throw new Error('unsafe screenshot file size or type');
    const bytes = readFileSync(file);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.subarray(12, 16).toString() !== 'IHDR' ||
      width < 160 ||
      height < 160 ||
      width > 10_000 ||
      height > 10_000
    )
      throw new Error('invalid PNG signature or dimensions');
    return { valid: true, sha256: sha256(bytes), detail: width + 'x' + height };
  } catch (error) {
    return { valid: false, sha256: '', detail: String(error) };
  }
}

/** Xcode exports XCTAttachment.name as `<name>_<index>_<UUID>.png`. */
export function matchesIOSNativeCaptureName(actual: string, expected: string): boolean {
  if (actual === expected || actual === expected + '.png') return true;
  if (!actual.startsWith(expected + '_')) return false;
  return /^_\d+_[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}\.png$/.test(
    actual.slice(expected.length),
  );
}

function exportNativeScreenshots(
  target: ReadyIOS,
  bundle: string,
  names: readonly string[],
  directory: string,
  scenario: IOSScenario,
): { checks: IOSNativeResult['checks']; screenshots: IOSNativeResult['screenshots'] } {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const exportResult = run(
    XCRUN,
    ['xcresulttool', 'export', 'attachments', '--path', bundle, '--output-path', directory],
    undefined,
    35_000,
    target.developer,
  );
  const checks: IOSNativeResult['checks'] = [];
  const screenshots: IOSNativeResult['screenshots'] = [];
  if (exportResult.code !== 0) {
    checks.push({
      id: 'native-screenshots-exported',
      passed: false,
      detail: 'Apple attachment export failed: ' + concise(exportResult),
    });
    return { checks, screenshots };
  }
  // xcresulttool's manifest maps an exported attachment to its source test;
  // never accept a screenshot provided by the evaluated candidate.
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  } catch {
    manifest = null;
  }
  const records = Array.isArray(manifest) ? manifest : [];
  const attachmentRecords = records.flatMap((record: unknown) => {
    if (!record || typeof record !== 'object') return [];
    const item = record as Record<string, unknown>;
    const id = String(item.testIdentifier ?? '');
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    return attachments.map((a: unknown) => ({ id, attachment: a }));
  });
  for (const name of names) {
    const expectedId = (scenario === NAV ? 'NavigationUITests/' : 'DocumentUITests/') + name + '()';
    const matching = attachmentRecords.filter(
      (item) => item.id === expectedId && item.attachment && typeof item.attachment === 'object',
    );
    for (const label of CAPTURE_NAMES[name] ?? []) {
      let verified = false;
      for (const entry of matching) {
        const attachment = entry.attachment as Record<string, unknown>;
        const humanName = String(attachment.suggestedHumanReadableName ?? '');
        if (!matchesIOSNativeCaptureName(humanName, label)) continue;
        if (attachment.deviceId !== target.udid || attachment.deviceName !== target.name) continue;
        const fileName = String(attachment.exportedFileName ?? '');
        if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(fileName)) continue;
        const file = join(directory, fileName);
        if (!existsSync(file)) continue;
        const png = pngValid(file);
        if (!png.valid) continue;
        screenshots.push({ absolutePath: file, sha256: png.sha256 });
        verified = true;
        break;
      }
      checks.push({
        id: 'native-rendered-' + name + '-' + label,
        passed: verified,
        detail: verified
          ? 'XCTest rendered screenshot ' + label + ' exported and hashed'
          : 'Missing Apple screenshot ' + label + ' for ' + expectedId + ' on selected simulator',
      });
    }
  }
  return { checks, screenshots };
}

interface NativeRunOptions {
  /** Native negative controls may select one failing phase; scoring always runs the full suite. */
  onlyTests?: readonly string[];
}

function simulatorCommand(target: ReadyIOS, args: string[], timeout = 15_000): CommandResult {
  return run(XCRUN, ['simctl', ...args], undefined, timeout, target.developer);
}

function inspectDocumentsOnDisk(
  target: ReadyIOS,
  appBundleId: string,
): IOSNativeResult['checks'][number] {
  const container = simulatorCommand(target, [
    'get_app_container',
    target.udid,
    appBundleId,
    'data',
  ]);
  if (container.code !== 0)
    return { id: 'native-independent-disk-oracle', passed: false, detail: concise(container) };
  const root = container.stdout.trim();
  try {
    const valid = ['A', 'B'].every((id) => {
      const file = join(root, 'Documents', 'kory-doc-' + id + '.json');
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000) return false;
      const stored = JSON.parse(readFileSync(file, 'utf8')) as {
        text?: string;
        revision?: number;
        undoHistory?: unknown[];
      };
      return (
        typeof stored.text === 'string' &&
        stored.text.includes('process-' + id) &&
        typeof stored.revision === 'number' &&
        stored.revision >= 1 &&
        Array.isArray(stored.undoHistory) &&
        stored.undoHistory.length >= 1
      );
    });
    return {
      id: 'native-independent-disk-oracle',
      passed: valid,
      detail: valid
        ? 'Host independently decoded both real sandbox Documents JSON files with revisions'
        : 'Document process-restoration edits or revisions missing from app data-container JSON',
    };
  } catch (error) {
    return {
      id: 'native-independent-disk-oracle',
      passed: false,
      detail: 'Failed to read durable iOS document store: ' + String(error),
    };
  }
}

function makeNativePhases(
  id: IOSScenario,
  selected: readonly string[],
): {
  label: string;
  tests: string[];
  large: boolean;
  oracle: boolean;
}[] {
  const accessibility =
    id === NAV ? 'testAccessibilityAndLargeType' : 'testPerSceneFocusAndAccessibleLargeType';
  const restoration = 'testProcessDeathAndDiskRestoration';
  const tests = selected.filter((name) => name !== accessibility && name !== restoration);
  // Run each test in its own XCUITest phase. iOS 27 can kill a multi-window
  // runner after a prior scene phase, and changing Dynamic Type can kill the
  // next runner, so the accessibility phase is last.
  const phases = [
    ...tests.map((name) => ({
      label: tests.length === 1 ? 'standard' : 'standard-' + name,
      tests: [name],
      large: false,
      oracle: false,
    })),
    {
      label: 'accessibility-large',
      tests: selected.filter((name) => name === accessibility),
      large: true,
      oracle: false,
    },
  ];
  if (id === DOC)
    phases.push({
      label: 'process-restoration',
      tests: selected.filter((name) => name === restoration),
      large: false,
      oracle: true,
    });
  return phases.filter((phase) => phase.tests.length > 0);
}

function prepareNativeProject(candidateRoot: string, directory: string): string {
  for (const name of [...FIXED, ...CANDIDATE]) {
    const path = SOURCE + '/' + name;
    const dest = join(directory, path);
    mkdirSync(join(directory, SOURCE), { recursive: true, mode: 0o700 });
    copyFileSync(join(candidateRoot, path), dest);
    if (
      FIXED.includes(name as (typeof FIXED)[number]) &&
      !readFileSync(dest).equals(fixedBytes(path))
    )
      throw new Error('Fixed evaluator support failed its checksum after copy: ' + path);
  }
  for (const name of [EVALUATOR, SCHEME, PLIST]) {
    const dest = join(directory, name);
    mkdirSync(resolve(dest, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(join(BASE, name), dest);
    if (!readFileSync(dest).equals(fixedBytes(name)))
      throw new Error('Evaluator XCUITest or Xcode scheme checksum changed: ' + name);
  }
  const original = fixedBytes(PROJECT).toString('utf8');
  const nonce = randomUUID().replaceAll('-', '').slice(0, 20);
  const appId = 'com.kory.iosfixture.' + nonce;
  const project = original
    .replace(
      'PRODUCT_BUNDLE_IDENTIFIER = com.kory.iosfixture.tests;',
      'PRODUCT_BUNDLE_IDENTIFIER = ' + appId + '.tests;',
    )
    .replace(
      'PRODUCT_BUNDLE_IDENTIFIER = com.kory.iosfixture;',
      'PRODUCT_BUNDLE_IDENTIFIER = ' + appId + ';',
    );
  if (
    project === original ||
    project.includes('com.kory.iosfixture;') ||
    project.includes('com.kory.iosfixture.tests;')
  )
    throw new Error('Cannot isolate evaluator-owned Xcode application bundle IDs');
  const pbxproj = join(directory, PROJECT);
  mkdirSync(resolve(pbxproj, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(pbxproj, project, { mode: 0o600 });
  return appId;
}

/** Faithful host evaluator: calls Xcode 27 against a selected, booted simulator. */
export function runIOSSwiftUINativeRuntime(
  root: string,
  id: IOSScenario,
  options: NativeRunOptions = {},
): IOSNativeResult {
  const result: IOSNativeResult = {
    passed: false,
    integrityFailure: false,
    scenarioId: id,
    deviceUDID: null,
    checks: [],
    blockers: [],
    evidence: [],
    screenshots: [],
    proof: 'unavailable',
    limitations: [
      'Native XCTest accessibility tree is verified; spoken VoiceOver and manual traversal are not.',
      'A physical device, physical keyboard, sensors, notifications, and entitlements are untested.',
      'V5 skill/no-skill paired blind-review results require separate orchestration.',
    ],
  };
  const integrity = sourceIntegrity(root, id);
  if (integrity) {
    result.integrityFailure = true;
    result.blockers.push(integrity);
    return result;
  }
  const readiness = inspectReadiness(id);
  result.blockers.push(...readiness.blockers);
  if (!readiness.ready) return result;
  const target = readiness.ready;
  result.deviceUDID = target.udid;
  const expected: string[] = id === NAV ? [...NAV_TESTS] : [...DOC_TESTS];
  const selected = options.onlyTests ?? expected;
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => !expected.includes(name))
  ) {
    result.blockers.push('Invalid native XCUITest selection');
    return result;
  }
  // A one-test negative control can establish a regression, but an eventual
  // one-test success is never sufficient to qualify the full iOS scenario.
  const fullSuite =
    selected.length === expected.length && expected.every((name) => selected.includes(name));
  // Candidate evaluation has no results, Xcode project or evaluator test content in its
  // workspace. Each invocation injects independently hashed fixed assets into private tmp.
  const work = mkdtempSync(join(tmpdir(), 'kory-ios-v5-native-'));
  result.evidence.push('Private native Xcode results: ' + work);
  let originalContentSize: string | null = null;
  let mustRestoreContentSize = false;
  try {
    const appId = prepareNativeProject(root, work);
    result.checks.push({
      id: 'native-fixed-xcode-injection',
      passed: true,
      detail:
        'Immutable SwiftUI support, project/scheme, XCUITest SHA256 checked; ' +
        'app bundle ' +
        appId,
    });
    const readSize = simulatorCommand(target, ['ui', target.udid, 'content_size']);
    if (
      readSize.code !== 0 ||
      !/^(?:extra-small|small|medium|large|extra-large|extra-extra-large|extra-extra-extra-large|accessibility-(?:medium|large|extra-large|extra-extra-large|extra-extra-extra-large))$/.test(
        readSize.stdout.trim(),
      )
    )
      throw new Error('Cannot read native simulator Dynamic Type setting: ' + concise(readSize));
    originalContentSize = readSize.stdout.trim();
    for (const phase of makeNativePhases(id, selected)) {
      if (phase.large) {
        // The settings change is applied solely to the caller-pinned simulator.
        mustRestoreContentSize = true;
        const changed = simulatorCommand(target, [
          'ui',
          target.udid,
          'content_size',
          'accessibility-large',
        ]);
        if (changed.code !== 0)
          throw new Error('Cannot enable accessibility Dynamic Type: ' + concise(changed));
      } else if (mustRestoreContentSize && originalContentSize) {
        const restored = simulatorCommand(target, [
          'ui',
          target.udid,
          'content_size',
          originalContentSize,
        ]);
        if (restored.code !== 0)
          throw new Error(
            'Cannot restore standard Dynamic Type before next phase: ' + concise(restored),
          );
        mustRestoreContentSize = false;
      }
      const xcresult = join(work, phase.label + '.xcresult');
      const testClass = id === NAV ? 'NavigationUITests' : 'DocumentUITests';
      const onlyTesting = phase.tests.flatMap((name) => [
        '-only-testing:KoryIOSUITests/' + testClass + '/' + name,
      ]);
      // iPadOS 27 can restore WindowGroup scenes across separate xcodebuild
      // invocations. Remove the prior app before the next phase so XCTest
      // observes only the evaluator's declared launch state.
      simulatorCommand(target, ['terminate', target.udid, appId]);
      simulatorCommand(target, ['uninstall', target.udid, appId]);
      const build = run(
        join(target.developer, 'usr/bin/xcodebuild'),
        [
          'test',
          '-project',
          join(work, 'KoryIOSFixture.xcodeproj'),
          '-scheme',
          'KoryIOSFixture',
          '-configuration',
          'Debug',
          '-destination',
          'platform=iOS Simulator,id=' + target.udid,
          '-parallel-testing-enabled',
          'NO',
          '-derivedDataPath',
          join(work, 'DerivedData'),
          '-resultBundlePath',
          xcresult,
          ...onlyTesting,
          '-quiet',
        ],
        work,
        900_000,
        target.developer,
      );
      result.evidence.push(
        'Xcode native phase ' +
          phase.label +
          ': result=' +
          xcresult +
          ', exit=' +
          build.code +
          ', stdout/stderr tail: ' +
          concise(build),
      );
      result.checks.push({
        id: 'native-xcode-command-' + phase.label,
        passed: build.code === 0 && !build.error,
        detail: 'Xcode 27 xcodebuild exited ' + build.code + ': ' + concise(build),
      });
      const native = verifyIOSXCTestBundle(xcresult, target, id, phase.tests);
      result.checks.push(
        ...native.checks.map((check) => ({
          ...check,
          id: check.id + '-' + phase.label,
        })),
      );
      result.evidence.push(...native.failures);
      if (!native.passed || build.code !== 0 || build.error) {
        result.blockers.push(
          'Actual XCTest phase ' + phase.label + ' failed or its provenance could not be verified',
        );
        break;
      }
      const captures = exportNativeScreenshots(
        target,
        xcresult,
        phase.tests,
        join(work, 'captures-' + phase.label),
        id,
      );
      result.checks.push(...captures.checks);
      result.screenshots.push(...captures.screenshots);
      if (!captures.checks.every((check) => check.passed)) {
        result.blockers.push('Native screenshot or XCTest attachment evidence missing');
        break;
      }
      if (phase.oracle) {
        const disk = inspectDocumentsOnDisk(target, appId);
        result.checks.push(disk);
        if (!disk.passed) {
          result.blockers.push('Native iPad document persistence oracle failed');
          break;
        }
      }
    }
  } catch (error) {
    result.blockers.push('Native iOS evaluator error: ' + String(error));
  } finally {
    if (mustRestoreContentSize && originalContentSize) {
      const restore = simulatorCommand(target, [
        'ui',
        target.udid,
        'content_size',
        originalContentSize,
      ]);
      const success = restore.code === 0;
      result.checks.push({
        id: 'native-dynamic-type-restoration',
        passed: success,
        detail: success
          ? 'Restored ' + originalContentSize
          : 'Simulator settings restoration failed: ' + concise(restore),
      });
      if (!success) result.blockers.push('Native simulator content size restoration failed');
    }
  }
  result.passed =
    fullSuite &&
    result.blockers.length === 0 &&
    result.checks.every((check) => check.passed) &&
    result.screenshots.length >= selected.length;
  if (!result.passed && !result.blockers.length)
    result.blockers.push(
      fullSuite
        ? 'Native XCTest verification or rendered evidence was incomplete'
        : 'A partial native XCUITest control cannot qualify the full scenario',
    );
  result.proof = result.passed ? 'xcode-ios-simulator' : 'unavailable';
  result.evidence.push(
    ...result.checks.map(
      (check) => (check.passed ? 'PASS ' : 'FAIL ') + check.id + ': ' + check.detail,
    ),
  );
  return result;
}

/** Positive/negative validation controls run outside the candidate workspace. */
export function runIOSSwiftUINativeControl(
  id: IOSScenario,
  variant: 'defective' | 'repaired',
  options: NativeRunOptions = {},
): IOSNativeResult {
  const root = mkdtempSync(join(tmpdir(), 'kory-ios-v5-control-'));
  materializeIOSSwiftUIFixture(root, id);
  if (variant === 'repaired') {
    const name = id === NAV ? CANDIDATE[0] : CANDIDATE[1];
    const source = join(BASE, 'evaluator', 'repaired', name);
    const destination = join(root, SOURCE, name);
    copyFileSync(source, destination);
  }
  return runIOSSwiftUINativeRuntime(root, id, options);
}

function score(root: string, id: IOSScenario): SkillEvalDeterministicScore {
  const native = runIOSSwiftUINativeRuntime(root, id);
  return {
    passed: native.passed,
    quality: native.passed ? 1 : 0,
    verification: native.passed ? 1 : 0,
    integrityFailure: native.integrityFailure,
    evidence: [...native.evidence, ...native.blockers.map((item) => 'BLOCKED ' + item)],
  };
}

/** Register in the shared fixture registry only after independent red/green controls pass. */
export const IOS_SWIFTUI_NATIVE_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'ios-swiftui/native-navigation-xcuitest-v5@3',
    realRuntime: true,
    get readinessBlockers() {
      return iosSwiftUINativeReadiness(NAV);
    },
    matches: (scenario) => scenario.id === NAV,
    materialize: (destination) => materializeIOSSwiftUIFixture(destination, NAV),
  },
  {
    id: 'ios-swiftui/native-multiwindow-xcuitest-v5@3',
    realRuntime: true,
    get readinessBlockers() {
      return iosSwiftUINativeReadiness(DOC);
    },
    matches: (scenario) => scenario.id === DOC,
    materialize: (destination) => materializeIOSSwiftUIFixture(destination, DOC),
  },
];

export const IOS_SWIFTUI_NATIVE_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'ios-swiftui/native-navigation-scorer-v5@3',
    scenarioIds: [NAV],
    score: ({ workingDirectory }) => score(workingDirectory, NAV),
  },
  {
    id: 'ios-swiftui/native-multiwindow-scorer-v5@3',
    scenarioIds: [DOC],
    score: ({ workingDirectory }) => score(workingDirectory, DOC),
  },
];
