import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const DIRTY_WORKTREE = 'repo-discovery-full-task-dirty-worktree-bugfix';
const SIBLING_CHECKOUT = 'repo-discovery-full-task-wrong-checkout-runtime';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1_000_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `fixture git ${args.join(' ')} failed: ${`${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()}`,
    );
  }
  return result.stdout ?? '';
}

function initializeRepository(root: string): void {
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Kory Skill Eval',
    '-c',
    'user.email=kory-skill-eval@example.invalid',
    'commit',
    '-q',
    '-m',
    'fixture baseline',
  ]);
}

function readTextIfPresent(root: string, path: string): string | null {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return null;
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

function gitStatusIfPresent(root: string): string | null {
  if (!existsSync(join(root, '.git'))) return null;
  const result = spawnSync('git', ['status', '--porcelain=v1'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1_000_000,
  });
  return result.status === 0 ? (result.stdout ?? '') : null;
}

function sameExistingPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

const STAGED_USER_CONTENT = `# Release draft

User-owned staged note: preserve this exact wording while fixing the parser.
`;

const UNSTAGED_USER_CONTENT = `owner=product-ops
draft-theme=high-contrast
`;

const UNTRACKED_USER_CONTENT = `local scratchpad — intentionally untracked
`;

const DIRTY_ROOT_INSTRUCTIONS = `# Fixture repository guidance

- Preserve all pre-existing staged, unstaged, and untracked user work exactly.
- Follow nested AGENTS.md files that govern the owning package.
- Do not clean, reset, checkout, stash, or reformat unrelated files.
- Record resolved discovery facts in .kory-eval/discovery.json before finishing.
`;

const DIRTY_PACKAGE_INSTRUCTIONS = `# Package guidance

Parser behavior is owned by packages/parser. Use that package's focused verification path for parser changes.
`;

const DIRTY_PARSER_INSTRUCTIONS = `# Parser package guidance

- The implementation owner is src/timeout.ts.
- A focused parser verification is: bun test packages/parser/tests/timeout.test.ts
- Keep the parser dependency-free and preserve invalid-input behavior while repairing the reproduced regression.
`;

const DIRTY_SOURCE = `export function parseTimeoutMs(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return null;
  // BUG: zero is a valid explicit timeout, but this treats it as absent.
  if (!value) return null;
  return value;
}
`;

const DIRTY_PUBLIC_TEST = `import { expect, test } from 'bun:test';
import { parseTimeoutMs } from '../src/timeout';

test('positive integer timeout is preserved', () => {
  expect(parseTimeoutMs('250')).toBe(250);
});

test('invalid and negative values stay rejected', () => {
  expect(parseTimeoutMs('later')).toBeNull();
  expect(parseTimeoutMs('-1')).toBeNull();
});
`;

const dirtyWorktreeMaterializer: SkillEvalFixtureMaterializer = {
  id: 'repository-environment-discovery/dirty-worktree-bug@1',
  matches: (scenario) => scenario.id === DIRTY_WORKTREE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-dirty-repository'));
    writeFixtureFile(destination, '.tool-versions', 'bun 1.3.14\n');
    writeFixtureFile(destination, 'AGENTS.md', DIRTY_ROOT_INSTRUCTIONS);
    writeFixtureFile(destination, 'packages/AGENTS.md', DIRTY_PACKAGE_INSTRUCTIONS);
    writeFixtureFile(destination, 'packages/parser/AGENTS.md', DIRTY_PARSER_INSTRUCTIONS);
    writeFixtureFile(destination, 'packages/parser/src/timeout.ts', DIRTY_SOURCE);
    writeFixtureFile(destination, 'packages/parser/tests/timeout.test.ts', DIRTY_PUBLIC_TEST);
    writeFixtureFile(
      destination,
      'README.md',
      `# Dirty-worktree parser fixture

The reported regression is that an explicit timeout of \`0\` is treated as absent even though zero is valid. Preserve invalid/negative handling. The repository already contains unrelated user work in three Git states. Resolve the governing instruction chain and focused verification from repository evidence before editing.

The required discovery artifact is \`.kory-eval/discovery.json\` with the repository root, governing instruction paths, owning source path, runtime/toolchain, focused verification command, and whether the regression was reproduced or otherwise directly bounded.
`,
    );
    writeFixtureFile(
      destination,
      'docs/release-draft.md',
      '# Release draft\n\nCommitted baseline.\n',
    );
    writeFixtureFile(
      destination,
      'notes/operator.conf',
      'owner=product-ops\ndraft-theme=default\n',
    );
    writeFixtureFile(
      destination,
      'tests/fixture-root.test.ts',
      "import { test } from 'bun:test';\n\ntest('fixture root is valid', () => {});\n",
    );

    initializeRepository(destination);

    writeFixtureFile(destination, 'docs/release-draft.md', STAGED_USER_CONTENT);
    git(destination, ['add', 'docs/release-draft.md']);
    writeFixtureFile(destination, 'notes/operator.conf', UNSTAGED_USER_CONTENT);
    writeFixtureFile(destination, 'notes/local-only.txt', UNTRACKED_USER_CONTENT);
  },
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function firstString(record: JsonRecord | null, keys: string[]): string {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function firstStringArray(record: JsonRecord | null, keys: string[]): string[] {
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return value as string[];
    }
  }
  return [];
}

function nestedNameVersion(
  record: JsonRecord | null,
  key: string,
): { name: string; version: string } {
  const value = asRecord(record?.[key]);
  return {
    name: firstString(value, ['name', 'toolkit', 'runtime']),
    version: firstString(value, ['version', 'toolkitVersion', 'runtimeVersion']),
  };
}

function includesAllPaths(actual: unknown, expected: string[], root: string): boolean {
  if (!Array.isArray(actual)) return false;
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/u, '');
  const normalized = actual.map((item) => {
    let path = String(item).replaceAll('\\', '/');
    if (path.startsWith(`${normalizedRoot}/`)) path = path.slice(normalizedRoot.length + 1);
    return path.replace(/^\.\//u, '');
  });
  return expected.every((path) => normalized.includes(path));
}

const dirtyWorktreeScorer: SkillEvalDeterministicScorer = {
  id: 'repository-environment-discovery/dirty-worktree-bug-scorer@4',
  scenarioIds: [DIRTY_WORKTREE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { parseTimeoutMs } from '../packages/parser/src/timeout';

test('hidden: explicit zero remains distinct from invalid input', () => {
  expect(parseTimeoutMs('0')).toBe(0);
  expect(parseTimeoutMs('00')).toBe(0);
  expect(parseTimeoutMs('nope')).toBeNull();
});

test('hidden: positive integers and rejection boundaries remain intact', () => {
  expect(parseTimeoutMs('1')).toBe(1);
  expect(parseTimeoutMs('60000')).toBe(60000);
  expect(parseTimeoutMs('-2')).toBeNull();
  expect(parseTimeoutMs('1.5')).toBeNull();
});
`,
    );
    const stagedPreserved =
      readTextIfPresent(workingDirectory, 'docs/release-draft.md') === STAGED_USER_CONTENT;
    const unstagedPreserved =
      readTextIfPresent(workingDirectory, 'notes/operator.conf') === UNSTAGED_USER_CONTENT;
    const untrackedPreserved =
      readTextIfPresent(workingDirectory, 'notes/local-only.txt') === UNTRACKED_USER_CONTENT;
    const status = gitStatusIfPresent(workingDirectory) ?? '';
    const statusPreserved =
      /^M  docs\/release-draft\.md$/mu.test(status) &&
      /^ M notes\/operator\.conf$/mu.test(status) &&
      /^\?\? notes\/local-only\.txt$/mu.test(status);
    const report = asRecord(
      readJsonArtifact<unknown>(workingDirectory, '.kory-eval/discovery.json'),
    );
    const governingInstructions = firstStringArray(report, [
      'governingInstructions',
      'governingInstructionFiles',
      'governingInstructionPaths',
      'applicableInstructions',
      'instructionChain',
    ]);
    const instructionChain = includesAllPaths(
      governingInstructions,
      ['AGENTS.md', 'packages/AGENTS.md', 'packages/parser/AGENTS.md'],
      workingDirectory,
    );
    const repositoryRootValue = firstString(report, ['repositoryRoot', 'resolvedRepositoryRoot']);
    const repositoryRoot =
      repositoryRootValue === '.' || sameExistingPath(repositoryRootValue, workingDirectory);
    const owningPath = firstString(report, [
      'owningPath',
      'owningSource',
      'owningSourcePath',
      'ownerPath',
    ]);
    const ownership = /packages\/parser\/src\/timeout\.ts$/u.test(owningPath.replaceAll('\\', '/'));
    const runtimeValue = firstString(report, ['runtime', 'runtimeToolchain', 'toolchain']);
    const runtime = /bun/iu.test(runtimeValue) && /1\.3\.14/u.test(runtimeValue);
    const verificationValue = firstString(report, [
      'verificationCommand',
      'focusedVerification',
      'focusedVerificationCommand',
      'representativeVerificationCommand',
    ]);
    const verification =
      /bun\s+test/iu.test(verificationValue) &&
      /packages\/parser\/tests\/timeout\.test\.ts/u.test(verificationValue.replaceAll('\\', '/'));
    const regression = asRecord(report?.regression);
    const reproducedValue =
      report?.reproduced ??
      report?.regressionBounded ??
      regression?.reproduced ??
      regression?.status;
    const reproduced =
      reproducedValue === true || /repro|observed|bounded/iu.test(String(reproducedValue ?? ''));
    const preservation =
      stagedPreserved && unstagedPreserved && untrackedPreserved && statusPreserved;
    const discovery =
      repositoryRoot && instructionChain && ownership && runtime && verification && reproduced;
    const passed = hidden.passed && preservation && discovery;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && preservation ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden parser behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `pre-existing Git state/content: ${preservation ? 'preserved' : 'changed'}`,
        `instruction/owner/runtime discovery artifact: ${discovery ? 'complete' : 'incomplete'}`,
        hidden.evidence,
      ],
    };
  },
};

const TARGET_CHECKOUT = 'checkouts/kory-native';
const DECOY_CHECKOUT = 'checkouts/kory-native-legacy';

const TARGET_ROOT_INSTRUCTIONS = `# Native checkout guidance

This is the current native product checkout. Follow nested src/ui/AGENTS.md for UI implementation constraints and verify with this checkout's Bun test path.
`;

const TARGET_UI_INSTRUCTIONS = `# Native UI guidance

- Use the existing KoryStatusPill presentation shape; do not introduce web-only markup or browser UI primitives.
- The owning source for sync-state presentation is status.ts.
- Verify with: bun test checkouts/kory-native/tests/status.test.ts
`;

const TARGET_PACKAGE = `${JSON.stringify(
  {
    name: 'kory-native-current',
    private: true,
    type: 'module',
    dependencies: {
      '@tauri-apps/api': '2.4.1',
      svelte: '5.35.2',
    },
  },
  null,
  2,
)}\n`;

const TARGET_METADATA = `${JSON.stringify(
  {
    product: 'Kory Native Desktop',
    surface: 'native-desktop',
    toolkit: 'Tauri',
    toolkitVersion: '2.4.1',
    uiRuntime: 'Svelte',
    uiRuntimeVersion: '5.35.2',
    owningModule: 'src/ui/status.ts',
  },
  null,
  2,
)}\n`;

const TARGET_STATUS_SOURCE = `export type SyncState = 'online' | 'offline' | 'paused';

export interface StatusPresentation {
  control: 'KoryStatusPill';
  label: string;
  tone: 'success' | 'neutral' | 'warning';
}

export function presentSyncState(state: SyncState): StatusPresentation {
  if (state === 'online') return { control: 'KoryStatusPill', label: 'Online', tone: 'success' };
  if (state === 'offline') return { control: 'KoryStatusPill', label: 'Offline', tone: 'neutral' };
  // BUG: the current native UI has no paused-state presentation yet.
  return { control: 'KoryStatusPill', label: 'Unknown', tone: 'neutral' };
}
`;

const TARGET_PUBLIC_TEST = `import { expect, test } from 'bun:test';
import { presentSyncState } from '../src/ui/status';

test('existing online/offline presentations remain stable', () => {
  expect(presentSyncState('online')).toEqual({ control: 'KoryStatusPill', label: 'Online', tone: 'success' });
  expect(presentSyncState('offline')).toEqual({ control: 'KoryStatusPill', label: 'Offline', tone: 'neutral' });
});
`;

const DECOY_FILES: Readonly<Record<string, string>> = {
  'README.md': '# Legacy web prototype\n\nArchived sibling checkout. Not the active task target.\n',
  'package.json': `${JSON.stringify(
    {
      name: 'kory-native-legacy-web',
      private: true,
      type: 'module',
      dependencies: { react: '19.1.1' },
    },
    null,
    2,
  )}\n`,
  'src/status.tsx': `export const Status = () => '<span>legacy</span>';\n`,
};

function writeDecoyCheckout(root: string): void {
  for (const [path, content] of Object.entries(DECOY_FILES)) {
    writeFixtureFile(root, `${DECOY_CHECKOUT}/${path}`, content);
  }
}

const siblingCheckoutMaterializer: SkillEvalFixtureMaterializer = {
  id: 'repository-environment-discovery/sibling-checkouts-native-ui@1',
  matches: (scenario) => scenario.id === SIBLING_CHECKOUT,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'active-workspace.json',
      `${JSON.stringify(
        {
          taskTarget: TARGET_CHECKOUT,
          reason: 'current native desktop checkout selected by workspace registration',
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'TASK.md',
      `# Current UI request

In the active native checkout, add the missing compact presentation for the \`paused\` sync state. It must follow the current checkout's existing status-control pattern. The similarly named legacy sibling is historical and must remain untouched.

Record the resolved target checkout, governing instruction files, toolkit/runtime versions, owning path, and representative verification command in \`.kory-eval/sibling-discovery.json\`.
`,
    );
    writeFixtureFile(destination, `${TARGET_CHECKOUT}/AGENTS.md`, TARGET_ROOT_INSTRUCTIONS);
    writeFixtureFile(destination, `${TARGET_CHECKOUT}/src/ui/AGENTS.md`, TARGET_UI_INSTRUCTIONS);
    writeFixtureFile(destination, `${TARGET_CHECKOUT}/package.json`, TARGET_PACKAGE);
    writeFixtureFile(destination, `${TARGET_CHECKOUT}/native-project.json`, TARGET_METADATA);
    writeFixtureFile(destination, `${TARGET_CHECKOUT}/src/ui/status.ts`, TARGET_STATUS_SOURCE);
    writeFixtureFile(destination, `${TARGET_CHECKOUT}/tests/status.test.ts`, TARGET_PUBLIC_TEST);
    writeFixtureFile(
      destination,
      `${TARGET_CHECKOUT}/README.md`,
      '# Current Kory native desktop checkout\n\nRepository metadata and nested instructions define the supported native UI path.\n',
    );
    writeFixtureFile(
      destination,
      'tests/fixture-root.test.ts',
      "import { test } from 'bun:test';\n\ntest('workspace fixture root is valid', () => {});\n",
    );
    writeDecoyCheckout(destination);
    initializeRepository(join(destination, TARGET_CHECKOUT));
    initializeRepository(join(destination, DECOY_CHECKOUT));
  },
};

function directoryFileMap(root: string, current = root): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(current)) return result;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      for (const [path, value] of directoryFileMap(root, absolute)) result.set(path, value);
    } else if (entry.isFile()) {
      result.set(relative(root, absolute).replaceAll('\\', '/'), readFileSync(absolute, 'utf8'));
    }
  }
  return result;
}

function decoyCheckoutPreserved(root: string): boolean {
  const actual = directoryFileMap(join(root, DECOY_CHECKOUT));
  if (actual.size !== Object.keys(DECOY_FILES).length) return false;
  return Object.entries(DECOY_FILES).every(([path, content]) => actual.get(path) === content);
}

const siblingCheckoutScorer: SkillEvalDeterministicScorer = {
  id: 'repository-environment-discovery/sibling-checkouts-native-ui-scorer@2',
  scenarioIds: [SIBLING_CHECKOUT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { presentSyncState } from '../checkouts/kory-native/src/ui/status';

test('hidden: paused state uses the native status-pill pattern', () => {
  expect(presentSyncState('paused')).toEqual({
    control: 'KoryStatusPill',
    label: 'Paused',
    tone: 'warning',
  });
});

test('hidden: existing states retain their established semantics', () => {
  expect(presentSyncState('online').label).toBe('Online');
  expect(presentSyncState('offline').label).toBe('Offline');
});
`,
    );
    const siblingPreserved = decoyCheckoutPreserved(workingDirectory);
    const metadataPreserved =
      readTextIfPresent(workingDirectory, `${TARGET_CHECKOUT}/native-project.json`) ===
      TARGET_METADATA;
    const report = asRecord(
      readJsonArtifact<unknown>(workingDirectory, '.kory-eval/sibling-discovery.json'),
    );
    const targetValue = firstString(report, ['targetCheckout', 'resolvedTargetCheckout']);
    const target = targetValue.replaceAll('\\', '/') === TARGET_CHECKOUT;
    const governingInstructions = firstStringArray(report, [
      'governingInstructions',
      'governingInstructionFiles',
      'governingInstructionPaths',
      'applicableInstructions',
      'instructionChain',
    ]);
    const instructions = includesAllPaths(
      governingInstructions,
      [`${TARGET_CHECKOUT}/AGENTS.md`, `${TARGET_CHECKOUT}/src/ui/AGENTS.md`],
      workingDirectory,
    );
    const toolkitNested = nestedNameVersion(report, 'toolkit');
    const toolkitName =
      toolkitNested.name || firstString(report, ['toolkitName', 'nativeToolkit', 'toolkit']);
    const toolkitVersion =
      toolkitNested.version || firstString(report, ['toolkitVersion', 'nativeToolkitVersion']);
    const runtimeNested = nestedNameVersion(report, 'runtime');
    const runtimeName =
      runtimeNested.name || firstString(report, ['uiRuntime', 'runtimeName', 'framework']);
    const runtimeVersion =
      runtimeNested.version ||
      firstString(report, ['uiRuntimeVersion', 'runtimeVersion', 'frameworkVersion']);
    const toolkit = /tauri/iu.test(toolkitName) && toolkitVersion.trim() === '2.4.1';
    const runtime = /svelte/iu.test(runtimeName) && runtimeVersion.trim() === '5.35.2';
    const owningPath = firstString(report, ['owningPath', 'owningSource', 'owningSourcePath']);
    const owner = /checkouts\/kory-native\/src\/ui\/status\.ts$/u.test(
      owningPath.replaceAll('\\', '/'),
    );
    const verificationValue = firstString(report, [
      'verificationCommand',
      'focusedVerification',
      'focusedVerificationCommand',
      'representativeVerificationCommand',
    ]);
    const verification =
      /bun\s+test/iu.test(verificationValue) &&
      /checkouts\/kory-native\/tests\/status\.test\.ts/u.test(
        verificationValue.replaceAll('\\', '/'),
      );
    const discovery = target && instructions && toolkit && runtime && owner && verification;
    const passed = hidden.passed && siblingPreserved && metadataPreserved && discovery;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && siblingPreserved ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `native paused-state behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `legacy sibling checkout: ${siblingPreserved ? 'unchanged' : 'changed'}`,
        `target native metadata: ${metadataPreserved ? 'preserved' : 'changed'}`,
        `checkout/instruction/runtime discovery artifact: ${discovery ? 'complete' : 'incomplete'}`,
        hidden.evidence,
      ],
    };
  },
};

export const REPOSITORY_ENVIRONMENT_DISCOVERY_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [dirtyWorktreeMaterializer, siblingCheckoutMaterializer];

export const REPOSITORY_ENVIRONMENT_DISCOVERY_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] =
  [dirtyWorktreeScorer, siblingCheckoutScorer];
