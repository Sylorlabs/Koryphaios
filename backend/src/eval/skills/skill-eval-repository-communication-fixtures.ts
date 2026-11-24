import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const RELEASE_NOTES = 'documents-communication-full-task-1-individual';
const SETUP_GUIDE = 'instructional-communication-full-task-1-individual';
const EXTRACTION_PLAN = 'planning-full-task-2-individual';
const TECH_DESIGN = 'technical-communication-full-task-1-individual';

const RELEASE_PACKET = {
  from: 'v5.2.0',
  to: 'v5.3.0',
  template: ['Highlights', 'Fixes', 'Known limitations'],
  changes: [
    {
      id: 'PR-101',
      kind: 'feature',
      userVisible: true,
      confirmed: true,
      title: 'Add resumable uploads after network interruption',
      evidence: 'diff adds resume token and integration test',
    },
    {
      id: 'PR-102',
      kind: 'fix',
      userVisible: true,
      confirmed: true,
      title: 'Preserve filter selection when returning from detail view',
      evidence: 'state restoration regression test',
    },
    {
      id: 'PR-103',
      kind: 'internal',
      userVisible: false,
      confirmed: true,
      title: 'Refactor query cache ownership',
      evidence: 'no public API or behavior change',
    },
    {
      id: 'PR-104',
      kind: 'ambiguous',
      userVisible: null,
      confirmed: false,
      title: 'Reduce background sync wakeups',
      evidence: 'implementation changed; user impact not measured',
    },
  ],
} as const;

const SETUP_PACKET = {
  toolchain: { bun: '1.3.14', node: '24.x' },
  start: { backend: 'bun run --filter backend dev', frontend: 'bun run --filter frontend dev' },
  verify: {
    backend: 'bun test backend/src/kory/__tests__/skills.test.ts',
    frontend: 'bun test frontend/src/lib/components/skills-workspace.test.ts',
  },
  envRequired: ['KORY_DATA_DIR'],
  failures: [
    {
      diagnostic: 'Unsupported lockfile version',
      cause: 'Bun older than 1.3',
      recovery: 'Install Bun 1.3.14 and rerun bun install --frozen-lockfile',
    },
    {
      diagnostic: 'KORY_DATA_DIR is required',
      cause: 'environment template not copied',
      recovery: 'Copy .env.example to .env and set KORY_DATA_DIR to a writable project-local path',
    },
  ],
  versionDifference: 'Bun 1.3 uses bun run --filter; older workspace invocation is unsupported.',
} as const;

const PLAN_PACKET = {
  callers: ['billing', 'account-settings', 'admin-replay'],
  tables: ['notifications', 'notification_attempts'],
  queue: 'jobs-default',
  constraints: [
    'no lost transactional email',
    'old and new versions overlap during rolling deploy',
    'rollback must remain possible after partial cutover',
    'independent service owns delivery only after reconciliation parity',
  ],
  owners: {
    monolith: 'App team',
    delivery: 'Messaging team',
    platform: 'Platform team',
    security: 'Security',
  },
  compatibility: ['password-reset', 'receipt', 'security-alert'],
} as const;

const DESIGN_PACKET = {
  current: {
    mode: 'synchronous webhook delivery in request path',
    idempotency: 'event_key unique per customer',
    latencySloMs: 800,
    deployments: ['api', 'worker'],
    tests: ['duplicate event', 'provider 500 retry'],
  },
  queue: { version: 'jobs-v2', retry: 'exponential 5 attempts', deadLetter: 'webhook-dlq' },
  alternatives: [
    {
      id: 'A',
      name: 'transactional outbox + worker',
      tradeoff: 'adds durable handoff and worker operations; preserves request latency',
    },
    {
      id: 'B',
      name: 'in-memory background task',
      tradeoff: 'low complexity but loses work on process failure',
    },
  ],
  unknowns: ['peak webhook fanout during backfill'],
} as const;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function regularText(root: string, path: string): string | null {
  try {
    const stat = lstatSync(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return readFixtureText(root, path);
  } catch {
    return null;
  }
}
function fixed(root: string, path: string, expected: string): boolean {
  return regularText(root, path) === expected;
}
function containsAll(text: string | null, patterns: RegExp[]): boolean {
  return (
    !!text &&
    patterns.every((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    })
  );
}

function scoreRelease(root: string): SkillEvalDeterministicScore {
  const packet = json(RELEASE_PACKET);
  const intact = fixed(root, 'evidence/release.json', packet);
  const notes = regularText(root, 'release-notes.md');
  const holdMarker = notes?.search(/Editorial hold \(draft only, not for publication\)/iu) ?? -1;
  const publishableNotes = holdMarker >= 0 ? notes!.slice(0, holdMarker) : notes;
  const holdNotes = holdMarker >= 0 ? notes!.slice(holdMarker) : null;
  const map = readJsonArtifact<{ included?: string[]; excluded?: string[]; uncertain?: string[] }>(
    root,
    'evidence-map.json',
  );
  const checks: [string, boolean][] = [
    ['packet integrity', intact],
    ['target release identity', containsAll(notes, [/v5\.3\.0/iu])],
    ['confirmed feature represented', containsAll(notes, [/resumable upload/iu, /PR-101/iu])],
    ['confirmed fix represented', containsAll(notes, [/filter selection/iu, /PR-102/iu])],
    ['internal-only change excluded', !!notes && !/query cache ownership|PR-103/iu.test(notes)],
    [
      'ambiguous impact bounded',
      !!holdNotes &&
        !/Known limitations[\s\S]*PR-104/iu.test(publishableNotes ?? '') &&
        containsAll(holdNotes, [
          /PR-104/iu,
          /(unconfirmed|unknown|not(?:\s+\w+){0,2}\s+measured|uncertain)/iu,
        ]),
    ],
    [
      'structured provenance',
      Array.isArray(map?.included) &&
        map!.included!.includes('PR-101') &&
        map!.included!.includes('PR-102') &&
        Array.isArray(map?.excluded) &&
        map!.excluded!.includes('PR-103') &&
        Array.isArray(map?.uncertain) &&
        map!.uncertain!.includes('PR-104'),
    ],
  ];
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: !intact,
    evidence: checks.map(([n, ok]) => `${n}: ${ok ? 'pass' : 'fail'}`),
  };
}

function scoreSetup(root: string): SkillEvalDeterministicScore {
  const packet = json(SETUP_PACKET);
  const intact = fixed(root, 'evidence/setup.json', packet);
  const guide = regularText(root, 'setup-guide.md');
  const checks: [string, boolean][] = [
    ['packet integrity', intact],
    ['toolchain pinned', containsAll(guide, [/Bun 1\.3\.14/iu, /Node 24/iu])],
    ['environment prerequisite', containsAll(guide, [/KORY_DATA_DIR/iu, /\.env\.example/iu])],
    ['backend startup', containsAll(guide, [/bun run --filter backend dev/u])],
    ['frontend startup', containsAll(guide, [/bun run --filter frontend dev/u])],
    [
      'both verification targets',
      containsAll(guide, [/skills\.test\.ts/u, /skills-workspace\.test\.ts/u]),
    ],
    [
      'lockfile recovery',
      containsAll(guide, [/Unsupported lockfile version/iu, /frozen-lockfile/iu]),
    ],
    [
      'environment recovery',
      containsAll(guide, [/KORY_DATA_DIR is required/iu, /writable project-local/iu]),
    ],
    ['completion check explicit', containsAll(guide, [/(verify|completion|successful)/iu])],
  ];
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: !intact,
    evidence: checks.map(([n, ok]) => `${n}: ${ok ? 'pass' : 'fail'}`),
  };
}

interface PlanArtifact {
  phases?: Array<{
    id?: string;
    owners?: string[];
    dependsOn?: string[];
    gate?: string;
    rollback?: string;
  }>;
  openQuestions?: string[];
  cutoverEvidence?: string[];
}
function scorePlan(root: string): SkillEvalDeterministicScore {
  const packet = json(PLAN_PACKET);
  const intact = fixed(root, 'evidence/architecture.json', packet);
  const plan = readJsonArtifact<PlanArtifact>(root, 'plan.json');
  const prose = regularText(root, 'plan.md');
  const rawPhases = Array.isArray(plan?.phases) ? plan.phases : [];
  const phaseRowsValid = rawPhases.every(
    (phase) => phase !== null && typeof phase === 'object' && !Array.isArray(phase),
  );
  const phases = phaseRowsValid ? rawPhases : [];
  const ids = phases.map((p) => p.id);
  const required = ['inventory', 'contract', 'outbox', 'shadow-reconcile', 'cutover', 'retire'];
  const phaseComplete = phaseRowsValid && required.every((id) => ids.includes(id));
  const gated =
    phaseComplete &&
    phases.every(
      (p) =>
        typeof p.gate === 'string' &&
        p.gate.length > 8 &&
        typeof p.rollback === 'string' &&
        p.rollback.length > 8 &&
        Array.isArray(p.owners) &&
        p.owners.length > 0,
    );
  const dependency =
    phaseComplete &&
    ids[0] === 'inventory' &&
    new Set(ids).size === phases.length &&
    phases.every((phase, index) => {
      if (typeof phase.id !== 'string' || !phase.id.trim()) return false;
      if (phase.id === 'inventory') {
        return !phase.dependsOn || (Array.isArray(phase.dependsOn) && phase.dependsOn.length === 0);
      }
      const dependencies = phase.dependsOn;
      return (
        Array.isArray(dependencies) &&
        dependencies.length > 0 &&
        new Set(dependencies).size === dependencies.length &&
        dependencies.every(
          (id) => typeof id === 'string' && ids.indexOf(id) < index && ids.includes(id),
        )
      );
    });
  const checks: [string, boolean][] = [
    ['packet integrity', intact],
    [
      'ordered compatibility phases',
      phaseComplete &&
        required.every(
          (id, i) =>
            ids.indexOf(id) < 0 || i === 0 || ids.indexOf(required[i - 1]!) < ids.indexOf(id),
        ),
    ],
    ['owners gates rollback', gated],
    ['dependency graph', dependency],
    [
      'cutover evidence',
      Array.isArray(plan?.cutoverEvidence) && plan!.cutoverEvidence!.length >= 3,
    ],
    [
      'open questions preserved',
      Array.isArray(plan?.openQuestions) && plan!.openQuestions!.length > 0,
    ],
    [
      'no speculative implementation code',
      !!prose && !/```(?:ts|js|sql|go|rust|python)/iu.test(prose),
    ],
    [
      'compatibility called out',
      containsAll(prose, [/password-reset/iu, /receipt/iu, /security-alert/iu, /reconciliation/iu]),
    ],
  ];
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: !intact,
    evidence: checks.map(([n, ok]) => `${n}: ${ok ? 'pass' : 'fail'}`),
  };
}

interface DesignArtifact {
  decision?: string;
  mechanism?: string[];
  alternatives?: string[];
  risks?: string[];
  openQuestions?: string[];
  verification?: string[];
  rollback?: string;
}
function scoreDesign(root: string): SkillEvalDeterministicScore {
  const packet = json(DESIGN_PACKET);
  const intact = fixed(root, 'evidence/current.json', packet);
  const design = readJsonArtifact<DesignArtifact>(root, 'design.json');
  const prose = regularText(root, 'design.md');
  const checks: [string, boolean][] = [
    ['packet integrity', intact],
    ['decision explicit', design?.decision === 'A'],
    [
      'mechanism covers durability/idempotency/dlq',
      Array.isArray(design?.mechanism) &&
        containsAll(design!.mechanism!.join(' '), [
          /outbox/iu,
          /idempot/iu,
          /dead.?letter|dlq/iu,
          /worker/iu,
        ]),
    ],
    [
      'alternatives compared',
      Array.isArray(design?.alternatives) &&
        design!.alternatives!.includes('A') &&
        design!.alternatives!.includes('B'),
    ],
    ['SLO and topology evidence', containsAll(prose, [/800\s*ms/iu, /api/iu, /worker/iu])],
    [
      'risk and open question',
      Array.isArray(design?.risks) &&
        design!.risks!.length > 0 &&
        Array.isArray(design?.openQuestions) &&
        design!.openQuestions!.some((q) => /fanout/iu.test(q)),
    ],
    [
      'verification covers duplicate/provider failure',
      Array.isArray(design?.verification) &&
        containsAll(design!.verification!.join(' '), [/duplicate/iu, /500|provider failure/iu]),
    ],
    ['rollback explicit', typeof design?.rollback === 'string' && design!.rollback!.length > 10],
  ];
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: !intact,
    evidence: [
      ...checks.map(([n, ok]) => `${n}: ${ok ? 'pass' : 'fail'}`),
      `design sha256: ${prose ? createHash('sha256').update(prose).digest('hex') : 'missing'}`,
    ],
  };
}

export const REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    {
      id: 'documents-communication/release-evidence@1',
      matches: (s) => s.id === RELEASE_NOTES,
      materialize: (root) => {
        writeFixtureFile(root, 'evidence/release.json', json(RELEASE_PACKET));
        writeFixtureFile(root, 'release-notes.md', '# v5.3.0 release notes\n\nTODO\n');
        writeFixtureFile(
          root,
          'evidence-map.json',
          '{"included":[],"excluded":[],"uncertain":[]}\n',
        );
        writeFixtureFile(
          root,
          'README.md',
          '# Release notes fixture\nUse evidence/release.json and the supplied version boundary. Follow the packet template. Cite source IDs for every release claim; internal-only changes do not belong in customer notes and ambiguous impact must stay explicitly uncertain.\n',
        );
      },
    },
    {
      id: 'instructional-communication/clean-machine-setup@1',
      matches: (s) => s.id === SETUP_GUIDE,
      materialize: (root) => {
        writeFixtureFile(root, 'evidence/setup.json', json(SETUP_PACKET));
        writeFixtureFile(root, 'setup-guide.md', '# Clean machine setup\n\nTODO\n');
        writeFixtureFile(
          root,
          'README.md',
          '# Setup guide fixture\nWrite setup-guide.md from the fixed packet. Include prerequisites, exact startup commands, expected verification, both documented failure diagnostics/recoveries, and a completion check. Do not invent unsupported commands.\n',
        );
      },
    },
    {
      id: 'planning/notification-extraction-plan@3',
      matches: (s) => s.id === EXTRACTION_PLAN,
      materialize: (root) => {
        writeFixtureFile(root, 'evidence/architecture.json', json(PLAN_PACKET));
        writeFixtureFile(root, 'plan.md', '# Notification extraction plan\n\nTODO\n');
        writeFixtureFile(
          root,
          'plan.json',
          '{"phases":[],"openQuestions":[],"cutoverEvidence":[]}\n',
        );
        writeFixtureFile(
          root,
          'README.md',
          '# Notification extraction planning fixture\nCreate plan.md plus plan.json. Required phase ids are inventory, contract, outbox, shadow-reconcile, cutover, retire. Every phase has owners, dependencies (except inventory), an evidence gate, and rollback. Preserve open questions; this is a plan, not implementation code.\n',
        );
      },
    },
    {
      id: 'technical-communication/webhook-async-design@1',
      matches: (s) => s.id === TECH_DESIGN,
      materialize: (root) => {
        writeFixtureFile(root, 'evidence/current.json', json(DESIGN_PACKET));
        writeFixtureFile(root, 'design.md', '# Webhook delivery technical design\n\nTODO\n');
        writeFixtureFile(
          root,
          'design.json',
          '{"decision":null,"mechanism":[],"alternatives":[],"risks":[],"openQuestions":[],"verification":[],"rollback":""}\n',
        );
        writeFixtureFile(
          root,
          'README.md',
          '# Technical design fixture\nUse the current-state packet. Choose and justify one supplied alternative without erasing the other. Preserve idempotency, queue/DLQ behavior, the 800ms SLO/topology, risks, rollback, verification, and unresolved peak fanout.\n',
        );
      },
    },
  ];
export const REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] =
  [
    {
      id: 'documents-communication/release-evidence-scorer@2',
      scenarioIds: [RELEASE_NOTES],
      score: ({ workingDirectory }) => scoreRelease(workingDirectory),
    },
    {
      id: 'instructional-communication/clean-machine-setup-scorer@1',
      scenarioIds: [SETUP_GUIDE],
      score: ({ workingDirectory }) => scoreSetup(workingDirectory),
    },
    {
      id: 'planning/notification-extraction-plan-scorer@3',
      scenarioIds: [EXTRACTION_PLAN],
      score: ({ workingDirectory }) => scorePlan(workingDirectory),
    },
    {
      id: 'technical-communication/webhook-async-design-scorer@1',
      scenarioIds: [TECH_DESIGN],
      score: ({ workingDirectory }) => scoreDesign(workingDirectory),
    },
  ];
