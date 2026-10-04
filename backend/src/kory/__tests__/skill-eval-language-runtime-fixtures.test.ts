import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS,
} from '../skill-eval-language-runtime-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('language runtime skill fixtures', () => {
  test('TypeScript webhook scorer observes the repository typecheck', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'typescript-javascript-engineering',
    )!;
    const scenario = buildSkillEvalSuiteV3(skill).scenarios.find(
      (item) => item.id === 'typescript-javascript-engineering-full-task-1-individual',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-ts-runtime-green-'));
    roots.push(root);
    const materializer = LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    await materializer.materialize(root, scenario);

    const validSource = `export type DomainEvent =
  | { type: 'created'; version: 1; payload: { id: string; amount: number } }
  | { type: 'deleted'; version: 1; payload: { id: string; hard: boolean } };
export type ParseResult =
  | { ok: true; event: DomainEvent }
  | { ok: false; error: 'INVALID_SHAPE' | 'MISSING_DISCRIMINATOR' | 'UNKNOWN_TYPE' | 'UNKNOWN_VERSION' };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parseWebhook(input: unknown): ParseResult {
  if (!isRecord(input)) return { ok: false, error: 'INVALID_SHAPE' };
  if (!Object.prototype.hasOwnProperty.call(input, 'type') || !Object.prototype.hasOwnProperty.call(input, 'version')) return { ok: false, error: 'MISSING_DISCRIMINATOR' };
  if (input.type !== 'created' && input.type !== 'deleted') return { ok: false, error: 'UNKNOWN_TYPE' };
  if (input.version !== 1) return { ok: false, error: 'UNKNOWN_VERSION' };
  if (!isRecord(input.payload) || typeof input.payload.id !== 'string') return { ok: false, error: 'INVALID_SHAPE' };
  if (input.type === 'created') {
    if (typeof input.payload.amount !== 'number' || !Number.isFinite(input.payload.amount)) return { ok: false, error: 'INVALID_SHAPE' };
    return { ok: true, event: { type: 'created', version: 1, payload: { id: input.payload.id, amount: input.payload.amount } } };
  }
  if (typeof input.payload.hard !== 'boolean') return { ok: false, error: 'INVALID_SHAPE' };
  return { ok: true, event: { type: 'deleted', version: 1, payload: { id: input.payload.id, hard: input.payload.hard } } };
}
export function handleEvent(event: DomainEvent): string {
  switch (event.type) {
    case 'created': return 'created:' + event.payload.id + ':' + event.payload.amount;
    case 'deleted': return 'deleted:' + event.payload.id + ':' + String(event.payload.hard);
  }
}
`;
    writeFixtureFile(root, 'src/webhook.ts', validSource);
    writeFixtureFile(
      root,
      'tests/webhook.test.ts',
      `import { expect, test } from 'bun:test';
import { parseWebhook } from '../src/webhook';
test('unknown version and malformed nested amount are rejected', () => {
  expect(parseWebhook({ type: 'created', version: 2, payload: { id: 'a', amount: 1 } })).toEqual({ ok: false, error: 'UNKNOWN_VERSION' });
  expect(parseWebhook({ type: 'created', version: 1, payload: { id: 'a', amount: 'bad' } })).toEqual({ ok: false, error: 'INVALID_SHAPE' });
});
`,
    );
    writeFixtureFile(
      root,
      '.kory-eval/typescript-webhook.json',
      `${JSON.stringify(
        {
          boundary: { runtime: 'validated unknown input', static: 'strict discriminated union' },
          moduleRuntime: { runtime: 'Bun', module: 'ESNext' },
          hierarchy: { broader: 'implementation', adjacent: 'c-cpp-systems-engineering' },
          evidence: { typecheck: 'repository strict noEmit', runtime: 'negative and success tests' },
        },
        null,
        2,
      )}\n`,
    );
    const input = {
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    };
    const green = await scorer.score(input);
    expect(scorer.id).toEndWith('@2');
    expect(green.passed).toBe(true);
    expect(green.verification).toBe(1);
    expect(green.evidence).toContain('repository typecheck: pass');

    writeFixtureFile(root, 'src/webhook.ts', `${validSource}\nconst typecheckOnlyFailure: string = 1;\n`);
    const staticFailure = await scorer.score(input);
    expect(staticFailure.passed).toBe(false);
    expect(staticFailure.verification).toBe(0);
    expect(staticFailure.evidence).toContain('repository typecheck: fail');
  });
});
