import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-language-runtime-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

// Exercises the evaluator's real Bun runtime and TypeScript compiler, rather than
// asserting that its hidden test source happens to contain specific words.
const VALID_TIMEOUT = `export interface TimerRuntime {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const DEFAULT_TIMER: TimerRuntime = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? new DOMException('Aborted', 'AbortError')
    : signal.reason;
}
export function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal,
  timer: TimerRuntime = DEFAULT_TIMER,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let handle: unknown;
    let installed = false;
    const cleanup = () => {
      if (installed) {
        timer.clear(handle);
        installed = false;
      }
      callerSignal?.removeEventListener('abort', onCallerAbort);
    };
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onCallerAbort = () => {
      if (!callerSignal) return;
      const reason = abortReason(callerSignal);
      controller.abort(reason);
      settle(() => reject(reason));
    };
    if (callerSignal?.aborted) {
      onCallerAbort();
      return;
    }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    handle = timer.set(() => {
      const error = new Error('TIMEOUT');
      controller.abort(error);
      settle(() => reject(error));
    }, timeoutMs);
    installed = true;
    if (settled) {
      timer.clear(handle);
      installed = false;
      return;
    }
    try {
      Promise.resolve(operation(controller.signal)).then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function timeoutFixture() {
  const skill = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'typescript-javascript-engineering',
  )!;
  const scenario = buildSkillEvalSuiteV3(skill).scenarios.find(
    (item) => item.id === 'typescript-javascript-engineering-full-task-2-individual',
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-ts-timeout-fixture-'));
  roots.push(root);
  const materializer = LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  await materializer.materialize(root, scenario);
  writeFixtureFile(root, 'src/timeout.ts', VALID_TIMEOUT);
  writeFixtureFile(
    root,
    'tests/timeout.test.ts',
    `import { expect, test } from 'bun:test';
import { withTimeout, type TimerRuntime } from '../src/timeout';
test('success cleans up the timer and preserves underlying rejection', async () => {
  let cleared = 0;
  const timer: TimerRuntime = {
    set: () => undefined,
    clear: () => { cleared++; },
  };
  expect(await withTimeout(async () => 9, 10, undefined, timer)).toBe(9);
  expect(cleared).toBe(1);
  const reason = new Error('source');
  await expect(withTimeout(async () => { throw reason; }, 10, undefined, timer)).rejects.toBe(reason);
  expect(cleared).toBe(2);
});
test('caller abort cleans up the timer and propagates cancellation', async () => {
  const caller = new AbortController();
  let cleared = 0;
  const timer: TimerRuntime = { set: () => 1, clear: () => { cleared++; } };
  const pending = withTimeout(async (signal) => new Promise<number>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), 10, caller.signal, timer);
  const reason = new Error('caller-stop');
  caller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cleared).toBe(1);
});
`,
  );
  writeFixtureFile(
    root,
    '.kory-eval/typescript-timeout.json',
    JSON.stringify({
      boundary: 'JavaScript runtime cancellation versus static TypeScript type promises',
      hierarchy: { broader: 'implementation', adjacent: 'csharp-dotnet-engineering' },
      verification: { runtime: 'negative and recovery timer regression' },
    }),
  );
  return {
    root,
    materializer,
    scorer,
    input: {
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    },
  };
}

describe('TypeScript timeout evaluation boundary', () => {
  test('materialized fixture passes both runtime and repository typecheck gates', async () => {
    const { root, scorer, materializer, input } = await timeoutFixture();
    expect(materializer.id).toEndWith('@2');
    expect(scorer.id).toEndWith('@2');

    const green = await scorer.score(input);
    expect(green.passed).toBe(true);
    expect(green.verification).toBe(1);
    expect(green.evidence).toContain('repository typecheck: pass');

    // Bun executes valid JS here; the repository typecheck alone detects this.
    writeFixtureFile(root, 'src/timeout.ts', `${VALID_TIMEOUT}\nconst invalidType: string = 1;\n`);
    const staticFailure = await scorer.score(input);
    expect(staticFailure.passed).toBe(false);
    expect(staticFailure.verification).toBe(0);
    expect(staticFailure.evidence).toContain('terminal cleanup/cancellation: pass');
    expect(staticFailure.evidence).toContain('repository typecheck: fail');
  }, 30_000);

  test('real hidden runtime checks reject pre-abort, null-reason, and undefined-handle gaps', async () => {
    const { root, scorer, input } = await timeoutFixture();
    const regressions = [
      {
        from: 'if (callerSignal?.aborted) {',
        to: 'if (false) {',
      },
      {
        from: 'signal.reason === undefined',
        to: 'signal.reason == null',
      },
      {
        from: 'if (installed) {',
        to: 'if (handle !== undefined) {',
      },
    ];
    for (const regression of regressions) {
      expect(VALID_TIMEOUT).toContain(regression.from);
      writeFixtureFile(
        root,
        'src/timeout.ts',
        VALID_TIMEOUT.replace(regression.from, regression.to),
      );
      const result = await scorer.score(input);
      expect(result.passed).toBe(false);
      expect(result.evidence).toContain('terminal cleanup/cancellation: fail');
      expect(result.evidence).toContain('repository typecheck: pass');
    }
  }, 30_000);
});
