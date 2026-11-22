import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NOTE_TOOL_PERMISSIONS } from '@koryphaios/shared';
import { DEFAULT_AGENT_SETTINGS, saveAgentSettings } from '../../agent-settings';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { setContext } from '../../context';
import { saveNotesAgentPermissions, saveNotesSettings } from '../../notes/notes-settings';
import { KORY_TOOLS } from '../../providers/kory-mcp-bridge';
import { ToolRegistry } from '../../tools/registry';
import { mcpBridgeRoutes } from './mcp-bridge';

const NAME = 'retrieve_note_context';
const sessionId = 'note-context-bridge-permissions';
let root: string;
let executed: number;
let approvals: number;
let decision: string;
let request: (endpoint: 'catalog' | 'execute') => Promise<Response>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-note-context-bridge-'));
  executed = 0;
  approvals = 0;
  decision = 'Allow once';
  saveAgentSettings(root, { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'guarded' });
  const tools = new ToolRegistry();
  const definition = KORY_TOOLS.find((tool) => tool.name === `kory__${NAME}`)!;
  tools.register({
    ...definition,
    name: NAME,
    run: async (ctx, call) => {
      executed++;
      expect(ctx.workingDirectory).toBe(root);
      return {
        callId: call.id,
        name: NAME,
        output: 'bounded excerpts',
        isError: false,
        durationMs: 0,
      };
    },
  });
  setContext({
    tools,
    sessions: {
      get: async () => ({ id: sessionId, workingDirectory: root }),
      getActive: async () => ({ id: sessionId, workingDirectory: root }),
    },
    goals: { list: async () => [] },
    kory: {
      resolveSessionWorkingDirectoryPublic: async () => root,
      hasActiveSessionExecution: () => true,
      tryAcquireSessionMutationBarrier: () => null,
        isWorkspaceRebindPending: () => false,
        markWorkspaceMutatedThisTurn: () => undefined,
      requestToolApproval: async () => {
        approvals++;
        return decision;
      },
    },
  } as never);
  const app = new Elysia()
    .onError(({ error, set }) => {
      set.status = (error as { statusCode?: number }).statusCode ?? 500;
      return { error: error instanceof Error ? error.message : String(error) };
    })
    .use(mcpBridgeRoutes);
  const authorization = buildLocalBearerToken(localAuth.createSession([`mcp:${sessionId}:worker`]));
  request = (endpoint) =>
    app.handle(
      new Request(`http://localhost/api/v1/mcp-bridge/${endpoint}`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          role: 'worker',
          ...(endpoint === 'execute'
            ? {
                toolName: NAME,
                input: { query: 'design' },
                workingDirectory: '/untrusted-override',
              }
            : {}),
        }),
      }),
    );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function permission(level: 'auto' | 'ask' | 'block') {
  saveNotesAgentPermissions(root, {
    preset: 'custom',
    tools: { ...DEFAULT_NOTE_TOOL_PERMISSIONS, [NAME]: level },
  });
}

describe('associative retrieval control-plane bridge permissions', () => {
  test('advertises a read operation and executes with the authenticated project root', async () => {
    const catalog = await request('catalog');
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).tools.map((tool: { name: string }) => tool.name)).toContain(
      `kory__${NAME}`,
    );
    const response = await request('execute');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isError: false, output: 'bounded excerpts' });
    expect(executed).toBe(1);
    expect(approvals).toBe(0);
  });

  test('revoked or disabled Notes cannot be invoked through a stale bridge catalog', async () => {
    expect((await request('catalog')).status).toBe(200);
    for (const disabled of [false, true]) {
      permission(disabled ? 'auto' : 'block');
      saveNotesSettings(root, { enabled: !disabled });
      const catalog = await request('catalog');
      expect((await catalog.json()).tools).toEqual([]);
      expect((await request('execute')).status).toBe(403);
    }
    expect(executed).toBe(0);
    expect(approvals).toBe(0);
  });

  test('Notes Ask requires an explicit approval and never executes a rejected read', async () => {
    permission('ask');
    decision = 'Reject';
    const rejected = await request('execute');
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ isError: true });
    expect(executed).toBe(0);
    expect(approvals).toBe(1);
    decision = 'Allow once';
    expect((await request('execute')).status).toBe(200);
    expect(executed).toBe(1);
    expect(approvals).toBe(2);
  });

  test('host Block wins even with Notes Auto and a host allowlist entry', async () => {
    saveAgentSettings(root, {
      ...DEFAULT_AGENT_SETTINGS,
      permissionMode: 'yolo',
      toolAllowlist: [NAME],
      toolBlocklist: [NAME],
      toolPermissionsByTier: { yolo: { allow: [NAME], block: [NAME], ask: [] } },
    });
    const response = await request('execute');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isError: true });
    expect(executed).toBe(0);
  });
});
