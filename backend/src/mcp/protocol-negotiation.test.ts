import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NOTE_TOOL_PERMISSIONS } from '@koryphaios/shared';
import { handleMcpRequest } from './koryphaios-mcp-endpoint';
import { setContext } from '../context';
import { saveNotesAgentPermissions } from '../notes/notes-settings';

// Minimal context stub so exposedToolDefs() can read kory.tools without a full
// bootstrap. Including the work-note tool proves the public knowledge MCP
// endpoint does not silently omit this Kory-native capability.
setContext({
  kory: {
    tools: {
      getAll: () => [
        {
          name: 'record_work_note',
          description: 'Record a structured work note',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              summary: { type: 'string' },
              status: {
                type: 'string',
                enum: ['completed', 'partial', 'blocked', 'decision'],
              },
            },
            required: ['title', 'summary', 'status'],
          },
        },
      ],
      execute: async () => ({ output: '', isError: false }),
    },
  },
} as never);

// Unit tests for the 2026-07-28 protocol negotiation in the Koryphaios MCP
// server endpoint. These test handleMcpRequest directly (no HTTP layer) so
// they don't need auth or a running server.

describe('MCP endpoint protocol negotiation (2026-07-28)', () => {
  test('server/discover returns supportedVersions (modern only) + serverInfo in _meta', async () => {
    const result = (await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {},
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
      '/tmp',
    )) as {
      result: {
        supportedVersions: string[];
        capabilities: unknown;
        serverInfo?: unknown;
        _meta?: { 'io.modelcontextprotocol/serverInfo'?: unknown };
        resultType: string;
      };
    };

    // 2026-07-28 spec: field is `supportedVersions`, NOT `protocolVersions`
    expect(result.result.supportedVersions).toContain('2026-07-28');
    // Only modern versions are listed — 2025-era versions go via initialize
    expect(result.result.supportedVersions).not.toContain('2024-11-05');
    expect(result.result.supportedVersions).not.toContain('2025-11-25');
    expect(result.result.capabilities).toEqual({ tools: {} });
    // serverInfo is NOT top-level on discover — it's in _meta (spec PR #3002)
    expect(result.result.serverInfo).toBeUndefined();
    expect(result.result._meta?.['io.modelcontextprotocol/serverInfo']).toEqual({
      name: 'koryphaios',
      version: expect.any(String),
    });
    expect(result.result.resultType).toBe('complete');
  });

  test('server/discover without _meta does not stamp serverInfo in _meta', async () => {
    const result = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
      '/tmp',
    )) as { result: { _meta?: unknown; supportedVersions: string[] } };

    // Legacy client (no _meta) — serverInfo not stamped
    expect(result.result._meta).toBeUndefined();
    expect(result.result.supportedVersions).toContain('2026-07-28');
  });

  test('tools/list result includes ttlMs and cacheScope (2026-07-28 CacheableResult)', async () => {
    // handleMcpRequest calls exposedToolDefs() which reads getContext().kory.tools.
    // In test without bootstrap, the context may be empty — the tools list will
    // be empty but the result shape should still carry ttlMs/cacheScope.
    const result = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      '/tmp',
    )) as { result: { tools: unknown[]; ttlMs: number; cacheScope: string; resultType: string } };

    expect(result.result.ttlMs).toBeGreaterThan(0);
    expect(result.result.cacheScope).toBe('private');
    expect(result.result.resultType).toBe('complete');
  });

  test('tools/list exposes the structured work-note capability', async () => {
    const result = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} },
      '/tmp',
    )) as {
      result: {
        tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
      };
    };

    expect(result.result.tools).toContainEqual(
      expect.objectContaining({
        name: 'record_work_note',
        inputSchema: expect.objectContaining({ required: ['title', 'summary', 'status'] }),
      }),
    );
  });

  test('work-note writes fail closed when this stateless endpoint cannot ask for approval', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'kory-mcp-work-note-approval-'));
    try {
      const result = (await handleMcpRequest(
        {
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: {
            name: 'record_work_note',
            arguments: { title: 'Result', summary: 'Evidence', status: 'completed' },
          },
        },
        projectRoot,
      )) as { result: { isError: boolean; content: Array<{ text: string }> } };

      expect(result.result.isError).toBe(true);
      expect(result.result.content[0]?.text).toContain('has no approval channel');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('tools/list omits work-note recording when Notes permissions block it', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'kory-mcp-work-note-block-'));
    try {
      saveNotesAgentPermissions(projectRoot, {
        preset: 'custom',
        tools: { ...DEFAULT_NOTE_TOOL_PERMISSIONS, record_work_note: 'block' },
      });
      const result = (await handleMcpRequest(
        { jsonrpc: '2.0', id: 13, method: 'tools/list', params: {} },
        projectRoot,
      )) as { result: { tools: Array<{ name: string }> } };

      expect(result.result.tools.map((tool) => tool.name)).not.toContain('record_work_note');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('tools/list for modern client stamps serverInfo in _meta', async () => {
    const result = (await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/list',
        params: {},
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
      '/tmp',
    )) as {
      result: { _meta?: { 'io.modelcontextprotocol/serverInfo'?: unknown } };
    };

    expect(result.result._meta?.['io.modelcontextprotocol/serverInfo']).toEqual({
      name: 'koryphaios',
      version: expect.any(String),
    });
  });

  test('legacy initialize still works for backward compat', async () => {
    const result = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 3, method: 'initialize', params: {} },
      '/tmp',
    )) as {
      result: {
        protocolVersion: string;
        capabilities: unknown;
        serverInfo: unknown;
        resultType: string;
      };
    };

    // Without _meta, defaults to the required 2025-11-25 fallback.
    expect(result.result.protocolVersion).toBe('2025-11-25');
    expect(result.result.capabilities).toEqual({ tools: {} });
    expect(result.result.resultType).toBe('complete');
  });

  test('initialize with 2026-07-28 in _meta negotiates to 2026-07-28', async () => {
    const result = (await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: {},
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
      '/tmp',
    )) as { result: { protocolVersion: string } };

    expect(result.result.protocolVersion).toBe('2026-07-28');
  });

  test('initialize with unsupported version falls back to legacy', async () => {
    const result = (await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'initialize',
        params: {},
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' },
      },
      '/tmp',
    )) as { result: { protocolVersion: string } };

    expect(result.result.protocolVersion).toBe('2025-11-25');
  });

  test('notifications/initialized returns null (no reply)', async () => {
    const result = await handleMcpRequest(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      '/tmp',
    );
    expect(result).toBeNull();
  });

  test('unknown method returns -32601 method-not-found', async () => {
    const result = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 6, method: 'resources/subscribe', params: {} },
      '/tmp',
    )) as { error: { code: number; message: string } };

    expect(result.error.code).toBe(-32601);
    expect(result.error.message).toContain('Method not found');
  });

  test('tools/call with unknown tool returns -32602', async () => {
    const result = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nonexistent_tool' } },
      '/tmp',
    )) as { error: { code: number } };

    expect(result.error.code).toBe(-32602);
  });

  test('all results carry resultType: complete', async () => {
    // server/discover (modern client)
    const discover = (await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'server/discover',
        params: {},
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
      '/tmp',
    )) as { result: { resultType: string } };
    expect(discover.result.resultType).toBe('complete');

    // initialize (legacy client)
    const init = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 9, method: 'initialize', params: {} },
      '/tmp',
    )) as { result: { resultType: string } };
    expect(init.result.resultType).toBe('complete');
  });
});
