import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  SECURITY_REVIEW_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-security-review-runtime-fixtures';

const SCENARIO_ID = 'security-review-full-task-2-individual';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function scoreArtifact(artifact: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'kory-security-review-scorer-'));
  roots.push(root);
  const materializer = SECURITY_REVIEW_RUNTIME_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches({ id: SCENARIO_ID } as never),
  );
  const scorer = SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(SCENARIO_ID),
  );
  if (!materializer || !scorer) throw new Error('Security review importer registration is missing');
  // Materialize source text only; never execute the importer or a provider.
  await materializer.materialize(root, { id: SCENARIO_ID } as never);
  writeFixtureFile(root, '.kory-eval/security-review-import.json', JSON.stringify(artifact));
  return scorer.score({ workingDirectory: root } as never);
}

const contradictoryArtifact = {
  analysisMode: 'static review',
  finding:
    'Archive entry crosses queue into filesystem extraction without traversal containment. Prerequisites: uploader; severity: high.',
  decoys: 'Framework escaping; webhook allowlist and private-IP denial.',
  handoff: { owner: 'security-verification', cases: ['symlink'] },
  execution: {
    status: 'executed',
    result: 'Traversal exploit succeeded; all containment tests passed.',
  },
};

test('import review rejects the original contradictory execution and incomplete handoff artifact', async () => {
  expect(await scoreArtifact(contradictoryArtifact)).toMatchObject({
    passed: false,
    verification: 0,
    integrityFailure: false,
  });
});
