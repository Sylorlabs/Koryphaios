import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  hasAffirmativeLlvmVulnerabilityClaim,
  SECURITY_REVIEW_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-security-review-runtime-fixtures';

const HOST_SCENARIO_ID = 'infrastructure-security-full-task-2';
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function materializeHostFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-security-review-host-'));
  temporaryRoots.push(root);
  const materializer = SECURITY_REVIEW_RUNTIME_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches({ id: HOST_SCENARIO_ID } as never),
  );
  if (!materializer) throw new Error('Host fixture materializer is missing');
  materializer.materialize(root, { id: HOST_SCENARIO_ID } as never);
  return root;
}

async function scoreHostFixture(root: string) {
  const scorer = SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(HOST_SCENARIO_ID),
  );
  if (!scorer) throw new Error('Host fixture scorer is missing');
  return scorer.score({ workingDirectory: root } as never);
}

function writePassingHostArtifact(root: string): void {
  writeFixtureFile(
    root,
    '.kory-eval/host-hardening.json',
    `${JSON.stringify(
      {
        installedPackages: ['service-runtime'],
        enabledServices: ['service'],
        listeners: [{ port: 443, purpose: 'service', networks: ['service'] }],
        serviceIdentity: { user: 'service', uid: 1001, sharedWithAdmin: false, privileged: false },
        admin: {
          sharedAccount: false,
          timeBounded: true,
          audited: true,
          managementNetworks: ['bastion'],
          emergencySeparate: true,
        },
        patch: {
          supportedBase: true,
          owner: 'platform-security',
          riskBasedDeadline: true,
          immutableRebuildPreferred: true,
          rollbackArtifact: true,
          emergencyConvergesBack: true,
        },
        permissions: { configWritableByService: false, secretWorldReadable: false },
        privilegedChangeLogging: true,
        actualStateChecked: [
          'packages',
          'listeners',
          'identities',
          'permissions',
          'network',
          'patches',
          'audit',
        ],
        cloudIamOwnedBy: 'cloud-security',
      },
      null,
      2,
    )}\n`,
  );
}

test('host scorer preserves normal scoring when immutable evidence is intact', async () => {
  const root = materializeHostFixture();
  writePassingHostArtifact(root);

  await expect(scoreHostFixture(root)).resolves.toMatchObject({
    passed: true,
    integrityFailure: false,
    quality: 1,
    verification: 1,
  });
});

test('host scorer reports evaluator integrity failure when evidence/host.json is deleted', async () => {
  const root = materializeHostFixture();
  rmSync(join(root, 'evidence/host.json'));

  await expect(scoreHostFixture(root)).resolves.toMatchObject({
    passed: false,
    integrityFailure: true,
  });
});

test('host scorer reports evaluator integrity failure when evidence/host.json is renamed', async () => {
  const root = materializeHostFixture();
  renameSync(join(root, 'evidence/host.json'), join(root, 'evidence/host-renamed.json'));

  await expect(scoreHostFixture(root)).resolves.toMatchObject({
    passed: false,
    integrityFailure: true,
  });
});

test('compiler evidence distinguishes an explicit non-vulnerability statement from an LLVM vulnerability claim', () => {
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'This records a custom compiler lowering defect, not a vulnerability in LLVM or generic LLVM behavior.',
    ),
  ).toBe(false);
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'This is a custom compiler defect, not a claim of generic LLVM vulnerability.',
    ),
  ).toBe(false);
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'This is not a generic LLVM vulnerability; LLVM may optimize valid frontend assertions.',
    ),
  ).toBe(false);
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'The evidence does not establish an LLVM vulnerability; it establishes a frontend lowering defect.',
    ),
  ).toBe(false);
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'The evidence establishes an LLVM vulnerability in optimizer handling.',
    ),
  ).toBe(true);
});
