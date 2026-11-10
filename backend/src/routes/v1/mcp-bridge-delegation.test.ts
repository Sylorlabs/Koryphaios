import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { initTools } from '../../bootstrap';
import { setContext } from '../../context';
import type { ToolRegistry } from '../../tools/registry';
import { mcpBridgeRoutes } from './mcp-bridge';

describe('MCP bridge delegation', () => {
  test('bridge-originated manager calls can delegate to a worker', async () => {
    const registry = await initTools({} as never);
    const projectRoot = mkdtempSync(join(tmpdir(), 'kory-mcp-delegation-'));
    const sessionId = 'mcp-delegation-session';
    const runWorkerPipeline = (async (..._args: unknown[]) => 'worker-result-ok') as unknown as (
      ...args: unknown[]
    ) => Promise<string>;
    try {
      setContext({
        tools: {
          getToolDefsForRole: (role: string) => registry.getToolDefsForRole(role as never),
          isAllowedForRole: (name: string, role: string) =>
            registry.isAllowedForRole(name, role as never),
          execute: (ctx: unknown, call: { name: string; input: Record<string, unknown>; id: string }) =>
            registry.execute(ctx as never, call as never),
        },
        sessions: {
          get: async (id: string) =>
            id === sessionId ? { id, workingDirectory: projectRoot } : undefined,
          getActive: async (id: string) =>
            id === sessionId ? { id, workingDirectory: projectRoot } : undefined,
        },
        goals: { list: async () => [] },
        kory: {
          resolveSessionWorkingDirectoryPublic: async () => projectRoot,
          requestToolApproval: async () => 'Allow',
          hasActiveSessionExecution: () => true,
          tryAcquireSessionMutationBarrier: () => null,
          runWorkerPipeline,
          renameSession: async () => 'renamed',
        },
      } as never);

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

      const authorization = buildLocalBearerToken(localAuth.createSession([`mcp:${sessionId}:manager`]));
      const response = await app.handle(
        new Request('http://localhost/api/v1/mcp-bridge/execute', {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            role: 'manager',
            toolName: 'delegate_to_worker',
            input: { task: 'Do the delegated work' },
          }),
        }),
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        output: 'worker-result-ok',
        isError: false,
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30_000);
});