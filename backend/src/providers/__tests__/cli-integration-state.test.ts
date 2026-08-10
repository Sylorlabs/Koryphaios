import { describe, expect, it, mock, beforeAll } from 'bun:test';
import {
  getCliConversationRevision,
  markCliConversationRewritten,
  resetCliConversationRevisions,
} from '../cli-session-state';
import { materializeCliImage, renderCliContent } from '../cli-attachments';
import { buildKoryCliMcpConfig } from '../kory-cli-mcp-config';
import { buildKoryHookConfigs, buildKoryMcpServerConfig } from '../cli-bridges';
import { readBridgeGrantScopeFromFile } from '../bridge-grant';
import { initDb } from '../../db';
import { db, sessions } from '../../db';
import { eq } from 'drizzle-orm';

// Ensure the sessions table exists so cli-session-state's queries don't throw.
// Do NOT mock the db module — mock.module is process-wide in Bun and would
// break subsequent test files that need the real drizzle instance.
beforeAll(async () => {
  await initDb();
});

describe('native CLI integration state', () => {
  it('increments the rewrite revision used to invalidate native conversations', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `cli-revision-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'CLI revision test',
      conversationRevision: 7,
      providerConversationRevision: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    resetCliConversationRevisions();
    expect(await getCliConversationRevision(sessionId)).toBe(2);
    // Simulate another backend process advancing the authoritative row.
    await db
      .update(sessions)
      .set({ providerConversationRevision: 8 })
      .where(eq(sessions.id, sessionId));
    expect(await getCliConversationRevision(sessionId)).toBe(8);
    await markCliConversationRewritten(sessionId);
    expect(await getCliConversationRevision(sessionId)).toBe(9);
    const [persisted] = await db
      .select({
        contextRevision: sessions.conversationRevision,
        providerRevision: sessions.providerConversationRevision,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(persisted).toEqual({ contextRevision: 7, providerRevision: 9 });
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('materializes text-transport images securely and reuses the content-addressed path', () => {
    const data = Buffer.from('safe-test-image').toString('base64');
    const first = materializeCliImage(data, 'image/png');
    const second = materializeCliImage(data, 'image/png');
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(first).toContain('koryphaios-cli-attachments');
    expect(
      renderCliContent([
        { type: 'text', text: 'look' },
        { type: 'image', imageData: data, imageMimeType: 'image/png' },
      ]),
    ).toContain(first!);
  });

  it('fails closed for oversized attachment data', () => {
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    expect(materializeCliImage(oversized, 'image/png')).toBeNull();
  });

  it('scopes the Kory MCP grant to the exact conversation and role', () => {
    const config = buildKoryCliMcpConfig(
      {
        provider: 'cursor',
        role: 'critic',
        sandbox: undefined,
        workingDirectory: '/tmp/workspace',
        sessionId: 'mcp-session',
        systemPrompt: 'test',
        tools: [],
      },
      'cursor',
    );
    // Auth is delivered via a private grant file (KORY_BRIDGE_AUTH_FILE),
    // never as an inline bearer in argv/env. The grant is scoped to this
    // exact session + role + MCP actions.
    const authFile = config?.[0]?.env?.KORY_BRIDGE_AUTH_FILE;
    expect(authFile).toBeTruthy();
    const scope = readBridgeGrantScopeFromFile(authFile!);
    expect(scope.sessionId).toBe('mcp-session');
    expect(scope.role).toBe('critic');
    expect(scope.actions).toContain('mcp:catalog');
    expect(scope.actions).toContain('mcp:execute');
    expect(config?.[0]?.args.some((arg) => arg.endsWith('kory-mcp-bridge.ts'))).toBe(true);
    const bridged = buildKoryMcpServerConfig(
      {
        provider: 'claude',
        role: 'critic',
        sandbox: undefined,
        workingDirectory: '/tmp/workspace',
        sessionId: 'mcp-session',
        systemPrompt: 'test',
        tools: [],
      },
      'claude',
    );
    // The bridged config must also carry a grant scoped to the same session.
    const bridgedAuthFile = bridged?.env?.KORY_BRIDGE_AUTH_FILE;
    expect(bridgedAuthFile).toBeTruthy();
    const bridgedScope = readBridgeGrantScopeFromFile(bridgedAuthFile!);
    expect(bridgedScope.sessionId).toBe('mcp-session');
    expect(bridgedScope.role).toBe('critic');
  });

  it('authenticates each native CLI lifecycle hook and preserves its real event', () => {
    const previous = process.env.KORY_HOOK_BRIDGE_SCRIPT;
    process.env.KORY_HOOK_BRIDGE_SCRIPT = '/tmp/kory hook bridge.js';
    try {
      const hooks = buildKoryHookConfigs({
        provider: 'claude',
        role: 'worker',
        sandbox: undefined,
        workingDirectory: '/tmp/workspace',
        sessionId: 'hook-session',
        systemPrompt: '',
        tools: [],
      });
      expect(hooks?.map((hook) => hook.events[0])).toEqual([
        'PreToolUse',
        'PostToolUse',
        'UserPromptSubmit',
        'Stop',
      ]);
      for (const hook of hooks ?? []) {
        // Auth is delivered via a private grant file path, not an inline
        // bearer. The grant is scoped to this session + role + hook action.
        expect(hook.command).toContain('--auth-file');
        expect(hook.command).toContain('bridge-grant');
        expect(hook.command).toContain(`--event ${hook.events[0]}`);
        expect(hook.command).toContain('"/tmp/kory hook bridge.js"');
      }
    } finally {
      if (previous === undefined) delete process.env.KORY_HOOK_BRIDGE_SCRIPT;
      else process.env.KORY_HOOK_BRIDGE_SCRIPT = previous;
    }
  });
});
