import { describe, expect, test } from 'bun:test';

import { MCPClient } from './client';

interface TestProcessHandle {
  kill(): void;
}

interface TestableMCPClient {
  process?: TestProcessHandle;
  connected: boolean;
  buffer: string;
  bufferBytes: number;
  maxStdoutFrameBytes: number;
  pending: Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >;
  acceptStdoutText(processHandle: TestProcessHandle, text: string): void;
}

function testable(client: MCPClient): TestableMCPClient {
  return client as unknown as TestableMCPClient;
}

function fakeProcess(): TestProcessHandle & { kills: number } {
  return {
    kills: 0,
    kill() {
      this.kills += 1;
    },
  };
}

const EXITING_MCP_SERVER = String.raw`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { capabilities: {} },
      }) + '\n');
      continue;
    }
    if (request.method === 'tools/call') process.exit(17);
  }
});
setInterval(() => {}, 1_000).unref();
`;

const HANGING_MCP_SERVER = String.raw`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { capabilities: {} },
      }) + '\n');
    }
  }
});
setInterval(() => {}, 1_000);
`;

function subprocessClient(name: string, source: string): MCPClient {
  return new MCPClient({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: ['--no-env-file', '-e', source],
    env: { NODE_ENV: 'test' },
  });
}

describe('MCP stdio framing and lifecycle', () => {
  test('reassembles a response split across stdout chunks', async () => {
    const client = new MCPClient({ name: 'split-fixture', transport: 'stdio' });
    const internals = testable(client);
    const processHandle = fakeProcess();
    internals.process = processHandle;

    const response = new Promise<unknown>((resolve, reject) => {
      internals.pending.set(7, { resolve, reject });
    });
    internals.acceptStdoutText(processHandle, '{"jsonrpc":"2.0","id":');

    expect(internals.pending.has(7)).toBe(true);
    expect(internals.bufferBytes).toBeGreaterThan(0);

    internals.acceptStdoutText(processHandle, '7,"result":{"ok":true}}\n');

    expect(await response).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    expect(internals.pending.size).toBe(0);
    expect(internals.buffer).toBe('');
    expect(internals.bufferBytes).toBe(0);
    expect(processHandle.kills).toBe(0);
  });

  test('terminates and rejects pending work on newline-free frame overflow', async () => {
    const client = new MCPClient({ name: 'incomplete-overflow', transport: 'stdio' });
    const internals = testable(client);
    const processHandle = fakeProcess();
    internals.process = processHandle;
    internals.connected = true;
    internals.maxStdoutFrameBytes = 64;

    const rejection = new Promise<Error>((resolve) => {
      internals.pending.set(1, { resolve: () => {}, reject: resolve });
    });
    internals.acceptStdoutText(processHandle, 'x'.repeat(65));

    expect((await rejection).message).toBe('MCP stdout frame exceeded the supported size');
    expect(processHandle.kills).toBe(1);
    expect(internals.process).toBeUndefined();
    expect(internals.connected).toBe(false);
    expect(internals.pending.size).toBe(0);

    internals.acceptStdoutText(
      processHandle,
      '{"jsonrpc":"2.0","id":1,"result":{"ignored":false}}\n',
    );
    expect(processHandle.kills).toBe(1);
  });

  test('rejects an oversized completed line before parsing it', async () => {
    const client = new MCPClient({ name: 'completed-overflow', transport: 'stdio' });
    const internals = testable(client);
    const processHandle = fakeProcess();
    internals.process = processHandle;
    internals.maxStdoutFrameBytes = 96;

    const rejection = new Promise<Error>((resolve) => {
      internals.pending.set(2, { resolve: () => {}, reject: resolve });
    });
    internals.acceptStdoutText(
      processHandle,
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'x'.repeat(128) })}\n`,
    );

    expect((await rejection).message).toBe('MCP stdout frame exceeded the supported size');
    expect(processHandle.kills).toBe(1);
    expect(internals.pending.size).toBe(0);
  });

  test('rejects a pending tool call immediately when the child exits', async () => {
    const client = subprocessClient('exit-fixture', EXITING_MCP_SERVER);
    await client.connect();
    const startedAt = performance.now();

    await expect(client.callTool('fixture', {})).rejects.toThrow(
      'MCP process exited before the request completed',
    );

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(client.isConnected).toBe(false);
    expect(testable(client).pending.size).toBe(0);
  }, 5_000);

  test('shutdown rejects pending work instead of silently clearing it', async () => {
    const client = subprocessClient('shutdown-fixture', HANGING_MCP_SERVER);
    await client.connect();
    const pending = client.callTool('fixture', {});
    await Bun.sleep(20);
    await client.shutdown();

    await expect(pending).rejects.toThrow('MCP client shut down before the request completed');
    expect(testable(client).pending.size).toBe(0);
    expect(client.isConnected).toBe(false);
  }, 5_000);
});
