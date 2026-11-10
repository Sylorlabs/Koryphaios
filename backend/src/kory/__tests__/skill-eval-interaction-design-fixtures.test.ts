import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PILOT_SKILL_EVAL_SCORERS } from '../skill-eval-pilot-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('resumable-import scorer accepts a guarded dynamic restore to a named remote state', async () => {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'interaction-design',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === 'interaction-design-full-task-resumable-import',
  )!;
  const scorer = PILOT_SKILL_EVAL_SCORERS.find((entry) => entry.scenarioIds.includes(scenario.id))!;
  const root = mkdtempSync(join(tmpdir(), 'kory-interaction-eval-'));
  roots.push(root);

  writeFileSync(
    join(root, 'interaction-contract.json'),
    `${JSON.stringify(
      {
        states: [
          'selected',
          'validating',
          'reviewing-partial',
          'processing-precommit',
          'committing',
          'disconnected',
          'partial-result',
          'completed',
          'reopened',
          'cancelled',
          'failed',
        ],
        actions: [
          {
            id: 'cancel',
            preconditions: ['processing-precommit before commit begins'],
            description: 'Cancellation is blocked after commit begins.',
          },
        ],
        transitions: [
          { from: 'selected', to: 'validating' },
          { from: 'validating', to: 'reviewing-partial' },
          { from: 'reviewing-partial', to: 'processing-precommit' },
          { from: 'processing-precommit', to: 'committing' },
          { from: 'processing-precommit', to: 'disconnected' },
          {
            from: 'disconnected',
            event: 'reconciled-active',
            guard:
              'remoteState is validating, reviewing-partial, processing-precommit, or committing',
            to: '$remoteState',
          },
          { from: 'disconnected', to: 'completed' },
          { from: 'committing', to: 'partial-result' },
          {
            from: 'committing',
            event: 'cancel-requested',
            to: 'committing',
            effect: 'block cancellation after commit starts',
          },
          { from: 'completed', to: 'reopened' },
        ],
        invariants: [
          'A disconnected client reconciles to the authoritative remote state after reconnect.',
          'Commit blocks cancellation once commit starts.',
        ],
        acceptanceTests: [{ id: 'disconnect-resume' }],
      },
      null,
      2,
    )}\n`,
  );

  const score = await scorer.score({
    scenario,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });

  expect(scorer.id).toEndWith('@4');
  expect(score.passed).toBe(true);
  expect(score.evidence).toContain('state/recovery invariants: pass');
});
