import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, ProviderEvent, StreamRequest } from '../../providers/types';
import {
  createDirectProviderTextPatchSkillEvalExecutor,
  createOmnirushTextOnlyPatchSkillEvalExecutor,
  createOpenRouterTextOnlyPatchSkillEvalExecutor,
} from '../skill-eval-provider';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';

const workspaceScenario = (
  kind: 'synthetic' | 'repository' | 'cli' | 'browser' | 'public-web' | 'device' = 'synthetic',
): SkillEvalScenarioV3 => ({
  id: 'provider-text-patch-test',
  skill: 'test-skill',
  category: 'full-task',
  prompt: 'Update the fixture.',
  expectedSelection: true,
  expectedSkills: [],
  forbiddenSkills: [],
  heldOut: true,
  adjacentSkills: [],
  tags: [],
  environment: {
    kind,
    startingState: 'fixture',
    requirements: [],
  },
  falsifiableChecks: [],
  scorers: [],
  requiredEvidence: [],
  requiredArtifacts: [],
});

function provider(events: ProviderEvent[], available = true): Provider {
  return {
    name: 'fake-provider' as Provider['name'],
    config: { name: 'fake-provider' as Provider['name'], disabled: false },
    isAvailable: () => available,
    listModels: () => [
      {
        id: 'test-model',
        name: 'Test model',
        provider: 'omnirush',
        contextWindow: 100_000,
        maxOutputTokens: 10_000,
      },
    ],
    isModelCatalogAuthoritative: () => true,
    async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
      yield* events;
    },
  };
}

function input(root: string, scenario = workspaceScenario()) {
  return {
    experiment: {} as never,
    scenario,
    workingDirectory: root,
    taskPrompt: scenario.prompt,
    skillContext: 'Use the fixture guidance.',
  };
}

function executor(
  fake: Provider,
  wallClockMs = 100,
  reasoningLevel?: string,
): ReturnType<typeof createDirectProviderTextPatchSkillEvalExecutor> {
  return createDirectProviderTextPatchSkillEvalExecutor({
    provider: fake,
    model: 'test-model',
    runtimeIdentity: 'fake-runtime-v1',
    reasoningLevel,
    wallClockMs,
  });
}

test('OpenRouter qualification metadata binds the explicitly requested model', () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = 'test-only-placeholder';
    const first = createOpenRouterTextOnlyPatchSkillEvalExecutor({ model: 'vendor/model-a' });
    const second = createOpenRouterTextOnlyPatchSkillEvalExecutor({ model: 'vendor/model-b' });
    expect(first.model).toBe('vendor/model-a');
    expect(first.runtimeIdentity).toBe('openrouter-api:vendor/model-a:text-only-patch');
    expect(second.runtimeIdentity).toBe('openrouter-api:vendor/model-b:text-only-patch');
    expect(first.id).not.toBe(second.id);
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

describe('direct provider skill evaluation text patch executor', () => {
  test('collects tagged provider content and applies the patch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      writeFileSync(join(root, 'README.md'), 'fixture\n');
      const result = await executor(
        provider([
          {
            type: 'content_delta',
            content:
              '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"done\\n"}]</kory-eval-patch>',
          },
          { type: 'complete', finishReason: 'end_turn' },
        ]),
      ).execute(input(root));
      expect(result.infrastructureFailure).toBeUndefined();
      expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('done\n');
      expect(result.evidence.join('\n')).toContain('applied: result.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('passes the evaluator deadline to the provider sandbox budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    let observed: StreamRequest | undefined;
    try {
      const fake: Provider = {
        ...provider([
          { type: 'content_delta', content: '<kory-eval-patch>[]</kory-eval-patch>' },
          { type: 'complete', finishReason: 'end_turn' },
        ]),
        async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
          observed = request;
          yield { type: 'content_delta', content: '<kory-eval-patch>[]</kory-eval-patch>' };
          yield { type: 'complete', finishReason: 'end_turn' };
        },
      };
      const result = await executor(fake, 1_234).execute(input(root));
      expect(result.infrastructureFailure).toBeUndefined();
      expect(result.taskFailure).toBeUndefined();
      expect(observed?.sandbox?.maxRuntimeSeconds).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifies provider error events without applying output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      const result = await executor(
        provider([{ type: 'error', error: 'upstream unavailable', errorTransient: true }]),
      ).execute(input(root));
      expect(result.infrastructureFailure).toMatchObject({ kind: 'provider', retryable: true });
      expect(result.output).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects malformed model output as a task failure without applying a patch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      writeFileSync(join(root, 'README.md'), 'fixture\n');
      const result = await executor(
        provider([
          { type: 'content_delta', content: 'not a patch' },
          { type: 'complete', finishReason: 'stop' },
        ]),
      ).execute(input(root));
      expect(result.taskFailure).toContain('patch contract');
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('fixture\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires a successful complete event and rejects tool events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      const incomplete = await executor(
        provider([{ type: 'content_delta', content: '<kory-eval-patch>[]</kory-eval-patch>' }]),
      ).execute(input(root));
      expect(incomplete.taskFailure).toContain('without a complete event');

      const tool = await executor(
        provider([{ type: 'tool_use_start', toolName: 'shell' }]),
      ).execute(input(root));
      expect(tool.taskFailure).toContain('unsupported tool_use_start');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifies timeout, aborts the request, and never applies a late patch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      let aborted = false;
      const slow: Provider = {
        ...provider([]),
        async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
          request.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 30));
          yield {
            type: 'content_delta',
            content:
              '<kory-eval-patch>[{"operation":"write","path":"late.txt","content":"late"}]</kory-eval-patch>',
          };
          yield { type: 'complete', finishReason: 'end_turn' };
        },
      };
      const result = await executor(slow, 5).execute(input(root));
      expect(result.infrastructureFailure?.kind).toBe('timeout');
      expect(result.evidence.join('\n')).toContain('no test-execution evidence');
      expect(aborted).toBe(true);
      expect(() => readFileSync(join(root, 'late.txt'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('clears the bounded teardown watchdog after provider cleanup wins the race', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const teardownTimers = new Set<ReturnType<typeof setTimeout>>();
    globalThis.setTimeout = ((
      callback: (...args: any[]) => void,
      delay?: number,
      ...args: any[]
    ) => {
      const timer = originalSetTimeout(callback, delay, ...args);
      if (delay === 2_000) teardownTimers.add(timer);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      teardownTimers.delete(timer);
      return originalClearTimeout(timer);
    }) as typeof clearTimeout;
    try {
      const slow: Provider = {
        ...provider([]),
        async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
          await new Promise<void>((resolve) =>
            request.signal?.addEventListener('abort', () => setTimeout(resolve, 10), {
              once: true,
            }),
          );
        },
      };
      const result = await executor(slow, 5).execute(input(root));
      expect(result.infrastructureFailure?.kind).toBe('timeout');
      expect(teardownTimers).toHaveLength(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('waits for bounded provider teardown before returning a timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      let cleaned = false;
      const slow: Provider = {
        ...provider([]),
        async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener(
              'abort',
              () =>
                setTimeout(() => {
                  cleaned = true;
                  resolve();
                }, 20),
              { once: true },
            );
          });
        },
      };

      const result = await executor(slow, 5).execute(input(root));
      expect(result.infrastructureFailure?.kind).toBe('timeout');
      expect(cleaned).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifies an unavailable provider as setup infrastructure failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      const result = await executor(provider([], false)).execute(input(root));
      expect(result.infrastructureFailure).toMatchObject({ kind: 'setup' });
      expect(result.infrastructureFailure?.detail).toContain('unavailable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses public-web, browser, and device scenarios before calling the provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      let called = false;
      const fake = provider([]);
      fake.streamResponse = async function* () {
        called = true;
      };
      for (const kind of ['public-web', 'browser', 'device'] as const) {
        const result = await executor(fake).execute(input(root, workspaceScenario(kind)));
        expect(result.infrastructureFailure).toMatchObject({ kind: 'tool' });
      }
      expect(called).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('publishes provider, model, runtime, tools, and budget metadata', () => {
    const value = executor(provider([]), 321);
    expect(value).toMatchObject({
      provider: 'fake-provider',
      model: 'test-model',
      runtimeIdentity: 'fake-runtime-v1',
      tools: ['workspace-snapshot', 'patch-apply'],
      budget: { wallClockMs: 321 },
    });
    expect(value.id).toContain('fake-provider:test-model:fake-runtime-v1');
  });

  test('marks the provider request as native-tool disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      let request: StreamRequest | undefined;
      const fake: Provider = {
        ...provider([
          {
            type: 'content_delta',
            content: '<kory-eval-patch>[]</kory-eval-patch>',
          },
          { type: 'complete', finishReason: 'end_turn' },
        ]),
        async *streamResponse(value: StreamRequest): AsyncGenerator<ProviderEvent> {
          request = value;
          yield { type: 'content_delta', content: '<kory-eval-patch>[]</kory-eval-patch>' };
          yield { type: 'complete', finishReason: 'end_turn' };
        },
      };
      await executor(fake).execute(input(root));
      expect(request).toMatchObject({
        tools: [],
        allowedToolNames: [],
        nativeToolsDisabled: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('passes the already-resolved reasoning level to the provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-provider-eval-'));
    try {
      let request: StreamRequest | undefined;
      const fake: Provider = {
        ...provider([]),
        async *streamResponse(value: StreamRequest): AsyncGenerator<ProviderEvent> {
          request = value;
          yield { type: 'content_delta', content: '<kory-eval-patch>[]</kory-eval-patch>' };
          yield { type: 'complete', finishReason: 'end_turn' };
        },
      };
      await executor(fake, 100, 'deliberate-v2').execute(input(root));
      expect(request?.reasoningLevel).toBe('deliberate-v2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('qualification executor keeps the captured OmniRush launcher after PATH changes', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-provider-omnirush-binding-'));
    const launcherA = join(testRoot, 'a', 'omnirush');
    const launcherB = join(testRoot, 'b', 'omnirush');
    const stateRoot = join(testRoot, 'state');
    const used = join(testRoot, 'used.log');
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    try {
      mkdirSync(join(testRoot, 'a'), { recursive: true, mode: 0o700 });
      mkdirSync(join(testRoot, 'b'), { recursive: true, mode: 0o700 });
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(
        join(stateRoot, 'model-catalog.json'),
        JSON.stringify({
          payload: {
            data: [
              {
                id: 'gpt-6-astra',
                limits: { context: 400_000, output: 128_000 },
                reasoning_levels: ['low', 'high'],
                capabilities: { reasoning: true, tool_call: false, image_input: false },
              },
            ],
          },
        }),
        { mode: 0o600 },
      );
      const patch = '<kory-eval-patch>[]</kory-eval-patch>';
      for (const [launcher, label] of [
        [launcherA, 'A'],
        [launcherB, 'B'],
      ] as const) {
        writeFileSync(
          launcher,
          `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(used)}, '${label}:' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv.includes('--version')) process.stdout.write('omnirush ${label}\\n');
else if (process.argv.includes('whoami')) process.stdout.write('verified\\n');
else if (process.argv.includes('--print')) process.stdout.write(${JSON.stringify(patch)} + '\\n');
else process.exit(1);
`,
          { mode: 0o700 },
        );
        chmodSync(launcher, 0o700);
      }

      process.env.PATH = join(testRoot, 'a');
      process.env.OMNIRUSH_DIR = stateRoot;
      const executor = createOmnirushTextOnlyPatchSkillEvalExecutor({
        reasoningEffort: 'high',
        wallClockMs: 2_000,
      });
      const noReasoningExecutor = createOmnirushTextOnlyPatchSkillEvalExecutor({
        reasoningEffort: 'none',
        wallClockMs: 2_000,
      });
      process.env.PATH = join(testRoot, 'b');
      const root = mkdtempSync(join(testRoot, 'workspace-'));
      writeFileSync(join(root, 'README.md'), 'fixture\n');
      try {
        const result = await executor.execute(input(root));
        expect(result.infrastructureFailure).toBeUndefined();
        expect(result.output).toContain('<kory-eval-patch>');
        expect(readFileSync(used, 'utf8')).toContain(
          'A:--model gpt-6-astra --thinking high --print',
        );
        expect(readFileSync(used, 'utf8')).not.toContain('B:');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      const noReasoningRoot = mkdtempSync(join(testRoot, 'workspace-no-reasoning-'));
      try {
        const result = await noReasoningExecutor.execute(input(noReasoningRoot));
        expect(result.infrastructureFailure).toBeUndefined();
        expect(readFileSync(used, 'utf8')).toContain('A:--model gpt-6-astra --print');
        expect(readFileSync(used, 'utf8')).not.toContain('A:--model gpt-6-astra --thinking none');
      } finally {
        rmSync(noReasoningRoot, { recursive: true, force: true });
      }
      expect(() =>
        createOmnirushTextOnlyPatchSkillEvalExecutor({
          reasoningEffort: 'unsupported',
          wallClockMs: 2_000,
        }),
      ).toThrow('does not advertise reasoning level unsupported');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
