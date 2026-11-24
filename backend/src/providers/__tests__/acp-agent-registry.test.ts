import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OFFICIAL_ACP_REGISTRY_URL,
  autodetectAcpAgents,
  fetchAcpRegistry,
  parseAcpRegistry,
  resetAcpRegistryCacheForTesting,
} from '../acp/sources';
import {
  loadAcpAgentDefinitions,
  loadAcpAgentEnv,
  loadAcpAgentEnvSecrets,
  loadAcpProbeVerdicts,
  removeAcpAgent,
  saveAcpAgent,
} from '../acp/agent-store';
import {
  AcpAgentValidationError,
  validateAcpAgentInput,
  isRefusedAgentEnvName,
  slugifyAcpAgentId,
  toAcpProbeConfig,
  type AcpAgentDefinition,
} from '../acp/agent-definitions';
import { buildAcpChildEnv } from '../acp/env';
import {
  addCustomAcpAgent,
  AcpAgentConflictError,
  listAcpAgents,
  probeCustomAcpAgent,
  removeCustomAcpAgent,
  type AcpAgentHost,
} from '../acp/agent-service';
import { FAKE_ACP_AGENT_SOURCE } from './acp-fake-agent';

let root: string;
let scriptPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-acp-registry-test-'));
  scriptPath = join(root, 'fake-acp-agent.cjs');
  writeFileSync(scriptPath, FAKE_ACP_AGENT_SOURCE);
  resetAcpRegistryCacheForTesting();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetAcpRegistryCacheForTesting();
});

const REGISTRY_PAYLOAD = {
  version: '1',
  agents: [
    {
      id: 'agoragentic-acp',
      name: 'Agoragentic',
      version: '1.3.0',
      description: 'Agent marketplace',
      distribution: { npx: { package: 'agoragentic-mcp@1.3.0', args: ['--acp'] } },
    },
    {
      id: 'uv-agent',
      name: 'UV Agent',
      distribution: { uvx: { package: 'uv-agent-pkg' } },
    },
    {
      id: 'binary-agent',
      name: 'Binary Agent',
      distribution: { binary: { 'darwin-aarch64': { cmd: './agent' } } },
    },
    { id: 'bad id with spaces', name: 'Bad' },
    { name: 'No id' },
  ],
  extensions: [],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('official registry fetch', () => {
  it('points at the documented CDN endpoint', () => {
    expect(OFFICIAL_ACP_REGISTRY_URL).toBe(
      'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    );
  });

  it('parses valid entries, derives install instructions and drops malformed ones', async () => {
    const snapshot = await fetchAcpRegistry({
      force: true,
      fetchImpl: async () => jsonResponse(REGISTRY_PAYLOAD),
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.source).toBe('network');
    expect(snapshot.entries.map((e) => e.id)).toEqual([
      'agoragentic-acp',
      'uv-agent',
      'binary-agent',
    ]);
    const npx = snapshot.entries[0]!;
    expect(npx.install.kind).toBe('npx');
    expect(npx.install.command).toBe('npx');
    expect(npx.install.args).toEqual(['-y', 'agoragentic-mcp@1.3.0', '--acp']);
    expect(snapshot.entries[1]!.install.kind).toBe('uvx');
    expect(snapshot.entries[2]!.install.kind).toBe('binary');
    expect(snapshot.entries[2]!.install.command).toBeUndefined();
  });

  it('reports a network failure without throwing and keeps no fake entries', async () => {
    const snapshot = await fetchAcpRegistry({
      force: true,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.error).toMatch(/network unavailable/);
  });

  it('refuses redirects instead of following them', async () => {
    const snapshot = await fetchAcpRegistry({
      force: true,
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.com/r.json' },
        }),
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.error).toMatch(/redirect/);
  });

  it('rejects a response that came from an unexpected host', async () => {
    const response = jsonResponse(REGISTRY_PAYLOAD);
    Object.defineProperty(response, 'url', { value: 'https://evil.example.com/registry.json' });
    const snapshot = await fetchAcpRegistry({ force: true, fetchImpl: async () => response });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.error).toMatch(/unexpected host/);
  });

  it('times out a hung registry request', async () => {
    const snapshot = await fetchAcpRegistry({
      force: true,
      timeoutMs: 50,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'TimeoutError';
            reject(err);
          });
        }),
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.error).toMatch(/timed out/);
  });

  it('rejects non-JSON and empty payloads', async () => {
    const notJson = await fetchAcpRegistry({
      force: true,
      fetchImpl: async () => new Response('<html>', { status: 200 }),
    });
    expect(notJson.ok).toBe(false);
    expect(notJson.error).toMatch(/not valid JSON/);

    const empty = await fetchAcpRegistry({
      force: true,
      fetchImpl: async () => jsonResponse({ agents: [] }),
    });
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/no usable agents/);
  });

  it('serves a cached success without refetching, and negative-caches failures', async () => {
    let now = 1_000_000;
    let calls = 0;
    const ok = await fetchAcpRegistry({
      force: true,
      now: () => now,
      fetchImpl: async () => {
        calls++;
        return jsonResponse(REGISTRY_PAYLOAD);
      },
    });
    expect(ok.ok).toBe(true);
    const cached = await fetchAcpRegistry({
      now: () => now,
      fetchImpl: async () => {
        calls++;
        return jsonResponse(REGISTRY_PAYLOAD);
      },
    });
    expect(cached.source).toBe('cache');
    expect(calls).toBe(1);

    now += 7 * 60 * 60 * 1000; // past the 6h success TTL
    await fetchAcpRegistry({
      now: () => now,
      fetchImpl: async () => {
        calls++;
        throw new TypeError('down');
      },
    });
    expect(calls).toBe(2);
    // Failure is negative-cached: the next call does not hit the network.
    const negative = await fetchAcpRegistry({
      now: () => now,
      fetchImpl: async () => {
        calls++;
        throw new TypeError('down');
      },
    });
    expect(negative.ok).toBe(false);
    expect(calls).toBe(2);
  });

  it('keeps the last good entries when a later refresh fails', async () => {
    let now = 1_000_000;
    await fetchAcpRegistry({
      force: true,
      now: () => now,
      fetchImpl: async () => jsonResponse(REGISTRY_PAYLOAD),
    });
    now += 7 * 60 * 60 * 1000;
    const failed = await fetchAcpRegistry({
      force: true,
      now: () => now,
      fetchImpl: async () => new Response('nope', { status: 503 }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.entries.length).toBe(3);
  });
});

describe('parseAcpRegistry', () => {
  it('returns nothing for a non-registry payload', () => {
    expect(parseAcpRegistry(null)).toEqual([]);
    expect(parseAcpRegistry([])).toEqual([]);
    expect(parseAcpRegistry({ agents: 'nope' })).toEqual([]);
  });
});

describe('PATH autodetect', () => {
  it('lists candidates found on PATH as available with unverified args', () => {
    const found = autodetectAcpAgents(
      [
        { id: 'alpha', label: 'Alpha', binary: 'alpha-bin', args: ['acp'], argsVerified: false },
        { id: 'beta', label: 'Beta', binary: 'beta-bin', args: [], argsVerified: false },
      ],
      (bin) => (bin === 'alpha-bin' ? '/usr/local/bin/alpha-bin' : null),
    );
    expect(found).toEqual([
      {
        id: 'alpha',
        label: 'Alpha',
        binaryPath: '/usr/local/bin/alpha-bin',
        args: ['acp'],
        argsVerified: false,
      },
    ]);
  });
});

describe('agent definitions', () => {
  it('accepts a bare command, an absolute path and a plain env name', () => {
    const v = validateAcpAgentInput({
      label: 'My Agent',
      command: 'my-agent',
      env: { ANTHROPIC_API_KEY: 'k' },
    });
    expect(v.id).toBe('my-agent');
    expect(v.env).toEqual({ ANTHROPIC_API_KEY: 'k' });
    expect(() => validateAcpAgentInput({ label: 'x', command: '/opt/bin/agent' })).not.toThrow();
  });

  it('refuses loader and runtime injection env names', () => {
    for (const name of [
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'NODE_OPTIONS',
      'PATH',
      'BUN_CONFIG',
    ]) {
      expect(isRefusedAgentEnvName(name)).toBe(true);
      expect(() =>
        validateAcpAgentInput({ label: 'x', command: 'a', env: { [name]: '1' } }),
      ).toThrow(AcpAgentValidationError);
    }
  });

  it('rejects relative command paths, bad ids and lowercase env names', () => {
    expect(() => validateAcpAgentInput({ label: 'x', command: './agent' })).toThrow(
      AcpAgentValidationError,
    );
    expect(() => validateAcpAgentInput({ label: 'x', command: 'a', id: 'Bad Id' })).toThrow(
      AcpAgentValidationError,
    );
    expect(() => validateAcpAgentInput({ label: 'x', command: 'a', env: { lower: '1' } })).toThrow(
      AcpAgentValidationError,
    );
    expect(() => validateAcpAgentInput({ label: '', command: 'a' })).toThrow(
      AcpAgentValidationError,
    );
  });

  it('slugifies labels into stable ids', () => {
    expect(slugifyAcpAgentId('  Claude Agent (ACP) v2 ')).toBe('claude-agent-acp-v2');
    expect(slugifyAcpAgentId('!!!')).toBe('agent');
  });

  it('projects a verdict onto the provider probe shape', () => {
    const probe = toAcpProbeConfig({
      ok: true,
      checkedAt: 5,
      durationMs: 9,
      models: ['m'],
      protocolVersion: 1,
      agentName: 'x',
    });
    expect(probe).toEqual({
      ok: true,
      checkedAt: 5,
      models: ['m'],
      protocolVersion: 1,
      agentName: 'x',
    });
  });

  it('builds a child env from the allowlist plus bound secrets only', () => {
    const env = buildAcpChildEnv(
      { MY_TOKEN: 'secret' },
      {
        PATH: '/bin',
        HOME: '/h',
        LC_ALL: 'C',
        OPENAI_API_KEY: 'leak',
        KORY_BRIDGE_AUTH_FILE: '/grant',
      },
    );
    expect(env.PATH).toBe('/bin');
    expect(env.LC_ALL).toBe('C');
    expect(env.MY_TOKEN).toBe('secret');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.KORY_BRIDGE_AUTH_FILE).toBeUndefined();
  });
});

describe('agent store', () => {
  const def = (id: string, overrides: Partial<AcpAgentDefinition> = {}): AcpAgentDefinition => ({
    id,
    label: id,
    command: '/opt/agent',
    args: ['acp'],
    envNames: ['MY_TOKEN'],
    cwdPolicy: 'workspace',
    permissionProfile: 'bridge-only',
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  it('keeps env values out of koryphaios.json and preserves other keys', () => {
    writeFileSync(join(root, 'koryphaios.json'), JSON.stringify({ theme: 'dark' }));
    saveAcpAgent(def('alpha'), { MY_TOKEN: 'super-secret-value' }, root);

    const config = readFileSync(join(root, 'koryphaios.json'), 'utf8');
    expect(config).not.toContain('super-secret-value');
    const parsed = JSON.parse(config);
    expect(parsed.theme).toBe('dark');
    expect(parsed.acpAgents.alpha.envNames).toEqual(['MY_TOKEN']);

    expect(loadAcpAgentEnv('alpha', root)).toEqual({ MY_TOKEN: 'super-secret-value' });
    expect(existsSync(join(root, '.koryphaios', 'acp-agent-env.json'))).toBe(true);
    expect(loadAcpAgentDefinitions(root).map((d) => d.id)).toEqual(['alpha']);
  });

  it('removes an agent with its definition, secrets and verdict', () => {
    saveAcpAgent(def('alpha'), { MY_TOKEN: 'v' }, root);
    saveAcpAgent(def('beta'), {}, root);
    removeAcpAgent('alpha', root);
    expect(loadAcpAgentDefinitions(root).map((d) => d.id)).toEqual(['beta']);
    expect(loadAcpAgentEnvSecrets(root)).toEqual({});
    expect(loadAcpProbeVerdicts(root)).toEqual({});
  });
});

describe('agent lifecycle service', () => {
  type Registration = { id: string; probed: boolean | undefined };
  const makeHost = () => {
    const registered: Registration[] = [];
    const removed: string[] = [];
    const host: AcpAgentHost = {
      registerAcpAgentProvider(def, verdict) {
        registered.push({ id: def.id, probed: verdict?.ok });
      },
      removeAcpAgentProvider(id) {
        removed.push(id);
      },
    };
    return { host, registered, removed };
  };

  it('adds an agent, probes it, stores the verdict and keeps env out of config', async () => {
    const { host, registered } = makeHost();
    const result = await addCustomAcpAgent(
      host,
      {
        label: 'Fake Agent',
        command: process.execPath,
        args: [scriptPath],
        env: { FAKE_ACP_STATE: join(root, 'state.json'), MY_TOKEN: 'do-not-persist' },
      },
      { root },
    );
    expect(result.status).toBe('ready');
    expect(result.providerName).toBe('acp:fake-agent');
    expect(result.probe?.models).toEqual(['fake-small', 'fake-large']);
    expect(registered).toEqual([{ id: 'fake-agent', probed: true }]);
    expect(readFileSync(join(root, 'koryphaios.json'), 'utf8')).not.toContain('do-not-persist');
    expect(loadAcpProbeVerdicts(root)['fake-agent']?.ok).toBe(true);
  });

  it('keeps an agent whose probe fails, marked probe-failed, so it can be fixed', async () => {
    const { host } = makeHost();
    const result = await addCustomAcpAgent(
      host,
      {
        label: 'Broken',
        command: process.execPath,
        args: [scriptPath],
        env: { FAKE_ACP_STATE: join(root, 'state.json'), FAKE_ACP_PROTOCOL: '9' },
      },
      { root },
    );
    expect(result.status).toBe('probe-failed');
    expect(result.probe?.error).toContain('protocol 9');
    expect(loadAcpAgentDefinitions(root).map((d) => d.id)).toEqual(['broken']);
  });

  it('skips the probe when asked and reports needs-probe', async () => {
    const { host } = makeHost();
    const result = await addCustomAcpAgent(
      host,
      { label: 'Later', command: '/opt/later', probe: false },
      { root },
    );
    expect(result.status).toBe('needs-probe');
    expect(result.probe).toBeUndefined();
    expect(loadAcpProbeVerdicts(root)['later']).toBeUndefined();
  });

  it('refuses a duplicate id', async () => {
    const { host } = makeHost();
    await addCustomAcpAgent(host, { label: 'Dup', command: '/opt/dup', probe: false }, { root });
    await expect(
      addCustomAcpAgent(host, { label: 'Dup', command: '/opt/dup', probe: false }, { root }),
    ).rejects.toBeInstanceOf(AcpAgentConflictError);
  });

  it('re-probes a registered agent and updates its verdict', async () => {
    const { host, registered } = makeHost();
    await addCustomAcpAgent(
      host,
      {
        label: 'Recheck',
        command: process.execPath,
        args: [scriptPath],
        env: { FAKE_ACP_STATE: join(root, 's.json'), FAKE_ACP_PROTOCOL: '9' },
        probe: false,
      },
      { root },
    );
    // Re-probe with the stored env: still protocol 9, so the verdict fails.
    const verdict = await probeCustomAcpAgent(host, 'recheck', { root });
    expect(verdict?.ok).toBe(false);
    expect(registered.at(-1)).toEqual({ id: 'recheck', probed: false });
    expect(await probeCustomAcpAgent(host, 'missing', { root })).toBeNull();
  });

  it('removes an agent from config and from the provider registry', async () => {
    const { host, removed } = makeHost();
    await addCustomAcpAgent(host, { label: 'Gone', command: '/opt/gone', probe: false }, { root });
    expect(removeCustomAcpAgent(host, 'gone', root)).toBe(true);
    expect(removed).toEqual(['gone']);
    expect(removeCustomAcpAgent(host, 'gone', root)).toBe(false);
  });

  it('lists custom, autodetected and registry entries with status, even when the registry is down', async () => {
    const { host } = makeHost();
    await addCustomAcpAgent(
      host,
      { label: 'Listed', command: '/opt/listed', registryId: 'agoragentic-acp', probe: false },
      { root },
    );
    const listing = await listAcpAgents({
      root,
      registryFetch: async () => ({
        ok: false,
        url: OFFICIAL_ACP_REGISTRY_URL,
        fetchedAt: 1,
        source: 'none',
        entries: [],
        error: 'registry fetch failed (network unavailable)',
      }),
    });
    expect(listing.registry.ok).toBe(false);
    const custom = listing.agents.find((a) => a.source === 'custom' && a.id === 'listed');
    expect(custom?.status).toBe('needs-probe');
    expect(custom?.providerName).toBe('acp:listed');
  });

  it('marks registry entries as added when a custom agent references them', async () => {
    const { host } = makeHost();
    await addCustomAcpAgent(
      host,
      { label: 'Linked', command: '/opt/linked', registryId: 'agoragentic-acp', probe: false },
      { root },
    );
    const registry = await fetchAcpRegistry({
      force: true,
      fetchImpl: async () => jsonResponse(REGISTRY_PAYLOAD),
    });
    expect(registry.ok).toBe(true);
    const listing = await listAcpAgents({
      root,
      registryFetch: async () => registry,
    });
    const entry = listing.agents.find((a) => a.source === 'registry' && a.id === 'agoragentic-acp');
    expect(entry?.status).toBe('added');
    expect(entry?.providerName).toBe('acp:linked');
    const notAdded = listing.agents.find((a) => a.source === 'registry' && a.id === 'uv-agent');
    expect(notAdded?.status).toBe('not-added');
  });
});
