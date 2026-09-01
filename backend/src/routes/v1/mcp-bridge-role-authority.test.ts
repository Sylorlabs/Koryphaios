import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NOTE_TOOL_PERMISSIONS } from '@koryphaios/shared';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { initTools } from '../../bootstrap';
import { setContext } from '../../context';
import {
  KORY_CODER_TOOL_WHITELIST,
  KORY_CRITIC_TOOL_WHITELIST,
  KORY_MANAGER_TOOL_WHITELIST,
  KORY_TOOL_WHITELIST,
  KORY_WORKER_TOOL_WHITELIST,
  KimiCodeCliBridge,
  koryToolWhitelistForRole,
} from '../../providers/cli-bridges';
import { KORY_TOOLS, toolsForRole } from '../../providers/kory-mcp-bridge';
import type { ToolRegistry } from '../../tools/registry';
import { saveNotesAgentPermissions } from '../../notes/notes-settings';
import { mcpBridgeRoutes } from './mcp-bridge';

const ROLES = ['manager', 'worker', 'critic', 'coder'] as const;
type Role = (typeof ROLES)[number];

const MUTATING_TOOLS = [
  'record_work_note',
  'create_note',
  'set_note_property',
  'update_note',
  'delete_note',
  'link_notes',
  'unlink_notes',
  'ghost_commit',
] as const;

const READ_ONLY_NOTE_TOOLS = [
  'read_note',
  'recall_notes',
  'search_notes',
  'list_notes',
  'get_note_backlinks',
  'get_note_graph_summary',
  'get_note_properties',
  'query_note_base',
  'render_note',
] as const;

const prefixed = (name: string) => `kory__${name}`;
const sorted = (values: Iterable<string>) => [...values].sort();

async function authoritativeRegistry(): Promise<ToolRegistry> {
  // Tool construction does not invoke provider methods. This deliberately uses
  // bootstrap's registry builder so the regression cannot pass with a hand-built
  // subset that omits tools or misstates their roles.
  return initTools({} as never);
}

function authorizationFor(sessionId: string, role: string): string {
  return buildLocalBearerToken(localAuth.createSession([`mcp:${sessionId}:${role}`]));
}

describe('MCP bridge role authority', () => {
  test('matches every catalog name and advertised role set to the bootstrap ToolRegistry', async () => {
    const registry = await authoritativeRegistry();
    const catalogNames = KORY_TOOLS.map((tool) => tool.name.replace(/^kory__/, ''));
    const registryNames = registry.getAll().map((tool) => tool.name);

    expect(new Set(catalogNames).size).toBe(catalogNames.length);
    expect(sorted(catalogNames)).toEqual(sorted(registryNames));

    const exportedWhitelists: Record<Role, string[]> = {
      manager: KORY_MANAGER_TOOL_WHITELIST,
      worker: KORY_WORKER_TOOL_WHITELIST,
      critic: KORY_CRITIC_TOOL_WHITELIST,
      coder: KORY_CODER_TOOL_WHITELIST,
    };
    expect(KORY_TOOL_WHITELIST).toBe(KORY_MANAGER_TOOL_WHITELIST);

    for (const role of ROLES) {
      const expected = registry
        .getAll()
        .filter((tool) => registry.isAllowedForRole(tool.name, role))
        .map((tool) => prefixed(tool.name));
      const catalog = toolsForRole(role).map((tool) => tool.name);

      expect(sorted(catalog)).toEqual(sorted(expected));
      expect(sorted(exportedWhitelists[role])).toEqual(sorted(expected));
      expect(sorted(koryToolWhitelistForRole(role))).toEqual(sorted(expected));

      for (const name of registryNames) {
        expect(catalog.includes(prefixed(name))).toBe(registry.isAllowedForRole(name, role));
      }
    }

    expect(toolsForRole('auditor')).toEqual([]);
    expect(koryToolWhitelistForRole('auditor')).toEqual([]);

    const kimiBridge = new KimiCodeCliBridge();
    for (const role of ['manager', 'worker', 'critic'] as const) {
      const toolDefs = registry.getToolDefsForRole(role);
      const config = kimiBridge.buildAgentConfig({
        provider: 'kimicode',
        role,
        sandbox: undefined,
        workingDirectory: '/tmp',
        sessionId: 'kimi-role-parity',
        systemPrompt: '',
        tools: toolDefs,
      });
      expect(config?.allowedTools).toEqual(toolDefs.map((tool) => tool.name));
      expect(config?.allowedTools.some((name) => name.startsWith('kory__'))).toBe(false);
    }

    for (const name of MUTATING_TOOLS) {
      expect(registry.isAllowedForRole(name, 'critic')).toBe(false);
      expect(registry.isAllowedForRole(name, 'worker')).toBe(true);
      expect(registry.isAllowedForRole(name, 'coder')).toBe(true);
      expect(registry.isAllowedForRole(name, 'manager')).toBe(true);
    }
    for (const name of READ_ONLY_NOTE_TOOLS) {
      expect(registry.isAllowedForRole(name, 'critic')).toBe(true);
    }
  });

  test('/execute enforces the same decision for every bootstrapped tool and role', async () => {
    const registry = await authoritativeRegistry();
    const sessionId = 'mcp-role-parity-session';
    const executed: Array<{ agentId: string | undefined; name: string }> = [];
    setContext({
      tools: {
        getToolDefsForRole: (role: Role) => registry.getToolDefsForRole(role),
        isAllowedForRole: (name: string, role: Role) => registry.isAllowedForRole(name, role),
        execute: async (ctx: { agentId?: string }, call: { name: string }) => {
          executed.push({ agentId: ctx.agentId, name: call.name });
          return {
            callId: 'role-parity',
            name: call.name,
            output: 'stubbed-authorized-execution',
            isError: false,
            durationMs: 0,
          };
        },
      },
      sessions: {
        get: async (id: string) =>
          id === sessionId ? { id, workingDirectory: '/tmp' } : undefined,
        getActive: async (id: string) =>
          id === sessionId ? { id, workingDirectory: '/tmp' } : undefined,
      },
      goals: { list: async () => [] },
      kory: {
        requestToolApproval: async () => 'Allow',
        hasActiveSessionExecution: () => true,
        tryAcquireSessionMutationBarrier: () => null,
      },
    } as never);

    const app = new Elysia()
      .onError(({ error, set }) => {
        const operational = error as {
          statusCode?: number;
          code?: string;
          message?: string;
        };
        set.status = operational.statusCode ?? 500;
        return {
          ok: false,
          code: operational.code ?? 'INTERNAL_ERROR',
          error: operational.message ?? String(error),
        };
      })
      .use(mcpBridgeRoutes);
    const execute = (role: string, toolName: string, authorization: string) =>
      app.handle(
        new Request('http://localhost/api/v1/mcp-bridge/execute', {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, toolName, input: {}, role }),
        }),
      );
    const catalog = (role: string, authorization: string) =>
      app.handle(
        new Request('http://localhost/api/v1/mcp-bridge/catalog', {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, role }),
        }),
      );

    let expectedExecutions = 0;
    for (const role of ROLES) {
      const authorization = authorizationFor(sessionId, role);
      const catalogResponse = await catalog(role, authorization);
      expect(catalogResponse.status).toBe(200);
      expect(await catalogResponse.json()).toEqual({
        ok: true,
        tools: registry.getToolDefsForRole(role).map((tool) => ({
          ...tool,
          name: prefixed(tool.name),
        })),
      });
      for (const tool of registry.getAll()) {
        const allowed = registry.isAllowedForRole(tool.name, role);
        const response = await execute(role, tool.name, authorization);
        expect(response.status).toBe(allowed ? 200 : 403);
        const body = (await response.json()) as Record<string, unknown>;
        if (allowed) {
          expectedExecutions++;
          expect(body).toMatchObject({
            ok: true,
            output: 'stubbed-authorized-execution',
            isError: false,
          });
        } else {
          expect(body).toMatchObject({
            ok: false,
            code: 'ACCESS_DENIED',
            error: `${role} is not allowed to call ${tool.name}`,
          });
        }
      }
    }
    expect(executed).toHaveLength(expectedExecutions);
    expect(
      executed
        .filter(({ name }) => name === 'record_work_note')
        .map(({ agentId }) => agentId)
        .sort(),
    ).toEqual(['mcp-bridge:coder', 'mcp-bridge:manager', 'mcp-bridge:worker']);

    const unknownRole = await execute(
      'auditor',
      'read_file',
      authorizationFor(sessionId, 'auditor'),
    );
    expect(unknownRole.status).toBe(400);
    expect(await unknownRole.json()).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'A valid CLI role is required',
    });
    const unknownCatalogRole = await catalog('auditor', authorizationFor(sessionId, 'auditor'));
    expect(unknownCatalogRole.status).toBe(400);
  }, 20_000);

  test('Notes block permission removes record_work_note from catalog and execution', async () => {
    const registry = await authoritativeRegistry();
    const projectRoot = mkdtempSync(join(tmpdir(), 'kory-mcp-work-note-role-'));
    const sessionId = 'mcp-work-note-block-session';
    let executed = false;
    try {
      saveNotesAgentPermissions(projectRoot, {
        preset: 'custom',
        tools: { ...DEFAULT_NOTE_TOOL_PERMISSIONS, record_work_note: 'block' },
      });
      setContext({
        tools: {
          getToolDefsForRole: (role: Role) => registry.getToolDefsForRole(role),
          isAllowedForRole: (name: string, role: Role) => registry.isAllowedForRole(name, role),
          execute: async () => {
            executed = true;
            return {
              callId: 'must-not-run',
              name: 'record_work_note',
              output: 'must not run',
              isError: false,
              durationMs: 0,
            };
          },
        },
        sessions: {
          get: async (id: string) =>
            id === sessionId ? { id, workingDirectory: projectRoot } : undefined,
          getActive: async (id: string) =>
            id === sessionId ? { id, workingDirectory: projectRoot } : undefined,
        },
        goals: { list: async () => [] },
        kory: {
          requestToolApproval: async () => 'Allow',
          hasActiveSessionExecution: () => true,
          tryAcquireSessionMutationBarrier: () => null,
        },
      } as never);
      const app = new Elysia()
        .onError(({ error, set }) => {
          const operational = error as {
            statusCode?: number;
            code?: string;
            message?: string;
          };
          set.status = operational.statusCode ?? 500;
          return {
            ok: false,
            code: operational.code ?? 'INTERNAL_ERROR',
            error: operational.message ?? String(error),
          };
        })
        .use(mcpBridgeRoutes);
      const authorization = authorizationFor(sessionId, 'worker');
      const catalog = await app.handle(
        new Request('http://localhost/api/v1/mcp-bridge/catalog', {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, role: 'worker' }),
        }),
      );
      const catalogBody = (await catalog.json()) as { tools: Array<{ name: string }> };
      expect(catalog.status).toBe(200);
      expect(catalogBody.tools.map((tool) => tool.name)).not.toContain('kory__record_work_note');

      const execute = await app.handle(
        new Request('http://localhost/api/v1/mcp-bridge/execute', {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            role: 'worker',
            toolName: 'record_work_note',
            input: { title: 'Blocked', summary: 'Must not write', status: 'blocked' },
          }),
        }),
      );
      expect(execute.status).toBe(403);
      expect(await execute.json()).toMatchObject({
        ok: false,
        code: 'ACCESS_DENIED',
        error: 'worker is not allowed to call record_work_note',
      });
      expect(executed).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
