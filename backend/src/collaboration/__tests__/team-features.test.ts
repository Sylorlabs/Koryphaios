import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { serverLog } from '../../logger';
import { DEFAULT_COLLABORATION_POLICY } from '@koryphaios/shared';
import { BashTool } from '../../tools/bash';
import { clearCollaborationToolPolicy, setCollaborationToolPolicy } from '../tool-policy';
import { canBindLoopback } from '../../__tests__/runtime-capabilities';
import type { StreamRequest } from '../../providers/types';

const port = 18_181;
const relayUrl = `http://127.0.0.1:${port}`;
const hostSecret = 'team-feature-host-secret';
let relay: ReturnType<typeof Bun.spawn>;
const LOOPBACK_AVAILABLE = canBindLoopback();

async function waitForRelay() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${relayUrl}/health`)).ok) return;
    } catch (err: unknown) {
      // Relay hasn't started yet; retry on next polling tick.
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Relay not yet up; retrying',
      );
    }
    await Bun.sleep(25);
  }
  throw new Error('Test relay did not start');
}

function nextMessage(
  ws: WebSocket,
  type: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type !== type) return;
      clearTimeout(timeout);
      ws.removeEventListener('message', listener);
      resolveMessage(message);
    };
    ws.addEventListener('message', listener);
  });
}

beforeAll(async () => {
  if (!LOOPBACK_AVAILABLE) return;
  relay = Bun.spawn(['bun', 'run', resolve(import.meta.dir, '../../../../relay/server.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST_SECRET: hostSecret,
      JWT_SECRET: 'team-feature-jwt-secret',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await waitForRelay();
});

afterAll(() => relay?.kill());

describe.skipIf(!LOOPBACK_AVAILABLE)('team collaboration boundaries', () => {
  test('joins expose host-selected folder names without host filesystem paths', async () => {
    const { RelayClient } = await import('../relay-client');
    const host = new RelayClient({ relayUrl, hostSecret });
    try {
      const created = await host.startSession('host-folder-metadata');
      await host.updatePolicy({
        ...structuredClone(DEFAULT_COLLABORATION_POLICY),
        hostName: 'Micah', workspacePaths: ['/Users/private-host/projects/koryphaios', 'C:\\Users\\private-host\\docs'],
        joinMode: 'auto',
      });
      const resolved = await host.resolveJoinCode(created.joinCode);
      expect(resolved.hostName).toBe('Micah');
      expect(resolved.sharedFolders).toEqual([
        { id: 'workspace-1', name: 'koryphaios' }, { id: 'workspace-2', name: 'docs' },
      ]);
      expect(JSON.stringify(resolved)).not.toContain('private-host');
      const { RelayGuestClient } = await import('../relay-guest-client');
      const previousUrl = process.env.RELAY_URL;
      process.env.RELAY_URL = relayUrl;
      try {
        await expect(new RelayGuestClient().connect(created.joinCode, 'Guest', true)).rejects.toMatchObject({
          code: 'WRONG_SHARING_CODE', statusCode: 400,
        });
      } finally {
        if (previousUrl === undefined) delete process.env.RELAY_URL;
        else process.env.RELAY_URL = previousUrl;
      }
    } finally {
      await host.endSession();
    }
  });

  test('model-only guests cannot receive history, folders, participant details or session updates', async () => {
    const { RelayClient } = await import('../relay-client');
    const host = new RelayClient({ relayUrl, hostSecret });
    let guest: WebSocket | undefined;
    try {
      await host.startSession('model-only-session-boundary');
      const policy = structuredClone(DEFAULT_COLLABORATION_POLICY);
      policy.accessTiers.find((tier) => tier.id === 'models')!.permissions.viewChat = true;
      await host.updatePolicy({ ...policy, hostName: 'Micah', joinMode: 'auto', workspacePaths: ['/private/top-secret-project'] });
      host.broadcast({ type: 'chat', from: 'agent', content: 'private session history' });
      await Bun.sleep(30);
      const inviteUrl = await host.createInvite('models');
      const token = new URL(inviteUrl).searchParams.get('token');
      guest = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token!)}&name=ModelsGuest`);
      const frames: Record<string, any>[] = [];
      guest.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
      const init = await nextMessage(guest, 'init');
      expect(init.history).toEqual([]);
      expect(init.participants).toEqual({});
      expect((init.policy as any).sharedFolders).toEqual([]);
      expect((init.tier as any).permissions.viewChat).toBe(false);
      expect(JSON.stringify(init)).not.toContain('top-secret-project');
      host.broadcast({ type: 'chat', content: 'another private message' });
      host.broadcast({ type: 'log', content: 'password=never-visible' });
      await host.updatePolicy({ ...policy, hostName: 'Renamed host', workspacePaths: ['/private/another-secret'], joinMode: 'auto' });
      await Bun.sleep(50);
      expect(frames.some((frame) => frame.type === 'chat' || frame.type === 'log')).toBe(false);
      expect(JSON.stringify(frames)).not.toContain('another-secret');
    } finally {
      guest?.close();
      await host.endSession();
    }
  });

  test('model codes register host-named models, serve inference without credentials, and revoke on stop', async () => {
    const { setContext } = await import('../../context');
    const { setSharedProviders } = await import('../remote-provider-host');
    const { startModelSharing, stopModelSharing, modelSharingStatus } = await import('../model-sharing');
    const { RelayGuestClient } = await import('../relay-guest-client');
    const { connectToProviderHost, disconnectFromProviderHost } = await import('../remote-provider-client');
    const registered: any[] = [];
    const providerRequests: StreamRequest[] = [];
    let cancelledOnHost = false;
    const previousUrl = process.env.RELAY_URL;
    const previousSecret = process.env.RELAY_HOST_SECRET;
    process.env.RELAY_URL = relayUrl;
    process.env.RELAY_HOST_SECRET = hostSecret;
    const credential = 'host-private-provider-api-key-abcdefgh';
    setContext({ providers: {
      getStatus: () => [{ name: 'openai', enabled: true, adapterAvailable: true, models: ['test-model'],
        apiKey: credential, authToken: 'host-login-secret',
        allAvailableModels: [{ id: 'test-model', name: 'Test model', apiKey: credential }],
      }],
      getConfigs: () => ({ openai: { apiKey: credential } }),
      clearRemoteProviders: () => { registered.length = 0; },
      registerRemoteProvider: (provider: any) => registered.push(provider),
      executeWithRetry: async function* (request: StreamRequest) {
        providerRequests.push(request);
        if (request.systemPrompt === 'wait-for-cancel') {
          yield { type: 'content_delta', content: 'Streaming response. '.repeat(100) };
          await new Promise<void>((resolveCancelled) => {
            const cancelled = () => { cancelledOnHost = true; resolveCancelled(); };
            if (request.signal?.aborted) cancelled();
            else request.signal?.addEventListener('abort', cancelled, { once: true });
          });
          return;
        }
        yield { type: 'content_delta', content: `Answer ${credential.slice(0, 12)}` };
        yield { type: 'content_delta', content: credential.slice(12), apiKey: credential };
        yield { type: 'complete', accountId: 'private-host-account' };
      },
    } } as never);
    setSharedProviders(['openai'], { openai: ['test-model'] });
    const guest = new RelayGuestClient();
    try {
      const sharing = await startModelSharing('Micah');
      expect(sharing.joinCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(modelSharingStatus().joinCode).toBe(sharing.joinCode);
      const connection = await connectToProviderHost(sharing.joinCode.toLowerCase(), 'Recipient');
      expect(connection.hostName).toBe('Micah');
      expect(registered[0]?.config.label).toBe('Micah · openai');
      expect(registered[0]?.listModels()[0]?.id).toBe('test-model');
      expect(JSON.stringify(registered[0]?.config)).not.toContain(credential);
      const renamed = await startModelSharing('Study group');
      expect(renamed.joinCode).toBe(sharing.joinCode);
      for (let attempt = 0; attempt < 100 && registered[0]?.config.label !== 'Study group · openai'; attempt++) await Bun.sleep(10);
      expect(registered[0]?.config.label).toBe('Study group · openai');
      disconnectFromProviderHost();
      expect(modelSharingStatus().active).toBe(true);
      const catalogReady = new Promise<any>((resolveCatalog) => guest.onCatalog(resolveCatalog));
      await guest.connect(sharing.joinCode, 'Guest');
      const catalog = await catalogReady;
      expect(catalog.hostName).toBe('Study group');
      expect(JSON.stringify(catalog)).not.toContain(credential);
      expect(JSON.stringify(catalog)).not.toContain('host-login-secret');
      const events = [];
      for await (const event of guest.requestInference({ provider: 'openai', model: 'test-model', messages: [], systemPrompt: '' })) events.push(event);
      expect(events.map((event) => event.content || '').join('')).toBe('Answer [redacted]');
      expect(JSON.stringify(events)).not.toContain(credential);
      expect(JSON.stringify(events)).not.toContain('private-host-account');

      for await (const event of guest.requestInference({ provider: 'openai', model: 'test-model', messages: [], systemPrompt: 'wait-for-cancel' })) {
        expect(event.type).toBe('content_delta');
        break;
      }
      for (let attempt = 0; attempt < 100 && !cancelledOnHost; attempt++) await Bun.sleep(10);
      expect(cancelledOnHost).toBe(true);
      const requestCount = providerRequests.length;
      const aborted = new AbortController();
      aborted.abort();
      await expect(guest.requestInference({ provider: 'openai', model: 'test-model', messages: [] }, aborted.signal).next()).rejects.toThrow('Cancelled');
      await Bun.sleep(10);
      expect(providerRequests).toHaveLength(requestCount);
      await stopModelSharing();
      expect(modelSharingStatus().active).toBe(false);
      expect(modelSharingStatus().joinCode).toBeNull();
      expect((await fetch(`${relayUrl}/code/${sharing.joinCode}`)).status).toBe(404);
      const token = new URL(sharing.inviteUrl).searchParams.get('token');
      const stale = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token!)}`);
      const denied = await new Promise<number>((resolveClose) => stale.addEventListener('close', (event) => resolveClose(event.code)));
      expect(denied).not.toBe(1000);

      // Concurrent settings requests retain their order: stop revokes the
      // first code and a later start creates a new, correctly named session.
      const [first, , latest] = await Promise.all([
        startModelSharing('First host'),
        stopModelSharing(),
        startModelSharing('Latest host'),
      ]);
      expect((await fetch(`${relayUrl}/code/${first.joinCode}`)).status).toBe(404);
      expect((await fetch(`${relayUrl}/code/${latest.joinCode}`)).status).toBe(200);
      expect(latest.joinCode).not.toBe(first.joinCode);
      expect(modelSharingStatus()).toMatchObject({ active: true, hostName: 'Latest host', joinCode: latest.joinCode });
    } finally {
      guest.disconnect();
      disconnectFromProviderHost();
      await stopModelSharing();
      setSharedProviders([]);
      if (previousUrl === undefined) delete process.env.RELAY_URL;
      else process.env.RELAY_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.RELAY_HOST_SECRET;
      else process.env.RELAY_HOST_SECRET = previousSecret;
    }
  });

  test('public join-code resolution never requires or exposes the host secret', async () => {
    const createdResponse = await fetch(`${relayUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-secret': hostSecret },
      body: JSON.stringify({ sessionId: 'public-code-separation' }),
    });
    const created = (await createdResponse.json()) as { joinCode: string; sessionId: string };

    const publicResponse = await fetch(`${relayUrl}/code/${created.joinCode}`);
    const publicJoin = (await publicResponse.json()) as Record<string, unknown>;
    expect(publicResponse.status).toBe(200);
    expect(publicJoin.ok).toBe(true);
    expect(publicJoin.sessionId).toBe(created.sessionId);
    expect(JSON.stringify(publicJoin)).not.toContain(hostSecret);

    const unauthorizedPolicy = await fetch(`${relayUrl}/session/${created.sessionId}/policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ joinMode: 'auto' }),
    });
    expect(unauthorizedPolicy.status).toBe(401);
  });

  test('relay enforces the host access profile on guest prompts', async () => {
    const created = (await fetch(`${relayUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-secret': hostSecret },
      body: JSON.stringify({ sessionId: 'profile-enforcement' }),
    }).then((response) => response.json())) as {
      sessionToken: string;
      joinCode: string;
      sessionId: string;
    };

    const tier = structuredClone(DEFAULT_COLLABORATION_POLICY.accessTiers[1]!);
    tier.id = 'reviewer';
    tier.name = 'Reviewer';
    tier.allowedModels = ['openai:gpt-5'];
    tier.reasoningByModel = { 'openai:gpt-5': ['high'] };
    tier.permissions.commandAllowlist = ['git', 'bun'];
    tier.permissions.commandBlocklist = ['git push'];

    await fetch(`${relayUrl}/session/${created.sessionId}/policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-secret': hostSecret },
      body: JSON.stringify({
        ...structuredClone(DEFAULT_COLLABORATION_POLICY),
        sessionName: 'Review Room',
        joinMode: 'auto',
        defaultTierId: 'reviewer',
        accessTiers: [tier],
      }),
    });

    const resolved = (await fetch(`${relayUrl}/code/${created.joinCode}`).then((response) =>
      response.json(),
    )) as { inviteUrl: string };
    const guestToken = new URL(resolved.inviteUrl).searchParams.get('token');
    const host = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(created.sessionToken)}`,
    );
    const guest = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(guestToken!)}&name=Reviewer`,
    );

    const init = await nextMessage(guest, 'init');
    expect(init.sessionName).toBe('Review Room');
    expect((init.tier as { id: string }).id).toBe('reviewer');

    const forwardedPromise = nextMessage(host, 'guest-prompt');
    guest.send(
      JSON.stringify({
        type: 'guest-prompt',
        content: 'Review the patch',
        model: 'openai:gpt-5',
        reasoningLevel: 'high',
      }),
    );
    const forwarded = await forwardedPromise;
    expect(forwarded.model).toBe('openai:gpt-5');
    expect(forwarded.reasoningLevel).toBe('high');
    expect(forwarded.commandAllowlist).toEqual(['git', 'bun']);
    expect(forwarded.commandBlocklist).toEqual(['git push']);

    const filteredPromise = nextMessage(host, 'guest-prompt');
    guest.send(
      JSON.stringify({
        type: 'guest-prompt',
        content: 'Use a forbidden model',
        model: 'anthropic:claude-opus',
        reasoningLevel: 'max',
      }),
    );
    const filtered = await filteredPromise;
    expect(filtered.model).toBe('');
    expect(filtered.reasoningLevel).toBe('');

    guest.close();
    host.close();
  });

  test('team command blocklist wins over allowlist', async () => {
    const sessionId = 'team-policy-precedence';
    const bash = new BashTool();
    // This test isolates collaboration-policy precedence. Kernel sandbox
    // availability is covered separately and correctly fails closed when the
    // host cannot enforce it.
    const context = { sessionId, workingDirectory: process.cwd(), isSandboxed: false };

    setCollaborationToolPolicy(sessionId, {
      commandAllowlist: ['echo'],
      commandBlocklist: ['echo'],
    });
    const blocked = await bash.run(context, {
      id: 'blocked',
      name: 'bash',
      input: { command: 'echo should-not-run' },
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain('team access policy');

    setCollaborationToolPolicy(sessionId, {
      commandAllowlist: ['pwd'],
      commandBlocklist: [],
    });
    const allowed = await bash.run(context, {
      id: 'allowed',
      name: 'bash',
      input: { command: 'pwd' },
    });
    expect(allowed.isError).toBe(false);
    clearCollaborationToolPolicy(sessionId);
  });

  test('relay limits repeated code guessing', async () => {
    let last: Response | undefined;
    for (let attempt = 0; attempt < 21; attempt++)
      last = await fetch(`${relayUrl}/code/XXXXXXXX`);
    expect(last?.status).toBe(429);
    expect(await last?.json()).toMatchObject({ ok: false, error: expect.stringContaining('Too many code attempts') });
  });
});
