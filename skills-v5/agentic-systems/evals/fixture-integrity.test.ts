/** Package-local authoring and evaluator-integrity checks, not qualification evidence. */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  AI_PROTOCOL_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-ai-protocol-concept-fixtures';
import { buildSkillEvalSuiteV3 } from '../../../backend/src/kory/skill-eval-harness';
import { validateV5SkillPackage } from '../../../backend/src/kory/skill-packages';
import {
  isDirectSkillSelection,
  listSkills,
  resolveSkills,
} from '../../../backend/src/kory/skills';

const directory = resolve(import.meta.dir, '..');
const projectRoot = resolve(directory, '../..');
const validation = validateV5SkillPackage(directory);
const pkg = validation.package!;

test('package validates with current source freshness and separate blind scorer contracts', () => {
  expect(validation.valid, validation.errors.join('\n')).toBe(true);
  expect(validation.warnings).toEqual([]);
  expect(pkg.evaluation.tasks).toHaveLength(2);
  for (const task of pkg.evaluation.tasks) {
    expect(task.scorers.reduce((sum, scorer) => sum + scorer.weight, 0)).toBeCloseTo(1);
    const blind = task.scorers.find((scorer) => scorer.kind === 'blind-semantic');
    expect(blind?.blindTo).toEqual(expect.arrayContaining(['skill-variant', 'expected-outcome']));
  }
});

test('source-map dates match the sidecar and authored relative links resolve within the package', () => {
  const sourceMap = readFileSync(join(directory, 'references/sources.md'), 'utf8');
  for (const source of pkg.sidecar.sources) {
    const entry = sourceMap.split('\n- **').find((part) => part.includes(`: ${source.url}\n`));
    expect(entry, source.url).toBeDefined();
    expect(entry).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
  for (const path of [
    'SKILL.md',
    'references/sources.md',
    'references/execution-decisions.md',
    'evals/README.md',
  ]) {
    const absolute = join(directory, path);
    const markdown = readFileSync(absolute, 'utf8');
    for (const [, link] of markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(link!)) continue;
      const target = resolve(dirname(absolute), link!);
      const local = relative(directory, target);
      expect(
        isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\'),
      ).toBe(false);
      expect(existsSync(target), target).toBe(true);
    }
  }
});

test('execution-state verification boundaries remain explicit in the package contract', () => {
  const skill = readFileSync(join(directory, 'SKILL.md'), 'utf8');
  const runbook = readFileSync(join(directory, 'references/execution-decisions.md'), 'utf8');
  const README = readFileSync(join(directory, 'evals/README.md'), 'utf8');
  const traceFixture = readFileSync(join(directory, 'evals/fixtures/trace-evidence.json'), 'utf8');
  const normalize = (text: string) => text.replace(/\s+/g, ' ');
  const normalizedSkill = normalize(skill);
  const normalizedRunbook = normalize(runbook);
  const normalizedREADME = normalize(README);
  const scenario = JSON.parse(
    readFileSync(join(directory, 'evals/tasks/scenario-1.json'), 'utf8'),
  ) as {
    environment: { requirements: string[] };
    falsifiableChecks: Array<{ id: string; assertion: string }>;
  };

  expect(normalizedSkill).toContain(
    'Only a fresh `observe` event may advance `latestObservedRevision`',
  );
  expect(normalizedSkill).toContain(
    'A fresh `healthy: false` result clears any prior healthy state',
  );
  expect(normalizedSkill).toContain(
    'every fresh observation invalidate the prior completion verification',
  );
  expect(normalizedRunbook).toContain(
    'A verify-only result cannot establish or advance the observed revision',
  );
  expect(normalizedRunbook).toContain(
    'a fresh unhealthy result removes any prior healthy completion',
  );
  expect(normalizedRunbook).toContain(
    'increments the evidence generation and invalidates a previously healthy terminal check',
  );
  expect(normalizedREADME).toContain(
    'verify-only event cannot create or advance the current observed revision',
  );
  expect(normalizedSkill).toContain('object-valued JSON identifiers');
  expect(normalizedSkill).toContain('**live authority**, **recovery**, **tool integration**');
  expect(normalizedRunbook).toContain('structural JSON equality');
  expect(normalizedREADME).toContain('independently parsed JSON objects');
  expect(traceFixture).toContain('"fixtureKind": "package-local-trace-contract"');
  expect(scenario.environment.requirements).toContain(
    'verify-only events cannot establish the observed revision, fresh unhealthy verification replaces healthy state, and new mutations or observations invalidate prior health evidence',
  );
  expect(
    scenario.falsifiableChecks.find((check) => check.id === 'verification-discipline')?.assertion,
  ).toContain('Verify-only cannot advance latestObservedRevision');
});

test('trace fixture covers required negative and recovery paths without claiming execution', () => {
  const fixture = JSON.parse(
    readFileSync(join(directory, 'evals/fixtures/trace-evidence.json'), 'utf8'),
  ) as {
    executionStatus: string;
    observedResult: unknown;
    evidenceBoundary: {
      unverifiedObligations: Array<{
        id: string;
        owner: string;
        status: string;
        missingProof: string;
      }>;
    };
    structuralIdentifierReconciliation: {
      examples: Array<{
        left: unknown;
        right: unknown;
        structurallyEquivalent: boolean;
        objectIdentityEquivalent: boolean;
      }>;
    };
    traces: Array<{
      id: string;
      scenarioId: string;
      executionStatus: string;
      observedResult: unknown;
      requiredTrace: Array<{
        step: number;
        event: string;
        expectedState: string;
        expectedDecision: string;
        budgetCharge: number;
      }>;
      missingEvidence: string;
    }>;
  };

  expect(fixture.executionStatus).toBe('unverified');
  expect(fixture.observedResult).toBeNull();
  expect(fixture.evidenceBoundary.unverifiedObligations.map((item) => item.id)).toEqual([
    'live-authority',
    'recovery',
    'tool-integration',
    'external-completion-oracle',
  ]);
  for (const obligation of fixture.evidenceBoundary.unverifiedObligations) {
    expect(obligation.owner).toBeTruthy();
    expect(obligation.status).toBe('unverified');
    expect(obligation.missingProof).toBeTruthy();
  }

  for (const example of fixture.structuralIdentifierReconciliation.examples) {
    expect(example.objectIdentityEquivalent).toBe(false);
    if (example.structurallyEquivalent) expect(example.left).toEqual(example.right);
    else expect(example.left).not.toEqual(example.right);
  }

  const requiredTraceIds = [
    'scenario-1-approved-current-success',
    'scenario-1-healthy-at-entry-zero-write',
    'scenario-1-approval-denied',
    'scenario-1-deployment-race',
    'scenario-1-timeout-after-remote-apply',
    'scenario-1-no-progress-budget-exhausted',
    'scenario-1-unavailable-completion-oracle',
    'scenario-1-verify-only',
    'scenario-1-fresh-unhealthy-replaces-healthy',
    'scenario-1-new-observation-invalidates-health',
    'scenario-1-mutation-invalidates-health',
    'scenario-1-timeout-recovery-unhealthy-then-healthy',
    'scenario-2-current-agreement',
    'scenario-2-scope-expansion',
    'scenario-2-timeout-missing-artifact',
    'scenario-2-completed-child-resume',
    'scenario-2-contradictory-current-evidence',
    'scenario-2-stale-memory',
    'scenario-2-unavailable-primary-source',
  ];
  expect(fixture.traces.map((trace) => trace.id)).toEqual(requiredTraceIds);
  for (const trace of fixture.traces) {
    expect(trace.scenarioId).toMatch(/^agentic-systems-full-task-[12]-individual$/);
    expect(trace.executionStatus).toBe('unverified');
    expect(trace.observedResult).toBeNull();
    expect(trace.requiredTrace.length).toBeGreaterThanOrEqual(2);
    expect(trace.requiredTrace.map((event) => event.step)).toEqual(
      trace.requiredTrace.map((_, index) => index + 1),
    );
    for (const event of trace.requiredTrace) {
      expect(event.event).toBeTruthy();
      expect(event.expectedState).toBeTruthy();
      expect(event.expectedDecision).toBeTruthy();
      expect(event.budgetCharge).toBeGreaterThanOrEqual(0);
    }
    expect(trace.missingEvidence).toBeTruthy();
  }
});

test('real resolver: all package-local routing cases with an isolated skills home', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentic-systems-routing-'));
  const previousHome = process.env.KORYPHAIOS_SKILLS_HOME;
  try {
    process.env.KORYPHAIOS_SKILLS_HOME = join(root, 'skills');
    const revisions = listSkills(root);
    const failures: unknown[] = [];
    for (const row of pkg.evaluation.routing) {
      const resolution = resolveSkills(projectRoot, row.prompt, createTaskContract(row.prompt), {
        skillRevisions: revisions,
        contextBudget: 60_000,
      });
      const selected = resolution.selected
        .filter((item) => row.selectionScope !== 'direct' || isDirectSkillSelection(item))
        .map((item) => item.skill.name);
      const missing = row.expectedSkills.filter((name) => !selected.includes(name));
      const forbidden = row.forbiddenSkills.filter((name) => selected.includes(name));
      if (
        selected.includes(pkg.sidecar.name) !== row.expectedSelection ||
        missing.length ||
        forbidden.length
      ) {
        failures.push({ id: row.id, selected, missing, forbidden });
      }
    }
    expect(failures).toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.KORYPHAIOS_SKILLS_HOME;
    else process.env.KORYPHAIOS_SKILLS_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of buildSkillEvalSuiteV3(pkg).scenarios.filter(
  (row) => row.category === 'full-task',
)) {
  test(`synthetic negative controls: ${scenario.id}`, async () => {
    const materializer = AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    );
    const scorer = AI_PROTOCOL_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    );
    expect(materializer).toBeDefined();
    expect(scorer).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'agentic-systems-integrity-'));
    try {
      await materializer!.materialize(root, scenario);
      const contract = JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8'));
      expect(contract).toMatchObject({ scenarioId: scenario.id, evidence: 'synthetic' });
      const score = () =>
        scorer!.score({
          scenario,
          experiment: {} as never,
          workingDirectory: root,
          observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
        });
      const starter = await score();
      expect(starter.passed).toBe(false);
      expect(starter.integrityFailure).toBe(false);

      // A plausible prose claim cannot replace the exact executable output.
      writeFileSync(
        join(root, 'candidate.ts'),
        'export function solve() { return { status: "complete" }; }\n',
      );
      const incomplete = await score();
      expect(incomplete.passed).toBe(false);
      expect(incomplete.integrityFailure).toBe(false);

      writeFileSync(join(root, 'README.md'), 'Altered evaluator contract\n');
      const tampered = await score();
      expect(tampered.passed).toBe(false);
      expect(tampered.integrityFailure).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
