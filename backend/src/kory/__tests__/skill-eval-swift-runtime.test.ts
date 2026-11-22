import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as platform from '../../runtime/platform';
import { auditSkillEvalExecutionReadiness } from '../../eval/skills/skill-eval-execution';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SWIFT_SKILL_EVAL_MATERIALIZERS,
  SWIFT_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-swift-fixtures';
import { runSwiftProgram, swiftRuntimeReadiness } from '../../eval/skills/skill-eval-swift-runtime';

const keys = [
  'DEVELOPER_DIR',
  'SDKROOT',
  'OPENAI_API_KEY',
  'DYLD_INSERT_LIBRARIES',
  'SWIFTFLAGS',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kory-swift-runtime-unit-'));
  roots.push(root);
  const developerDir = join(root, 'Xcode with spaces.app', 'Contents', 'Developer');
  mkdirSync(developerDir, { recursive: true });
  // Unique selections keep mocked readiness out of real native controls, even in one process.
  process.env.DEVELOPER_DIR = developerDir;
  const mac = spyOn(platform, 'isMac').mockReturnValue(true);
  const spawn = spyOn(childProcess, 'spawnSync').mockImplementation(
    (command) =>
      ({
        status: 0,
        signal: null,
        stdout: command === '/usr/bin/xcrun' ? '' : 'KORY_SWIFT_READY\nKORY_SWIFT_OK\n',
        stderr: '',
      }) as never,
  );
  restorers.push(
    () => spawn.mockRestore(),
    () => mac.mockRestore(),
  );
  return { root, developerDir, spawn, mac };
}

describe('Swift runtime readiness and caller-selected compiler contract', () => {
  test('known-good probe and candidates share flags, selection, bounds and stripped environments', () => {
    const { root, developerDir, spawn } = setup();
    process.env.OPENAI_API_KEY = 'test-secret';
    process.env.DYLD_INSERT_LIBRARIES = '/untrusted/injected.dylib';
    process.env.SWIFTFLAGS = '-suppress-warnings';
    delete process.env.SDKROOT;
    let probeSource = '';
    spawn.mockImplementation((command, args) => {
      if (command === '/usr/bin/xcrun') probeSource = readFileSync(String(args![4]), 'utf8');
      return { status: 0, signal: null, stdout: 'KORY_SWIFT_READY\n', stderr: '' } as never;
    });
    const readiness = swiftRuntimeReadiness();
    expect(readiness.reasons).toEqual([]);
    expect(readiness.evidence).toContain('swiftc passed');
    expect(probeSource).toContain('import Foundation');
    expect(probeSource).toContain('actor Probe');
    expect(probeSource).toContain('await Probe().value()');
    expect(spawn).toHaveBeenCalledTimes(2);
    const compileCall = spawn.mock.calls[0]!;
    const probeOptions = compileCall[2] as childProcess.SpawnSyncOptions;
    expect(existsSync(String(probeOptions.cwd))).toBe(false);

    spawn.mockImplementation(
      () => ({ status: 0, signal: null, stdout: 'KORY_SWIFT_OK\n', stderr: '' }) as never,
    );
    const candidate = runSwiftProgram(
      root,
      ['candidate.swift', 'hidden.swift'],
      join(root, 'candidate'),
      'KORY_SWIFT_OK',
    );
    expect(candidate.passed).toBe(true);
    expect(spawn.mock.calls[2]![0]).toBe(compileCall[0]);
    expect(spawn.mock.calls[2]![1]!.slice(0, 4)).toEqual(compileCall[1]!.slice(0, 4));
    expect(compileCall[1]!.slice(0, 4)).toEqual([
      'swiftc',
      '-parse-as-library',
      '-strict-concurrency=complete',
      '-warnings-as-errors',
    ]);
    for (const [index, call] of spawn.mock.calls.entries()) {
      const options = call[2] as childProcess.SpawnSyncOptions;
      const compiling = index % 2 === 0;
      expect(options.timeout).toBe(compiling ? 90_000 : 12_000);
      expect(options.killSignal).toBe('SIGKILL');
      expect(options.env!.HOME).toBe(options.cwd);
      expect(options.env!.TMPDIR).toBe(options.cwd);
      expect(options.env!.DEVELOPER_DIR).toBe(
        compiling ? platform.canonicalizePath(developerDir) : undefined,
      );
      for (const key of ['OPENAI_API_KEY', 'DYLD_INSERT_LIBRARIES', 'SWIFTFLAGS', 'SDKROOT'])
        expect(options.env![key]).toBeUndefined();
    }
  });

  test('caller-selected macOS SDK reaches the compiler without leaking ambient SDKROOT', () => {
    const { root, developerDir, spawn } = setup();
    const sdkRoot = join(root, 'MacOSX26.5.sdk');
    mkdirSync(sdkRoot);
    writeFileSync(join(sdkRoot, 'SDKSettings.json'), '{}');
    process.env.SDKROOT = '/untrusted/sdk';
    const result = runSwiftProgram(root, ['source.swift'], join(root, 'candidate'), 'KORY_SWIFT_OK', {
      developerDir, sdkRoot,
    });
    expect(result.passed).toBe(true);
    const compile = spawn.mock.calls[0]!;
    expect(compile[1]).toContain('-sdk');
    expect(compile[1]).toContain(platform.canonicalizePath(sdkRoot));
    expect((compile[2] as childProcess.SpawnSyncOptions).env!.SDKROOT).toBeUndefined();
    expect(runSwiftProgram(root, ['source.swift'], join(root, 'candidate'), 'KORY_SWIFT_OK', {
      developerDir, sdkRoot: '/missing/sdk',
    }).passed).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('default selection stays unset and explicit selection never falls back after compiler failure', () => {
    const { root, spawn } = setup();
    runSwiftProgram(root, ['source.swift'], join(root, 'candidate'), 'KORY_SWIFT_OK', {});
    expect(
      (spawn.mock.calls[0]![2] as childProcess.SpawnSyncOptions).env!.DEVELOPER_DIR,
    ).toBeUndefined();
    spawn.mockClear();
    spawn.mockImplementation(
      () =>
        ({
          status: 1,
          signal: null,
          stdout: '',
          stderr: 'SDK was built with a different Swift compiler',
        }) as never,
    );
    const failed = swiftRuntimeReadiness();
    expect(failed.reasons.join('\n')).toContain('SDK was built with a different Swift compiler');
    expect(failed.evidence).not.toContain('swiftc passed');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('unavailable and timed-out compiler diagnostics survive without executing a binary', () => {
    const { root, spawn } = setup();
    for (const code of ['ENOENT', 'ETIMEDOUT']) {
      spawn.mockClear();
      spawn.mockImplementation(
        () =>
          ({
            status: null,
            signal: null,
            stdout: '',
            stderr: 'compiler diagnostic',
            error: new Error(`spawnSync /usr/bin/xcrun ${code}`),
          }) as never,
      );
      const result = runSwiftProgram(
        root,
        ['source.swift'],
        join(root, 'candidate'),
        'KORY_SWIFT_OK',
      );
      expect(result.passed).toBe(false);
      expect(result.evidence).toContain(code);
      expect(result.evidence).toContain('compiler diagnostic');
      expect(result.evidence).not.toContain('swiftc passed');
      expect(spawn).toHaveBeenCalledTimes(1);
    }
  });

  for (const failure of [
    { name: 'absent receipt', status: 0, signal: null, stdout: '' },
    { name: 'nonzero exit', status: 1, signal: null, stdout: 'KORY_SWIFT_READY\n' },
    { name: 'signal', status: null, signal: 'SIGKILL', stdout: 'KORY_SWIFT_READY\n' },
    {
      name: 'timeout',
      status: null,
      signal: null,
      stdout: 'KORY_SWIFT_READY\n',
      error: new Error('ETIMEDOUT'),
    },
  ]) {
    test(`successful compilation cannot establish readiness with runtime ${failure.name}`, () => {
      const { spawn } = setup();
      spawn.mockImplementation(
        (command) =>
          (command === '/usr/bin/xcrun'
            ? { status: 0, signal: null, stdout: '', stderr: '' }
            : { ...failure, stderr: 'runtime diagnostic' }) as never,
      );
      const result = swiftRuntimeReadiness();
      expect(result.reasons.join('\n')).toContain('Swift runtime unavailable');
      expect(result.evidence).toContain('swiftc passed');
      expect(result.evidence).toContain('runtime diagnostic');
      expect(spawn).toHaveBeenCalledTimes(2);
    });
  }

  test('invalid developer selections and unsupported hosts block before any spawn', () => {
    const { root, developerDir, spawn, mac } = setup();
    const file = join(root, 'file');
    writeFileSync(file, 'not a directory');
    for (const value of ['', 'relative', join(root, 'missing'), file, `${root}\n`, `${root}\0`]) {
      expect(swiftRuntimeReadiness({ developerDir: value }).reasons.join('\n')).toContain(
        'DEVELOPER_DIR',
      );
    }
    mac.mockReturnValue(false);
    expect(swiftRuntimeReadiness({}).reasons.join('\n')).toContain('requires macOS');
    expect(swiftRuntimeReadiness({ developerDir }).reasons.join('\n')).toContain('requires macOS');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('readiness caches successes and failures by canonical caller-selected toolchain', () => {
    const { root, developerDir, spawn } = setup();
    // The explicit alias check below selects only DEVELOPER_DIR. Keep the
    // ambient default on that same selection even when the test runner has
    // a caller-selected SDKROOT for real native tests.
    delete process.env.SDKROOT;
    spawn.mockImplementation(
      () => ({ status: 1, signal: null, stdout: '', stderr: 'unavailable selected SDK' }) as never,
    );
    const failed = swiftRuntimeReadiness();
    expect(swiftRuntimeReadiness()).toBe(failed);
    expect(spawn).toHaveBeenCalledTimes(1);
    const alias = join(root, 'developer-alias');
    symlinkSync(developerDir, alias, platform.directoryLinkType());
    expect(swiftRuntimeReadiness({ developerDir: alias })).toBe(failed);
    expect(spawn).toHaveBeenCalledTimes(1);
    const other = join(root, 'other-developer');
    mkdirSync(other);
    spawn.mockImplementation(
      () => ({ status: 0, signal: null, stdout: 'KORY_SWIFT_READY\n', stderr: '' }) as never,
    );
    const ready = swiftRuntimeReadiness({ developerDir: other });
    expect(ready.reasons).toEqual([]);
    expect(swiftRuntimeReadiness({ developerDir: other })).toBe(ready);
    expect(swiftRuntimeReadiness()).toBe(failed);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  test('both Swift evaluators remain registered but unavailable runtimes earn no verification', async () => {
    const { root, spawn } = setup();
    spawn.mockImplementation(
      () => ({ status: 1, signal: null, stdout: '', stderr: 'SDK/compiler mismatch' }) as never,
    );
    const pkg = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'swift-engineering',
    )!;
    const rows = auditSkillEvalExecutionReadiness(
      [pkg],
      SWIFT_SKILL_EVAL_MATERIALIZERS,
      SWIFT_SKILL_EVAL_SCORERS,
    );
    expect(rows).toHaveLength(2);
    for (const scenario of buildSkillEvalSuiteV3(pkg).scenarios.filter(
      (item) => item.category === 'full-task',
    )) {
      const materializer = SWIFT_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
      const scorer = SWIFT_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenario.id),
      )!;
      expect(materializer.realRuntime).toBe(true);
      const row = rows.find((item) => item.scenarioId === scenario.id)!;
      expect(row.materializerId).toBe(materializer.id);
      expect(row.deterministicScorerId).toBe(scorer.id);
      expect(row.ready).toBe(false);
      expect(row.reasons.join('\n')).toContain('SDK/compiler mismatch');
      // Source-only materialization is still available for mandatory fixture checks.
      const destination = join(root, scenario.id);
      await materializer.materialize(destination, scenario);
      expect(existsSync(join(destination, 'README.md'))).toBe(true);
      const score = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: destination,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed).toBe(false);
      expect(score.verification).toBe(0);
      expect(score.integrityFailure).toBe(false);
      expect(score.evidence.join('\n')).toContain('SDK/compiler mismatch');
      expect(existsSync(join(destination, '__KoryHidden.swift'))).toBe(false);
    }
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
