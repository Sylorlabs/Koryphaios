import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import { BUILTIN_SKILL_EVAL_MATERIALIZERS, BUILTIN_SKILL_EVAL_SCORERS } from '../skill-eval-fixtures';
import {
  ANDROID_COMPOSE_NATIVE_SCENARIOS,
  ANDROID_COMPOSE_NATIVE_MATERIALIZERS,
  ANDROID_COMPOSE_NATIVE_SCORERS,
  androidComposeNativeReadiness,
  androidEmulatorAvdMatches,
  materializeAndroidComposeNativeFixture,
  runAndroidComposeNativeRuntime,
} from '../skill-eval-android-compose-native-runtime';

const { edit, feed } = ANDROID_COMPOSE_NATIVE_SCENARIOS;
const workspaces: string[] = [];
const envKeys = [
  'KORY_SKILL_EVAL_ANDROID_SDK_ROOT',
  'KORY_SKILL_EVAL_ANDROID_GRADLE',
  'KORY_SKILL_EVAL_ANDROID_JAVA_HOME',
  'KORY_SKILL_EVAL_ANDROID_SERIAL',
  'KORY_SKILL_EVAL_ANDROID_AVD_NAME',
  'KORY_SKILL_EVAL_ANDROID_ALLOW_PHYSICAL',
  'KORY_SKILL_EVAL_ANDROID_ALLOW_DEVICE_SETTINGS',
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const initiallyReady = androidComposeNativeReadiness(edit).length === 0;
const nativeOptIn = process.env.KORY_SKILL_EVAL_ANDROID_NATIVE_TESTS === '1';
const sourceBase = join(import.meta.dir, '../fixtures/android-compose-v5');

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'kory-android-native-test-'));
  workspaces.push(path);
  return path;
}

function restoreEnvironment(): void {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnvironment();
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scenario(id: typeof edit | typeof feed) {
  const file = id === edit ? 'scenario-1.json' : 'scenario-2.json';
  return JSON.parse(
    readFileSync(join(import.meta.dir, '../../../../skills-v5/android-compose/evals/tasks', file), 'utf8'),
  ) as {
    id: string;
    prompt: string;
    environment: { kind: string; startingState: string; requirements: string[] };
    requiredArtifacts: string[];
  };
}

async function score(root: string, id: typeof edit | typeof feed) {
  const selected = ANDROID_COMPOSE_NATIVE_SCORERS.find((item) => item.scenarioIds.includes(id));
  expect(selected).toBeDefined();
  return selected!.score({
    workingDirectory: root,
    scenario: scenario(id) as never,
    experiment: {} as never,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
}

function repair(root: string, name: 'EditFeature.kt' | 'FeedFeature.kt'): void {
  writeFixtureFile(root, 'app/src/main/java/com/kory/eval/' + name,
    readFileSync(join(sourceBase, 'controls', name), 'utf8'));
}

describe('Jetpack Compose V5 independent native sidecar', () => {
  test('dedicated emulator guard requires the exact AVD and a successful console receipt', () => {
    expect(androidEmulatorAvdMatches('KoryComposeNativeApi37\r\nOK\r\n',
      'KoryComposeNativeApi37')).toBe(true);
    expect(androidEmulatorAvdMatches('AnotherAVD\nOK\n',
      'KoryComposeNativeApi37')).toBe(false);
    expect(androidEmulatorAvdMatches('KoryComposeNativeApi37\nKO\n',
      'KoryComposeNativeApi37')).toBe(false);
    expect(androidEmulatorAvdMatches('KoryComposeNativeApi37\nOK\nextra\n',
      'KoryComposeNativeApi37')).toBe(false);
  });
  test('matches the two Android full-task scenarios and is registered centrally', () => {
    const first = scenario(edit);
    const second = scenario(feed);
    expect(first.id).toBe(edit);
    expect(second.id).toBe(feed);
    expect(first.environment.kind).toBe('device');
    expect(first.environment.startingState).toContain('offline-edit-state-restoration');
    expect(first.environment.requirements.join(' ')).toContain('process recreation');
    expect(second.environment.startingState).toContain('paged-list-key-lifecycle');
    expect(second.environment.requirements.join(' ')).toContain('stable message ids');
    expect(first.requiredArtifacts).toContain('android-compose-individual-scenario-1-paired-evaluation');
    expect(second.requiredArtifacts).toContain('android-compose-individual-scenario-2-paired-evaluation');
    expect(ANDROID_COMPOSE_NATIVE_MATERIALIZERS.map((item) => item.realRuntime)).toEqual([true, true]);
    for (const [index, id] of [edit, feed].entries()) {
      expect(ANDROID_COMPOSE_NATIVE_MATERIALIZERS[index]!.matches({ id } as never)).toBe(true);
      expect(ANDROID_COMPOSE_NATIVE_SCORERS[index]!.scenarioIds).toEqual([id]);
      const registered = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) => item.matches({ id } as never));
      expect(registered.map((item) => item.id)).toEqual([ANDROID_COMPOSE_NATIVE_MATERIALIZERS[index]!.id]);
      const registeredScorers = BUILTIN_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(id));
      expect(registeredScorers.map((item) => item.id)).toEqual([ANDROID_COMPOSE_NATIVE_SCORERS[index]!.id]);
    }
    expect(ANDROID_COMPOSE_NATIVE_MATERIALIZERS[0]!.matches({ id: feed } as never)).toBe(false);
    expect(ANDROID_COMPOSE_NATIVE_MATERIALIZERS[1]!.matches({ id: edit } as never)).toBe(false);
  });

  test('materializes real Gradle Compose source with intentionally red lifecycle defects', () => {
    for (const id of [edit, feed]) {
      const root = workspace();
      materializeAndroidComposeNativeFixture(root, id);
      const contract = JSON.parse(readFileSync(join(root, '.kory-eval/android-native-contract.json'), 'utf8'));
      expect(contract.scenarioId).toBe(id);
      expect(contract.broader).toBe('native-interface');
      expect(contract.nearNeighbor).toBe(id === edit ? 'desktop-electron-tauri' : 'ios-swiftui');
      expect(contract.componentSimulationIsNativeEvidence).toBe(false);
      expect(contract.pairedBlindEvaluation).toBe('separate-orchestration-required');
      const gradle = readFileSync(join(root, 'app/build.gradle.kts'), 'utf8');
      expect(gradle).toContain('id("org.jetbrains.kotlin.plugin.compose")');
      expect(gradle).toContain('androidx.compose.ui:ui-test-junit4');
      expect(gradle).toContain(id === edit ? '\\"edit\\"' : '\\"feed\\"');
      const manifest = readFileSync(join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
      expect(manifest).toContain('MainActivity');
      expect(existsSync(join(root, 'app/src/androidTest'))).toBe(false);
      const editStarter = readFileSync(join(root, 'app/src/main/java/com/kory/eval/EditFeature.kt'), 'utf8');
      const feedStarter = readFileSync(join(root, 'app/src/main/java/com/kory/eval/FeedFeature.kt'), 'utf8');
      expect(editStarter).toContain('var selected by remember {');
      expect(feedStarter).toContain('itemsIndexed(messages, key = { index, _ -> index })');
      expect(feedStarter).toContain('onDispose { /* wrongly leaves avatar load alive */ }');
      expect(readFileSync(join(sourceBase, 'evaluator/EditNativeTest.kt'), 'utf8'))
        .toContain('primeOfflineAndRotate');
      expect(readFileSync(join(sourceBase, 'evaluator/FeedNativeTest.kt'), 'utf8'))
        .toContain('AvatarAudit.totalOutstanding()');
    }
  });

  test('missing Java, Gradle, SDK and a device fail readiness and never earn verification', async () => {
    const root = workspace();
    materializeAndroidComposeNativeFixture(root, edit);
    process.env.KORY_SKILL_EVAL_ANDROID_SDK_ROOT = join(root, 'absent-sdk');
    process.env.KORY_SKILL_EVAL_ANDROID_GRADLE = join(root, 'absent-gradle');
    process.env.KORY_SKILL_EVAL_ANDROID_JAVA_HOME = join(root, 'absent-jdk');
    process.env.KORY_SKILL_EVAL_ANDROID_AVD_NAME = 'KoryComposeNativeApi37';
    const blockers = androidComposeNativeReadiness(edit);
    expect(blockers.join(' ')).toContain('JDK 17-27 unavailable');
    expect(blockers.join(' ')).toContain('Gradle 9.6.0 unavailable');
    expect(blockers.join(' ')).toContain('Android API 37 platform');
    expect(blockers.join(' ')).toContain('Google Play arm64 system image');
    expect(blockers.join(' ')).toContain('adb binary');
    const outcome = runAndroidComposeNativeRuntime(root, edit);
    expect(outcome.passed).toBe(false);
    expect(outcome.proof).toBe('unavailable');
    expect(outcome.checks).toEqual([]);
    expect(outcome.blockers.length).toBeGreaterThan(0);
    const scored = await score(root, edit);
    expect(scored.passed).toBe(false);
    expect(scored.verification).toBe(0);
    expect(scored.quality).toBe(0);
  });

  test('fake Gradle/device success text and a planted native receipt cannot manufacture a pass', async () => {
    const root = workspace();
    materializeAndroidComposeNativeFixture(root, feed);
    const sdk = workspace();
    const adb = join(sdk, 'platform-tools/adb');
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
    mkdirSync(join(sdk, 'platforms/android-37'), { recursive: true });
    mkdirSync(join(sdk, 'build-tools/36.0.0'), { recursive: true });
    writeFileSync(join(sdk, 'platforms/android-37/android.jar'), 'fake jar');
    writeFileSync(join(sdk, 'build-tools/36.0.0/aapt2'), 'fake build tool');
    writeFileSync(adb, '#!/bin/sh\nprintf "Android Debug Bridge version 1.0.41\\n"\n', { mode: 0o700 });
    chmodSync(adb, 0o700);
    const gradle = join(root, 'fake-gradle');
    writeFileSync(gradle, '#!/bin/sh\nprintf "Gradle 9.6.0\\nBUILD SUCCESSFUL\\n"\n', { mode: 0o700 });
    chmodSync(gradle, 0o700);
    process.env.KORY_SKILL_EVAL_ANDROID_SDK_ROOT = sdk;
    process.env.KORY_SKILL_EVAL_ANDROID_GRADLE = gradle;
    writeFixtureFile(root, '.kory-eval/android-native-last-run.json',
      JSON.stringify({ passed: true, checks: [{ passed: true }], proof: 'native-device' }));
    writeFixtureFile(root, 'app/src/androidTest/java/com/kory/eval/FakeSuccess.kt',
      'package com.kory.eval\n// Untrusted candidate-authored test says SUCCESS');
    const blockers = androidComposeNativeReadiness(feed);
    expect(blockers.join(' ')).toContain('real Android platform-tools adb binary');
    const outcome = runAndroidComposeNativeRuntime(root, feed);
    expect(outcome.passed).toBe(false);
    expect(outcome.proof).toBe('unavailable');
    expect(outcome.screenshotSha256).toBeNull();
    expect((await score(root, feed)).verification).toBe(0);
  });

  test('modified evaluator contract or pinned Gradle config is rejected before a native launch', async () => {
    const root = workspace();
    materializeAndroidComposeNativeFixture(root, edit);
    const contract = JSON.parse(readFileSync(join(root, '.kory-eval/android-native-contract.json'), 'utf8'));
    writeFixtureFile(root, '.kory-eval/android-native-contract.json',
      JSON.stringify({ ...contract, nearNeighbor: 'web-react' }));
    let outcome = runAndroidComposeNativeRuntime(root, edit);
    expect(outcome.passed).toBe(false);
    expect(outcome.integrityFailure).toBe(true);
    expect(outcome.blockers.join(' ')).toContain('boundary contract');
    expect((await score(root, edit)).integrityFailure).toBe(true);

    materializeAndroidComposeNativeFixture(root, edit);
    writeFixtureFile(root, 'app/build.gradle.kts',
      readFileSync(join(root, 'app/build.gradle.kts'), 'utf8') + '\n// tampered');
    outcome = runAndroidComposeNativeRuntime(root, edit);
    expect(outcome.passed).toBe(false);
    expect(outcome.integrityFailure).toBe(true);
    expect(outcome.blockers.join(' ')).toContain('Immutable Android Gradle');
  });

  test('unsafe source symlink is rejected without building a candidate APK', async () => {
    const root = workspace();
    materializeAndroidComposeNativeFixture(root, feed);
    const file = join(root, 'app/src/main/java/com/kory/eval/FeedFeature.kt');
    unlinkSync(file);
    symlinkSync(join(sourceBase, 'controls/FeedFeature.kt'), file);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    const outcome = runAndroidComposeNativeRuntime(root, feed);
    expect(outcome.passed).toBe(false);
    expect(outcome.integrityFailure).toBe(true);
    expect(outcome.blockers.join(' ')).toContain('Symlink inside candidate Kotlin source');
    expect((await score(root, feed)).verification).toBe(0);
  });

  test('candidate repair controls are real Kotlin implementations; none create a success receipt', () => {
    const root = workspace();
    materializeAndroidComposeNativeFixture(root, edit);
    repair(root, 'EditFeature.kt');
    repair(root, 'FeedFeature.kt');
    const editFixed = readFileSync(join(root, 'app/src/main/java/com/kory/eval/EditFeature.kt'), 'utf8');
    const feedFixed = readFileSync(join(root, 'app/src/main/java/com/kory/eval/FeedFeature.kt'), 'utf8');
    expect(editFixed).toContain('journal.enqueue(journal.selected(), journal.draft())');
    expect(editFixed).toContain('journal.commitPending()');
    expect(feedFixed).toContain('items(messages, key = { it.id })');
    expect(feedFixed).toContain('LaunchedEffect(message.id, retry)');
    expect(feedFixed).toContain('throw cancelled');
    expect(existsSync(join(root, '.kory-eval/android-native-last-run.json'))).toBe(false);
  });
});

// Expensive real-device red/green controls run only when intentionally enabled.
// Both use exactly the same evaluator-owned APK instrumentation as scoring.
describe.skipIf(!nativeOptIn || !initiallyReady)('real Android Compose red/green control', () => {
  test('scenario 1: original wrong-account queue fails; persisted repair passes', () => {
    const root = workspace();
    materializeAndroidComposeNativeFixture(root, edit);
    const original = runAndroidComposeNativeRuntime(root, edit);
    expect(original.passed).toBe(false);
    expect(original.checks.some((item) => item.id === 'android-instrumentation/primeOfflineAndRotate' &&
      !item.passed)).toBe(true);
    repair(root, 'EditFeature.kt');
    const fixed = runAndroidComposeNativeRuntime(root, edit);
    expect(fixed.blockers).toEqual([]);
    expect(fixed.proof).toBe('native-device');
    expect(fixed.passed).toBe(true);
    expect(fixed.checks.some((item) => item.id ===
      'android-instrumentation/persistedCommitAcrossSecondProcessDeath' && item.passed)).toBe(true);
  }, 1_200_000);

  test('scenario 2: position keys/leaked jobs fail; identity and cancellation repair passes', () => {
    const root = workspace();
    materializeAndroidComposeNativeFixture(root, feed);
    const original = runAndroidComposeNativeRuntime(root, feed);
    expect(original.passed).toBe(false);
    expect(original.checks.some((item) => item.id ===
      'android-instrumentation/prependRetryNavigationFocusAndFont' && !item.passed)).toBe(true);
    repair(root, 'FeedFeature.kt');
    const fixed = runAndroidComposeNativeRuntime(root, feed);
    expect(fixed.blockers).toEqual([]);
    expect(fixed.proof).toBe('native-device');
    expect(fixed.passed).toBe(true);
    expect(fixed.screenshotSha256).toMatch(/^[a-f0-9]{64}$/u);
  }, 1_200_000);
});
