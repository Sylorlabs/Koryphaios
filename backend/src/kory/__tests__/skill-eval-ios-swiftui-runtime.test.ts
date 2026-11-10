import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IOS_SWIFTUI_NATIVE_MATERIALIZERS,
  IOS_SWIFTUI_NATIVE_SCENARIOS,
  IOS_SWIFTUI_NATIVE_SCORERS,
  iosSwiftUINativeReadiness,
  matchesIOSNativeCaptureName,
  materializeIOSSwiftUIFixture,
  runIOSSwiftUINativeControl,
  runIOSSwiftUINativeRuntime,
  verifyIOSXCTestBundle,
} from '../skill-eval-ios-swiftui-runtime';

const { navigation, documents } = IOS_SWIFTUI_NATIVE_SCENARIOS;
const roots: string[] = [];
const keys = [
  'KORY_IOS_EVAL_IPHONE_UDID',
  'KORY_IOS_EVAL_IPAD_UDID',
  'KORY_IOS_EVAL_DEVELOPER_DIR',
  'DEVELOPER_DIR',
] as const;
const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const callerScopedDeveloper = env.KORY_IOS_EVAL_DEVELOPER_DIR ?? env.DEVELOPER_DIR;

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-ios-v5-unit-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('iOS 27 native SwiftUI evaluator sidecar', () => {
  test('matches only the two V5 full-task scenarios with real runtime requirements', () => {
    expect(IOS_SWIFTUI_NATIVE_MATERIALIZERS.map((item) => item.realRuntime)).toEqual([true, true]);
    expect(IOS_SWIFTUI_NATIVE_MATERIALIZERS[0]!.matches({ id: navigation } as never)).toBe(true);
    expect(IOS_SWIFTUI_NATIVE_MATERIALIZERS[1]!.matches({ id: documents } as never)).toBe(true);
    expect(IOS_SWIFTUI_NATIVE_MATERIALIZERS[0]!.matches({ id: documents } as never)).toBe(false);
    expect(IOS_SWIFTUI_NATIVE_MATERIALIZERS[1]!.matches({ id: navigation } as never)).toBe(false);
    expect(IOS_SWIFTUI_NATIVE_SCORERS.map((item) => item.scenarioIds)).toEqual([
      [navigation],
      [documents],
    ]);
  });

  test('materializes SwiftUI support and editable candidate files without evaluator oracle', () => {
    for (const id of [navigation, documents]) {
      const root = temp();
      materializeIOSSwiftUIFixture(root, id);
      expect(existsSync(join(root, 'KoryIOSFixture.xcodeproj'))).toBe(false);
      expect(existsSync(join(root, 'evaluator'))).toBe(false);
      expect(existsSync(join(root, 'Sources/KoryApp.swift'))).toBe(true);
      expect(existsSync(join(root, 'Sources/NavigationSupport.swift'))).toBe(true);
      expect(existsSync(join(root, 'Sources/DocumentSupport.swift'))).toBe(true);
      const bad = readFileSync(
        join(root, 'Sources', id === navigation ? 'DetailFeature.swift' : 'DocumentFeature.swift'),
        'utf8',
      );
      expect(bad).toContain(id === navigation ? '.onAppear' : 'GlobalDraft.shared');
      const contract = JSON.parse(
        readFileSync(join(root, '.kory-eval/ios-swiftui-native-contract.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(contract.scenarioId).toBe(id);
      expect(contract.broader).toBe('native-interface');
      expect(contract.nearNeighbor).toBe(
        id === navigation ? 'android-compose' : 'desktop-electron-tauri',
      );
      expect(contract.pairedBlindEvaluation).toBe('separate-orchestration-required');
      expect(Object.keys(contract.fixedSHA256 as object).length).toBe(7);
    }
  });

  test('binds every immutable contract entry to its fixed fixture bytes', () => {
    const fixedFiles = [
      'Sources/KoryApp.swift',
      'Sources/NavigationSupport.swift',
      'Sources/DocumentSupport.swift',
      'KoryIOSFixture.xcodeproj/project.pbxproj',
      'KoryIOSFixture.xcodeproj/xcshareddata/xcschemes/KoryIOSFixture.xcscheme',
      'evaluator/IOSNativeUITests.swift',
      'evaluator/Info.plist',
    ].sort();

    for (const id of [navigation, documents]) {
      const root = temp();
      materializeIOSSwiftUIFixture(root, id);
      const contract = JSON.parse(
        readFileSync(join(root, '.kory-eval/ios-swiftui-native-contract.json'), 'utf8'),
      ) as { fixedSHA256: Record<string, string> };
      expect(Object.keys(contract.fixedSHA256).sort()).toEqual(fixedFiles);
      for (const file of fixedFiles) {
        const fixedPath = join(import.meta.dir, '../fixtures/ios-swiftui-v5', file);
        const digest = createHash('sha256').update(readFileSync(fixedPath)).digest('hex');
        expect(contract.fixedSHA256[file]).toBe(digest);
      }
    }
  });

  test('rejects a contract whose fixed-file digest is changed independently', () => {
    const root = temp();
    materializeIOSSwiftUIFixture(root, navigation);
    const contractPath = join(root, '.kory-eval/ios-swiftui-native-contract.json');
    const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
      fixedSHA256: Record<string, string>;
    };
    contract.fixedSHA256['Sources/KoryApp.swift'] = '0'.repeat(64);
    writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n');

    const run = runIOSSwiftUINativeRuntime(root, navigation);
    expect(run.passed).toBe(false);
    expect(run.integrityFailure).toBe(true);
    expect(run.blockers.join(' ')).toContain('immutable scenario contract');
  });

  test('readiness fails closed for missing selected devices and Xcode', () => {
    delete process.env.KORY_IOS_EVAL_IPHONE_UDID;
    delete process.env.KORY_IOS_EVAL_IPAD_UDID;
    process.env.KORY_IOS_EVAL_DEVELOPER_DIR = join(temp(), 'missing-Xcode');
    expect(iosSwiftUINativeReadiness(navigation).join(' ')).toContain('UDID');
    expect(iosSwiftUINativeReadiness(documents).join(' ')).toContain('Xcode 27');
  });

  test.skipIf(!callerScopedDeveloper)(
    'gives the caller-scoped developer directory precedence over DEVELOPER_DIR',
    () => {
      process.env.KORY_IOS_EVAL_DEVELOPER_DIR = callerScopedDeveloper!;
      process.env.DEVELOPER_DIR = join(temp(), 'ignored-global-Xcode');
      delete process.env.KORY_IOS_EVAL_IPHONE_UDID;
      delete process.env.KORY_IOS_EVAL_IPAD_UDID;

      expect(
        iosSwiftUINativeReadiness(navigation).some((reason) =>
          reason.includes('Xcode 27 unavailable'),
        ),
      ).toBe(false);
      expect(
        iosSwiftUINativeReadiness(documents).some((reason) =>
          reason.includes('Xcode 27 unavailable'),
        ),
      ).toBe(false);
    },
  );

  test('rejects tampered immutable SwiftUI support without launching the simulator', () => {
    const root = temp();
    materializeIOSSwiftUIFixture(root, navigation);
    const support = join(root, 'Sources/KoryApp.swift');
    writeFileSync(support, readFileSync(support, 'utf8') + '\n// forged support\n');
    const run = runIOSSwiftUINativeRuntime(root, navigation);
    expect(run.passed).toBe(false);
    expect(run.integrityFailure).toBe(true);
    expect(run.blockers.join(' ')).toContain('immutable');
    expect(run.proof).toBe('unavailable');
  });

  test('rejects edits to the other scenario feature in a candidate snapshot', () => {
    for (const id of [navigation, documents]) {
      const root = temp();
      materializeIOSSwiftUIFixture(root, id);
      const unrelated = join(
        root,
        'Sources',
        id === navigation ? 'DocumentFeature.swift' : 'DetailFeature.swift',
      );
      writeFileSync(unrelated, readFileSync(unrelated, 'utf8') + '\n// bypass other scenario\n');
      const run = runIOSSwiftUINativeRuntime(root, id);
      expect(run.passed).toBe(false);
      expect(run.integrityFailure).toBe(true);
      expect(run.blockers.join(' ')).toContain('Unrelated scenario Swift source');
    }
  });

  test('rejects symlink traversal and evaluator/test receipt injection', () => {
    const root = temp();
    materializeIOSSwiftUIFixture(root, documents);
    rmSync(join(root, 'Sources/DocumentFeature.swift'));
    symlinkSync('/etc/hosts', join(root, 'Sources/DocumentFeature.swift'));
    const linked = runIOSSwiftUINativeRuntime(root, documents);
    expect(linked.integrityFailure).toBe(true);
    expect(linked.passed).toBe(false);
    const root2 = temp();
    materializeIOSSwiftUIFixture(root2, documents);
    mkdirSync(join(root2, 'evaluator'));
    writeFileSync(join(root2, 'evaluator/FakeTests.swift'), 'XCTAssertTrue(true)');
    expect(runIOSSwiftUINativeRuntime(root2, documents).integrityFailure).toBe(true);
    const root3 = temp();
    materializeIOSSwiftUIFixture(root3, navigation);
    writeFileSync(join(root3, '.kory-eval/receipt.json'), '{"passed":true}');
    expect(runIOSSwiftUINativeRuntime(root3, navigation).integrityFailure).toBe(true);
  });

  test('rejects fake Xcode receipts, empty bundles, and invented test success', () => {
    const root = temp();
    const bundle = join(root, 'spoof.xcresult');
    mkdirSync(bundle);
    writeFileSync(
      join(bundle, 'manifest.json'),
      JSON.stringify({
        result: 'Passed',
        passedTests: 5,
        deviceId: 'FAKE',
      }),
    );
    const inspected = verifyIOSXCTestBundle(
      bundle,
      {
        udid: '4ADB02EE-1CC6-4433-909A-1B1F247FA068',
        name: 'iPhone 17 Pro',
        osVersion: '27.0',
        developer: join(root, 'missing-Xcode'),
      },
      navigation,
      ['testNavigationRace'],
    );
    expect(inspected.passed).toBe(false);
    expect(inspected.failures.length).toBeGreaterThan(0);
    expect(lstatSync(bundle).isDirectory()).toBe(true);
  });

  test('accepts only the requested XCTAttachment name and Apple screenshot suffix', () => {
    const label = 'navigation-race-B-before-A';
    const uuid = '09AF5EC6-4421-4ABC-8311-5EBA12C4D123';
    expect(matchesIOSNativeCaptureName(label, label)).toBe(true);
    expect(matchesIOSNativeCaptureName(label + '.png', label)).toBe(true);
    expect(matchesIOSNativeCaptureName(`${label}_0_${uuid}.png`, label)).toBe(true);
    expect(matchesIOSNativeCaptureName(`${label}_12_${uuid}.png`, label)).toBe(true);
    expect(matchesIOSNativeCaptureName(`${label}-spoof_0_${uuid}.png`, label)).toBe(false);
    expect(matchesIOSNativeCaptureName(`${label}_0_${uuid}.jpg`, label)).toBe(false);
    expect(matchesIOSNativeCaptureName(`${label}_0_invalid.png`, label)).toBe(false);
  });

  const native = process.env.KORY_IOS_EVAL_NATIVE_TESTS === '1';
  test.skipIf(!native)(
    'independent native iPhone red/green (actual XCUITest)',
    () => {
      expect(iosSwiftUINativeReadiness(navigation)).toEqual([]);
      const red = runIOSSwiftUINativeControl(navigation, 'defective', {
        onlyTests: ['testNavigationRace'],
      });
      expect(
        red.checks.some((item) => item.id === 'native-ios-27-device-standard' && item.passed),
      ).toBe(true);
      expect(red.evidence.join(' ')).toContain('testNavigationRace()');
      expect(red.evidence.join(' ')).toContain('stale-response-overwrote-B');
      expect(red.passed).toBe(false);
      expect(red.integrityFailure).toBe(false);
      expect(
        red.checks.find((check) => check.id === 'native-xctest-identifiers-standard')?.passed,
      ).toBe(true);
      expect(
        red.checks.find((check) => check.id === 'native-xctest-all-passed-standard')?.passed,
      ).toBe(false);
      const green = runIOSSwiftUINativeControl(navigation, 'repaired');
      expect(green.blockers).toEqual([]);
      expect(green.passed).toBe(true);
      expect(green.screenshots.length).toBeGreaterThanOrEqual(5);
    },
    1_200_000,
  );

  test.skipIf(!native)(
    'independent native iPad red/green with real scenes and disk oracle',
    () => {
      expect(iosSwiftUINativeReadiness(documents)).toEqual([]);
      const red = runIOSSwiftUINativeControl(documents, 'defective', {
        onlyTests: ['testConcurrentSceneIsolation'],
      });
      expect(
        red.checks.some((item) => item.id === 'native-ios-27-device-standard' && item.passed),
      ).toBe(true);
      expect(red.evidence.join(' ')).toContain('testConcurrentSceneIsolation()');
      expect(red.evidence.join(' ')).toContain('global-draft-leaked-across-scenes');
      expect(red.passed).toBe(false);
      expect(red.integrityFailure).toBe(false);
      expect(
        red.checks.find((check) => check.id === 'native-xctest-identifiers-standard')?.passed,
      ).toBe(true);
      expect(
        red.checks.find((check) => check.id === 'native-xctest-all-passed-standard')?.passed,
      ).toBe(false);
      const green = runIOSSwiftUINativeControl(documents, 'repaired');
      if (!green.passed) {
        console.error('Native iPad repaired-control diagnostics:', JSON.stringify({
          blockers: green.blockers,
          failedChecks: green.checks.filter((check) => !check.passed),
          evidence: green.evidence.slice(-20),
          screenshots: green.screenshots.length,
        }));
      }
      expect(green.passed).toBe(true);
      expect(
        green.checks.find((check) => check.id === 'native-independent-disk-oracle')?.passed,
      ).toBe(true);
      expect(green.screenshots.length).toBeGreaterThanOrEqual(6);
    },
    1_200_000,
  );
});
