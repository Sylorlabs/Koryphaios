import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTH_SECRETS_SECURITY_SKILL_EVAL_MATERIALIZERS,
  AUTH_SECRETS_SECURITY_SKILL_EVAL_SCORERS,
} from '../skill-eval-auth-secrets-security-fixtures';
import { runHiddenBunTest, writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  hasCookieMutationInventory,
  PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
  PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS,
} from '../skill-eval-privacy-web-device-fixtures';
import { SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS } from '../skill-eval-security-review-runtime-fixtures';
import {
  SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_MATERIALIZERS,
  SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_SCORERS,
} from '../skill-eval-supply-chain-incident-fixtures';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-promotion-repair-'));
  roots.push(root);
  return root;
}

async function materialize(
  root: string,
  materializerId: string,
  scenarioId: string,
  materializers: typeof PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
): Promise<void> {
  const materializer = materializers.find((item) => item.id === materializerId);
  expect(materializer).toBeDefined();
  await materializer!.materialize(root, { id: scenarioId } as never);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('promotion repair evaluator regressions', () => {
  test('web-security materialization is parseable and uses the repaired contract generation', async () => {
    const root = workspace();
    await materialize(
      root,
      'web-security/dashboard-browser-boundaries@4',
      'web-security-full-task-1',
      PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
    );
    const parsed = runHiddenBunTest(
      root,
      "import{expect,test}from'bun:test';import{reportUrl}from'../src/web-policy';test('source parses',()=>expect(typeof reportUrl).toBe('function'));",
    );
    expect(parsed.passed, parsed.evidence).toBe(true);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(
      'immutable evaluator-provided contract',
    );
    expect(
      PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS.some(
        (item) => item.id === 'web-security/dashboard-browser-boundaries-scorer@8',
      ),
    ).toBe(true);
  });

  test('web-security inventory accepts a CSRF protected state-changing handler without a literal mutation label', () => {
    const documented = [
      {
        source: 'Cookie-authenticated dashboard actions',
        transform: 'A session-bound CSRF token in the X-CSRF-Token header',
        sink: 'JSON state-changing API handlers (POST, PUT, PATCH, DELETE)',
        control: 'Reject missing or invalid tokens on the server',
      },
    ];
    expect(hasCookieMutationInventory(documented)).toBe(true);
    expect(
      hasCookieMutationInventory([
        {
          source: 'Cookie-backed session authentication for dashboard requests',
          transform:
            'Session-bound CSRF token verified against the authenticated session server-side',
          sink: 'POST mutations that change dashboard state',
          control: 'Server validates every CSRF token and rejects missing or invalid tokens',
        },
      ]),
    ).toBe(true);
    expect(
      hasCookieMutationInventory([
        {
          source: 'Browser session cookie automatically attached to JSON mutation requests',
          transform:
            'Send a session-bound CSRF token in the X-CSRF-Token header and validate it server-side before every state change',
          sink: 'Cookie-authenticated POST, PUT, PATCH, and DELETE handlers',
          control:
            'Reject missing or invalid tokens; check exact trusted Origin as a complementary signal',
        },
      ]),
    ).toBe(true);
    expect(
      hasCookieMutationInventory([
        {
          source:
            'The HttpOnly session cookie, which the browser automatically attaches to same-origin JSON mutation requests',
          transform:
            'A server-issued synchronizer token is placed in X-CSRF-Token and checked against the authenticated session',
          sink: 'Every POST, PUT, PATCH, and DELETE handler that changes dashboard state',
          control:
            'Reject a missing, malformed, expired, or mismatched token before changing state',
        },
      ]),
    ).toBe(true);
    expect(
      hasCookieMutationInventory([
        { source: 'Payment postMessage', sink: 'iframe', control: 'Exact origin validation' },
      ]),
    ).toBe(false);
    expect(
      hasCookieMutationInventory([
        {
          source: 'HttpOnly session cookie',
          transform: 'The request includes a CSRF token without server verification',
          sink: 'POST handler changing server state',
          control: 'Disabled token checks',
        },
      ]),
    ).toBe(false);
    expect(
      hasCookieMutationInventory([
        {
          source: 'Cookie-backed session authentication for dashboard requests',
          transform:
            'Session-bound CSRF token verified against the authenticated session server-side',
          sink: 'POST mutations that change dashboard state',
          control:
            'Server validates every CSRF token and rejects missing or invalid tokens, but CSRF validation disabled for legacy requests',
        },
      ]),
    ).toBe(false);
    expect(
      hasCookieMutationInventory([
        {
          source: 'Cookie-authenticated action',
          sink: 'state-changing handler',
          control: 'No CSRF check',
        },
      ]),
    ).toBe(false);
    expect(
      hasCookieMutationInventory([
        {
          source: 'HttpOnly session cookie',
          transform: 'Client sends a synchronizer token but only checks it in JavaScript',
          sink: 'POST handler mutating dashboard state',
          control: 'Reject missing token on the client',
        },
      ]),
    ).toBe(false);
    expect(
      hasCookieMutationInventory([
        { source: 'HttpOnly session cookie', sink: 'POST handler changes dashboard state' },
        {
          transform: 'CSRF token checked against the authenticated session',
          control: 'Reject missing token on server',
        },
      ]),
    ).toBe(false);
  });

  test('privacy scorer rejects a stable caller identity disguised as aggregate adoption identity', async () => {
    const root = workspace();
    await materialize(
      root,
      'privacy-engineering/nearby-data-minimization@2',
      'privacy-engineering-full-task-1-individual',
      PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
    );
    writeFixtureFile(
      root,
      '.kory-eval/nearby-policy.json',
      `${JSON.stringify({
        adoptionFields: ['user'],
        nearbyFields: ['preciseLocation'],
        retainPreciseLocationMinutes: 30,
        retainStableDeviceId: false,
        deriveHomeWork: false,
        optOutSuppressesFuture: true,
        deletesPriorDerivedProfile: true,
        tombstoneQueuedEvents: true,
        backupRestoreReappliesSuppression: true,
      })}\n`,
    );
    const scorer = PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS.find(
      (item) => item.id === 'privacy-engineering/nearby-data-minimization-scorer@3',
    );
    expect(scorer).toBeDefined();
    const score = await scorer!.score({ workingDirectory: root } as never);
    expect(score.passed).toBe(false);
    expect(score.verification).toBe(0);
  });

  test('secure-authentication scorer rejects the former boolean-only recovery contract', async () => {
    const root = workspace();
    await materialize(
      root,
      'secure-authentication/consumer-passkey-recovery@2',
      'secure-authentication-full-task-1',
      AUTH_SECRETS_SECURITY_SKILL_EVAL_MATERIALIZERS,
    );
    writeFixtureFile(
      root,
      '.kory-eval/consumer-auth.json',
      `${JSON.stringify({
        password: {
          verifier: 'argon2id',
          memoryHard: true,
          compromisedScreening: true,
          antiEnumeration: true,
          throttleDimensions: ['account', 'source-network', 'device-or-client', 'global-capacity'],
          globalAttackerLockout: false,
        },
        webauthn: {
          challengeFreshnessSeconds: 120,
          rpId: 'accounts.example.test',
          origins: ['https://accounts.example.test'],
          requireUserVerification: true,
          verifyCredentialIdentity: true,
          verifySignature: true,
          duplicateEnrollmentRejected: true,
        },
        recovery: {
          codesSingleUse: true,
          codesProtectedLikeAuthenticator: true,
          lostDeviceRequiresDeliberateRecovery: true,
          recoveryEmailAloneResetsAll: false,
        },
        freshAuth: {
          maxAgeSeconds: 300,
          primaryEmail: true,
          removeAuthenticator: true,
          resetAllAuthenticators: true,
          exportRecoveryMaterial: true,
        },
        compromise: {
          revokeExistingSessions: true,
          rotateRefreshCredentials: true,
          securityEventRecorded: true,
        },
        phishingResistantMethods: ['webauthn'],
        oauthOidcInScope: false,
        evidence: 'synthetic design-only',
      })}\n`,
    );
    const scorer = AUTH_SECRETS_SECURITY_SKILL_EVAL_SCORERS.find(
      (item) => item.id === 'secure-authentication/consumer-passkey-recovery-scorer@3',
    );
    expect(scorer).toBeDefined();
    const score = await scorer!.score({ workingDirectory: root } as never);
    expect(score.passed).toBe(false);
  });

  test('supply-chain scorer rejects the former evidence-light release qualification', async () => {
    const root = workspace();
    await materialize(
      root,
      'supply-chain-security/release-trust-qualification@2',
      'supply-chain-security-full-task-1',
      SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_MATERIALIZERS,
    );
    writeFixtureFile(
      root,
      '.kory-eval/release-qualification.json',
      `${JSON.stringify({
        artifactDigest: 'sha256:4f8d9a1c-release',
        sourceRevision: 'git:9b7f1d2',
        approvedBuilder:
          'https://github.com/kory/release/.github/workflows/release.yml@refs/heads/main',
        approvedWorkflow: 'kory/release/.github/workflows/release.yml@refs/heads/main',
        allowedParameters: { platform: 'linux/amd64,linux/arm64', mode: 'release' },
        lockfileEnforced: true,
        inputs: [
          {
            kind: 'action',
            name: 'checkout',
            identity: 'actions/checkout@8ade135a',
            immutable: true,
          },
          { kind: 'action', name: 'setup-bun', identity: 'vendor/setup-bun@v2', immutable: false },
          { kind: 'base-image', name: 'distroless', identity: 'sha256:base123', immutable: true },
          { kind: 'toolchain', name: 'bun', identity: '1.3.2', immutable: true },
        ],
        sbom: {
          format: 'CycloneDX',
          components: ['app@1.8.0', 'codec-helper@2.4.0'],
          omissions: ['native-pack@3.2.1'],
          completenessClaim: false,
        },
        privilegedJobs: ['release-sign', 'publish-image'],
        mutablePrivilegedInputs: ['vendor/setup-bun@v2'],
        provenance: {
          subjectDigest: 'sha256:4f8d9a1c-release',
          sourceRevision: 'git:9b7f1d2',
          builder: 'https://github.com/fork/release/.github/workflows/release.yml@refs/heads/main',
          workflow: 'fork/release/.github/workflows/release.yml@refs/heads/main',
          parameters: { platform: 'linux/amd64,linux/arm64', mode: 'release' },
          valid: true,
        },
        signature: {
          subjectDigest: 'sha256:4f8d9a1c-release',
          cryptographicallyValid: true,
          issuer: 'https://token.actions.githubusercontent.com',
          workflowIdentity: 'fork/release/.github/workflows/release.yml@refs/heads/main',
          authorized: false,
        },
        cleanRebuild: { digest: 'sha256:4f8d9a1c-release', matched: true },
        verdict: 'reject',
        liveProviderVerified: false,
        ownership: { pipelineMechanics: 'cicd-engineering', keyCustody: 'secrets-key-management' },
      })}\n`,
    );
    const scorer = SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_SCORERS.find(
      (item) => item.id === 'supply-chain-security/release-trust-qualification-scorer@2',
    );
    expect(scorer).toBeDefined();
    const score = await scorer!.score({ workingDirectory: root } as never);
    expect(score.passed).toBe(false);
  });

  test('review and threat-model task contracts require explicit verification status without invented execution', () => {
    const repositoryRoot = join(import.meta.dir, '..', '..', '..', '..');
    for (const skill of ['security-review', 'threat-modeling-practice']) {
      for (const scenario of ['scenario-1.json', 'scenario-2.json']) {
        const task = JSON.parse(
          readFileSync(
            join(repositoryRoot, 'skills-v5', skill, 'evals', 'tasks', scenario),
            'utf8',
          ),
        ) as { prompt: string; requiredEvidence: string[] };
        expect(task.prompt.toLowerCase()).toContain('do not invent executed proof');
        expect(task.requiredEvidence.join(' ')).not.toContain(
          'Representative success, negative-path, and recovery verification',
        );
      }
    }
    expect(
      SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS.filter((item) =>
        item.scenarioIds.some((id) => id.startsWith('security-review-full-task')),
      ).every((item) => item.id.endsWith('@2')),
    ).toBe(true);
    expect(
      SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS.filter((item) =>
        item.scenarioIds.some((id) => id.startsWith('threat-modeling-practice-full-task')),
      ).every((item) => item.id.endsWith('@2')),
    ).toBe(true);
  });
});
