import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderConfig } from '@koryphaios/shared';
import { AcpAgentProvider } from '../acp/provider';
import { AcpClient } from '../acp/client';
import { probeAcpAgent, modelIdsFromConfigOptions, sanitizeProbeError } from '../acp/probe';
import { FAKE_ACP_AGENT_SOURCE } from './acp-fake-agent';
import type { StreamRequest } from '../types';
import type { ProviderEvent } from '../types';

let dir: string;
let scriptPath: string;
let statePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kory-acp-provider-test-'));
  scriptPath = join(dir, 'fake-acp-agent.cjs');
  statePath = join(dir, 'state.json');
  writeFileSync(scriptPath, FAKE_ACP_AGENT_SOURCE);
  writeFileSync(statePath, '{}');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readState = () => JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, any>;

function resetState() {
  writeFileSync(statePath, '{}');
}

function agentConfig(overrides: Record<string, unknown> = {}, probeOk = true): ProviderConfig {
  return {
    name: 'acp:fake',
    disabled: false,
    acpAgent: {
      id: 'fake',
      label: 'Fake Agent',
      command: process.execPath,
      args: [scriptPath],
      envNames: [],
      cwdPolicy: 'workspace',
      permissionProfile: 'bridge-only',
      source: 'manual',
      ...overrides,
      ...(probeOk
        ? {
            probe: {
              ok: true,
              checkedAt: Date.now(),
              protocolVersion: 1,
              models: ['fake-small', 'fake-large'],
            },
          }
        : {}),
    },
  } as unknown as ProviderConfig;
}

function envLoader(extra: Record<string, string> = {}) {
  return () => ({ FAKE_ACP_STATE: statePath, ...extra });
}

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    messages: [{ role: 'user', content: 'do the thing' }],
    systemPrompt: 'You are a test agent.',
    workingDirectory: dir,
    sessionId: 'sess-acp-test',
    harnessRole: 'manager',
    tools: [],
    model: 'fake-large',
    signal: undefined,
    ...overrides,
  } as unknown as StreamRequest;
}

async function collect(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('acp:<id> provider: handshake and streaming', () => {
  it('streams content, thinking and tool results, then completes', async () => {
    resetState();
    const provider = new AcpAgentProvider(agentConfig(), envLoader());
    const events = await collect(provider.streamResponse(request()));

    const text = events
      .filter((e) => e.type === 'content_delta')
      .map((e: any) => e.content)
      .join('');
    expect(text).toContain('Hello from fake agent');
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);

    const executed = events.filter((e) => e.type === 'tool_executed') as any[];
    const read = executed.find((e) => e.toolCallId === 't-read');
    expect(read?.isError).toBe(false);
    expect(read?.toolOutput).toContain('file body');
    const edit = executed.find((e) => e.toolCallId === 't-edit');
    expect(edit?.isError).toBe(true);

    expect(events.some((e) => e.type === 'usage_update')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'complete', finishReason: 'end_turn' } as ProviderEvent);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('opens the session in the requested working directory', async () => {
    resetState();
    const provider = new AcpAgentProvider(agentConfig(), envLoader());
    await collect(provider.streamResponse(request()));
    expect(readState().newSession.cwd).toBe(dir);
  });

  it('selects an offered model and refuses one the agent does not offer', async () => {
    resetState();
    const provider = new AcpAgentProvider(agentConfig(), envLoader());
    await collect(provider.streamResponse(request({ model: 'fake-large' })));
    expect(readState().config.model).toBe('fake-large');

    const refused = await collect(provider.streamResponse(request({ model: 'not-offered' })));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ type: 'error' });
    expect((refused[0] as any).error).toContain('does not offer model');
  });

  it('refuses to stream an agent that has not passed its probe', async () => {
    const provider = new AcpAgentProvider(agentConfig({}, false), envLoader());
    const events = await collect(provider.streamResponse(request()));
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as any).error).toContain('capability probe');
  });

  it('exposes only probed models and availability', () => {
    const ready = new AcpAgentProvider(agentConfig(), envLoader());
    expect(ready.isAvailable()).toBe(true);
    expect(ready.listModels().map((m) => m.id)).toEqual(['fake-small', 'fake-large']);
    expect(ready.listModels()[0]?.provider).toBe('acp:fake');

    const unprobed = new AcpAgentProvider(agentConfig({}, false), envLoader());
    expect(unprobed.isAvailable()).toBe(false);
    expect(unprobed.listModels()).toEqual([]);
  });

  it('switches to the plan mode for research-only turns', async () => {
    resetState();
    const provider = new AcpAgentProvider(agentConfig(), envLoader());
    await collect(
      provider.streamResponse(
        request({ capabilityProfile: 'research-only' } as Partial<StreamRequest>),
      ),
    );
    expect(readState().config.mode).toBe('plan');
  });
});

describe('acp:<id> provider: permission veto and bridge', () => {
  it('rejects native edit and allows read-like requests', async () => {
    resetState();
    const provider = new AcpAgentProvider(agentConfig(), envLoader());
    await collect(provider.streamResponse(request()));
    const state = readState();
    expect(state.editPermission.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });
    expect(state.readPermission.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });
  });

  it('passes the Kory MCP bridge per session with a session-scoped grant', async () => {
    resetState();
    const provider = new AcpAgentProvider(agentConfig(), envLoader());
    await collect(provider.streamResponse(request()));
    const servers = readState().newSession.mcpServers as Array<{
      name: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    }>;
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe('kory');
    expect(servers[0]!.args).toContain('acp:fake');
    expect(servers[0]!.env.map((e) => e.name)).toContain('KORY_BRIDGE_AUTH_FILE');
  });

  it('wires no MCP bridge for research-only turns', async () => {
    resetState();
    const provider = new AcpAgentProvider(agentConfig(), envLoader());
    await collect(
      provider.streamResponse(
        request({ capabilityProfile: 'research-only' } as Partial<StreamRequest>),
      ),
    );
    expect(readState().newSession.mcpServers).toEqual([]);
  });

  it('keeps secret env values out of the child env except the bound ones', async () => {
    resetState();
    process.env.KORY_TEST_UNRELATED_SECRET = 'should-not-leak';
    try {
      const provider = new AcpAgentProvider(agentConfig(), envLoader({ FAKE_ACP_EXTRA: 'bound' }));
      const events = await collect(provider.streamResponse(request()));
      expect(events.at(-1)).toMatchObject({ type: 'complete' });
    } finally {
      delete process.env.KORY_TEST_UNRELATED_SECRET;
    }
  });
});

describe('ACP client transport', () => {
  it('handshakes and reports agent info', async () => {
    const client = new AcpClient({
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: { ...process.env, FAKE_ACP_STATE: statePath },
      providerName: 'acp:fake',
      label: 'Fake',
    });
    const init = await client.connect();
    expect(init.protocolVersion).toBe(1);
    expect((init as any).agentInfo?.name).toBe('fake-acp');
    await client.disconnect();
  });

  it('rejects with a clear error when the command does not exist', async () => {
    const client = new AcpClient({
      command: join(dir, 'definitely-missing-acp-binary'),
      args: [],
      cwd: dir,
      env: { ...process.env },
      providerName: 'acp:missing',
      label: 'Missing',
    });
    await expect(client.connect()).rejects.toThrow(
      /command not found|failed to start|not connected/,
    );
    await client.disconnect();
  });
});

describe('capability probe verdicts', () => {
  const target = (args: string[] = [scriptPath], command = process.execPath) => ({
    id: 'fake',
    label: 'Fake Agent',
    command,
    args,
  });

  it('records ok, protocol, agent identity and the offered models', async () => {
    resetState();
    const verdict = await probeAcpAgent(target(), {
      baseEnv: { PATH: process.env.PATH ?? '' },
      secretEnv: { FAKE_ACP_STATE: statePath },
      timeoutMs: 5000,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.protocolVersion).toBe(1);
    expect(verdict.agentName).toBe('fake-acp');
    expect(verdict.models).toEqual(['fake-small', 'fake-large']);
    expect(verdict.error).toBeUndefined();
    // The probe opens a session with no MCP servers: it is a dry run.
    expect(readState().newSession.mcpServers).toEqual([]);
  });

  it('fails when the agent speaks a different protocol version', async () => {
    const verdict = await probeAcpAgent(target(), {
      secretEnv: { FAKE_ACP_STATE: statePath, FAKE_ACP_PROTOCOL: '2' },
      timeoutMs: 5000,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('protocol 2');
  });

  it('fails when the command is missing', async () => {
    const verdict = await probeAcpAgent(target([], join(dir, 'no-such-agent')), {
      timeoutMs: 5000,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toBeTruthy();
  });

  it('times out an agent that never answers initialize', async () => {
    const verdict = await probeAcpAgent(target(), {
      secretEnv: { FAKE_ACP_STATE: statePath, FAKE_ACP_MODE: 'hang-init' },
      timeoutMs: 400,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/timed out|timeout/);
  });

  it('fails an agent that exits during the handshake', async () => {
    const verdict = await probeAcpAgent(target(), {
      secretEnv: { FAKE_ACP_STATE: statePath, FAKE_ACP_MODE: 'exit-init' },
      timeoutMs: 5000,
    });
    expect(verdict.ok).toBe(false);
  });

  it('keeps an agent with no model option ok, with an empty model list', async () => {
    const verdict = await probeAcpAgent(target(), {
      secretEnv: { FAKE_ACP_STATE: statePath, FAKE_ACP_MODELS: '' },
      timeoutMs: 5000,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.models).toEqual([]);
  });
});

describe('probe helpers', () => {
  it('extracts unique model ids from model config options only', () => {
    expect(
      modelIdsFromConfigOptions([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          options: [{ value: 'a' }, { value: 'b' }, { value: 'a' }],
        },
        { id: 'mode', name: 'Mode', type: 'select', options: [{ value: 'plan' }] },
      ]),
    ).toEqual(['a', 'b']);
  });

  it('redacts token-shaped strings and bounds probe errors', () => {
    expect(sanitizeProbeError('auth failed for sk-abcdef123456789')).not.toContain(
      'sk-abcdef123456789',
    );
    expect(sanitizeProbeError('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});
