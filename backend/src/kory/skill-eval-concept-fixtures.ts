import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, writeFixtureFile } from './skill-eval-fixture-helpers';

export interface ConceptVector {
  name: string;
  input: unknown;
  expected: unknown;
}

export interface ConceptFixture {
  id: string;
  skill: string;
  contract: string;
  /** Bump when the public fixture contract or deterministic oracle changes. */
  generation?: number;
  /** Required evidence not furnished by this component harness; never silently waive it. */
  blockers?: readonly string[];
  vectors: () => ConceptVector[];
}

const STARTER = `// Implement the contract in README.md. Architecture and internal representation are yours.
export function solve(input: unknown): unknown {
  return null;
}
`;

function files(definition: ConceptFixture): Record<string, string> {
  return {
    'package.json': packageJson(`kory-eval-${definition.skill}`),
    'README.md': `# ${definition.skill}: transferable behavior exercise\n\n${definition.contract}\n\nImplement the pure solve(input) export in candidate.ts. Return JSON data; no network, subprocesses, or real account access is needed. Inputs vary identifiers, values, ordering, and failure paths. Score the supplied evidence; do not claim a real model, device, browser, codec, or permission sandbox ran.\n\n${definition.blockers?.length ? `Component coverage only. Full-task blockers:\n${definition.blockers.map((s) => `- ${s}`).join('\n')}` : 'The subject is an explicitly synthetic trace corpus. This tests evaluation logic, not the safety of a live model.'}\n`,
    'contract.json': `${JSON.stringify({ scenarioId: definition.id, evidence: 'synthetic', fullTaskBlockers: definition.blockers ?? [] }, null, 2)}\n`,
  };
}

// Inputs are sent to a bounded child; expected outcomes are compared in the parent, never in
// candidate-writable tests. This is process separation, NOT a hostile-code security sandbox.
const RUNNER = `
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const { solve } = await import('./candidate.ts');
const output = [];
for (const item of input) output.push(await solve(item));
process.stdout.write(JSON.stringify(output));
`;

export function scoreConceptFixture(
  definition: ConceptFixture,
  root: string,
): SkillEvalDeterministicScore {
  const fixedInputsIntact = () =>
    Object.entries(files(definition)).every(([path, expected]) => {
      try {
        return (
          lstatSync(join(root, path)).isFile() &&
          readFileSync(join(root, path), 'utf8') === expected
        );
      } catch {
        return false;
      }
    });
  let regularCandidate = false;
  try {
    regularCandidate = lstatSync(join(root, 'candidate.ts')).isFile();
  } catch {
    /* Missing candidate fails closed. */
  }
  if (!fixedInputsIntact() || !regularCandidate) {
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: true,
      evidence: [
        'Missing, altered, or symlinked fixed inputs/candidate; no candidate code executed.',
      ],
    };
  }
  const vectors = definition.vectors();
  const result = spawnSync('bun', ['--eval', RUNNER], {
    cwd: root,
    input: JSON.stringify(vectors.map((v) => v.input)),
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 256_000,
    env: { PATH: process.env.PATH ?? '', LANG: 'C', NO_COLOR: '1' },
  });
  if (!fixedInputsIntact()) {
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: true,
      evidence: ['Candidate changed fixed evaluator inputs during execution; results discarded.'],
    };
  }
  let actual: unknown = null;
  try {
    actual = JSON.parse(result.stdout ?? '');
  } catch {
    /* Invalid output is an ordinary failed evaluation, not a passing assertion. */
  }
  const outputs = Array.isArray(actual) ? actual : [];
  const matching = vectors.filter((v, index) => isDeepStrictEqual(outputs[index], v.expected));
  const passed =
    result.status === 0 && outputs.length === vectors.length && matching.length === vectors.length;
  return {
    passed,
    quality:
      result.status === 0 && outputs.length === vectors.length
        ? matching.length / vectors.length
        : 0,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `Synthetic behavioral vectors: ${matching.length}/${vectors.length}; full-task coverage: ${definition.blockers?.length ? 'incomplete' : 'synthetic evaluation protocol'}.`,
      ...vectors
        .filter((v, index) => !isDeepStrictEqual(outputs[index], v.expected))
        .map((v) => `Failed: ${v.name}`),
      ...(result.status !== 0
        ? [
            `Candidate process did not succeed: ${String(result.status)}; ${result.error?.message ?? 'nonzero exit'}`,
          ]
        : []),
    ],
  };
}

export function createConceptFixtures(definitions: readonly ConceptFixture[]): {
  materializers: SkillEvalFixtureMaterializer[];
  scorers: SkillEvalDeterministicScorer[];
} {
  return {
    materializers: definitions.map((definition) => ({
      id: `${definition.id}/concept@${definition.generation ?? 1}`,
      readinessBlockers: definition.blockers,
      matches: (scenario) => scenario.id === definition.id,
      materialize: (root) => {
        for (const [path, content] of Object.entries(files(definition)))
          writeFixtureFile(root, path, content);
        writeFixtureFile(root, 'candidate.ts', STARTER);
      },
    })),
    scorers: definitions.map((definition) => ({
      id: `${definition.id}/concept-scorer@${definition.generation ?? 1}`,
      scenarioIds: [definition.id],
      score: ({ workingDirectory }) => scoreConceptFixture(definition, workingDirectory),
    })),
  };
}
