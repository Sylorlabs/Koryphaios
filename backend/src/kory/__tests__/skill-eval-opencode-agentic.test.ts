import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { osSandboxAvailable } from '../../security/os-sandbox';
import {
  createOpenCodeLogfareAgenticExecutor,
  minimalOpenCodeConfig,
  opencodeAgenticPrompt,
  preflightProviderAccess,
  readLogfareDeclaredModels,
  readProviderFromOperatorConfig,
  readLogfareProviderFromOperatorConfig,
  type OpenCodeLogfareModel,
} from '../../eval/skills/skill-eval-opencode-agentic';

const model: OpenCodeLogfareModel = {
  model: 'auto',
  baseUrl: 'https://logfare.ai/v1',
  apiKey: 'lf_test_key',
  npm: '@ai-sdk/openai-compatible',
  providerName: 'Logfare',
};

function operatorConfig(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-config-'));
  const path = join(dir, 'opencode.json');
  writeFileSync(
    path,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { playwright: { type: 'local', command: ['node', 'cli.js'] } },
      plugin: ['some-plugin'],
      permission: 'allow',
      agent: { helper: { prompt: 'contaminated prompt' } },
      provider: {
        logfare: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Logfare',
          options: { apiKey: 'lf_operator', baseURL: 'https://logfare.ai/v1' },
          models: { auto: { id: 'logfare/auto' }, 'glm-5.3': { id: 'logfare/glm-5.3' } },
        },
      },
      ...extra,
    }),
  );
  return path;
}

describe('provider preflight', () => {
  const provider: OpenCodeLogfareModel = {
    model: 'glm-5.3-flash',
    baseUrl: 'https://vyceai.com/v1',
    apiKey: 'vyce_synthetic',
    npm: '@ai-sdk/openai-compatible',
    providerName: 'Vyce AI',
    providerId: 'vyceai',
  };

  test('an accepted request needs no failure', async () => {
    const calls: string[] = [];
    const fetched = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request.url);
      expect(request.headers.get('authorization')).toBe('Bearer vyce_synthetic');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await preflightProviderAccess(provider, fetched)).toBeNull();
    expect(calls).toEqual(['https://vyceai.com/v1/chat/completions']);
  });

  test('an exhausted budget is not retryable as a candidate failure but is retryable later', async () => {
    const fetched = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message:
              'Your account has reached its request budget. Limit reached: 10,000 requests per day.',
          },
        }),
        { status: 429 },
      )) as unknown as typeof fetch;
    // One attempt only: this asserts classification, not the transient-retry schedule.
    const failure = await preflightProviderAccess(provider, fetched, [0], async () => {});
    expect(failure?.kind).toBe('budget');
    expect(failure?.retryable).toBe(true);
    expect(failure?.detail).toContain('vyceai refused glm-5.3-flash');
  });

  test('a rejected key is a setup failure that is not retried', async () => {
    const fetched = (async () =>
      new Response(
        JSON.stringify({
          error: { message: 'Invalid API key.' },
        }),
        { status: 401 },
      )) as unknown as typeof fetch;
    const failure = await preflightProviderAccess(provider, fetched);
    expect(failure?.kind).toBe('setup');
    expect(failure?.retryable).toBe(false);
  });
});

describe('opencode logfare agentic executor', () => {
  test('reads only reach transport fields from the operator config', () => {
    const path = operatorConfig();
    const read = readLogfareProviderFromOperatorConfig(path);
    expect(read).not.toBeNull();
    expect(Object.keys(read!).sort()).toEqual([
      'apiKey',
      'baseUrl',
      'model',
      'npm',
      'providerId',
      'providerName',
    ]);
    expect(read!.apiKey).toBe('lf_operator');
    expect(read!.model).toBe('auto');
  });

  test('a selected provider is read from its own block and keeps its own id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-config-'));
    const path = join(dir, 'opencode.json');
    writeFileSync(
      path,
      JSON.stringify({
        provider: {
          logfare: {
            options: { apiKey: 'lf_operator', baseURL: 'https://logfare.ai/v1' },
            models: { auto: {} },
          },
          vyceai: {
            name: 'Vyce AI',
            options: { apiKey: 'vyce_operator', baseURL: 'https://vyceai.com/v1' },
            models: { 'glm-5.3-flash': {} },
          },
        },
      }),
    );
    const read = readProviderFromOperatorConfig(path, 'glm-5.3-flash', 'vyceai');
    expect(read?.providerId).toBe('vyceai');
    expect(read?.baseUrl).toBe('https://vyceai.com/v1');
    expect(read?.model).toBe('glm-5.3-flash');
    // The jail config must declare the same provider id it posts to, with the bare model id.
    const config = minimalOpenCodeConfig(read!) as {
      provider: Record<
        string,
        { options: { baseURL: string }; models: Record<string, { id: string }> }
      >;
    };
    expect(Object.keys(config.provider)).toEqual(['vyceai']);
    expect(config.provider.vyceai!.options.baseURL).toBe('https://vyceai.com/v1');
    expect(config.provider.vyceai!.models['glm-5.3-flash']!.id).toBe('glm-5.3-flash');
  });

  test('an exported provider key is used when the CLI config has no block for it', () => {
    const path = operatorConfig();
    process.env.VYCEAI_API_KEY = 'vyce_from_env';
    try {
      const read = readProviderFromOperatorConfig(path, 'glm-5.3-flash', 'vyceai');
      expect(read?.apiKey).toBe('vyce_from_env');
      expect(read?.baseUrl).toBe('https://vyceai.com/v1');
      expect(read?.providerId).toBe('vyceai');
    } finally {
      delete process.env.VYCEAI_API_KEY;
    }
    expect(readProviderFromOperatorConfig(path, 'glm-5.3-flash', 'vyceai')).toBeNull();
  });

  test('a provider that is not configured is refused instead of borrowing another key', () => {
    const path = operatorConfig();
    expect(readProviderFromOperatorConfig(path, 'glm-5.3-flash', 'vyceai')).toBeNull();
  });

  test('refuses a config with no logfare provider', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-config-'));
    const path = join(dir, 'opencode.json');
    writeFileSync(path, JSON.stringify({ provider: { openrouter: { options: { apiKey: 'x' } } } }));
    expect(readLogfareProviderFromOperatorConfig(path)).toBeNull();
  });

  test('refuses a missing config instead of inventing a provider', () => {
    expect(
      readLogfareProviderFromOperatorConfig(join(tmpdir(), 'definitely-absent-opencode.json')),
    ).toBeNull();
  });

  test('a requested model wins, a stale one falls back to the routing alias', () => {
    const path = operatorConfig();
    expect(readLogfareProviderFromOperatorConfig(path, 'glm-5.3')?.model).toBe('glm-5.3');
    // A model the provider no longer declares must not be requested blindly: the CLI
    // rejects it in about a second and the arm looks like a candidate failure.
    expect(readLogfareProviderFromOperatorConfig(path, 'retired-model')?.model).toBe('auto');
  });

  test('the declared catalog is read without the rest of the config', () => {
    expect(readLogfareDeclaredModels(operatorConfig())).toEqual(['auto', 'glm-5.3']);
    expect(readLogfareDeclaredModels(join(tmpdir(), 'absent-opencode.json'))).toEqual([]);
  });

  test('defaults to the routing alias even when another model is declared', () => {
    expect(readLogfareProviderFromOperatorConfig(operatorConfig())?.model).toBe('auto');
  });

  test('refuses an undeclared model instead of spending a doomed run', () => {
    expect(() =>
      createOpenCodeLogfareAgenticExecutor({
        model: { ...model, model: 'retired-model' },
        declaredModels: ['auto', 'glm-5.3'],
        wallClockMs: 1_000,
      }),
    ).toThrow(/is not declared by the operator's logfare provider/u);
  });

  test('the generated jail config carries no operator mcp, plugin or agent', () => {
    const config = minimalOpenCodeConfig(model) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(['permission', 'provider']);
    expect(JSON.stringify(config)).not.toContain('mcp');
    expect(JSON.stringify(config)).not.toContain('playwright');
    expect(JSON.stringify(config)).not.toContain('contaminated prompt');
    const provider = (config.provider as Record<string, { options: { apiKey: string } }>).logfare;
    expect(provider.options.apiKey).toBe('lf_test_key');
  });

  test('the jail config declares the provider id without a provider prefix', () => {
    const config = minimalOpenCodeConfig(model) as Record<string, unknown>;
    const provider = (config.provider as Record<string, { models: Record<string, { id: string }> }>)
      .logfare;
    // The id is what the CLI posts upstream. `logfare/glm-5.3` is not a model the endpoint
    // serves, so repeating the provider prefix here makes every named model unresolvable.
    for (const [key, entry] of Object.entries(provider.models)) expect(entry.id).toBe(key);
    expect(JSON.stringify(config)).not.toContain('"id": "logfare/');
  });

  test('the candidate prompt forbids the sealed evaluation directory', () => {
    const prompt = opencodeAgenticPrompt('do the task', 'skill body');
    expect(prompt).toContain('Never modify or create anything under .kory-eval');
    expect(prompt).toContain('skill body');
  });

  const sandboxed = process.platform === 'darwin' && osSandboxAvailable();

  test.skipIf(!sandboxed)(
    'runs a candidate inside the OS sandbox and reports changed files',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'oc-agentic-'));
      writeFileSync(join(workspace, 'before.txt'), 'unchanged\n');
      const fakeCli = join(mkdtempSync(join(tmpdir(), 'oc-fake-')), 'opencode');
      writeFileSync(
        fakeCli,
        '#!/bin/sh\nprintf "written by candidate\\n" > "$PWD/candidate.txt"\n',
      );
      chmodSync(fakeCli, 0o755);
      const executor = createOpenCodeLogfareAgenticExecutor({
        model,
        binary: fakeCli,
        wallClockMs: 30_000,
        preflight: null,
      });
      expect(executor.provider).toBe('logfare');
      const observation = await executor.execute({
        experiment: {} as never,
        scenario: { id: 'scenario', skill: 'skill' } as never,
        workingDirectory: workspace,
        taskPrompt: 'write candidate.txt',
        skillContext: null,
      });
      expect(observation.taskFailure).toBeUndefined();
      expect(observation.infrastructureFailure).toBeUndefined();
      const evidence = observation.evidence.join('\n');
      expect(evidence).toContain('changed 1 file(s)');
      expect(evidence).toContain('candidate.txt');
      expect(readFileSync(join(workspace, 'candidate.txt'), 'utf8')).toBe('written by candidate\n');
    },
  );

  test.skipIf(!sandboxed)(
    'the jail can use the host Rust toolchain instead of failing on its HOME',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'oc-agentic-'));
      const fakeCli = join(mkdtempSync(join(tmpdir(), 'oc-fake-')), 'opencode');
      // A rustup-installed cargo needs RUSTUP_HOME; with only a jail HOME it dies with
      // "could not create home directory ... Operation not permitted".
      // Unambiguous field markers: unset RUSTUP_HOME/CARGO_HOME collapse the
      // positional printf output and make the empty-case assertion meaningless.
      writeFileSync(
        fakeCli,
        '#!/bin/sh\nprintf "RUSTUP=%s CARGO=%s HOME=%s\\n" "$RUSTUP_HOME" "$CARGO_HOME" "$HOME" > "$PWD/env.txt"\n',
      );
      chmodSync(fakeCli, 0o755);
      const executor = createOpenCodeLogfareAgenticExecutor({
        model,
        binary: fakeCli,
        wallClockMs: 30_000,
        preflight: null,
      });
      const observation = await executor.execute({
        experiment: {} as never,
        scenario: { id: 'scenario', skill: 'skill' } as never,
        workingDirectory: workspace,
        taskPrompt: 'record the jail environment',
        skillContext: null,
      });
      expect(observation.infrastructureFailure).toBeUndefined();
      const fields = Object.fromEntries(
        readFileSync(join(workspace, 'env.txt'), 'utf8')
          .trim()
          .split(' ')
          .map((field) => {
            const index = field.indexOf('=');
            return [field.slice(0, index), field.slice(index + 1)];
          }),
      ) as { RUSTUP?: string; CARGO?: string; HOME?: string };
      const { existsSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      if (existsSync(join(homedir(), '.rustup'))) {
        expect(fields.RUSTUP).toBe(join(homedir(), '.rustup'));
        // The registry cache must be writable, so it lives inside the jail rather than on the host.
        expect(fields.CARGO!.startsWith(fields.HOME!)).toBe(true);
      } else {
        expect(fields.RUSTUP ?? '').toBe('');
      }
    },
  );

  test.skipIf(!sandboxed)('reports a run that changed nothing as a task failure', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'oc-agentic-'));
    const fakeCli = join(mkdtempSync(join(tmpdir(), 'oc-fake-')), 'opencode');
    writeFileSync(fakeCli, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeCli, 0o755);
    const executor = createOpenCodeLogfareAgenticExecutor({
      model,
      binary: fakeCli,
      wallClockMs: 30_000,
      preflight: null,
    });
    const observation = await executor.execute({
      experiment: {} as never,
      scenario: { id: 'scenario', skill: 'skill' } as never,
      workingDirectory: workspace,
      taskPrompt: 'do nothing',
      skillContext: null,
    });
    expect(observation.taskFailure).toBe('OpenCode exited without changing any file');
  });

  test.skipIf(!sandboxed)(
    'a CLI runtime failure is environment drift, not a candidate outcome',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'oc-agentic-'));
      const fakeCli = join(mkdtempSync(join(tmpdir(), 'oc-fake-')), 'opencode');
      writeFileSync(
        fakeCli,
        '#!/bin/sh\necho "Error: The Unix socket path exceeds macOS 104 byte limit" >&2\nexit 1\n',
      );
      chmodSync(fakeCli, 0o755);
      const executor = createOpenCodeLogfareAgenticExecutor({
        model,
        binary: fakeCli,
        wallClockMs: 30_000,
        preflight: null,
      });
      const observation = await executor.execute({
        experiment: {} as never,
        scenario: { id: 'scenario', skill: 'skill' } as never,
        workingDirectory: workspace,
        taskPrompt: 'do nothing',
        skillContext: null,
      });
      expect(observation.infrastructureFailure?.kind).toBe('environment-drift');
      expect(observation.infrastructureFailure?.retryable).toBe(true);
      expect(observation.taskFailure).toBeUndefined();
    },
  );

  test.skipIf(!sandboxed)(
    'a write outside the workspace is denied by the kernel sandbox',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'oc-agentic-'));
      const outside = join(mkdtempSync(join(tmpdir(), 'oc-outside-')), 'escape.txt');
      const fakeCli = join(mkdtempSync(join(tmpdir(), 'oc-fake-')), 'opencode');
      writeFileSync(fakeCli, `#!/bin/sh\nprintf escape > ${outside} 2>/dev/null || true\nexit 0\n`);
      chmodSync(fakeCli, 0o755);
      const executor = createOpenCodeLogfareAgenticExecutor({
        model,
        binary: fakeCli,
        wallClockMs: 30_000,
        preflight: null,
      });
      await executor.execute({
        experiment: {} as never,
        scenario: { id: 'scenario', skill: 'skill' } as never,
        workingDirectory: workspace,
        taskPrompt: 'escape',
        skillContext: null,
      });
      let wrote = true;
      try {
        readFileSync(outside);
      } catch {
        wrote = false;
      }
      expect(wrote).toBe(false);
    },
  );
});

describe('provider outage classification', () => {
  const sandboxed = process.platform === 'darwin' || process.platform === 'linux';
  test.skipIf(!sandboxed)(
    'a provider that disappears mid-turn is a retryable provider failure',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'oc-agentic-'));
      const fakeCli = join(mkdtempSync(join(tmpdir(), 'oc-fake-')), 'opencode');
      writeFileSync(fakeCli, '#!/bin/sh\necho "Error: provider became unavailable" >&2\nexit 1\n');
      chmodSync(fakeCli, 0o755);
      const executor = createOpenCodeLogfareAgenticExecutor({
        model,
        binary: fakeCli,
        wallClockMs: 30_000,
        preflight: null,
      });
      const observation = await executor.execute({
        experiment: {} as never,
        scenario: { id: 'scenario', skill: 'skill' } as never,
        workingDirectory: workspace,
        taskPrompt: 'do nothing',
        skillContext: null,
      });
      expect(observation.infrastructureFailure?.kind).toBe('provider');
      // The stream watchdog sees the outage before the process exits, so it is retryable: the
      // provider may come back, and no candidate evidence was produced either way.
      expect(observation.infrastructureFailure?.retryable).toBe(true);
      expect(observation.taskFailure).toBeUndefined();
    },
  );
});

describe('provider abort watchdog', () => {
  const sandboxed = process.platform === 'darwin' || process.platform === 'linux';
  test.skipIf(!sandboxed)(
    'a rate-limit error on the CLI stream ends the arm instead of the wall clock',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'oc-agentic-'));
      const fakeCli = join(mkdtempSync(join(tmpdir(), 'oc-fake-')), 'opencode');
      // Writes an artifact, then reports a 429 and hangs: the shape that used to burn the budget.
      writeFileSync(
        fakeCli,
        '#!/bin/sh\nprintf "{}" > .kory-eval-artifact.json\n' +
          'echo "429 free model request limit reached" >&2\nsleep 600\n',
      );
      chmodSync(fakeCli, 0o755);
      const executor = createOpenCodeLogfareAgenticExecutor({
        model,
        binary: fakeCli,
        wallClockMs: 60_000,
        preflight: null,
      });
      const started = Date.now();
      const observation = await executor.execute({
        experiment: {} as never,
        scenario: { id: 'scenario', skill: 'skill' } as never,
        workingDirectory: workspace,
        taskPrompt: 'do nothing',
        skillContext: null,
      });
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(observation.infrastructureFailure?.kind).toBe('provider');
      expect(observation.infrastructureFailure?.retryable).toBe(true);
      expect(observation.infrastructureFailure?.evidence.join(' ')).toContain('429');
    },
    30_000,
  );
});

describe('provider heartbeat', () => {
  const sandboxed = process.platform === 'darwin' || process.platform === 'linux';
  test.skipIf(!sandboxed)(
    'a silent 429 the CLI never prints still ends the arm',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'oc-agentic-'));
      const fakeCli = join(mkdtempSync(join(tmpdir(), 'oc-fake-')), 'opencode');
      // No output at all: this is what an OpenCode retry loop looks like under a 429.
      writeFileSync(fakeCli, '#!/bin/sh\nsleep 600\n');
      chmodSync(fakeCli, 0o755);
      let probes = 0;
      const executor = createOpenCodeLogfareAgenticExecutor({
        model,
        binary: fakeCli,
        wallClockMs: 120_000,
        providerHeartbeatMs: 40,
        // The fake CLI prints nothing, so the arm is stalled from its first moment.
        providerStallMs: 0,
        preflight: async () => {
          probes += 1;
          // Three consecutive refusals are required: one refusal is itself a request, and a
          // throttled provider answers the first probes and then refuses for a few seconds.
          return probes < 5
            ? null
            : {
                kind: 'budget',
                retryable: true,
                detail: 'numes: free model request limit reached',
              };
        },
      });
      const started = Date.now();
      const observation = await executor.execute({
        experiment: {} as never,
        scenario: { id: 'scenario', skill: 'skill' } as never,
        workingDirectory: workspace,
        taskPrompt: 'do nothing',
        skillContext: null,
      });
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(probes).toBeGreaterThan(1);
      expect(observation.infrastructureFailure?.kind).toBe('provider');
      expect(observation.infrastructureFailure?.retryable).toBe(true);
      expect(observation.infrastructureFailure?.evidence.join(' ')).toContain('provider probe');
    },
    30_000,
  );
});

describe('provider heartbeat stall gate', () => {
  const model = {
    model: 'glm-5.3',
    baseUrl: 'https://logfare.ai/v1',
    apiKey: 'k',
    providerId: 'logfare',
  } as never;

  test('a refused probe does not end an arm whose CLI is still producing output', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'oc-stall-'));
    const fakeCli = join(mkdtempSync(join(tmpdir(), 'oc-fake-')), 'opencode');
    // Prints continuously for ~1.2s, so the arm is never stalled while probes keep failing.
    writeFileSync(
      fakeCli,
      '#!/bin/sh\nfor i in $(seq 1 24); do echo "working $i"; sleep 0.05; done\n',
    );
    chmodSync(fakeCli, 0o755);
    let probes = 0;
    const executor = createOpenCodeLogfareAgenticExecutor({
      model,
      binary: fakeCli,
      wallClockMs: 30_000,
      providerHeartbeatMs: 20,
      providerStallMs: 250,
      preflight: async () => {
        probes += 1;
        // The arm starts while the provider answers, then the probes are refused.
        return probes === 1
          ? null
          : {
              kind: 'budget',
              retryable: true,
              detail: 'logfare refused glm-5.3: Service temporarily unavailable',
            };
      },
    });
    const observation = await executor.execute({
      experiment: {} as never,
      scenario: { id: 'scenario', skill: 'skill' } as never,
      workingDirectory: workspace,
      taskPrompt: 'keep printing',
      skillContext: null,
    });
    expect(probes).toBeGreaterThan(2);
    expect(observation.infrastructureFailure).toBeUndefined();
  });
});

describe('provider preflight retry', () => {
  const model = {
    model: 'glm-5.3',
    baseUrl: 'https://logfare.ai/v1',
    apiKey: 'k',
    providerId: 'logfare',
  } as never;
  const sleeps: number[] = [];
  const noSleep = async (ms: number) => {
    sleeps.push(ms);
  };

  test('a transient 503 is retried instead of refusing the arm', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 3
        ? new Response('{"error":{"message":"Service temporarily unavailable"}}', { status: 503 })
        : new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    sleeps.length = 0;
    expect(await preflightProviderAccess(model, fetchImpl, [0, 1, 1], noSleep)).toBeNull();
    expect(calls).toBe(3);
  });

  test('a permanent refusal is not retried away', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('{"error":{"message":"invalid api key"}}', { status: 401 });
    }) as unknown as typeof fetch;
    const failure = await preflightProviderAccess(model, fetchImpl, [0, 1, 1], noSleep);
    expect(calls).toBe(1);
    expect(failure?.kind).toBe('setup');
  });

  test('a provider that stays throttled still reports the measured reason', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":{"message":"inference request per min rate reached"}}', {
        status: 429,
      })) as unknown as typeof fetch;
    const failure = await preflightProviderAccess(model, fetchImpl, [0, 1, 1], noSleep);
    expect(failure?.kind).toBe('budget');
    expect(failure?.detail).toContain('per min rate reached');
  });
});
