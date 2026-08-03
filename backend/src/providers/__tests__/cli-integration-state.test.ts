import { describe, expect, it, mock } from 'bun:test';
import {
  getCliConversationRevision,
  markCliConversationRewritten,
  resetCliConversationRevisions,
} from '../cli-session-state';
import { materializeCliImage, renderCliContent } from '../cli-attachments';
import { buildKoryCliMcpConfig } from '../kory-cli-mcp-config';
import { validateLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';

// Mock the DB so cli-session-state's async DB calls resolve without a real
// database. The mock returns an empty row list (revision 0) and an empty
// update result, letting us exercise the in-memory cache path.
mock.module('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => ({ limit: () => [] }),
        }),
      }),
    }),
  },
}));

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
  });
});
