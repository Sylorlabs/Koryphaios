import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillEvaluationV5ContractHash } from '../skill-eval-contract-hash';
import {
  DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS,
  DELIVERY_PLATFORM_SKILL_EVAL_SCORERS,
} from '../skill-eval-delivery-platform-fixtures';
import { CURRENT_SKILL_EVAL_CONTRACT_VERSION } from '../skill-evaluations';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const skillPackage = loadV5SkillPackages().packages.find(
  (item) => item.sidecar.name === 'terraform-iac',
)!;
const scenarios = buildSkillEvalSuiteV3(skillPackage).scenarios;
const adoptionScenario = scenarios.find(
  (item) => item.id === 'terraform-iac-full-task-1-individual',
)!;
const refactorScenario = scenarios.find(
  (item) => item.id === 'terraform-iac-full-task-2-individual',
)!;
const materializer = DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS.find((item) =>
  item.matches(adoptionScenario),
)!;
const scorer = DELIVERY_PLATFORM_SKILL_EVAL_SCORERS.find((item) =>
  item.scenarioIds.includes(adoptionScenario.id),
)!;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function workspace(scenario = adoptionScenario) {
  const root = mkdtempSync(join(tmpdir(), 'kory-terraform-adoption-'));
  roots.push(root);
  await DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!.materialize(root, scenario);
  return root;
}

// With-skill output from pair a07c19c3-bbdc-435e-aaf4-8e068239b4e3.
// Keep the unavailable facts: the original fixture supplied no toolchain identity.
const recordedAdoption = {
  cliVersion: 'fixture/task supplied: not specified',
  providerVersions: [] as string[],
  lockfile: 'fixture/task supplied: not present',
  backend: 'remote://org/prod',
  workspace: 'prod',
  staleLocalStateAuthoritative: false,
  importBlocks: [
    'import { to = terraform_data.bucket_123 id = "bucket-123" }',
    'import { to = terraform_data.queue_456 id = "queue-456" }',
  ],
  matchingResources: [
    'resource "terraform_data" "bucket_123" { input = "bucket-123" }',
    'resource "terraform_data" "queue_456" { input = "queue-456" }',
  ],
  directStateEdit: false,
  destructivePlanRejected: true,
  lockPreserved: true,
  recoveryArtifact:
    'synthetic/local pre-change recovery record: remote://org/prod workspace prod, lineage lineage-88, lock held-by-plan; restoration requires an observed backend state copy with matching lineage before any authorized state operation',
  identitiesPreserved: true,
  freshPlan: { create: 0, replace: 0, destroy: 0, unexplained: 0 },
  blanketIgnoreChanges: false,
};

function suppliedAdoption(root: string) {
  const context = JSON.parse(readFileSync(join(root, 'evidence/backend.json'), 'utf8'));
  return {
    ...recordedAdoption,
    cliVersion: context.cliVersion,
    providerVersions: context.providerVersions,
    lockfile: context.lockfile,
  };
}

function score(root: string, artifact: unknown) {
  writeFixtureFile(root, '.kory-eval/terraform-adoption.json', JSON.stringify(artifact));
  return scorer.score({
    scenario: adoptionScenario,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
}

describe('Terraform adoption starting-state toolchain evidence', () => {
  test('supplies pinned synthetic CLI/provider/lockfile facts before candidate edits', async () => {
    const root = await workspace();
    const context = JSON.parse(readFileSync(join(root, 'evidence/backend.json'), 'utf8'));
    expect(context).toMatchObject({
      cliVersion: '1.9.8',
      providerVersions: ['registry.terraform.io/hashicorp/aws@5.74.0'],
      lockfile: '.terraform.lock.hcl',
      evidenceSource: 'evaluator-owned synthetic starting state',
      liveProviderVerified: false,
      backend: 'remote://org/prod',
      workspace: 'prod',
      lineage: 'lineage-88',
      lock: 'held-by-plan',
      staleLocalState: 'lineage-71',
      liveResources: ['bucket-123', 'queue-456'],
      dangerousDelta: 'replace bucket-123',
    });
    const lockfile = readFileSync(join(root, context.lockfile), 'utf8');
    expect(lockfile).toContain('provider "registry.terraform.io/hashicorp/aws"');
    expect(lockfile).toMatch(/version\s*=\s*"5\.74\.0"/u);
    expect(lockfile).toMatch(/constraints\s*=\s*"= 5\.74\.0"/u);
    expect(lockfile).toContain('Synthetic');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('evidence/backend.json');
    expect(readme).toContain('.terraform.lock.hcl');
    expect(readme).toContain('not an observed CLI execution or live account/provider verification');
  });

  test('replays the recorded missing-provider failure, then passes using only supplied context', async () => {
    const root = await workspace();
    const red = await score(root, recordedAdoption);
    expect(red).toMatchObject({ passed: false, integrityFailure: false });
    expect(red.evidence.join('\n')).toContain('Received: 0');
    expect(red.evidence.join('\n')).toContain(
      '(pass) hidden: adoption converges without replacement',
    );

    const green = await score(root, suppliedAdoption(root));
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
  });

  test.each([
    ['missing provider identity', { providerVersions: [] }],
    ['wrong backend', { backend: 'local' }],
    ['wrong workspace', { workspace: 'staging' }],
    ['stale local state authority', { staleLocalStateAuthoritative: true }],
    ['direct state edit', { directStateEdit: true }],
    ['accepted destructive plan', { destructivePlanRejected: false }],
    ['lost lock', { lockPreserved: false }],
    ['missing recovery evidence', { recoveryArtifact: '' }],
    ['changed resource identity', { identitiesPreserved: false }],
    ['blanket drift suppression', { blanketIgnoreChanges: true }],
    ['missing import', { importBlocks: recordedAdoption.importBlocks.slice(0, 1) }],
    ...['create', 'replace', 'destroy', 'unexplained'].map((action) => [
      `residual ${action}`,
      { freshPlan: { ...recordedAdoption.freshPlan, [action]: 1 } },
    ]),
  ])('still rejects %s', async (_label, mutation) => {
    const root = await workspace();
    expect((await score(root, { ...suppliedAdoption(root), ...mutation })).passed).toBe(false);
  });

  test('still rejects tampered state lineage or simulator as integrity failures', async () => {
    const root = await workspace();
    const context = readFileSync(join(root, 'evidence/backend.json'), 'utf8');
    const artifact = suppliedAdoption(root);
    writeFixtureFile(root, 'evidence/backend.json', context.replace('lineage-88', 'lineage-99'));
    expect(await score(root, artifact)).toMatchObject({ passed: false, integrityFailure: true });
    writeFixtureFile(root, 'evidence/backend.json', context);
    writeFixtureFile(root, 'src/terraform-sim.ts', '// replaced simulator\n');
    expect(await score(root, artifact)).toMatchObject({ passed: false, integrityFailure: true });
  });

  test('invalidates only the adoption materializer contract', () => {
    expect(materializer.id).toBe('terraform-iac/declarative-import-adoption@2');
    expect(scorer.id).toBe('terraform-iac/declarative-import-adoption-scorer@1');
    for (const scenario of [adoptionScenario, refactorScenario]) {
      const task = skillPackage.evaluation.tasks.find((item) => item.id === scenario.id)!;
      const materializerIds = DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS.filter((item) =>
        item.matches(scenario),
      ).map((item) => item.id);
      const contract = {
        contractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
        skill: skillPackage.sidecar.name,
        packageVersion: skillPackage.sidecar.version,
        scenario: task,
        materializerIds,
        scorerIds: DELIVERY_PLATFORM_SKILL_EVAL_SCORERS.filter((item) =>
          item.scenarioIds.includes(scenario.id),
        ).map((item) => item.id),
      };
      const previousHash = skillEvaluationV5ContractHash({
        ...contract,
        materializerIds: materializerIds.map((id) =>
          id.replace('declarative-import-adoption@2', 'declarative-import-adoption@1'),
        ),
      });
      expect(skillEvaluationV5ContractHash(contract) === previousHash).toBe(
        scenario.id === refactorScenario.id,
      );
    }
  });

  test('neighboring refactor keeps exact saved-plan identity, context and convergence gates', async () => {
    const root = await workspace(refactorScenario);
    const refactorMaterializer = DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(refactorScenario),
    )!;
    const refactorScorer = DELIVERY_PLATFORM_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(refactorScenario.id),
    )!;
    expect(refactorMaterializer.id).toBe('terraform-iac/moved-block-refactor@1');
    expect(refactorScorer.id).toBe('terraform-iac/moved-block-refactor-scorer@1');
    // Explicit scorer control data, not a claim that scenario-2 supplies this toolchain.
    const artifact = {
      ...recordedAdoption,
      cliVersion: '1.9.8',
      providerVersions: ['registry.terraform.io/hashicorp/aws@5.74.0'],
      lockfile: '.terraform.lock.hcl',
      moduleVersions: ['synthetic/storage@1.0.0', 'synthetic/queue@1.0.0'],
      movedBlocks: ['aws_s3_bucket.assets', 'aws_sqs_queue.jobs'],
      accidentalReplacementRejected: true,
      reviewedPlanDigest: `sha256:${'a'.repeat(64)}`,
      appliedPlanDigest: `sha256:${'a'.repeat(64)}`,
      contextChangedBetweenPlanApply: false,
      historicalMovesPreserved: true,
    };
    for (const mutation of [
      null,
      { appliedPlanDigest: `sha256:${'b'.repeat(64)}` },
      { contextChangedBetweenPlanApply: true },
      { accidentalReplacementRejected: false },
      { historicalMovesPreserved: false },
      { freshPlan: { ...artifact.freshPlan, replace: 1 } },
    ]) {
      writeFixtureFile(
        root,
        '.kory-eval/terraform-refactor.json',
        JSON.stringify({ ...artifact, ...mutation }),
      );
      const result = await refactorScorer.score({
        scenario: refactorScenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(result.passed, result.evidence.join('\n')).toBe(mutation === null);
      expect(result.integrityFailure).toBe(false);
    }
  });
});
