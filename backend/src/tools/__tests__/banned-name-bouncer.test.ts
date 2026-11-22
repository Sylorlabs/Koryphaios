import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BANNED_NAME_REASON } from '../../security/banned-names';
import { ToolRegistry, type Tool, type ToolContext } from '../registry';

/**
 * The bouncer has to hold at the door, not at the exit: the tool body must never
 * run, and nothing may be created on disk, because a check that happens after
 * the write is a killer, not a bouncer.
 */
describe('banned name bouncer at the tool door', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kory-bouncer-'));

  const ctx: ToolContext = { sessionId: 'session', workingDirectory: workspace };

  const mkTool = (name: string, run: Tool['run']): Tool => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    run,
  });

  test('refuses a write that would create the banned name, and never runs the tool', async () => {
    const registry = new ToolRegistry();
    const run = mock(async (context: ToolContext, call: { id: string; name: string }) => ({
      callId: call.id,
      name: call.name,
      output: 'wrote',
      isError: false,
      durationMs: 0,
    }));
    registry.register(mkTool('write_file', run));

    const result = await registry.execute(ctx, {
      id: 'call-1',
      name: 'write_file',
      input: { path: join(workspace, 'Native Settings', 'index.html'), content: '<h1>x</h1>' },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(BANNED_NAME_REASON);
    expect(run).not.toHaveBeenCalled();
    expect(readdirSync(workspace)).toEqual([]);
    rmSync(workspace, { recursive: true, force: true });
  });

  test('refuses a shell command that would launch it', async () => {
    const registry = new ToolRegistry();
    const run = mock(async () => ({
      callId: 'call-2',
      name: 'bash',
      output: 'ran',
      isError: false,
      durationMs: 0,
    }));
    registry.register(mkTool('bash', run));

    const result = await registry.execute(ctx, {
      id: 'call-2',
      name: 'bash',
      input: { command: 'open "/tmp/Native-Settings.app"' },
    });

    expect(result).toEqual({
      callId: 'call-2',
      name: 'bash',
      output: BANNED_NAME_REASON,
      isError: true,
      durationMs: 0,
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('still runs an ordinary call', async () => {
    const registry = new ToolRegistry();
    registry.register(
      mkTool('write_file', async (_ctx, call) => ({
        callId: call.id,
        name: call.name,
        output: 'ok',
        isError: false,
        durationMs: 0,
      })),
    );

    const result = await registry.execute(ctx, {
      id: 'call-3',
      name: 'write_file',
      input: { path: join(workspace, 'app.ts'), content: 'export {}' },
    });

    expect(result.isError).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });
});
