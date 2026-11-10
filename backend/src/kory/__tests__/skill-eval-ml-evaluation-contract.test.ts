import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SYSTEMS_PROTOCOL_CONCEPTS,
  SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS,
} from '../skill-eval-systems-protocol-concept-fixtures';

const definition = SYSTEMS_PROTOCOL_CONCEPTS.find(
  (item) => item.id === 'ml-evaluation-full-task-1-individual',
)!;
const skillPackage = loadV5SkillPackages().packages.find(
  (item) => item.sidecar.name === definition.skill,
)!;
const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
  (item) => item.id === definition.id,
)!;
const materializer = SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find((item) =>
  item.matches(scenario),
)!;
const scorer = SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS.find((item) =>
  item.scenarioIds.includes(scenario.id),
)!;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Independent candidate implementation, executed through the real child-process scorer.
const candidate = `export function solve(input: any) {
  const trainAccounts = new Set(input.train.map((row: any) => row.account));
  const trainFingerprints = new Set(input.train.map((row: any) => row.fingerprint));
  const eligible: any[] = [];
  const leakage: string[] = [];
  for (const row of input.rows) {
    if (row.label !== 0 && row.label !== 1) continue;
    if (row.time <= input.cutoff || trainAccounts.has(row.account) || trainFingerprints.has(row.fingerprint)) {
      leakage.push(row.id);
    } else eligible.push(row);
  }
  const reviewed = [...eligible]
    .sort((left, right) => right.probability - left.probability || left.id.localeCompare(right.id))
    .slice(0, input.reviewCapacity);
  const positives = eligible.filter((row) => row.label === 1).length;
  const hits = reviewed.filter((row) => row.label === 1).length;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    eligibleIds: eligible.map((row) => row.id),
    leakageIds: leakage,
    reviewedIds: reviewed.map((row) => row.id),
    precision: reviewed.length ? round(hits / reviewed.length) : 0,
    recall: positives ? round(hits / positives) : 0,
  };
}
`;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kory-ml-evaluation-contract-'));
  roots.push(root);
  await materializer.materialize(root, scenario);
  return root;
}

async function score(root: string, source: string) {
  writeFileSync(join(root, 'candidate.ts'), source);
  return scorer.score({
    scenario,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
}

describe('ml-evaluation evaluator contract', () => {
  test('generation 3 README and scorer share the exact cutoff/train/rows contract', async () => {
    const root = await setup();
    expect(definition.generation).toBe(3);
    expect(materializer.id).toEndWith('/concept@3');
    expect(scorer.id).toEndWith('/concept-scorer@3');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain(definition.contract);
    expect(readme).toContain('Input is exactly {cutoff,reviewCapacity,train,rows}');
    expect(readme).toContain('row.time > cutoff');
    expect(readme).toContain('only numeric label === 0 or label === 1 is valid');
    expect(readme).toContain(
      'Return exactly {eligibleIds,leakageIds,reviewedIds,precision,recall}',
    );
    expect(readme).not.toContain('finalExamples');
    for (const vector of definition.vectors()) {
      expect(Object.keys(vector.input as object).sort()).toEqual([
        'cutoff',
        'reviewCapacity',
        'rows',
        'train',
      ]);
    }
    const result = await score(root, candidate);
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.quality).toBe(1);
    expect(result.verification).toBe(1);
  });

  for (const mutation of [
    {
      name: 'omitted temporal gate',
      from: 'row.time <= input.cutoff || ',
      to: '',
      failedVector: 'temporal and account leakage are removed before threshold evaluation',
    },
    {
      name: 'admitting the exact cutoff boundary',
      from: 'row.time <= input.cutoff',
      to: 'row.time < input.cutoff',
      failedVector: 'temporal and account leakage are removed before threshold evaluation',
    },
    {
      name: 'checking only equality and admitting earlier rows',
      from: 'row.time <= input.cutoff',
      to: 'row.time === input.cutoff',
      failedVector: 'temporal and account leakage are removed before threshold evaluation',
    },
    {
      name: 'omitted account leakage gate',
      from: 'trainAccounts.has(row.account) || ',
      to: '',
      failedVector: 'temporal and account leakage are removed before threshold evaluation',
    },
    {
      name: 'omitted fingerprint leakage gate',
      from: ' || trainFingerprints.has(row.fingerprint)',
      to: '',
      failedVector: 'temporal and account leakage are removed before threshold evaluation',
    },
    {
      name: 'missing labels admitted to ranking and precision denominator',
      from: 'if (row.label !== 0 && row.label !== 1) continue;',
      to: '',
      failedVector: 'missing labels are excluded from denominator',
    },
    {
      name: 'missing labels counted in recall denominator despite correct ID filtering',
      from: 'const positives = eligible.filter((row) => row.label === 1).length;',
      to: 'const positives = input.rows.filter((row: any) => row.label === 1 || row.label == null).length;',
      failedVector: 'missing labels are excluded from denominator',
    },
    {
      name: 'non-binary labels accepted as valid',
      from: 'if (row.label !== 0 && row.label !== 1) continue;',
      to: 'if (row.label == null) continue;',
      failedVector: 'invalid labels are excluded before leakage classification and ranking',
    },
  ]) {
    test(`scorer rejects ${mutation.name}`, async () => {
      const root = await setup();
      const mutated = candidate.replace(mutation.from, mutation.to);
      expect(mutated).not.toBe(candidate);
      const result = await score(root, mutated);
      expect(result.passed).toBe(false);
      expect(result.verification).toBe(0);
      expect(result.integrityFailure).toBe(false);
      expect(result.evidence).toContain(`Failed: ${mutation.failedVector}`);
      expect(
        result.evidence.some((line) => line.startsWith('Candidate process did not succeed')),
      ).toBe(false);
    });
  }
});
