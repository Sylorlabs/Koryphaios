import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { DEFAULT_COLLABORATION_POLICY } from '@koryphaios/shared';
import { BashTool } from '../../tools/bash';
import { clearCollaborationToolPolicy, setCollaborationToolPolicy } from '../tool-policy';

const port = 18_181;
const relayUrl = `http://127.0.0.1:${port}`;
const hostSecret = 'team-feature-host-secret';
let relay: ReturnType<typeof Bun.spawn>;

async function waitForRelay() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${relayUrl}/health`)).ok) return;
    } catch {
      // Starting.
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

describe('team collaboration boundaries', () => {
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
    const context = { sessionId, workingDirectory: process.cwd(), isSandboxed: true };

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
});
