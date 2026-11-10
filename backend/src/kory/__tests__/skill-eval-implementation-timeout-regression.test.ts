import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS,
  CORE_EXECUTION_SKILL_EVAL_SCORERS,
} from '../skill-eval-core-execution-fixtures';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';

const roots: string[] = [];
const materializer = CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS.find(
  (item) => item.id === 'implementation/use-existing-timeout@1',
)!;
const scorer = CORE_EXECUTION_SKILL_EVAL_SCORERS.find(
  (item) => item.scenarioIds.includes('implementation-full-task-2'),
)!;

async function candidate() {
  const root = mkdtempSync(join(tmpdir(), 'kory-implementation-timeout-'));
  roots.push(root);
  await materializer.materialize(root, { id: 'implementation-full-task-2' } as never);
  const original = readFileSync(join(root, 'src/runtime.ts'), 'utf8');
  const fixed = original.replace('runProvider(input, 30000, observe)', 'runProvider(input, options.timeoutMs, observe)');
  expect(fixed).not.toBe(original);
  writeFixtureFile(root, 'src/runtime.ts', fixed);
  return { root, fixed };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('implementation timeout scorer isolation and regression evidence', () => {
  test('requires a candidate-authored non-default timeout regression', async () => {
    const { root } = await candidate();
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.evidence.join('\n')).toContain('candidate-authored regression');
  });

  test('rejects a red regression that mutates replay files and preserves the submission', async () => {
    const { root, fixed } = await candidate();
    const marker = 'Unrelated candidate workspace file must remain intact.\n';
    writeFixtureFile(root, 'notes/unrelated.txt', marker);
    writeFixtureFile(root, 'tests/runtime.test.ts', `import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { executeRequest } from '../src/runtime';

test('non-default timeout is observed at the provider call', async () => {
  let observed = -1;
  await executeRequest('ok', { timeoutMs: 1234 }, (timeout) => { observed = timeout; });
  if (observed !== 1234) {
    writeFileSync(new URL('../notes/unrelated.txt', import.meta.url), 'test wrote into workspace\\n');
  }
  expect(observed).toBe(1234);
});
`);
    const beforeTest = readFileSync(join(root, 'tests/runtime.test.ts'), 'utf8');
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.evidence.join('\n')).toContain('source/test integrity: modified');
    expect(readFileSync(join(root, 'src/runtime.ts'), 'utf8')).toBe(fixed);
    expect(readFileSync(join(root, 'tests/runtime.test.ts'), 'utf8')).toBe(beforeTest);
    expect(readFileSync(join(root, 'notes/unrelated.txt'), 'utf8')).toBe(marker);
  });

  test('accepts a clean candidate-authored non-default timeout red/green regression', async () => {
    const { root, fixed } = await candidate();
    writeFixtureFile(root, 'tests/runtime.test.ts', `import { expect, test } from 'bun:test';
import { executeRequest } from '../src/runtime';

test('non-default timeout is observed at the provider call', async () => {
  let observed = -1;
  expect(await executeRequest('ok', { timeoutMs: 1234 }, (value) => { observed = value; })).toBe('OK');
  expect(observed).toBe(1234);
});
`);
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.verification).toBe(1);
    expect(result.evidence.join('\n')).toContain('candidate-authored regression red/green: observed');
    expect(readFileSync(join(root, 'src/runtime.ts'), 'utf8')).toBe(fixed);
  });

  test('rejects candidate-authored tests that still pass the broken timeout', async () => {
    const { root } = await candidate();
    writeFixtureFile(root, 'tests/runtime.test.ts', `import { expect, test } from 'bun:test';
import { executeRequest } from '../src/runtime';

test('passes a non-default timeout argument without observing its propagation', async () => {
  expect(await executeRequest('ok', { timeoutMs: 1234 })).toBe('OK');
});
`);
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.verification).toBe(0);
    expect(result.evidence.join('\n')).toContain('candidate-authored regression red/green: not observed');
  });
});
