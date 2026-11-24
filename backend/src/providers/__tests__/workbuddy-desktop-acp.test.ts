import { afterEach, describe, expect, test } from 'bun:test';
import { WorkBuddyDesktopAcpClient } from '../workbuddy-desktop-acp';

function sseFrame(message: unknown): Response {
  return new Response(`data: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function connectedClient(): WorkBuddyDesktopAcpClient {
  const client = new WorkBuddyDesktopAcpClient('http://127.0.0.1:9/api/v1/acp');
  // The transport state a completed connect() would have left behind.
  (client as unknown as { connectionId: string }).connectionId = 'conn-test';
  return client;
}

const realFetch = globalThis.fetch;

function stubFetch(fn: typeof globalThis.fetch) {
  globalThis.fetch = fn;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const SERVER = {
  type: 'stdio' as const,
  name: 'kory',
  command: '/usr/bin/true',
  args: ['bridge'],
  env: [{ name: 'KORY_TOKEN', value: 'secret' }],
};

describe('WorkBuddy Desktop ACP session/new', () => {
  test('retries without the stdio type discriminator when the runtime rejects it', async () => {
    const sent: Array<{ params: Record<string, unknown> }> = [];
    stubFetch(async (_url: any, init: any) => {
      const body = JSON.parse(init.body) as {
        id: number;
        params: { mcpServers?: Array<Record<string, unknown>> };
      };
      sent.push({ params: body.params });
      const first = body.params.mcpServers?.[0];
      if (first && 'type' in first) {
        return sseFrame({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32602, message: 'Invalid params' },
        });
      }
      return sseFrame({ jsonrpc: '2.0', id: body.id, result: { sessionId: 'session-1' } });
    });

    const client = connectedClient();
    const result = await client.sessionNew({
      cwd: '/tmp/project',
      mcpServers: [SERVER],
    });

    expect(result.sessionId).toBe('session-1');
    expect(sent).toHaveLength(2);
    expect(sent[0].params.mcpServers).toEqual([SERVER]);
    // The fallback keeps the server and its env, only dropping `type`.
    expect(sent[1].params.mcpServers).toEqual([
      { name: 'kory', command: '/usr/bin/true', args: ['bridge'], env: SERVER.env },
    ]);
  });

  test('always sends the required mcpServers key, even with no servers', async () => {
    const sent: Array<Record<string, unknown>> = [];
    stubFetch(async (_url: any, init: any) => {
      const body = JSON.parse(init.body) as {
        id: number;
        params: Record<string, unknown>;
      };
      sent.push(body.params);
      // Measured runtime behaviour: the key is required, its contents are not.
      if (!('mcpServers' in body.params)) {
        return sseFrame({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32602, message: 'Invalid params' },
        });
      }
      return sseFrame({ jsonrpc: '2.0', id: body.id, result: { sessionId: 'session-2' } });
    });

    const client = connectedClient();
    const result = await client.sessionNew({ cwd: '/tmp/project' });

    expect(result.sessionId).toBe('session-2');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ cwd: '/tmp/project', mcpServers: [] });
  });

  test('still refuses to open a session when the minimal payload is rejected', async () => {
    stubFetch(async (_url: any, init: any) => {
      const body = JSON.parse(init.body) as { id: number };
      return sseFrame({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32602, message: 'Invalid params' },
      });
    });

    const client = connectedClient();
    await expect(client.sessionNew({ cwd: '/tmp/project', mcpServers: [SERVER] })).rejects.toThrow(
      /Invalid params/,
    );
  });

  test('does not downgrade a non-params failure', async () => {
    let calls = 0;
    stubFetch(async (_url: any, init: any) => {
      calls += 1;
      const body = JSON.parse(init.body) as { id: number };
      return sseFrame({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32000, message: 'Unauthorized' },
      });
    });

    const client = connectedClient();
    await expect(client.sessionNew({ cwd: '/tmp/project', mcpServers: [SERVER] })).rejects.toThrow(
      /Unauthorized/,
    );
    expect(calls).toBe(1);
  });
});
