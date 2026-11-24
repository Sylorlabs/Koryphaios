import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

/**
 * The server advertises the 2026-07-28 revision through `serveStdio` and must
 * still answer a pre-2026 client that only knows the legacy `initialize`
 * handshake. Both are driven here as a real stdio client against the real
 * executable entry point, because the negotiation outcome is decided on the
 * wire by the SDK transport, not by anything a unit-level fake can observe.
 */
const ENTRY = resolve(import.meta.dirname, '../../src/index.ts');

function bunBinary(): string {
  return execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
}

function connect(
  negotiation: unknown,
  env: Record<string, string> = {}
): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({
    command: bunBinary(),
    args: [ENTRY],
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: '/tmp', ...env },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'protocol-negotiation', version: '1.0.0' },
    { versionNegotiation: negotiation as never }
  );
  return { client, transport };
}

async function withClient<T>(
  negotiation: unknown,
  body: (client: Client) => Promise<T>,
  env: Record<string, string> = {}
): Promise<T> {
  const { client, transport } = connect(negotiation, env);
  await client.connect(transport);
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

describe('MCP protocol negotiation', () => {
  it('serves the 2026-07-28 revision to a modern client and the empty tool surface of the passive responder', async () => {
    const result = await withClient({ mode: 'auto' }, async client => ({
      negotiated: client.getNegotiatedProtocolVersion(),
      tools: (await client.listTools()).tools.length,
      prompts: (await client.listPrompts()).prompts.length,
      resources: (await client.listResources()).resources.length,
    }));
    expect(result).toEqual({ negotiated: '2026-07-28', tools: 0, prompts: 0, resources: 0 });
  }, 60_000);

  it('still answers a legacy client that performs the pre-2026 initialize handshake', async () => {
    const negotiated = await withClient({ mode: 'legacy' }, async client => {
      expect((await client.listTools()).tools).toEqual([]);
      return client.getNegotiatedProtocolVersion();
    });
    expect(negotiated).toBe('2025-11-25');
  }, 60_000);

  it('pins the modern revision without falling back', async () => {
    const negotiated = await withClient({ mode: { pin: '2026-07-28' } }, async client =>
      client.getNegotiatedProtocolVersion()
    );
    expect(negotiated).toBe('2026-07-28');
  }, 60_000);

  it('registers the full tool surface when Koryphaios is active and rejects an unknown tool as invalid params', async () => {
    const result = await withClient(
      { mode: 'auto' },
      async client => {
        const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
        const detection = await client.callTool({
          name: 'detect-errors',
          arguments: { source: 'console' },
        });
        let rejection: { code?: number; message?: string } = {};
        try {
          await client.callTool({ name: 'kory__does_not_exist', arguments: {} });
        } catch (error) {
          rejection = error as { code?: number; message?: string };
        }
        return {
          negotiated: client.getNegotiatedProtocolVersion(),
          tools,
          detectionBlocks: detection.content.length,
          rejection,
        };
      },
      { KORYPHAIOS_ACTIVE: '1' }
    );
    expect(result.negotiated).toBe('2026-07-28');
    expect(result.tools).toEqual([
      'analyze-error',
      'clear_logs',
      'click',
      'detect-errors',
      'evaluate',
      'fill',
      'get_logs',
      'navigate',
      'screenshot',
    ]);
    expect(result.detectionBlocks).toBeGreaterThan(0);
    expect(result.rejection.code).toBe(-32602);
    expect(result.rejection.message).toContain('Tool kory__does_not_exist not found');
  }, 120_000);
});
