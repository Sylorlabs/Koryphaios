import { describe, expect, it } from 'bun:test';
import {
  assembleAgentContext,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_SANDBOX_SETTINGS,
  mergeAgentSettings,
  mergeSandboxSettings,
  readPreferences,
  rememberExplicitPreference,
} from '../agent-settings';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, type Tool } from '../tools';

describe('autonomy limits', () => {
  it('persists only recognized composer permission modes', () => {
    expect(DEFAULT_AGENT_SETTINGS.permissionMode).toBe('guarded');
    for (const permissionMode of ['yolo', 'guarded', 'edits', 'ask', 'plan', 'custom'] as const) {
      expect(mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { permissionMode }).permissionMode).toBe(
        permissionMode,
      );
    }
    expect(
      mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { permissionMode: 'unsafe-value' }).permissionMode,
    ).toBe('guarded');
  });

  it('are off by default and do not constrain agent instructions', () => {
    expect(DEFAULT_AGENT_SETTINGS.autonomyLimitsEnabled).toBe(false);

    const context = assembleAgentContext(process.cwd(), DEFAULT_AGENT_SETTINGS);
    expect(context.enforcementMessage).not.toContain('AUTONOMY LIMITS');
  });

  it('preserves thresholds while activating an explicit approval boundary', () => {
    const settings = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      autonomyLimitsEnabled: true,
      approvalThresholdFiles: 12,
      approvalThresholdLines: 480,
    });

    const context = assembleAgentContext(process.cwd(), settings);
    expect(settings.autonomyLimitsEnabled).toBe(true);
    expect(settings.approvalThresholdFiles).toBe(12);
    expect(settings.approvalThresholdLines).toBe(480);
    expect(context.enforcementMessage).toContain('12 files or 480 lines');
  });

  it('blocks an oversized Kory file tool before it mutates the workspace', async () => {
    let ran = false;
    const tool: Tool = {
      name: 'write_file',
      description: 'test write',
      inputSchema: {},
      run: async (_ctx, call) => {
        ran = true;
        return { callId: call.id, name: call.name, output: 'wrote', isError: false, durationMs: 0 };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const result = await registry.execute(
      {
        sessionId: 'test',
        workingDirectory: process.cwd(),
        preflightFileChange: async (proposal) => {
          expect(proposal).toEqual({ paths: ['large-file.ts'], linesChanged: 120 });
          return { allowed: false, reason: 'Approval required.' };
        },
      },
      {
        id: 'tool-call',
        name: 'write_file',
        input: {
          path: 'large-file.ts',
          content: Array.from({ length: 120 }, () => 'x').join('\n'),
        },
      },
    );

    expect(ran).toBe(false);
    expect(result).toMatchObject({
      isError: true,
      output: 'Tool change blocked by the preflight safety policy.',
    });
  });
});

describe('sandbox settings', () => {
  it('defaults to auto mode with all granular checks on', () => {
    expect(DEFAULT_AGENT_SETTINGS.sandbox).toEqual(DEFAULT_SANDBOX_SETTINGS);
    expect(DEFAULT_AGENT_SETTINGS.sandbox.mode).toBe('auto');
    expect(DEFAULT_AGENT_SETTINGS.sandbox.metacharacters).toBe(true);
  });

  it('deep-merges a partial sandbox patch so omitted toggles keep defaults', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      sandbox: { mode: 'always', metacharacters: false },
    });
    expect(merged.sandbox.mode).toBe('always');
    expect(merged.sandbox.metacharacters).toBe(false);
    // Omitted toggles retain defaults
    expect(merged.sandbox.commandWhitelist).toBe(true);
    expect(merged.sandbox.pathConfinement).toBe(true);
    expect(merged.sandbox.network).toBe(true);
    expect(merged.sandbox.containerTools).toBe(true);
  });

  it('rejects an invalid sandbox mode and falls back to auto', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      sandbox: { mode: 'unsafe-value' },
    });
    expect(merged.sandbox.mode).toBe('auto');
  });

  it('mergeSandboxSettings layers later overrides over earlier ones', () => {
    const merged = mergeSandboxSettings(
      DEFAULT_SANDBOX_SETTINGS,
      { mode: 'always', network: false },
      { network: true, metacharacters: false },
    );
    expect(merged.mode).toBe('always');
    expect(merged.network).toBe(true);
    expect(merged.metacharacters).toBe(false);
  });

  it('subAgentApproval defaults to manager and accepts valid values', () => {
    expect(DEFAULT_AGENT_SETTINGS.subAgentApproval).toBe('manager');
    expect(
      mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { subAgentApproval: 'user' }).subAgentApproval,
    ).toBe('user');
    expect(
      mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { subAgentApproval: 'auto' }).subAgentApproval,
    ).toBe('auto');
  });

  it('rejects an invalid subAgentApproval value and keeps the default', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { subAgentApproval: 'yolo' });
    expect(merged.subAgentApproval).toBe('manager');
  });
});

describe('explicit preference memory', () => {
  it('persists explicit remember requests but ignores ordinary statements and secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-preferences-'));
    try {
      expect(rememberExplicitPreference(root, 'This is a desktop app.')).toBeNull();
      expect(
        rememberExplicitPreference(
          root,
          'Remember that this is a desktop app; do not launch it in a browser.',
        ),
      ).toContain('this is a desktop app');
      expect(readPreferences(root).content).toContain('do not launch it in a browser');
      expect(
        rememberExplicitPreference(
          root,
          'this is a desktop app dont launch it in the web browser thats something that should be remembered',
        ),
      ).toContain('desktop app');
      expect(rememberExplicitPreference(root, 'Remember that API key secret-123')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('tool allowlist and blocklist merging', () => {
  it('defaults to empty arrays', () => {
    expect(DEFAULT_AGENT_SETTINGS.toolAllowlist).toEqual([]);
    expect(DEFAULT_AGENT_SETTINGS.toolBlocklist).toEqual([]);
  });

  it('merges string arrays from a patch', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      toolAllowlist: ['bash', 'grep'],
      toolBlocklist: ['delete_file'],
    });
    expect(merged.toolAllowlist).toEqual(['bash', 'grep']);
    expect(merged.toolBlocklist).toEqual(['delete_file']);
  });

  it('replaces the array on subsequent patches (no concatenation)', () => {
    let merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { toolAllowlist: ['bash'] });
    merged = mergeAgentSettings(merged, { toolAllowlist: ['grep', 'ls'] });
    expect(merged.toolAllowlist).toEqual(['grep', 'ls']);
  });

  it('filters non-string entries from the array', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      toolAllowlist: ['bash', 42, null, 'grep'] as unknown as string[],
    });
    expect(merged.toolAllowlist).toEqual(['bash', 'grep']);
  });

  it('bounds numeric and structured settings at the persistence boundary', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      maxCriticIterations: 99,
      autoCompactThreshold: 105,
      contextKeepRecentTurns: -2,
      managerModelAccess: {
        general: ['openai:gpt', 42, 'openai:gpt'],
        'not a domain': ['ignored'],
      },
      managerNotes: {
        general: `keep this\u0000safe`,
        bad: null,
      },
      skillCollisionChoices: {
        design: 'project',
        invalid: 'both',
      },
    });

    expect(merged.maxCriticIterations).toBe(DEFAULT_AGENT_SETTINGS.maxCriticIterations);
    expect(merged.autoCompactThreshold).toBe(DEFAULT_AGENT_SETTINGS.autoCompactThreshold);
    expect(merged.contextKeepRecentTurns).toBe(DEFAULT_AGENT_SETTINGS.contextKeepRecentTurns);
    expect(merged.managerModelAccess).toEqual({ general: ['openai:gpt'] });
    expect(merged.managerNotes).toEqual({ general: 'keep this safe' });
    expect(merged.skillCollisionChoices).toEqual({ design: 'project' });
  });

  it('ignores non-array values for list fields', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      toolAllowlist: 'bash' as unknown as string[],
    });
    expect(merged.toolAllowlist).toEqual([]);
  });

  it('clears a list by sending an empty array', () => {
    let merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { toolAllowlist: ['bash'] });
    merged = mergeAgentSettings(merged, { toolAllowlist: [] });
    expect(merged.toolAllowlist).toEqual([]);
  });
});
