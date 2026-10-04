import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, runHiddenBunTest, writeFixtureFile } from './skill-eval-fixture-helpers';

const UNKNOWN_MEDIUM = 'frontend-engineering-full-task-unknown-medium';

const INITIAL_CONTRACT = `export type DomainJobStatus =
  | 'discovering'
  | 'running'
  | 'partial'
  | 'cancel-requested'
  | 'cancel-failed'
  | 'complete'
  | 'failed';

export interface DomainJobState {
  status: DomainJobStatus;
  progress?: number;
  partialCount?: number;
}

export interface PresentationState {
  stale: boolean;
  interrupted: boolean;
  focusedControl?: 'refresh' | 'cancel' | 'retry' | 'return-to-list';
}

export interface JobPresentation {
  label: string;
  canCancel: boolean;
  stale: boolean;
  recoveryAction: 'refresh' | 'retry-cancel' | 'retry-job' | 'resume' | null;
  primaryInput: 'keyboard+pointer' | 'keyboard' | 'touch';
  focusTarget: string | null;
}

export function presentJob(domain: DomainJobState, view: PresentationState): JobPresentation {
  // BUG: assumes a browser-like generic frontend and collapses most operational states.
  return {
    label: domain.status === 'complete' ? 'Complete' : 'Working',
    canCancel: domain.status !== 'complete',
    stale: false,
    recoveryAction: null,
    primaryInput: 'touch',
    focusTarget: null,
  };
}
`;

const UNKNOWN_PUBLIC_TEST = `import { expect, test } from 'bun:test';
import { presentJob } from '../src/interface-contract';

test('completed job is not cancellable', () => {
  expect(presentJob({ status: 'complete' }, { stale: false, interrupted: false }).canCancel).toBe(false);
});
`;

const mediumMaterializer: SkillEvalFixtureMaterializer = {
  id: 'frontend-engineering/unknown-medium-job-monitor@1',
  matches: (scenario) => scenario.id === UNKNOWN_MEDIUM,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'surface-registry.json',
      `${JSON.stringify(
        {
          activeOperatorTask: 'native-operations',
          surfaces: [
            {
              id: 'native-operations',
              lifecycle: 'active',
              medium: 'native-desktop',
              runtime: 'Tauri 2.4.1',
              uiToolkit: 'Svelte 5.35.2',
              launch: 'bun run desktop:dev',
              owns: ['job-discovery', 'job-monitoring', 'job-cancellation', 'job-recovery'],
              input: ['keyboard', 'precision-pointer'],
            },
            {
              id: 'web-dashboard-legacy',
              lifecycle: 'archived',
              medium: 'browser',
              runtime: 'React 18 prototype',
              launch: null,
              owns: ['historical-job-monitor-demo'],
              input: ['keyboard', 'pointer'],
            },
            {
              id: 'terminal-tools',
              lifecycle: 'active-supporting',
              medium: 'terminal',
              runtime: 'Bun CLI',
              launch: 'bun run jobs:logs',
              owns: ['job-log-tail'],
              input: ['keyboard'],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'apps/native/package.json',
      `${JSON.stringify(
        {
          name: 'kory-native-operations',
          private: true,
          type: 'module',
          dependencies: { '@tauri-apps/api': '2.4.1', svelte: '5.35.2' },
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'apps/native/component-inventory.json',
      `${JSON.stringify(
        {
          navigation: ['JobList', 'JobDetail'],
          controls: ['KoryButton', 'KoryStatusPill', 'KoryProgress', 'KoryDialog'],
          stateOwner: 'backend job stream + persisted job snapshot',
          presentationOwner: 'native JobDetail route',
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'apps/web/ARCHIVED.md',
      '# Archived web dashboard\n\nThe old React job-monitor demo is retained only as historical reference. It is not launchable or task-owning.\n',
    );
    writeFixtureFile(destination, 'src/interface-contract.ts', INITIAL_CONTRACT);
    writeFixtureFile(destination, 'tests/interface-contract.test.ts', UNKNOWN_PUBLIC_TEST);
    writeFixtureFile(
      destination,
      'README.md',
      `# Unknown-medium frontend fixture

Determine the task-owning surface from \`surface-registry.json\`, launch metadata, and component inventory before selecting a specialist. Do not choose the archived web prototype merely because the request says “frontend.”

Produce \`.kory-eval/frontend-selection.json\` recording the selected surface id, medium, runtime, UI toolkit, supported input modes, owning component/route, and selected narrower specialist. Repair \`src/interface-contract.ts\` so domain job state stays distinct from presentation-only stale/interruption/focus state. Produce \`.kory-eval/frontend-verification.json\` identifying the actual target runtime and representative state/input/resize/accessibility checks that must be exercised there; explicitly state that screenshot-only evidence is insufficient.

Do not claim the device/runtime checks were executed in this repository fixture. This task defines the implementation and verification contract; the separate confirmed-native scenario owns real-device proof.
`,
    );
  },
};

interface SelectionArtifact {
  selectedSurface?: string;
  selectedSurfaceId?: string;
  surfaceId?: string;
  medium?: string;
  runtime?: string;
  toolkit?: string;
  uiToolkit?: string;
  input?: unknown;
  supportedInput?: unknown;
  supportedInputModes?: unknown;
  owner?: string;
  owningComponent?: string;
  owningComponentOrRoute?: string;
  specialist?: string;
  selectedSpecialist?: string;
  selectedNarrowerSpecialist?: string;
}

interface VerificationArtifact {
  runtime?: string;
  targetRuntime?: string;
  medium?: string;
  checks?: unknown;
  states?: unknown;
  input?: unknown;
  resize?: unknown;
  accessibility?: unknown;
  screenshotOnlySufficient?: unknown;
  screenshotOnlyEvidenceInsufficient?: unknown;
  evidenceBoundary?: string;
}

function normalizedJson(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}

const mediumScorer: SkillEvalDeterministicScorer = {
  id: 'frontend-engineering/unknown-medium-job-monitor-scorer@2',
  scenarioIds: [UNKNOWN_MEDIUM],
  score: ({ workingDirectory }) => {
    const selection = readJsonArtifact<SelectionArtifact>(
      workingDirectory,
      '.kory-eval/frontend-selection.json',
    );
    const verification = readJsonArtifact<VerificationArtifact>(
      workingDirectory,
      '.kory-eval/frontend-verification.json',
    );
    const selectionText = normalizedJson(selection);
    const selectedCorrectly =
      /native-operations/u.test(
        selection?.selectedSurface ?? selection?.selectedSurfaceId ?? selection?.surfaceId ?? '',
      ) &&
      /native[- ]desktop/u.test(selection?.medium ?? '') &&
      /tauri\s*2\.4\.1/iu.test(selection?.runtime ?? '') &&
      /svelte\s*5\.35\.2/iu.test(selection?.toolkit ?? selection?.uiToolkit ?? '') &&
      /keyboard/u.test(selectionText) &&
      /pointer/u.test(selectionText) &&
      /jobdetail|job detail/iu.test(
        selection?.owner ?? selection?.owningComponent ?? selection?.owningComponentOrRoute ?? '',
      ) &&
      /native-interface/iu.test(
        selection?.specialist ??
          selection?.selectedSpecialist ??
          selection?.selectedNarrowerSpecialist ??
          '',
      ) &&
      !/web-interface/iu.test(
        selection?.specialist ??
          selection?.selectedSpecialist ??
          selection?.selectedNarrowerSpecialist ??
          '',
      );
    const verificationText = normalizedJson(verification);
    const verificationContract =
      /tauri\s*2\.4\.1/iu.test(verification?.runtime ?? verification?.targetRuntime ?? '') &&
      /native[- ]desktop/iu.test(
        verification?.medium ?? verification?.targetRuntime ?? verificationText,
      ) &&
      /discover|running/iu.test(verificationText) &&
      /partial/u.test(verificationText) &&
      /stale/u.test(verificationText) &&
      /cancel/u.test(verificationText) &&
      /failed/u.test(verificationText) &&
      /complete/u.test(verificationText) &&
      /recover|retry|resume/u.test(verificationText) &&
      /keyboard/u.test(verificationText) &&
      /pointer/u.test(verificationText) &&
      /focus/u.test(verificationText) &&
      /resize|overflow/u.test(verificationText) &&
      /access|reduced|contrast/u.test(verificationText) &&
      (verification?.screenshotOnlySufficient === false ||
        verification?.screenshotOnlyEvidenceInsufficient === true ||
        /screenshot[^.]{0,40}(?:insufficient|not sufficient|cannot)/iu.test(
          verification?.evidenceBoundary ?? '',
        ));
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { presentJob } from '../src/interface-contract';

const view = { stale: false, interrupted: false };

test('hidden: operational states remain distinct', () => {
  expect(presentJob({ status: 'discovering' }, view).label.toLowerCase()).toContain('discover');
  const running = presentJob({ status: 'running', progress: 40 }, view);
  expect(running.label.toLowerCase()).toMatch(/running|progress/);
  expect(running.canCancel).toBe(true);
  expect(presentJob({ status: 'partial', partialCount: 3 }, view).label.toLowerCase()).toContain('partial');
  expect(presentJob({ status: 'complete' }, view).canCancel).toBe(false);
  expect(presentJob({ status: 'failed' }, view).recoveryAction).toBe('retry-job');
});

test('hidden: stale presentation state does not rewrite domain state', () => {
  const stale = presentJob({ status: 'running', progress: 20 }, { stale: true, interrupted: false, focusedControl: 'refresh' });
  expect(stale.stale).toBe(true);
  expect(stale.recoveryAction).toBe('refresh');
  expect(stale.canCancel).toBe(false);
  expect(stale.focusTarget).toMatch(/refresh/i);
});

test('hidden: cancellation requested and failed cancellation differ', () => {
  const requested = presentJob({ status: 'cancel-requested' }, view);
  expect(requested.canCancel).toBe(false);
  expect(requested.label.toLowerCase()).toMatch(/cancel.*request|cancelling/);
  const failed = presentJob({ status: 'cancel-failed' }, view);
  expect(failed.recoveryAction).toBe('retry-cancel');
  expect(failed.label.toLowerCase()).toMatch(/cancel.*fail/);
});

test('hidden: interruption produces an explicit resume path without changing domain status', () => {
  const resumed = presentJob({ status: 'running', progress: 80 }, { stale: false, interrupted: true });
  expect(resumed.recoveryAction).toBe('resume');
  expect(resumed.focusTarget).toBeTruthy();
});

test('hidden: selected native operator surface uses its supported precision inputs', () => {
  expect(['keyboard+pointer', 'keyboard+precision-pointer']).toContain(
    presentJob({ status: 'running' }, view).primaryInput,
  );
});
`,
    );
    const passed = selectedCorrectly && verificationContract && hidden.passed;
    return {
      passed,
      quality: passed ? 1 : selectedCorrectly && verificationContract ? 0.75 : 0,
      verification: selectedCorrectly && hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `repository-backed medium/specialist selection: ${selectedCorrectly ? 'pass' : 'fail'}`,
        `native runtime verification contract: ${verificationContract ? 'complete' : 'incomplete'}`,
        `hidden state/presentation behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        hidden.evidence,
      ],
    };
  },
};

export const FRONTEND_ENGINEERING_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [mediumMaterializer];

export const FRONTEND_ENGINEERING_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  mediumScorer,
];
