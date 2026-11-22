import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const INTERNAL_PLATFORM = 'developer-experience-full-task-internal-platform';
const PUBLIC_SDK = 'developer-experience-full-task-public-sdk';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const internalPlatformMaterializer: SkillEvalFixtureMaterializer = {
  id: 'developer-experience/internal-platform-workflow@1',
  matches: (scenario) => scenario.id === INTERNAL_PLATFORM,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'platform/inventory.json',
      json({
        repositoryTemplate: 'service-template@7',
        commands: {
          create: 'kplat create',
          setup: 'kplat setup',
          credentials: 'kplat auth login',
          configure: 'kplat config validate',
          deploy: 'kplat deploy',
          status: 'kplat status --json',
          logs: 'kplat logs --request <id>',
          traces: 'kplat trace <request-id>',
          rollback: 'kplat rollback <deployment-id>',
          upgrade: 'kplat upgrade --plan',
          transfer: 'kplat ownership transfer',
          remove: 'kplat service remove --plan',
        },
        inspectableState: [
          'project',
          'environment',
          'credential-principal',
          'owner-team',
          'deployment-id',
          'request-id',
          'platform-version',
        ],
      }),
    );
    writeFixtureFile(
      destination,
      'evidence/developer-feedback.json',
      json({
        sample: 'qualitative reports, not validated causes',
        reports: [
          {
            segment: 'new-engineer',
            report: 'setup feels confusing and deploy feedback feels slow',
          },
          { segment: 'service-owner', report: 'failed deploys take too long to diagnose' },
          {
            segment: 'service-owner',
            report: 'upgrades and ownership transfer are hard to reason about',
          },
        ],
      }),
    );
    writeFixtureFile(
      destination,
      'evidence/task-samples.json',
      json({
        newEngineer: {
          setupAttempts: 12,
          setupCompleted: 8,
          medianMinutesToFirstDeploy: 43,
          commonObservedStops: ['credential-scope discovery', 'config validation'],
        },
        experiencedOwner: {
          failedDeployInvestigations: 10,
          medianMinutesToLocateRequestId: 11,
          successfulRollbackExercises: 9,
          upgradePlansCompletedWithoutSupport: 6,
        },
      }),
    );
    writeFixtureFile(
      destination,
      'evidence/system-measures.json',
      json({
        ciMedianMinutes: 7.8,
        ciP95Minutes: 15.1,
        deployApiMedianSeconds: 33,
        failedDeploysWithRequestIdInFirstScreen: '42%',
        authScopeErrorsPer100Setups: 17,
        rollbackCommandSuccessRate: '96%',
        note: 'These system measures are correlates/diagnostic evidence. They do not establish developer productivity or a single causal bottleneck.',
      }),
    );
    writeFixtureFile(
      destination,
      'profiles/developers.json',
      json({
        segments: [
          {
            id: 'new-engineer',
            frequency: 'low/recent',
            knowledge: 'low platform familiarity',
            permissions: 'often incomplete until team onboarding finishes',
            failureCost: 'blocked first contribution',
          },
          {
            id: 'experienced-owner',
            frequency: 'weekly/daily',
            knowledge: 'high service context',
            permissions: 'production owner',
            failureCost: 'service/release impact',
          },
        ],
      }),
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Internal platform developer-experience fixture

The reports in \`evidence/developer-feedback.json\` are hypotheses, not validated causes. Use the repository inventory, task samples, and system measures to build an evidence-backed improvement plan without collapsing developer productivity into CI duration or any other single metric.

Write \`.kory-eval/internal-platform-dx.json\` with: developer segments/jobs; the complete lifecycle journey; friction hypotheses with evidence/support status; proposed changes tied to evidence gaps; clean/failure-state recovery checks; and a measurement contract that keeps developer feedback, task outcomes, and system measures distinct.

The lifecycle must cover creation/setup, credentials/configuration, deployment, CI feedback, logs/traces and failed-deploy diagnosis, rollback, dependency/platform upgrades, ownership transfer, and eventual removal. Preserve segment-specific differences instead of treating new engineers and experienced owners as one persona.
`,
    );
  },
};

const publicSdkMaterializer: SkillEvalFixtureMaterializer = {
  id: 'developer-experience/public-sdk-integration@1',
  matches: (scenario) => scenario.id === PUBLIC_SDK,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'sdk/contract.json',
      json({
        package: '@kory/data-sdk',
        version: '2.8.0',
        install: 'npm install @kory/data-sdk@2.8.0',
        auth: { env: 'KORY_API_TOKEN', scopes: ['jobs:write', 'jobs:read'] },
        projectSelection: 'new KoryClient({ projectId })',
        submit: {
          call: 'client.jobs.submit({ input, idempotencyKey })',
          identity: 'caller-supplied idempotencyKey',
          success: '{ jobId, requestId }',
          indeterminateOutcome:
            'If the connection is lost after send, do not blindly submit with a new key. Reconcile with jobs.findByIdempotencyKey(key) before deciding whether another submit is safe.',
        },
        inspect: 'client.jobs.get(jobId)',
        cancel: 'client.jobs.cancel(jobId)',
        cleanup: 'client.jobs.delete(jobId) for terminal test jobs',
      }),
    );
    writeFixtureFile(
      destination,
      'sdk/errors.json',
      json({
        permission: {
          code: 'permission_denied',
          http: 403,
          fields: ['requestId', 'requiredScope', 'principal'],
          retryable: false,
        },
        rateLimit: {
          code: 'rate_limited',
          http: 429,
          fields: ['requestId', 'retryAfterSeconds'],
          retryable: true,
        },
        processing: {
          code: 'processing_failed',
          fields: ['jobId', 'requestId', 'stage', 'diagnosticCode'],
          retryable: false,
        },
      }),
    );
    writeFixtureFile(
      destination,
      'sdk/versions.json',
      json({
        currentApi: 'v2',
        supported: ['v1', 'v2'],
        v1SupportEnds: '2027-03-31',
        migrationGuide: 'docs/migrate-v1-v2.md',
        rollback:
          'Client package rollback is supported while the integration has not adopted v2-only job fields. Once v2-only writes are used, forward migration/repair is required; downgrade is not guaranteed safe.',
      }),
    );
    writeFixtureFile(
      destination,
      'docs/index.json',
      json({
        quickstart: 'docs/quickstart.md',
        authentication: 'docs/auth.md',
        errors: 'docs/errors.md',
        idempotency: 'docs/idempotency.md',
        jobLifecycle: 'docs/jobs.md',
        migration: 'docs/migrate-v1-v2.md',
        cleanup: 'docs/test-resource-cleanup.md',
      }),
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Public SDK developer-experience fixture

The API contract is fixed for this exercise. Do not invent incompatible endpoints or silently change retry/idempotency semantics to make the journey easier.

Write \`.kory-eval/public-sdk-dx.json\` with a decision-ready journey from install/auth/project selection through submit, indeterminate-outcome reconciliation, progress, permission/rate/processing diagnosis, documentation discovery, supported-version migration/compatibility, rollback boundaries, and test-resource cleanup. Include first-use and repeat/failure-use evaluation with developer feedback, task measures, and system evidence as separate signal classes.
`,
    );
  },
};

function text(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}

const internalPlatformScorer: SkillEvalDeterministicScorer = {
  id: 'developer-experience/internal-platform-workflow-scorer@1',
  scenarioIds: [INTERNAL_PLATFORM],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/internal-platform-dx.json',
    );
    const body = text(artifact);
    const segments =
      /new-engineer|new engineer/u.test(body) && /experienced-owner|experienced owner/u.test(body);
    const lifecycle = [
      /creat|repository|setup/u,
      /credential|auth/u,
      /config/u,
      /deploy/u,
      /ci\b|continuous integration/u,
      /log|trace|diagnos/u,
      /rollback/u,
      /upgrade/u,
      /ownership.*transfer|transfer.*ownership/u,
      /remov|decommission|delete/u,
    ].every((pattern) => pattern.test(body));
    const evidenceDiscipline =
      /hypoth|unvalidated|not validated|evidence gap|unknown cause/u.test(body) &&
      /feedback/u.test(body) &&
      /task/u.test(body) &&
      /system/u.test(body) &&
      !/ci[^.]{0,80}(?:proves|is the cause|sole|only metric)/u.test(body);
    const inspectRecovery =
      /permission|scope/u.test(body) &&
      /owner/u.test(body) &&
      /state/u.test(body) &&
      /request.?id|deployment.?id/u.test(body) &&
      /failed[^.]{0,80}deploy|deploy[^.]{0,80}fail/u.test(body) &&
      /rollback/u.test(body) &&
      /upgrade/u.test(body) &&
      /transfer/u.test(body) &&
      /remov/u.test(body);
    const balanced =
      /feedback/u.test(body) &&
      /completion|success rate|task outcome|time to|diagnos/u.test(body) &&
      /latency|error|request|system|ci/u.test(body) &&
      /multiple|triangulat|balanced|signal classes|separate/u.test(body);
    const passed =
      Boolean(artifact) &&
      segments &&
      lifecycle &&
      evidenceDiscipline &&
      inspectRecovery &&
      balanced;
    return {
      passed,
      quality: passed
        ? 1
        : segments && lifecycle && evidenceDiscipline
          ? 0.75
          : lifecycle
            ? 0.5
            : 0,
      verification: lifecycle && inspectRecovery ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `new/experienced segments: ${segments ? 'distinct' : 'missing'}`,
        `whole lifecycle: ${lifecycle ? 'covered' : 'incomplete'}`,
        `reported friction remains hypothesis: ${evidenceDiscipline ? 'yes' : 'no'}`,
        `inspectability/recovery contract: ${inspectRecovery ? 'complete' : 'incomplete'}`,
        `multi-signal measurement: ${balanced ? 'present' : 'missing'}`,
      ],
    };
  },
};

const publicSdkScorer: SkillEvalDeterministicScorer = {
  id: 'developer-experience/public-sdk-integration-scorer@1',
  scenarioIds: [PUBLIC_SDK],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/public-sdk-dx.json');
    const body = text(artifact);
    const contractPreserved =
      /@kory\/data-sdk|2\.8\.0/u.test(body) &&
      /kory_api_token|jobs:write|jobs:read/u.test(body) &&
      /projectid|project id/u.test(body) &&
      /jobs\.submit|submit/u.test(body) &&
      !/new endpoint|change the api|replace the api/iu.test(body);
    const unknownOutcome =
      /idempotencykey|idempotency key/u.test(body) &&
      /findbyidempotencykey|reconcil/u.test(body) &&
      /indeterminate|unknown outcome|connection.*lost/u.test(body) &&
      /do not[^.]{0,80}(?:blind|new key|resubmit)|avoid[^.]{0,80}blind/u.test(body);
    const diagnosis =
      /permission_denied|403/u.test(body) &&
      /requiredscope|required scope/u.test(body) &&
      /rate_limited|429/u.test(body) &&
      /retryafter|retry after/u.test(body) &&
      /processing_failed|processing failed/u.test(body) &&
      /requestid|request id/u.test(body) &&
      /jobid|job id/u.test(body) &&
      /docs|documentation/u.test(body);
    const versionLifecycle =
      /\bv1\b/u.test(body) &&
      /\bv2\b/u.test(body) &&
      /2027-03-31/u.test(body) &&
      /migrat/u.test(body) &&
      /rollback/u.test(body) &&
      /v2-only|not guaranteed|forward/u.test(body) &&
      /cleanup|delete|remove/u.test(body);
    const evaluation =
      /first[- ]use|first use/u.test(body) &&
      /repeat|failure[- ]use|recovery/u.test(body) &&
      /feedback/u.test(body) &&
      /task/u.test(body) &&
      /system/u.test(body) &&
      /multiple|triangulat|balanced|separate/u.test(body);
    const passed =
      Boolean(artifact) &&
      contractPreserved &&
      unknownOutcome &&
      diagnosis &&
      versionLifecycle &&
      evaluation;
    return {
      passed,
      quality: passed
        ? 1
        : contractPreserved && unknownOutcome && diagnosis && versionLifecycle
          ? 0.75
          : contractPreserved && unknownOutcome
            ? 0.5
            : 0,
      verification: unknownOutcome && diagnosis && versionLifecycle ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `fixed SDK/API contract: ${contractPreserved ? 'preserved' : 'drifted/incomplete'}`,
        `indeterminate-outcome reconciliation: ${unknownOutcome ? 'safe' : 'missing'}`,
        `permission/rate/processing diagnosis: ${diagnosis ? 'complete' : 'incomplete'}`,
        `version/rollback/cleanup lifecycle: ${versionLifecycle ? 'complete' : 'incomplete'}`,
        `multi-signal first/repeat-use evaluation: ${evaluation ? 'present' : 'missing'}`,
      ],
    };
  },
};

export const DEVELOPER_EXPERIENCE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [internalPlatformMaterializer, publicSdkMaterializer];

export const DEVELOPER_EXPERIENCE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  internalPlatformScorer,
  publicSdkScorer,
];
