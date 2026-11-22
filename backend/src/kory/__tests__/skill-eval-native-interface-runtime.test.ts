import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NATIVE_INTERFACE_DESKTOP_SCENARIO,
  NATIVE_INTERFACE_SKILL_EVAL_MATERIALIZERS,
  NATIVE_INTERFACE_SKILL_EVAL_SCORERS,
  NATIVE_INTERFACE_TOOLCHAIN,
  nativeInterfaceToolchain,
} from '../../eval/skills/skill-eval-native-interface-runtime';

const scratch: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-native-interface-'));
  scratch.push(root);
  return root;
}

afterAll(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true });
});

const materializer = NATIVE_INTERFACE_SKILL_EVAL_MATERIALIZERS[0]!;
const scorer = NATIVE_INTERFACE_SKILL_EVAL_SCORERS[0]!;

const scenario = {
  id: NATIVE_INTERFACE_DESKTOP_SCENARIO,
  kind: 'full-task',
} as never;

async function score(root: string) {
  return (await scorer.score({
    workingDirectory: root,
    scenario,
  } as never)) as {
    passed: boolean;
    verification?: number;
    evidence?: string[];
  };
}

function names(result: { evidence?: string[] }): string[] {
  return (result.evidence ?? [])
    .filter((line) => line.includes(': pass'))
    .map((line) => line.slice(0, line.indexOf(': pass')));
}

function detail(result: { evidence?: string[] }, check: string): string {
  return (result.evidence ?? []).find((line) => line.startsWith(`${check}:`)) ?? '';
}

describe('native-interface AppKit runtime', () => {
  test('materializer writes the evaluator owned shell and a defective starter', () => {
    const root = workspace();
    materializer.materialize(root);
    const shell = readFileSync(join(root, 'main.swift'), 'utf8');
    expect(shell).toContain('NSApplication.shared');
    expect(shell).toContain('firstResponder');
    expect(shell).toContain('cacheDisplay');
    const starter = readFileSync(join(root, 'OperationsModel.swift'), 'utf8');
    expect(starter).toContain('func saveableState() -> [String: Any] { return [:] }');
    expect(readFileSync(join(root, 'build.sh'), 'utf8')).toContain('XcodeDefault.xctoolchain');
  });

  test('toolchain discovery is by absolute path and reports a blocker when absent', () => {
    const found = nativeInterfaceToolchain();
    expect(found.swiftc === null).toBe(found.blocker !== null);
    expect(found.sdk === null).toBe(found.blocker !== null);
  });

  test('the starter fails exactly the checks it is wrong about', async () => {
    if (NATIVE_INTERFACE_TOOLCHAIN.blocker) return;
    const root = workspace();
    materializer.materialize(root);
    const result = await score(root);
    const passed = names(result);
    expect(passed).toContain('evaluator owned fixture inputs');
    expect(passed).toContain('desktop-native-platform-contract');
    expect(passed).not.toContain('desktop-native-job-state');
    expect(passed).not.toContain('desktop-native-input-focus');
    expect(passed).not.toContain('desktop-native-resize-scaling');
    expect(passed).not.toContain('desktop-native-restoration-proof');
    expect(passed).not.toContain('verification artifact matches the window');
    expect(detail(result, 'desktop-native-resize-scaling')).toContain('outside bounds');
  }, 240_000);

  test('a candidate that mutates the shell is refused', async () => {
    if (NATIVE_INTERFACE_TOOLCHAIN.blocker) return;
    const root = workspace();
    materializer.materialize(root);
    const shellPath = join(root, 'main.swift');
    Bun.write(shellPath, `${readFileSync(shellPath, 'utf8')}\n// tampered\n`).catch(() => {});
    const result = await score(root);
    expect(names(result)).not.toContain('evaluator owned fixture inputs');
    expect(names(result)).not.toContain('desktop-native-platform-contract');
  }, 240_000);
});
