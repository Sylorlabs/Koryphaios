import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS,
  CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS,
} from '../skill-eval-contract-concurrency-fixtures';
import {
  FRONTEND_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  FRONTEND_ENGINEERING_SKILL_EVAL_SCORERS,
} from '../skill-eval-frontend-engineering-fixtures';
import { MODEL_DATA_CONCEPTS } from '../skill-eval-model-data-concept-fixtures';
import {
  REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS,
  REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS,
} from '../skill-eval-repository-communication-fixtures';
import { SYSTEMS_PROTOCOL_CONCEPTS } from '../skill-eval-systems-protocol-concept-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scenario(skill: string, scenarioId: string) {
  const skillPackage = loadV5SkillPackages().packages.find((item) => item.sidecar.name === skill)!;
  return buildSkillEvalSuiteV3(skillPackage).scenarios.find((item) => item.id === scenarioId)!;
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'kory-targeted-v5-regression-'));
  roots.push(value);
  return value;
}

const observation = { output: '', evidence: [], artifacts: [], durationMs: 0 };

describe('targeted V5 evaluator regressions', () => {
  test('frontend scorer accepts README-aligned artifact aliases and precision pointer wording', async () => {
    const task = scenario('frontend-engineering', 'frontend-engineering-full-task-unknown-medium');
    const workingDirectory = root();
    const materializer = FRONTEND_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(task),
    )!;
    const scorer = FRONTEND_ENGINEERING_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(task.id),
    )!;
    await materializer.materialize(workingDirectory, task);
    writeFileSync(
      join(workingDirectory, 'src/interface-contract.ts'),
      `export function presentJob(domain: any, view: any) {
  let recoveryAction = null;
  let focusTarget = view.focusedControl ?? null;
  if (view.stale) { recoveryAction = 'refresh'; focusTarget = 'refresh'; }
  else if (domain.status === 'cancel-failed') recoveryAction = 'retry-cancel';
  else if (domain.status === 'failed') recoveryAction = 'retry-job';
  else if (view.interrupted) { recoveryAction = 'resume'; focusTarget = 'resume'; }
  const labels: Record<string,string> = {
    discovering: 'Discovering jobs', running: 'Running', partial: 'Partial results',
    'cancel-requested': 'Cancellation requested', 'cancel-failed': 'Cancellation failed',
    complete: 'Complete', failed: 'Failed'
  };
  return {
    label: labels[domain.status],
    canCancel: !view.stale && (domain.status === 'running' || domain.status === 'partial'),
    stale: view.stale,
    recoveryAction,
    primaryInput: 'keyboard+precision-pointer',
    focusTarget,
  };
}
`,
    );
    mkdirSync(join(workingDirectory, '.kory-eval'), { recursive: true });
    writeFileSync(
      join(workingDirectory, '.kory-eval/frontend-selection.json'),
      JSON.stringify({
        selectedSurfaceId: 'native-operations',
        medium: 'native-desktop',
        runtime: 'Tauri 2.4.1',
        uiToolkit: 'Svelte 5.35.2',
        supportedInputModes: ['keyboard', 'precision-pointer'],
        owningComponentOrRoute: 'native JobDetail route',
        selectedNarrowerSpecialist: 'native-interface',
      }),
    );
    writeFileSync(
      join(workingDirectory, '.kory-eval/frontend-verification.json'),
      JSON.stringify({
        targetRuntime: 'Tauri 2.4.1 native-desktop',
        screenshotOnlyEvidenceInsufficient: true,
        contract: {
          states: [
            'discovering',
            'running',
            'partial',
            'stale',
            'cancel requested',
            'cancel failed',
            'complete',
            'failed',
            'recovery retry resume',
          ],
          input: ['keyboard', 'precision pointer', 'focus'],
        },
        additionalChecks: ['resize overflow', 'accessibility reduced motion'],
      }),
    );
    const score = await scorer.score({
      scenario: task,
      experiment: {} as never,
      workingDirectory,
      observation,
    });
    expect(scorer.id).toEndWith('@2');
    expect(score.passed).toBe(true);
  });

  test('release scorer accepts a bounded not-been-measured statement without requiring the prior tag in customer prose', async () => {
    const task = scenario(
      'documents-communication',
      'documents-communication-full-task-1-individual',
    );
    const workingDirectory = root();
    const materializer = REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(task),
    )!;
    const scorer = REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(task.id),
    )!;
    await materializer.materialize(workingDirectory, task);
    writeFileSync(
      join(workingDirectory, 'release-notes.md'),
      `# v5.3.0 release notes
## Highlights
- Resumable uploads recover after interruption. (PR-101)
## Fixes
- Filter selection is preserved. (PR-102)
## Known limitations
- PR-104 user impact has not been measured, so it remains uncertain.
`,
    );
    writeFileSync(
      join(workingDirectory, 'evidence-map.json'),
      JSON.stringify({
        included: ['PR-101', 'PR-102'],
        excluded: ['PR-103'],
        uncertain: ['PR-104'],
      }),
    );
    const score = await scorer.score({
      scenario: task,
      experiment: {} as never,
      workingDirectory,
      observation,
    });
    expect(scorer.id).toEndWith('@2');
    expect(score.passed).toBe(true);
  });

  test('lease scorer accepts a colocated focused test file', async () => {
    const task = scenario(
      'deterministic-contract-testing',
      'deterministic-contract-testing-full-task-1',
    );
    const workingDirectory = root();
    const materializer = CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(task),
    )!;
    const scorer = CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(task.id),
    )!;
    await materializer.materialize(workingDirectory, task);
    writeFileSync(
      join(workingDirectory, 'src/lease.test.ts'),
      `import { expect, test } from 'bun:test';
import { FixedClock, FixedNonceSource } from './fixtures';
import { renewLease } from './lease';
const lease = { token:'old-token', expiresAt:'2026-09-05T12:00:00.000Z' };
test('before 11:59:59.999 renews and consumes nonce',()=>{ const n=new FixedNonceSource(); expect(renewLease(lease,new FixedClock('2026-09-05T11:59:59.999Z'),n)).toEqual({ok:true,lease:{token:'lease-0102a0ff',expiresAt:'2026-09-05T12:14:59.999Z'}}); expect(n.consumed()).toBe(1); });
test('exact equality 12:00:00.000 is expired without nonce',()=>{ const n=new FixedNonceSource(); expect(renewLease(lease,new FixedClock('2026-09-05T12:00:00.000Z'),n)).toEqual({ok:false,error:'LEASE_EXPIRED'}); expect(n.consumed()).toBe(0); });
test('after 12:00:00.001 is expired without nonce',()=>{ const n=new FixedNonceSource(); expect(renewLease(lease,new FixedClock('2026-09-05T12:00:00.001Z'),n)).toEqual({ok:false,error:'LEASE_EXPIRED'}); expect(n.consumed()).toBe(0); });
`,
    );
    mkdirSync(join(workingDirectory, '.kory-eval'), { recursive: true });
    writeFileSync(
      join(workingDirectory, '.kory-eval/deterministic-lease.json'),
      JSON.stringify({
        token: 'lease-0102a0ff',
        error: 'LEASE_EXPIRED',
        nonce: 'FixedNonceSource',
        mutation: '>= to > is red/fail',
        restored: 'green/pass twice with two run results',
        boundary: 'synthetic local',
      }),
    );
    const score = await scorer.score({
      scenario: task,
      experiment: {} as never,
      workingDirectory,
      observation,
    });
    expect(scorer.id).toEndWith('@2');
    expect(score.passed).toBe(true);
  });

  test('job scorer recognizes the structured duplicate-cancellation no-op without a prose keyword', async () => {
    const task = scenario(
      'deterministic-contract-testing',
      'deterministic-contract-testing-full-task-2',
    );
    const workingDirectory = root();
    const materializer = CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(task),
    )!;
    const scorer = CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(task.id),
    )!;
    await materializer.materialize(workingDirectory, task);
    mkdirSync(join(workingDirectory, 'tests'), { recursive: true });
    writeFileSync(
      join(workingDirectory, 'tests/job-contract.test.ts'),
      `import { expect,test } from 'bun:test'; import { decodeEnvelope,reduceJob } from '../src/job-contract';
test('legacy v1 and extra property contract',()=>{ expect(decodeEnvelope({version:1,jobId:'legacy',command:'cancel'}).ok).toBe(true); expect(decodeEnvelope({version:2,jobId:'x',command:'start',extra:true})).toEqual({ok:false,error:'EXTRA_PROPERTY'}); });
test('Queued Running and Cancelled Cancelled transitions',()=>{ expect(reduceJob('Queued','start')).toMatchObject({ok:true,state:'Running'}); expect(reduceJob('Cancelled','cancel')).toEqual({ok:true,state:'Cancelled',effects:[]}); });
`,
    );
    mkdirSync(join(workingDirectory, '.kory-eval'), { recursive: true });
    writeFileSync(
      join(workingDirectory, '.kory-eval/deterministic-job.json'),
      JSON.stringify({
        dialect: '2020-12',
        errors: ['INVALID_JOB_ID', 'UNKNOWN_COMMAND', 'EXTRA_PROPERTY'],
        states: ['Queued', 'Running', 'Succeeded', 'Cancelled'],
        stateTable: { legal: [['Cancelled', 'cancel', 'Cancelled', []]] },
        mutation: 'additionalProperties mutation red/fail',
        restored: 'green/pass',
        boundary: 'local synthetic',
      }),
    );
    const score = await scorer.score({
      scenario: task,
      experiment: {} as never,
      workingDirectory,
      observation,
    });
    expect(scorer.id).toEndWith('@2');
    expect(score.passed).toBe(true);
  });

  test('corrected concept contracts expose the same input/output shape as their vectors', () => {
    const game = SYSTEMS_PROTOCOL_CONCEPTS.find(
      (item) => item.id === 'game-development-full-task-2-individual',
    )!;
    expect(game.generation).toBe(2);
    expect(game.vectors()[0]!.input).toMatchObject({ version: 1, items: ['sword', 'potion'] });
    expect(game.vectors()[1]!.input).toHaveProperty('inventory');

    const detector = MODEL_DATA_CONCEPTS.find(
      (item) => item.id === 'computer-vision-full-task-1-individual',
    )!;
    const segmentation = MODEL_DATA_CONCEPTS.find(
      (item) => item.id === 'computer-vision-full-task-2-individual',
    )!;
    expect(detector.generation).toBe(2);
    expect(detector.contract).toContain("eligible samples' boolean truth and predicted fields");
    expect(segmentation.generation).toBe(2);
    expect(segmentation.contract).toContain('Return eligibleIds and leakageIds in input order');
  });
});
