import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, runHiddenBunTest, writeFixtureFile } from './skill-eval-fixture-helpers';

const CROSS_MEDIUM = 'task-routing-full-task-cross-medium-scope';
const RESEARCH_ONLY = 'task-routing-full-task-research-without-mutation';

const DESKTOP_METADATA = `${JSON.stringify(
  {
    product: 'Kory Operations Desktop',
    deliverySurface: 'native-desktop',
    toolkit: 'Tauri 2.4',
    owningModule: 'src/job-state.ts',
    verification: 'bun test',
  },
  null,
  2,
)}\n`;

const ISSUE_HISTORY = `# Issue history

Current report (2026-09-05): the native desktop job inspector crashes when a queue has no active job. Reproduce and repair the current native owner path.

Historical closed request (2024-02-11), retained only for archaeology:

> turn this into a website

That request was closed without migration and does not describe the current task or delivery surface.
`;

const JOB_SOURCE = `export interface Job {
  id: string;
  state: 'queued' | 'running' | 'completed';
}

export function activeJobId(jobs: Job[]): string | null {
  const active = jobs.find((job) => job.state === 'running');
  // BUG: the native inspector dereferences an absent active job.
  return active!.id;
}
`;

const JOB_TEST = `import { expect, test } from 'bun:test';
import { activeJobId } from '../src/job-state';

test('returns the running job id', () => {
  expect(activeJobId([{ id: 'job-1', state: 'running' }])).toBe('job-1');
});

test('an idle queue is a valid native state', () => {
  expect(activeJobId([{ id: 'job-1', state: 'completed' }])).toBeNull();
});
`;

const crossMediumMaterializer: SkillEvalFixtureMaterializer = {
  id: 'task-routing/native-history-decoy@1',
  matches: (scenario) => scenario.id === CROSS_MEDIUM,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-native-routing'));
    writeFixtureFile(destination, 'desktop-project.json', DESKTOP_METADATA);
    writeFixtureFile(destination, 'issue-history.md', ISSUE_HISTORY);
    writeFixtureFile(destination, 'src/job-state.ts', JOB_SOURCE);
    writeFixtureFile(destination, 'tests/job-state.test.ts', JOB_TEST);
    writeFixtureFile(
      destination,
      'README.md',
      `# Native job-inspector routing fixture

The current product metadata is authoritative for delivery surface and ownership. Historical issue text is evidence only for its own time and must not override the current request. Repair the reproducible crash in the owning module, preserve the native project identity, and verify the bounded behavior locally.
`,
    );
  },
};

function containsUnsupportedWebBranch(root: string): boolean {
  const suspicious = [
    'index.html',
    'vite.config.ts',
    'vite.config.js',
    'next.config.js',
    'next.config.mjs',
    'src/App.tsx',
    'src/App.jsx',
    'src/app/page.tsx',
  ];
  return suspicious.some((path) => existsSync(join(root, path)));
}

const crossMediumScorer: SkillEvalDeterministicScorer = {
  id: 'task-routing/native-history-decoy-scorer@1',
  scenarioIds: [CROSS_MEDIUM],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { activeJobId } from '../src/job-state';

test('hidden: empty queues do not crash the native inspector', () => {
  expect(activeJobId([])).toBeNull();
});

test('hidden: queued-only state has no active job', () => {
  expect(activeJobId([{ id: 'queued-1', state: 'queued' }])).toBeNull();
});

test('hidden: a running job still wins among unrelated states', () => {
  expect(activeJobId([
    { id: 'done-1', state: 'completed' },
    { id: 'run-2', state: 'running' },
    { id: 'queue-3', state: 'queued' },
  ])).toBe('run-2');
});
`,
    );
    const nativeIdentityPreserved =
      readFileSync(join(workingDirectory, 'desktop-project.json'), 'utf8') === DESKTOP_METADATA;
    const historyPreserved =
      readFileSync(join(workingDirectory, 'issue-history.md'), 'utf8') === ISSUE_HISTORY;
    const noWebBranch = !containsUnsupportedWebBranch(workingDirectory);
    const passed = hidden.passed && nativeIdentityPreserved && historyPreserved && noWebBranch;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && nativeIdentityPreserved ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `native behavior checks: ${hidden.passed ? 'pass' : 'fail'}`,
        `native project identity: ${nativeIdentityPreserved ? 'preserved' : 'changed'}`,
        `historical evidence: ${historyPreserved ? 'preserved' : 'changed'}`,
        `unsupported web branch: ${noWebBranch ? 'absent' : 'present'}`,
        hidden.evidence,
      ],
    };
  },
};

const AUTHORITY_INDEX = `${JSON.stringify(
  {
    snapshotDate: '2026-09-05',
    sources: [
      {
        id: 'RFC9700',
        title: 'Best Current Practice for OAuth 2.0 Security',
        status: 'BCP / RFC',
        published: '2025-01',
        authority: 'IETF',
      },
      {
        id: 'draft-ietf-oauth-v2-1-15',
        title: 'The OAuth 2.1 Authorization Framework',
        status: 'Internet-Draft, not an RFC',
        published: '2026-06-22',
        authority: 'IETF OAuth Working Group',
      },
    ],
  },
  null,
  2,
)}\n`;

const RFC9700_EXCERPT = `# RFC9700 — fixture excerpt

Status: IETF Best Current Practice / RFC. Published January 2025.

For this bounded design decision, treat these statements as authoritative fixture facts:

- Clients SHOULD NOT use the implicit grant or other flows that expose access tokens in the authorization response unless required mitigations are in place; authorization-code based flows avoid several of those exposure modes.
- Authorization-code clients use PKCE to bind the authorization request to the token exchange; the security BCP describes PKCE as a core defense against authorization-code injection/interception attacks.
- Redirect URI validation remains exact and security-sensitive; native/public clients require redirect mechanisms appropriate to their platform rather than a client secret being treated as proof of client identity.
`;

const OAUTH21_EXCERPT = `# draft-ietf-oauth-v2-1-15 — fixture excerpt

Status at the fixture snapshot date: IETF Internet-Draft, not a final RFC. Dated June 22, 2026.

Relevant draft direction for this project:

- The authorization code grant with PKCE is the normal browser-mediated authorization flow for public clients.
- The implicit grant is omitted from the OAuth 2.1 protocol set.
- A design may use this draft as current working-group direction, but must label draft-only requirements separately from published RFC/BCP requirements.
`;

const PROJECT_DECISION = `${JSON.stringify(
  {
    application: 'Kory Native Companion',
    clientType: 'public native client',
    currentFlow: 'authorization-code',
    currentControls: ['PKCE S256', 'loopback redirect with ephemeral port'],
    decision: 'whether a 2024 design note allowing implicit fallback should remain normative',
  },
  null,
  2,
)}\n`;

const RESEARCH_FILES: Record<string, string> = {
  'authority-index.json': AUTHORITY_INDEX,
  'project-decision.json': PROJECT_DECISION,
  'sources/RFC9700.md': RFC9700_EXCERPT,
  'sources/draft-ietf-oauth-v2-1-15.md': OAUTH21_EXCERPT,
  'README.md': `# Read-only OAuth research fixture

This workspace is evidence, not an implementation target. Read the bounded authoritative-source snapshot and answer the requested design question in your final response. Cite the source identifiers and distinguish published RFC/BCP requirements from Internet-Draft direction. Do not create, modify, delete, or reformat repository files.
`,
};

const researchMaterializer: SkillEvalFixtureMaterializer = {
  id: 'task-routing/oauth-readonly-research@1',
  matches: (scenario) => scenario.id === RESEARCH_ONLY,
  materialize: (destination) => {
    for (const [path, content] of Object.entries(RESEARCH_FILES)) {
      writeFixtureFile(destination, path, content);
    }
  },
};

function workspaceFileMap(root: string, current = root): Map<string, string> {
  const result = new Map<string, string>();
  for (const name of readdirSync(current, { withFileTypes: true })) {
    if (name.name === '.git') continue;
    const absolute = join(current, name.name);
    if (name.isDirectory()) {
      for (const [path, value] of workspaceFileMap(root, absolute)) result.set(path, value);
    } else if (name.isFile()) {
      result.set(relative(root, absolute), readFileSync(absolute, 'utf8'));
    }
  }
  return result;
}

function researchWorkspaceUnchanged(root: string): boolean {
  const actual = workspaceFileMap(root);
  if (actual.size !== Object.keys(RESEARCH_FILES).length) return false;
  return Object.entries(RESEARCH_FILES).every(([path, content]) => actual.get(path) === content);
}

const researchScorer: SkillEvalDeterministicScorer = {
  id: 'task-routing/oauth-readonly-research-scorer@2',
  scenarioIds: [RESEARCH_ONLY],
  score: ({ workingDirectory, observation }) => {
    const output = observation.output;
    const unchanged = researchWorkspaceUnchanged(workingDirectory);
    const publishedSource = /RFC\s*9700|RFC9700/iu.test(output);
    const draftSource = /draft-ietf-oauth-v2-1-15|OAuth\s*2\.1/iu.test(output);
    const draftBoundary =
      /Internet-Draft|working-group direction|draft\s+(?:15|ietf)/iu.test(output) &&
      /not (?:yet )?(?:a )?(?:final )?RFC|not (?:yet )?final(?:ized)?|draft-only/iu.test(output);
    const projectDecision =
      /implicit/iu.test(output) &&
      /PKCE/iu.test(output) &&
      /public|native/iu.test(output) &&
      /remove|retire|drop|not retain|should not remain|no longer/iu.test(output);
    const passed = unchanged && publishedSource && draftSource && draftBoundary && projectDecision;
    const semanticSignals = [publishedSource, draftSource, draftBoundary, projectDecision].filter(
      Boolean,
    ).length;
    return {
      passed,
      quality: passed ? 1 : unchanged ? semanticSignals / 4 : 0,
      verification: unchanged && publishedSource && draftSource ? 1 : unchanged ? 0.5 : 0,
      integrityFailure: false,
      evidence: [
        `repository unchanged: ${unchanged ? 'yes' : 'no'}`,
        `published source boundary: ${publishedSource ? 'present' : 'missing'}`,
        `draft source boundary: ${draftSource && draftBoundary ? 'present' : 'missing'}`,
        `project decision addressed: ${projectDecision ? 'yes' : 'no'}`,
      ],
    };
  },
};

export const TASK_ROUTING_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  crossMediumMaterializer,
  researchMaterializer,
];

export const TASK_ROUTING_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  crossMediumScorer,
  researchScorer,
];
