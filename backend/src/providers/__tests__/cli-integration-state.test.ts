import { describe, expect, it, mock, beforeAll } from 'bun:test';
import {
  getCliConversationRevision,
  markCliConversationRewritten,
  resetCliConversationRevisions,
} from '../cli-session-state';
import { materializeCliImage, renderCliContent } from '../cli-attachments';
import { buildKoryCliMcpConfig } from '../kory-cli-mcp-config';
import { buildKoryHookConfigs, buildKoryMcpServerConfig } from '../cli-bridges';
import { validateLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { initDb } from '../../db';

// Ensure the sessions table exists so cli-session-state's queries don't throw.
// Do NOT mock the db module — mock.module is process-wide in Bun and would
// break subsequent test files that need the real drizzle instance.
beforeAll(async () => {
  await initDb();
});

describe('native CLI integration state', () => {
  it('increments the rewrite revision used to invalidate native conversations', async () => {
    resetCliConversationRevisions();
    expect(await getCliConversationRevision('session-a')).toBe(0);
    // markCliConversationRewritten hits the DB mock (returns 0 → fallback to 1)
    await markCliConversationRewritten('session-a');
    // After marking, the cache is set to 1 (the fallback value)
    expect(await getCliConversationRevision('session-a')).toBe(1);
    expect(await getCliConversationRevision('session-b')).toBe(0);
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

  it('scopes the Kory MCP bearer to the exact conversation and role', () => {
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
    const bearer = config?.[0]?.env?.KORY_LOCAL_AUTH;
    const auth = validateLocalBearerToken(bearer);
    expect(auth).toBeTruthy();
    expect(localAuth.hasPermission(auth!, 'mcp:mcp-session:critic')).toBe(true);
    expect(localAuth.hasPermission(auth!, 'mcp:another-session:critic')).toBe(false);
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
    expect(bridged?.env?.KORY_LOCAL_AUTH).toBe(bearer);
  });

  it('authenticates each native CLI lifecycle hook and preserves its real event', () => {
    const previous = process.env.KORY_HOOK_BRIDGE_SCRIPT;
    process.env.KORY_HOOK_BRIDGE_SCRIPT = '/tmp/kory hook bridge.js';
    try {
      const hooks = buildKoryHookConfigs({
        provider: 'claude', role: 'worker', sandbox: undefined,
        workingDirectory: '/tmp/workspace', sessionId: 'hook-session', systemPrompt: '', tools: [],
      });
      expect(hooks?.map((hook) => hook.events[0])).toEqual([
        'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop',
      ]);
      for (const hook of hooks ?? []) {
        expect(hook.command).toContain('--auth "Bearer ');
        expect(hook.command).toContain(`--event ${hook.events[0]}`);
        expect(hook.command).toContain('"/tmp/kory hook bridge.js"');
      }
    } finally {
      if (previous === undefined) delete process.env.KORY_HOOK_BRIDGE_SCRIPT;
      else process.env.KORY_HOOK_BRIDGE_SCRIPT = previous;
    }
  });
});
