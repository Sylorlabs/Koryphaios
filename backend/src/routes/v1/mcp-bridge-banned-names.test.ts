import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { initTools } from '../../bootstrap';
import { setContext } from '../../context';
import { BANNED_NAME_REASON } from '../../security/banned-names';
import type { ToolCallInput, ToolContext } from '../../tools/registry';
import { mcpBridgeRoutes } from './mcp-bridge';

/**
 * The real CLI-agent door. A `kory__write_file` call from a signed bridge goes
 * through this route into the real ToolRegistry and the real executeTool
 * pipeline. This test proves the bouncer holds there: the call is refused, no
 * file exists, and the refusal text is exactly the banned-name reason — not a
 * permission-policy or sandbox error that happens to fire first.
 */
describe('MCP bridge /execute refuses the banned name at the door', () => {
  const sessionId = 'mcp-banned-name-session';
  const authorization = buildLocalBearerToken(
    localAuth.createSession([`mcp:${sessionId}:manager`]),
  );
  const workspace = mkdtempSync(join(tmpdir(), 'kory-bridge-banned-'));

  const app = new Elysia()
    .onError(({ error, set }) => {
      const operational = error as { statusCode?: number; code?: string; message?: string };
      set.status = operational.statusCode ?? 500;
      return {
        ok: false,
        code: operational.code ?? 'INTERNAL_ERROR',
        error: operational.message ?? String(error),
      };
    })
    .use(mcpBridgeRoutes);

  const execute = (toolName: string, input: Record<string, unknown>) =>
    app.handle(
      new Request('http://localhost/api/v1/mcp-bridge/execute', {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, toolName, input, role: 'manager' }),
      }),
    );

  test('kory__write_file to "Native Settings/index.html" is refused over HTTP', async () => {
    mkdirSync(workspace, { recursive: true });
    setContext({
      tools: {
        getToolDefsForRole: async () => [],
        isAllowedForRole: async () => true,
        execute: async (ctx: ToolContext, call: ToolCallInput) => {
          const registry = await initTools({} as never);
          return registry.execute(ctx, call);
        },
      },
      sessions: {
        get: async (id: string) =>
          id === sessionId ? { id, workingDirectory: workspace } : undefined,
        getActive: async (id: string) =>
          id === sessionId ? { id, workingDirectory: workspace } : undefined,
      },
      goals: { list: async () => [] },
      kory: {
        resolveSessionWorkingDirectoryPublic: async () => workspace,
        requestToolApproval: async () => 'Allow',
        hasActiveSessionExecution: () => true,
        tryAcquireSessionMutationBarrier: () => null,
        isWorkspaceRebindPending: () => false,
        markWorkspaceMutatedThisTurn: () => undefined,
      },
    } as never);

    const response = await execute('kory__write_file', {
      path: join(workspace, 'Native Settings', 'index.html'),
      content: '<title>Native Settings</title>',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; isError: boolean; output: string };
    expect(body.ok).toBe(true);
    expect(body.isError).toBe(true);
    expect(body.output).toBe(BANNED_NAME_REASON);
    // The bouncer held: nothing reached the disk.
    expect(readdirSync(workspace)).toEqual([]);
    expect(
      (() => {
        try {
          return readdirSync(join(workspace, 'Native Settings'));
        } catch {
          return [];
        }
      })(),
    ).toEqual([]);

    rmSync(workspace, { recursive: true, force: true });
  });

  test('an ordinary kory__write_file still succeeds through the same route', async () => {
    mkdirSync(workspace, { recursive: true });
    setContext({
      tools: {
        getToolDefsForRole: async () => [],
        isAllowedForRole: async () => true,
        execute: async (ctx: ToolContext, call: ToolCallInput) => {
          const registry = await initTools({} as never);
          return registry.execute(ctx, call);
        },
      },
      sessions: {
        get: async (id: string) =>
          id === sessionId ? { id, workingDirectory: workspace } : undefined,
        getActive: async (id: string) =>
          id === sessionId ? { id, workingDirectory: workspace } : undefined,
      },
      goals: { list: async () => [] },
      kory: {
        resolveSessionWorkingDirectoryPublic: async () => workspace,
        requestToolApproval: async () => 'Allow',
        hasActiveSessionExecution: () => true,
        tryAcquireSessionMutationBarrier: () => null,
        isWorkspaceRebindPending: () => false,
        markWorkspaceMutatedThisTurn: () => undefined,
      },
    } as never);

    const response = await execute('kory__write_file', {
      path: join(workspace, 'notes.md'),
      content: '# notes\n',
    });
    const body = (await response.json()) as { isError: boolean; output: string };
    expect(body.isError).toBe(false);
    expect(body.output).toContain('notes.md');

    rmSync(workspace, { recursive: true, force: true });
  });
});
