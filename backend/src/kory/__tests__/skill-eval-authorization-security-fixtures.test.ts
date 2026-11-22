import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTHORIZATION_SECURITY_SKILL_EVAL_MATERIALIZERS,
  AUTHORIZATION_SECURITY_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-authorization-security-fixtures';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scenario(scenarioId: string) {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'authorization-security',
  )!;
  return buildSkillEvalSuiteV3(skillPackage).scenarios.find((item) => item.id === scenarioId)!;
}

async function materializeAndScore(scenarioId: string, artifactPath: string, artifact: unknown) {
  const item = scenario(scenarioId);
  const root = mkdtempSync(join(tmpdir(), 'kory-authorization-eval-'));
  roots.push(root);
  const materializer = AUTHORIZATION_SECURITY_SKILL_EVAL_MATERIALIZERS.find((entry) =>
    entry.matches(item),
  )!;
  const scorer = AUTHORIZATION_SECURITY_SKILL_EVAL_SCORERS.find((entry) =>
    entry.scenarioIds.includes(item.id),
  )!;
  await materializer.materialize(root, item);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  writeFileSync(join(root, artifactPath), JSON.stringify(artifact));
  return scorer.score({
    scenario: item,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
}

test('document policy accepts explicit denied non-effects written as explanatory phrases', async () => {
  const score = await materializeAndScore(
    'authorization-security-full-task-1',
    '.kory-eval/authorization-document-api.json',
    {
      rules: [
        { role: 'member', relation: 'viewer', action: 'read', tenantMatch: true, allow: true },
        {
          role: 'editor',
          relation: 'editor',
          action: 'edit',
          tenantMatch: true,
          allow: true,
          allowedFields: ['title', 'body', 'tags'],
        },
        {
          role: 'tenant-admin',
          relation: 'none',
          action: 'member-manage',
          tenantMatch: true,
          allow: true,
        },
      ],
      defaultDeny: true,
      enforcementBoundary: 'trusted service and data layer',
      exportWorker: {
        effectiveSubject: 'originating user via constrained delegation',
        broadServiceIdentityAuthorizes: false,
        delegationBounded: true,
      },
      revocation: {
        suspensionImmediate: true,
        memberRemovalImmediateForHighRisk: true,
        maxStaleSeconds: 60,
        failClosedWhenPolicyUnavailable: true,
      },
      deniedNonEffects: [
        'no durable mutation',
        'no queued message',
        'no output file',
        'no export artifact',
      ],
      audit: { protectedDataExcluded: true, securityRelevantDenials: true },
      evidenceBoundary: 'synthetic design evidence for security-verification',
    },
  );
  expect((await score).passed).toBe(true);
});

test('GraphQL policy accepts explanatory non-effect phrases without weakening policy checks', async () => {
  const score = await materializeAndScore(
    'authorization-security-full-task-2',
    '.kory-eval/authorization-graphql.json',
    {
      rules: [
        {
          role: 'viewer',
          resource: 'Project',
          operation: 'read',
          field: 'name',
          orgMatch: true,
          allow: true,
        },
        {
          role: 'organization-support',
          resource: 'Project',
          operation: 'read',
          field: 'name',
          orgMatch: true,
          supportGrant: 'active',
          allow: true,
        },
      ],
      defaultDeny: true,
      enforcementPaths: {
        query: 'trusted policy',
        'nested-resolver': 'trusted policy',
        alias: 'trusted policy',
        'batch-loader': 'trusted policy',
        mutation: 'trusted policy',
      },
      backendServiceIdentityAsSubject: false,
      originatingCallerPreserved: true,
      support: {
        timeBounded: true,
        revocationImmediateForNewDecisions: true,
        prohibitedResources: ['BillingAccount.paymentMethod', 'ApiToken.secret'],
      },
      overpostDeniedFields: ['organizationId', 'ownerId', 'billingAccountId', 'role'],
      deniedNonEffects: ['no durable mutation', 'no queued message', 'no token issuance'],
      graphqlMechanicsOwnedBy: 'graphql-engineering',
      evidenceBoundary: 'synthetic design evidence',
    },
  );
  expect((await score).passed).toBe(true);
});
