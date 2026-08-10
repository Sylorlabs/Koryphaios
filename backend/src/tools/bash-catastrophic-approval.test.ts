import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from './registry';
import type { PermissionMode, ToolPermissionPolicy } from './permission-policy';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
process.env.DATABASE_URL = 'sqlite::memory:';

const { BashTool, isCatastrophicBashCommand } = await import('./bash');
const { ToolRegistry } = await import('./registry');
const { loadAgentSettings, saveAgentSettings } = await import('../agent-settings');

const root = mkdtempSync(join(tmpdir(), 'kory-catastrophic-approval-'));
const command = 'printf safe # rm -rf /';

const policy = (mode: PermissionMode, confirmRiskyActions: boolean): ToolPermissionPolicy => ({
  mode,
  autoRunTools: true,
  autoApplySafeFixes: true,
  confirmRiskyActions,
  autonomyLimitsEnabled: false,
  approvalThresholdFiles: 999,
  approvalThresholdLines: 999_999,
  toolAllowlist: [],
  toolBlocklist: [],
});

const context = (
  permissionPolicy: ToolPermissionPolicy,
  approvedToolCallIds = new Set<string>(),
): ToolContext => ({
  sessionId: 'catastrophic-approval-session',
  workingDirectory: root,
  isSandboxed: false,
  permissionPolicy,
  approvedToolCallIds,
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('catastrophic Bash approval floor', () => {
  test('YOLO and a persistent command allowlist cannot bypass per-call approval', async () => {
    expect(isCatastrophicBashCommand(command)).toBe(true);
    const settings = loadAgentSettings(root);
    saveAgentSettings(root, { ...settings, bashCommandAllowlist: ['rm', '*'] });

    const result = await new BashTool().run(context(policy('yolo', false)), {
      id: 'yolo-catastrophic',
      name: 'bash',
      input: { command },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('no human approval channel');
    expect(result.output).not.toContain('Exit code: 0');
  });

  test('custom no-confirm mode cannot bypass per-call approval', async () => {
    const result = await new BashTool().run(context(policy('custom', false)), {
      id: 'custom-catastrophic',
      name: 'bash',
      input: { command },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('no human approval channel');
  });

  test('a host receipt for this exact invocation allows the harmless proof command', async () => {
    const callId = 'approved-catastrophic';
    const result = await new BashTool().run(context(policy('yolo', false), new Set([callId])), {
      id: callId,
      name: 'bash',
      input: { command },
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('safe');
  });

  test('the central registry discards stale approval when a call ID is reused', async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const callId = 'reused-call-id';
    const result = await registry.execute(context(policy('yolo', false), new Set([callId])), {
      id: callId,
      name: 'bash',
      input: { command },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('no human approval channel');
  });
});
