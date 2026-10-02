import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const DESKTOP = 'architecture-planning-full-task-1';
const WEBHOOK = 'architecture-planning-full-task-2';

function normalized(value: unknown): string {
  return JSON.stringify(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

const desktopMaterializer: SkillEvalFixtureMaterializer = {
  id: 'architecture-planning/desktop-task-runner-boundary@1',
  matches: (scenario) => scenario.id === DESKTOP,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'requirements.json',
      `${JSON.stringify(
        {
          current: {
            product: 'single-user desktop app',
            executor: 'in-process',
            state: 'one local SQLite database',
          },
          constraints: {
            maxTaskMinutes: 30,
            surviveUiRestart: true,
            cancellation: true,
            perProjectMutatorConcurrency: 1,
            networkServiceRequired: false,
            teamEngineers: 2,
          },
          requiredAlternatives: [
            'retain in-process execution with durable resumable state',
            'local sidecar worker',
          ],
          criteria: [
            'lifecycle',
            'state ownership',
            'cancellation',
            'crash recovery',
            'upgrade compatibility',
            'observability',
            'operational cost',
            'future multi-process needs',
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Desktop task-runner architecture fixture

Produce a decision-ready architecture, not implementation. Compare both required alternatives against the same criteria in \`requirements.json\`; long-running work alone is not evidence that a sidecar is superior.

Write \`.kory-eval/architecture-desktop.json\` with: assumptions; same-criteria alternative matrix; chosen boundary and rejected alternative; component responsibilities/interfaces; state/control flow; cancellation/crash/upgrade/observability failure paths; quality scenarios for UI restart recovery, cancellation, per-project mutation serialization, and upgrade compatibility; tradeoffs/reversal triggers; and evidence/prototype work required before irreversible commitment.
`,
    );
  },
};

const desktopScorer: SkillEvalDeterministicScorer = {
  id: 'architecture-planning/desktop-task-runner-boundary-scorer@3',
  scenarioIds: [DESKTOP],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/architecture-desktop.json',
    );
    const body = normalized(artifact);
    const alternatives =
      /in-process|in process/u.test(body) &&
      /sidecar/u.test(body) &&
      /lifecycle/u.test(body) &&
      /state ownership|state owner/u.test(body) &&
      /cancel/u.test(body) &&
      /crash|restart/u.test(body) &&
      /upgrade/u.test(body) &&
      /observab/u.test(body) &&
      /operational|complexity|cost/u.test(body) &&
      /multi-process|multi process|multiprocess/u.test(body);
    const constraints =
      /30/u.test(body) &&
      /sqlite/u.test(body) &&
      /single-user|single user|one user/u.test(body) &&
      /two[- ]engineer|2 engineers|2 engineer|team.*2/u.test(body) &&
      /no network|network.*out of scope|local-only/u.test(body);
    const boundaries =
      /responsib|ownership/u.test(body) &&
      /interface/u.test(body) &&
      /data flow|control flow/u.test(body) &&
      /failure/u.test(body) &&
      /observab/u.test(body);
    const quality =
      /ui.*restart|restart.*ui/u.test(body) &&
      /cancel/u.test(body) &&
      /one.*project|per-project|serialization/u.test(body) &&
      /upgrade.*compat|compat.*upgrade/u.test(body);
    const evidence =
      /prototype|spike|experiment|validate|evidence/u.test(body) &&
      /revisit|reversal|trigger|assumption/u.test(body) &&
      /choose|chosen|decision/u.test(body) &&
      /reject|rejected|alternative/u.test(body);
    const passed =
      Boolean(artifact) && alternatives && constraints && boundaries && quality && evidence;
    return {
      passed,
      quality: passed ? 1 : alternatives && boundaries && quality ? 0.75 : alternatives ? 0.5 : 0,
      verification: alternatives && quality && evidence ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `same-criteria incumbent vs sidecar comparison: ${alternatives ? 'complete' : 'incomplete'}`,
        `stated constraints preserved: ${constraints ? 'yes' : 'no'}`,
        `chosen boundary/interfaces/failure ownership: ${boundaries ? 'explicit' : 'missing'}`,
        `restart/cancel/serialization/upgrade quality scenarios: ${quality ? 'complete' : 'incomplete'}`,
        `decision assumptions/reversal/prototype evidence: ${evidence ? 'bounded' : 'missing'}`,
      ],
    };
  },
};

const webhookMaterializer: SkillEvalFixtureMaterializer = {
  id: 'architecture-planning/webhook-ingestion-system@1',
  matches: (scenario) => scenario.id === WEBHOOK,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'requirements.json',
      `${JSON.stringify(
        {
          ingress: 'signed customer POST events',
          delivery: { duplicate: true, outOfOrder: true },
          load: { normalEventsPerSecond: 50, burstEventsPerSecond: 2000, burstMinutes: 10 },
          ack: { p95MsMax: 250, acceptedMustNotBeLost: true },
          ordering: 'per-customer only',
          downstreamOutageMinutes: 20,
          replayDays: 7,
          requiredAlternatives: ['synchronous processing', 'durable ingest + queue/worker'],
          providerSpecificServiceRequired: false,
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Webhook ingestion architecture fixture

Design from constraints rather than vendor fashion. Compare synchronous processing and durable-ingest + queue/worker. The acknowledgement boundary must make the no-loss claim testable.

Write \`.kory-eval/architecture-webhook.json\` with assumptions; same-criteria alternative matrix; chosen/rejected design; signed-event trust boundary; idempotency identity; durable state owner and exact acknowledgement point; per-customer partition/order key without global ordering; backpressure; retry/dead-letter/seven-day replay; downstream-outage isolation; observability; burst capacity assumptions; and concrete load/failure quality scenarios for 2,000 events/s for ten minutes and a twenty-minute enrichment outage. Avoid provider-specific service names unless justified.
`,
    );
  },
};

const webhookScorer: SkillEvalDeterministicScorer = {
  id: 'architecture-planning/webhook-ingestion-system-scorer@4',
  scenarioIds: [WEBHOOK],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/architecture-webhook.json',
    );
    const body = normalized(artifact);
    const alternatives =
      /synchronous/u.test(body) &&
      /queue|worker/u.test(body) &&
      /durable/u.test(body) &&
      /chosen|decision/u.test(body) &&
      /reject|tradeoff/u.test(body);
    const durability =
      /ack|acknowledg/u.test(body) &&
      /durable.*before|after.*durable|commit.*ack|persist.*ack/u.test(body) &&
      /idempoten/u.test(body) &&
      /signed|signature|trust/u.test(body);
    const ordering =
      /customer.*(?:partition|key|order)|partition.*customer/u.test(body) &&
      /duplicate/u.test(body) &&
      /out.?of.?order/u.test(body) &&
      /not.*global|no global|without global/u.test(body) &&
      /retry/u.test(body) &&
      /dead.?letter|dlq/u.test(body) &&
      /7 day|seven day|7-day/u.test(body) &&
      /replay/u.test(body);
    const loadValidation =
      /(?:load|capacity|burst).{0,160}(?:test|scenario|validat)|(?:test|scenario|validat).{0,160}(?:load|capacity|burst)/u.test(
        body,
      );
    const failureValidation =
      /(?:failure|outage).{0,160}(?:test|scenario|validat)|(?:test|scenario|validat).{0,160}(?:failure|outage)/u.test(
        body,
      );
    const capacity =
      /50/u.test(body) &&
      /2,?000|2000/u.test(body) &&
      /10 minute|ten minute/u.test(body) &&
      /20 minute|twenty minute/u.test(body) &&
      /250/u.test(body) &&
      /backpressure/u.test(body) &&
      loadValidation &&
      failureValidation;
    const boundaries =
      /state.?owner|owns? the|ownership|responsib/u.test(body) &&
      /observab/u.test(body) &&
      /failure/u.test(body);
    const noVendorAssumption = !/\b(?:sqs|kafka|pubsub|service bus|kinesis)\b/iu.test(body);
    const passed =
      Boolean(artifact) &&
      alternatives &&
      durability &&
      ordering &&
      capacity &&
      boundaries &&
      noVendorAssumption;
    return {
      passed,
      quality: passed
        ? 1
        : durability && ordering && capacity
          ? 0.75
          : durability && ordering
            ? 0.5
            : 0,
      verification: durability && ordering && capacity ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `synchronous vs durable-worker alternatives: ${alternatives ? 'compared' : 'missing'}`,
        `durable acknowledgement/trust/idempotency boundary: ${durability ? 'explicit' : 'missing'}`,
        `per-customer ordering/retry/replay: ${ordering ? 'complete' : 'incomplete'}`,
        `burst/outage/backpressure validation: ${capacity ? 'concrete' : 'incomplete'}`,
        `provider-neutral boundary model: ${noVendorAssumption ? 'yes' : 'no'}`,
      ],
    };
  },
};

export const ARCHITECTURE_PLANNING_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [desktopMaterializer, webhookMaterializer];

export const ARCHITECTURE_PLANNING_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  desktopScorer,
  webhookScorer,
];
