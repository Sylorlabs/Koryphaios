// Lifecycle contract: each verified CLI adapter declares exactly what its code supports,
// the conservative default applies to providers that declare nothing, and the registry
// exposes the declared capabilities read-only through getStatus().
//
// The argv guards run a real turn through the replay seam (see providers/replay/) and
// assert the flags that justify resume=false. If an adapter starts resuming a session,
// these fail and the capability declaration must change with it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ProviderConfig } from '@koryphaios/shared';
import { ClaudeCodeProvider, __resetClaudeCodeModelCacheForTesting } from '../claude-code';
import { CodexCliProvider } from '../codex-cli';
import { OpenCodeCliProvider } from '../opencode-cli';
import { ProviderRegistry } from '../registry';
import { lifecycleCapabilities, type LifecycleCapabilities, type Provider, type ProviderEvent, type StreamRequest } from '../types';
import { createReplaySpawn } from '../replay/replay-process';
import { loadTranscript } from '../replay/transcript';
import { createCliSandbox, type CliSandbox } from '../replay/__tests__/support';

const FIXTURES = join(import.meta.dir, '..', 'replay', 'fixtures');
const PROMPT = 'List the files in src/ and summarise main.ts';

const CODEX_CAPABILITIES: LifecycleCapabilities = {
  version: 1,
  interrupt: false,
  resume: false,
  resumeAfterRestart: false,
  steerInFlight: false,
  rollback: false,
  fork: false,
  terminalStatusQuality: 'weak',
};

const CLAUDE_CAPABILITIES: LifecycleCapabilities = { ...CODEX_CAPABILITIES };

const OPENCODE_CAPABILITIES: LifecycleCapabilities = {
  version: 1,
  interrupt: true,
  resume: false,
  resumeAfterRestart: false,
  steerInFlight: false,
  rollback: true,
  fork: false,
  terminalStatusQuality: 'strong',
};

const DEFAULT_CAPABILITIES: LifecycleCapabilities = {
  version: 1,
  interrupt: false,
  resume: false,
  resumeAfterRestart: false,
  steerInFlight: false,
  rollback: false,
  fork: false,
  terminalStatusQuality: 'weak',
};

let sandbox: CliSandbox;

beforeAll(() => {
  sandbox = createCliSandbox(['codex', 'claude', 'opencode'], { '.codex/auth.json': '{}' });
});

afterAll(() => {
  sandbox.dispose();
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function request(model: string): StreamRequest {
  return {
    model,
    systemPrompt: '',
    messages: [{ role: 'user', content: PROMPT }],
    workingDirectory: sandbox.workdir,
  };
}

describe('provider lifecycle capabilities', () => {
  test('codex declares no resume and weak terminal status', () => {
    const provider = new CodexCliProvider({ name: 'codex' } as ProviderConfig);
    expect(lifecycleCapabilities(provider)).toEqual(CODEX_CAPABILITIES);
    expect(provider.lifecycle?.resumeHandle?.('any-session')).toBeNull();
  });

  test('claude declares no resume and weak terminal status', () => {
    const provider = new ClaudeCodeProvider({ name: 'claude' } as ProviderConfig);
    expect(lifecycleCapabilities(provider)).toEqual(CLAUDE_CAPABILITIES);
    expect(provider.lifecycle?.resumeHandle?.('any-session')).toBeNull();
  });

  test('opencode declares ACP cancel, fresh-per-turn rollback and strong terminal status', () => {
    const provider = new OpenCodeCliProvider({ name: 'opencode' } as ProviderConfig);
    expect(lifecycleCapabilities(provider)).toEqual(OPENCODE_CAPABILITIES);
    expect(provider.lifecycle?.resumeHandle?.('any-session')).toBeNull();
  });

  test('a provider without lifecycle gets the conservative default', () => {
    const bare = { name: 'bare' } as unknown as Provider;
    expect(bare.lifecycle).toBeUndefined();
    expect(lifecycleCapabilities(bare)).toEqual(DEFAULT_CAPABILITIES);
  });

  test('getStatus exposes the declared lifecycle and the default for an undeclared adapter', () => {
    const declared = new OpenCodeCliProvider({ name: 'opencode' } as ProviderConfig);
    const undeclared = {
      name: 'remote-lifecycle-undeclared',
      config: { name: 'remote-lifecycle-undeclared' },
      streamResponse: async function* () {},
      isAvailable: () => true,
      listModels: () => [],
    } as unknown as Provider;
    const registry = new ProviderRegistry();
    registry.registerRemoteProvider(declared as unknown as Provider);
    registry.registerRemoteProvider(undeclared);

    const statuses = registry.getStatus();
    expect(statuses.find((entry) => entry.name === 'opencode')?.lifecycle).toEqual(
      OPENCODE_CAPABILITIES,
    );
    expect(statuses.find((entry) => entry.name === 'remote-lifecycle-undeclared')?.lifecycle).toEqual(
      DEFAULT_CAPABILITIES,
    );
  });
});

describe('argv guards behind resume=false', () => {
  test('codex runs every turn with --ephemeral and never resumes a thread', async () => {
    const transcript = loadTranscript(join(FIXTURES, 'codex-synthetic-turn.jsonl'));
    const spawnChild = createReplaySpawn((_command, args) => (args.includes('exec') ? transcript : null));
    const provider = new CodexCliProvider({ name: 'codex' } as ProviderConfig, spawnChild as never, sandbox.home);
    await collect(provider.streamResponse(request('gpt-5-codex')));

    const turn = spawnChild.calls.find((call) => call.args.includes('exec'));
    expect(turn).toBeDefined();
    expect(turn!.args).toContain('--ephemeral');
    expect(turn!.args.some((arg) => arg === 'resume' || arg === '--resume' || arg === '--last')).toBe(false);
  });

  test('claude turn argv carries no resume or session-id flag', async () => {
    __resetClaudeCodeModelCacheForTesting();
    const transcript = loadTranscript(join(FIXTURES, 'claude-synthetic-turn.jsonl'));
    const spawnChild = createReplaySpawn((_command, args) =>
      args.includes('--include-partial-messages') ? transcript : null,
    );
    const provider = new ClaudeCodeProvider(
      { name: 'claude', authToken: 'test-token' } as ProviderConfig,
      spawnChild as never,
    );
    await collect(provider.streamResponse(request('opus')));

    const turn = spawnChild.calls.find((call) => call.args.includes('--include-partial-messages'));
    expect(turn).toBeDefined();
    for (const flag of ['--resume', '--continue', '--session-id']) {
      expect(turn!.args).not.toContain(flag);
    }
  });
});
