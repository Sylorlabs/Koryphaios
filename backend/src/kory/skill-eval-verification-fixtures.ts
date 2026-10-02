import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const PROVIDER_SWITCH = 'verification-full-task-1';
const CLI_ENTRYPOINT = 'verification-full-task-2';

const PROVIDER_PACKAGE = `${JSON.stringify(
  {
    name: 'kory-eval-verification-provider-switch',
    private: true,
    type: 'module',
    scripts: {
      test: 'bun test tests/provider-switch.test.ts',
      'fixture:chat': 'bun run scripts/chat-fixture.ts',
      'read:provider': 'bun run scripts/read-provider-invocation.ts',
    },
  },
  null,
  2,
)}\n`;

const PROVIDER_CONFIG = `${JSON.stringify({ selectedProvider: 'nova' }, null, 2)}\n`;

const PROVIDERS_SOURCE = `import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ProviderName = 'legacy' | 'nova';

export interface ProviderResponse {
  status: number;
  provider: ProviderName;
  body: string;
}

export function callProvider(
  provider: ProviderName,
  prompt: string,
  logPath: string,
): ProviderResponse {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    JSON.stringify({ provider, prompt, status: 200, observedAt: 'fixture-runtime' }) + '\\n',
  );
  return { status: 200, provider, body: provider + ':ok' };
}
`;

const CHAT_SOURCE = `import { readFileSync } from 'node:fs';
import { callProvider, type ProviderName, type ProviderResponse } from './providers';

interface ProviderConfig {
  selectedProvider: ProviderName;
}

export function configuredProvider(): ProviderName {
  const config = JSON.parse(readFileSync('config/provider.json', 'utf8')) as ProviderConfig;
  return config.selectedProvider;
}

export function handleChat(
  path: string,
  prompt: string,
  logPath = '.runtime/provider-invocations.jsonl',
): ProviderResponse {
  if (path !== '/chat') throw new Error('unsupported route: ' + path);
  const configured = configuredProvider();
  // BUG: the completed provider-switch patch updated configuration but not real dispatch.
  const provider: ProviderName = 'legacy';
  void configured;
  return callProvider(provider, prompt, logPath);
}
`;

const CHAT_SCRIPT = `import { handleChat } from '../src/chat';

const prompt = process.argv.slice(2).join(' ') || 'verification-probe';
const logPath = process.env.KORY_INVOCATION_LOG ?? '.runtime/provider-invocations.jsonl';
const response = handleChat('/chat', prompt, logPath);
console.log(JSON.stringify({ route: '/chat', ...response }));
`;

const READ_PROVIDER_SCRIPT = `import { existsSync, readFileSync } from 'node:fs';

const logPath = process.env.KORY_INVOCATION_LOG ?? '.runtime/provider-invocations.jsonl';
if (!existsSync(logPath)) {
  console.error('no provider invocation record');
  process.exit(2);
}
const entries = readFileSync(logPath, 'utf8').trim().split('\\n').filter(Boolean);
console.log(entries.at(-1));
`;

const PROVIDER_TEST = `import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { configuredProvider } from '../src/chat';
import { callProvider } from '../src/providers';

test('configuration selects nova', () => {
  expect(configuredProvider()).toBe('nova');
});

test('both fixture providers are healthy over the superficial transport oracle', () => {
  const logPath = '.runtime/focused-provider-health.jsonl';
  rmSync(logPath, { force: true });
  try {
    expect(callProvider('legacy', 'health', logPath).status).toBe(200);
    expect(callProvider('nova', 'health', logPath).status).toBe(200);
  } finally {
    rmSync(logPath, { force: true });
  }
});
`;

const PROVIDER_README = `# Provider-switch verification fixture

The patch is already complete for purposes of this task. Verification is read-only: do not edit, rebuild, or repair repository files.

Configuration says \`nova\`, but HTTP 200 is deliberately nondiscriminating because both fixture providers return 200. Verify the provider identity claim through the actual \`/chat\` fixture path and the independent provider invocation record.

Supported focused check:

\`bun test tests/provider-switch.test.ts\`

Real consumer-path probe:

\`bun run fixture:chat -- verification-probe\`

Independent readback of the recorded invocation:

\`bun run read:provider\`

Write \`.kory-eval/verification-scenario-1.json\` with the claim-to-oracle mapping, exact commands/results, the configured provider, independently observed invoked provider, why HTTP 200 is insufficient, and a bounded \`confirmed\` / \`refuted\` / \`inconclusive\` verdict. Return the same bounded conclusion in the final response. Do not fix the defect.
`;

const providerMaterializer: SkillEvalFixtureMaterializer = {
  id: 'verification/provider-switch-false-success@1',
  matches: (scenario) => scenario.id === PROVIDER_SWITCH,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', PROVIDER_PACKAGE);
    writeFixtureFile(destination, 'config/provider.json', PROVIDER_CONFIG);
    writeFixtureFile(destination, 'src/providers.ts', PROVIDERS_SOURCE);
    writeFixtureFile(destination, 'src/chat.ts', CHAT_SOURCE);
    writeFixtureFile(destination, 'scripts/chat-fixture.ts', CHAT_SCRIPT);
    writeFixtureFile(destination, 'scripts/read-provider-invocation.ts', READ_PROVIDER_SCRIPT);
    writeFixtureFile(destination, 'tests/provider-switch.test.ts', PROVIDER_TEST);
    writeFixtureFile(destination, 'README.md', PROVIDER_README);
  },
};

interface VerificationReport {
  verdict?: unknown;
  overallVerdict?: unknown;
  overall_verdict?: unknown;
  [key: string]: unknown;
}

function normalized(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}

function topLevelVerdict(report: VerificationReport | null): string | null {
  if (!report) return null;
  for (const value of [report.overallVerdict, report.overall_verdict, report.verdict]) {
    if (typeof value !== 'string') continue;
    const normalizedVerdict = value.trim().toLowerCase();
    if (['confirmed', 'refuted', 'inconclusive'].includes(normalizedVerdict)) {
      return normalizedVerdict;
    }
  }
  return null;
}

function finalResponseText(output: string): string {
  const marker = '</kory-eval-patch>';
  const markerIndex = output.lastIndexOf(marker);
  return (markerIndex >= 0 ? output.slice(markerIndex + marker.length) : output).toLowerCase();
}

function exactFilesPreserved(root: string, expected: Readonly<Record<string, string>>): boolean {
  return Object.entries(expected).every(([path, content]) => {
    const absolute = join(root, path);
    return existsSync(absolute) && readFileSync(absolute, 'utf8') === content;
  });
}

function run(root: string, command: string, args: string[], extraEnv?: NodeJS.ProcessEnv) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1_000_000,
    env: { ...process.env, ...extraEnv },
  });
}

const providerScorer: SkillEvalDeterministicScorer = {
  id: 'verification/provider-switch-false-success-scorer@2',
  scenarioIds: [PROVIDER_SWITCH],
  score: ({ workingDirectory, observation }) => {
    const preserved = exactFilesPreserved(workingDirectory, {
      'package.json': PROVIDER_PACKAGE,
      'config/provider.json': PROVIDER_CONFIG,
      'src/providers.ts': PROVIDERS_SOURCE,
      'src/chat.ts': CHAT_SOURCE,
      'scripts/chat-fixture.ts': CHAT_SCRIPT,
      'scripts/read-provider-invocation.ts': READ_PROVIDER_SCRIPT,
      'tests/provider-switch.test.ts': PROVIDER_TEST,
      'README.md': PROVIDER_README,
    });

    const focused = run(workingDirectory, 'bun', ['test', 'tests/provider-switch.test.ts']);
    const hiddenLog = join(workingDirectory, '.kory-eval', '__hidden-provider-log.jsonl');
    rmSync(hiddenLog, { force: true });
    const chat = run(
      workingDirectory,
      'bun',
      ['run', 'scripts/chat-fixture.ts', 'hidden-verification-probe'],
      { KORY_INVOCATION_LOG: hiddenLog },
    );
    let invocation: Record<string, unknown> | null = null;
    if (existsSync(hiddenLog)) {
      const lines = readFileSync(hiddenLog, 'utf8').trim().split('\n').filter(Boolean);
      try {
        invocation = JSON.parse(lines.at(-1) ?? '') as Record<string, unknown>;
      } catch {
        invocation = null;
      }
    }
    rmSync(hiddenLog, { force: true });

    let chatResult: Record<string, unknown> | null = null;
    try {
      chatResult = JSON.parse((chat.stdout ?? '').trim()) as Record<string, unknown>;
    } catch {
      chatResult = null;
    }
    const realPathRefutes =
      focused.status === 0 &&
      chat.status === 0 &&
      chatResult?.route === '/chat' &&
      chatResult?.status === 200 &&
      chatResult?.provider === 'legacy' &&
      invocation?.provider === 'legacy';

    const report = readJsonArtifact<VerificationReport>(
      workingDirectory,
      '.kory-eval/verification-scenario-1.json',
    );
    const reportText = normalized(report);
    const reportComplete =
      /nova/u.test(reportText) &&
      /legacy/u.test(reportText) &&
      /\/chat/u.test(reportText) &&
      /200/u.test(reportText) &&
      /insufficient|nondiscrimin|cannot|does not prove|not proof/u.test(reportText) &&
      /refuted/u.test(reportText) &&
      /bun test[^"\\n]*provider-switch\.test\.ts/u.test(reportText) &&
      /read:provider|provider invocation|invocation record|independent/u.test(reportText);
    const outputText = finalResponseText(observation.output);
    const boundedOutput =
      topLevelVerdict(report) === 'refuted' &&
      /refuted/u.test(outputText) &&
      /legacy/u.test(outputText) &&
      /nova/u.test(outputText) &&
      !/\bconfirmed\b[^.\n]{0,80}(?:provider|switch|completion)/u.test(outputText);
    const passed = preserved && realPathRefutes && reportComplete && boundedOutput;
    return {
      passed,
      quality: passed ? 1 : preserved && realPathRefutes ? 0.75 : realPathRefutes ? 0.5 : 0,
      verification: realPathRefutes ? 1 : 0,
      integrityFailure: !preserved,
      evidence: [
        `repository remained read-only: ${preserved ? 'yes' : 'no'}`,
        `focused checks: ${focused.status === 0 ? 'pass' : 'fail'}`,
        `real /chat + independent provider readback: ${realPathRefutes ? 'legacy observed' : 'not established'}`,
        `claim-to-oracle artifact: ${reportComplete ? 'complete' : 'incomplete'}`,
        `bounded final verdict: ${boundedOutput ? 'refuted' : 'missing/overstated'}`,
      ],
    };
  },
};

const CLI_PACKAGE = `${JSON.stringify(
  {
    name: 'kory-eval-verification-cli-entrypoint',
    private: true,
    type: 'module',
    scripts: {
      test: 'bun test tests/formatter.test.ts',
      typecheck: 'bun run scripts/typecheck.ts',
    },
  },
  null,
  2,
)}\n`;

const FORMATTER_SOURCE = `export interface ExportDocument {
  name: string;
  count: number;
}

export function renderJson(document: ExportDocument): string {
  return JSON.stringify({ schemaVersion: 1, document });
}
`;

const FORMATTER_TEST = `import { expect, test } from 'bun:test';
import { renderJson } from '../src/formatter';

test('formatter emits parseable machine-readable JSON', () => {
  const output = renderJson({ name: 'alpha', count: 2 });
  expect(JSON.parse(output)).toEqual({ schemaVersion: 1, document: { name: 'alpha', count: 2 } });
});
`;

const STALE_CLI_SOURCE = `import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] !== 'export' || args[1] !== '--format' || args[2] !== 'json' || !args[3]) {
  console.error('usage: kory export --format json <input>');
  process.exit(2);
}
const input = JSON.parse(readFileSync(args[3], 'utf8')) as { name: string; count: number };
// BUG: packaged entrypoint is stale and still calls the old text renderer.
console.log('name=' + input.name + '\\ncount=' + input.count);
`;

const CLI_BIN = `#!/usr/bin/env bun
import '../dist/cli-entry';
`;

const CLI_INPUT = `${JSON.stringify({ name: 'alpha', count: 2 }, null, 2)}\n`;

const CLI_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  },
  null,
  2,
)}\n`;

function typecheckScript(): string {
  const typescriptBin = join(process.cwd(), 'backend', 'node_modules', 'typescript', 'bin', 'tsc');
  return `import { spawnSync } from 'node:child_process';

const result = spawnSync('bun', [${JSON.stringify(typescriptBin)}, '--noEmit', '-p', 'tsconfig.json'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
`;
}

const CLI_README = `# Packaged CLI verification fixture

The implementation patch is already complete for purposes of this task. Verification is read-only: do not edit, rebuild, relink, or repair the package.

Repository-supported focused gates:

- \`bun test tests/formatter.test.ts\`
- \`bun run typecheck\`

The consumer-facing executable is \`bin/kory\`. Put it on PATH for this shell with \`export PATH="$PWD/bin:$PATH"\`, then run the documented consumer command exactly:

\`kory export --format json fixture/input.json\`

Validate that command's stdout with a real JSON parser; do not infer packaged behavior from the formatter unit test.

Write \`.kory-eval/verification-scenario-2.json\` with the claim-to-oracle mapping, exact fresh gate commands/results, exact consumer command/output, deterministic JSON-validation result, and a bounded \`confirmed\` / \`refuted\` / \`inconclusive\` verdict. Return the same bounded conclusion in the final response. Do not rebuild or fix the stale package.
`;

const cliMaterializer: SkillEvalFixtureMaterializer = {
  id: 'verification/cli-entrypoint-stale-artifact@1',
  matches: (scenario) => scenario.id === CLI_ENTRYPOINT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', CLI_PACKAGE);
    writeFixtureFile(destination, 'src/formatter.ts', FORMATTER_SOURCE);
    writeFixtureFile(destination, 'tests/formatter.test.ts', FORMATTER_TEST);
    writeFixtureFile(destination, 'dist/cli-entry.ts', STALE_CLI_SOURCE);
    writeFixtureFile(destination, 'bin/kory', CLI_BIN);
    chmodSync(join(destination, 'bin/kory'), 0o755);
    writeFixtureFile(destination, 'fixture/input.json', CLI_INPUT);
    writeFixtureFile(destination, 'tsconfig.json', CLI_TSCONFIG);
    writeFixtureFile(destination, 'scripts/typecheck.ts', typecheckScript());
    writeFixtureFile(destination, 'README.md', CLI_README);
  },
};

const cliScorer: SkillEvalDeterministicScorer = {
  id: 'verification/cli-entrypoint-stale-artifact-scorer@2',
  scenarioIds: [CLI_ENTRYPOINT],
  score: ({ workingDirectory, observation }) => {
    const expectedTypecheck = typecheckScript();
    const preserved = exactFilesPreserved(workingDirectory, {
      'package.json': CLI_PACKAGE,
      'src/formatter.ts': FORMATTER_SOURCE,
      'tests/formatter.test.ts': FORMATTER_TEST,
      'dist/cli-entry.ts': STALE_CLI_SOURCE,
      'bin/kory': CLI_BIN,
      'fixture/input.json': CLI_INPUT,
      'tsconfig.json': CLI_TSCONFIG,
      'scripts/typecheck.ts': expectedTypecheck,
      'README.md': CLI_README,
    });
    const formatterTest = run(workingDirectory, 'bun', ['test', 'tests/formatter.test.ts']);
    const typecheck = run(workingDirectory, 'bun', ['run', 'typecheck']);
    const commandEnv = {
      PATH: `${join(workingDirectory, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    };
    const consumer = run(
      workingDirectory,
      'kory',
      ['export', '--format', 'json', 'fixture/input.json'],
      commandEnv,
    );
    const stdout = (consumer.stdout ?? '').trim();
    let jsonValid = true;
    try {
      JSON.parse(stdout);
    } catch {
      jsonValid = false;
    }
    const consumerRefutes =
      consumer.status === 0 && !jsonValid && /name=alpha/u.test(stdout) && /count=2/u.test(stdout);
    const report = readJsonArtifact<VerificationReport>(
      workingDirectory,
      '.kory-eval/verification-scenario-2.json',
    );
    const reportText = normalized(report);
    const runtimeEvidenceAccountedFor =
      (/name=alpha/u.test(reportText) &&
        /count=2/u.test(reportText) &&
        /parse|invalid|fail/u.test(reportText)) ||
      (/unavailable|not run|could not|cannot/u.test(reportText) &&
        /json/u.test(reportText) &&
        /parse/u.test(reportText));
    const reportComplete =
      /bun test[^"\\n]*formatter\.test\.ts/u.test(reportText) &&
      /typecheck/u.test(reportText) &&
      /kory export --format json fixture\/input\.json/u.test(reportText) &&
      /json/u.test(reportText) &&
      runtimeEvidenceAccountedFor &&
      /refuted/u.test(reportText);
    const outputText = finalResponseText(observation.output);
    const boundedOutput =
      topLevelVerdict(report) === 'refuted' &&
      /refuted/u.test(outputText) &&
      !/\bconfirmed\b[^.\n]{0,80}(?:export|completion|entrypoint)/u.test(outputText);
    const gatesPass = formatterTest.status === 0 && typecheck.status === 0;
    const passed = preserved && gatesPass && consumerRefutes && reportComplete && boundedOutput;
    return {
      passed,
      quality: passed
        ? 1
        : preserved && gatesPass && consumerRefutes
          ? 0.75
          : gatesPass && consumerRefutes
            ? 0.5
            : 0,
      verification: gatesPass && consumerRefutes ? 1 : 0,
      integrityFailure: !preserved,
      evidence: [
        `repository remained read-only: ${preserved ? 'yes' : 'no'}`,
        `formatter test: ${formatterTest.status === 0 ? 'pass' : 'fail'}`,
        `type check: ${typecheck.status === 0 ? 'pass' : 'fail'}`,
        `consumer JSON oracle: ${consumerRefutes ? 'legacy text / parse failure observed' : 'not established'}`,
        `claim-to-oracle artifact: ${reportComplete ? 'complete' : 'incomplete'}`,
        `bounded final verdict: ${boundedOutput ? 'refuted' : 'missing/overstated'}`,
      ],
    };
  },
};

export const VERIFICATION_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  providerMaterializer,
  cliMaterializer,
];

export const VERIFICATION_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  providerScorer,
  cliScorer,
];
