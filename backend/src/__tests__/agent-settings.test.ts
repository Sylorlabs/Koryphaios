import { describe, expect, it } from 'bun:test';
import {
  assembleAgentContext,
  DEFAULT_AGENT_SETTINGS,
  mergeAgentSettings,
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
    expect(mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { permissionMode: 'ask' }).permissionMode).toBe('ask');
    expect(mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { permissionMode: 'plan' }).permissionMode).toBe('plan');
    expect(mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { permissionMode: 'unsafe-value' }).permissionMode).toBe('guarded');
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
    expect(result).toMatchObject({ isError: true, output: 'Approval required.' });
  });
});

describe('explicit preference memory', () => {
  it('persists explicit remember requests but ignores ordinary statements and secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-preferences-'));
    try {
      expect(rememberExplicitPreference(root, 'This is a desktop app.')).toBeNull();
      expect(rememberExplicitPreference(root, 'Remember that this is a desktop app; do not launch it in a browser.'))
        .toContain('this is a desktop app');
      expect(readPreferences(root).content).toContain('do not launch it in a browser');
      expect(rememberExplicitPreference(root, "this is a desktop app dont launch it in the web browser thats something that should be remembered"))
        .toContain('desktop app');
      expect(rememberExplicitPreference(root, 'Remember that API key secret-123')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
