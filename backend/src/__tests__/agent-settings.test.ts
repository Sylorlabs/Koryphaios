import { describe, expect, it } from 'bun:test';
import { resolveMessagingPermission } from '@koryphaios/shared';
import {
  applySessionAgentOverrides,
  assembleAgentContext,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_SANDBOX_SETTINGS,
  loadAgentSettings,
  loadAgentSettingsForSession,
  mergeAgentSettings,
  mergeSandboxSettings,
  saveAgentSettings,
  readPreferences,
  rememberExplicitPreference,
} from '../agent-settings';
import {
  getSessionAgentOverrides,
  resetSessionAgentOverridesCache,
  setSessionAgentOverrides,
} from '../stores/session-agent-overrides';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, type Tool } from '../tools';

describe('autonomy limits', () => {
  it('keeps cold prompt prewarm opt-in while accepting an explicit enable', () => {
    expect(DEFAULT_AGENT_SETTINGS.promptCacheColdPrewarmEnabled).toBe(false);
    expect(
      mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { promptCacheColdPrewarmEnabled: true })
        .promptCacheColdPrewarmEnabled,
    ).toBe(true);
  });

  it('persists only recognized composer permission modes', () => {
    expect(DEFAULT_AGENT_SETTINGS.permissionMode).toBe('guarded');
    for (const permissionMode of ['yolo', 'guarded', 'edits', 'ask', 'custom'] as const) {
      expect(mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { permissionMode }).permissionMode).toBe(
        permissionMode,
      );
    }
    // The composer's Worktree preset writes this project default, so a PUT
    // patch must keep it rather than silently falling back to `auto`.
    expect(DEFAULT_AGENT_SETTINGS.worktreeMode).toBe('auto');
    expect(
      mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { worktreeMode: 'never' }).worktreeMode,
    ).toBe('never');
    expect(
      mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { permissionMode: 'unsafe-value' }).permissionMode,
    ).toBe('guarded');
  });

  it('does not restore legacy plan as a permission preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-settings-plan-'));
    try {
      writeFileSync(
        join(root, 'koryphaios.json'),
        JSON.stringify({ agentSettings: { permissionMode: 'plan' } }),
      );
      expect(loadAgentSettings(root).permissionMode).toBe('guarded');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('pruning default migration', () => {
  it('uses the loosened pruning defaults for fresh installs', () => {
    expect(DEFAULT_AGENT_SETTINGS.contextKeepRecentTurns).toBe(8);
    expect(DEFAULT_AGENT_SETTINGS.contextPruneMinChars).toBe(2000);
  });

  it('bumps persisted stale pruning defaults (3/600) in memory and on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-pruning-migration-'));
    try {
      writeFileSync(
        join(root, 'koryphaios.json'),
        JSON.stringify({
          agentSettings: { contextKeepRecentTurns: 3, contextPruneMinChars: 600 },
        }),
      );
      const migrated = loadAgentSettings(root);
      expect(migrated.contextKeepRecentTurns).toBe(8);
      expect(migrated.contextPruneMinChars).toBe(2000);
      const persisted = JSON.parse(readFileSync(join(root, 'koryphaios.json'), 'utf-8')) as {
        agentSettings: { contextKeepRecentTurns: number; contextPruneMinChars: number };
      };
      expect(persisted.agentSettings.contextKeepRecentTurns).toBe(8);
      expect(persisted.agentSettings.contextPruneMinChars).toBe(2000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves user-customized pruning values alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-pruning-custom-'));
    try {
      const before = JSON.stringify({
        agentSettings: { contextKeepRecentTurns: 5, contextPruneMinChars: 900 },
      });
      writeFileSync(join(root, 'koryphaios.json'), before);
      const loaded = loadAgentSettings(root);
      expect(loaded.contextKeepRecentTurns).toBe(5);
      expect(loaded.contextPruneMinChars).toBe(900);
      expect(readFileSync(join(root, 'koryphaios.json'), 'utf-8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('per-chat agent overrides', () => {
  it('defaults to Auto, persists it, and preserves explicit legacy choices', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-critic-mode-'));
    try {
      for (const [config, expected] of [
        [{}, 'auto'],
        [{ enableCritic: false }, 'off'],
        [{ enableCritic: true }, 'always'],
        [{ agentSettings: { criticGateEnabled: false } }, 'off'],
        [{ agentSettings: { criticGateEnabled: true } }, 'always'],
        [{ enableCritic: false, agentSettings: { criticMode: 'auto', criticGateEnabled: false } }, 'auto'],
      ] as const) {
        writeFileSync(join(root, 'koryphaios.json'), JSON.stringify(config));
        const settings = loadAgentSettings(root);
        expect(settings.criticMode).toBe(expected);
        expect(settings.criticGateEnabled).toBe(expected !== 'off');
      }
      const settings = mergeAgentSettings(loadAgentSettings(root), { criticMode: 'auto' });
      saveAgentSettings(root, settings);
      expect(loadAgentSettings(root).criticMode).toBe('auto');
      expect(JSON.parse(readFileSync(join(root, 'koryphaios.json'), 'utf8')).agentSettings.criticMode).toBe('auto');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('resolves mode patches and chat legacy overrides without overriding other chats', () => {
    const auto = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, { criticMode: 'auto' });
    expect(mergeAgentSettings(auto, { criticMode: 'invalid' }).criticMode).toBe('auto');
    expect(mergeAgentSettings(auto, { criticGateEnabled: true }).criticMode).toBe('always');
    expect(mergeAgentSettings(auto, { criticMode: 'off', criticGateEnabled: true }).criticGateEnabled).toBe(false);
    expect(applySessionAgentOverrides(auto, { criticGateEnabled: false }).criticMode).toBe('off');
    expect(applySessionAgentOverrides(auto, { criticMode: 'always' }).criticMode).toBe('always');
    expect(applySessionAgentOverrides(auto, {}).criticMode).toBe('auto');
    expect(auto.criticMode).toBe('auto');
  });
  it('layers a chat approval preset over the workspace default without touching it', () => {
    const project = { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'guarded' as const };
    const overridden = applySessionAgentOverrides(project, { permissionMode: 'yolo' });
    expect(overridden.permissionMode).toBe('yolo');
    expect(project.permissionMode).toBe('guarded');
  });

  it('leaves unset fields on the workspace value', () => {
    const project = {
      ...DEFAULT_AGENT_SETTINGS,
      permissionMode: 'guarded' as const,
      agentExecutionMode: 'multi' as const,
      criticGateEnabled: true,
    };
    const overridden = applySessionAgentOverrides(project, { criticGateEnabled: false });
    expect(overridden.criticGateEnabled).toBe(false);
    expect(overridden.permissionMode).toBe('guarded');
    expect(overridden.agentExecutionMode).toBe('multi');
  });

  it('resolves each chat from the same project defaults independently', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-session-overrides-'));
    try {
      writeFileSync(
        join(root, 'koryphaios.json'),
        JSON.stringify({ agentSettings: { permissionMode: 'guarded', criticGateEnabled: true } }),
      );
      setSessionAgentOverrides('chat-yolo', { permissionMode: 'yolo' });
      setSessionAgentOverrides('chat-off', { criticGateEnabled: false });
      try {
        expect(loadAgentSettingsForSession(root, 'chat-yolo').permissionMode).toBe('yolo');
        expect(loadAgentSettingsForSession(root, 'chat-yolo').criticGateEnabled).toBe(true);

        expect(loadAgentSettingsForSession(root, 'chat-off').permissionMode).toBe('guarded');
        expect(loadAgentSettingsForSession(root, 'chat-off').criticGateEnabled).toBe(false);

        // A chat that never chose anything keeps the project default, and the
        // workspace file itself is never rewritten by a chat-scoped change.
        expect(loadAgentSettingsForSession(root, 'chat-untouched').permissionMode).toBe('guarded');
        const persisted = JSON.parse(readFileSync(join(root, 'koryphaios.json'), 'utf-8')) as {
          agentSettings: { permissionMode: string };
        };
        expect(persisted.agentSettings.permissionMode).toBe('guarded');
      } finally {
        resetSessionAgentOverridesCache();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('worktreeMode migration', () => {
    it('maps the legacy worktreeIsolation boolean to a preset', () => {
      const off = mkdtempSync(join(tmpdir(), 'kory-wt-off-'));
      const on = mkdtempSync(join(tmpdir(), 'kory-wt-on-'));
      try {
        writeFileSync(
          join(off, 'koryphaios.json'),
          JSON.stringify({ agentSettings: { worktreeIsolation: false } }),
        );
        writeFileSync(
          join(on, 'koryphaios.json'),
          JSON.stringify({ agentSettings: { worktreeIsolation: true } }),
        );
        expect(loadAgentSettings(off).worktreeMode).toBe('never');
        expect(loadAgentSettings(on).worktreeMode).toBe('auto');
      } finally {
        rmSync(off, { recursive: true, force: true });
        rmSync(on, { recursive: true, force: true });
      }
    });

    it('keeps an explicit worktreeMode and defaults to auto', () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-wt-mode-'));
      try {
        writeFileSync(
          join(root, 'koryphaios.json'),
          JSON.stringify({ agentSettings: { worktreeMode: 'always' } }),
        );
        expect(loadAgentSettings(root).worktreeMode).toBe('always');
        expect(DEFAULT_AGENT_SETTINGS.worktreeMode).toBe('auto');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('session overrides prefer worktreeMode but still accept the legacy boolean', () => {
      const base = { ...DEFAULT_AGENT_SETTINGS };
      expect(
        applySessionAgentOverrides(base, { worktreeMode: 'never' }).worktreeMode,
      ).toBe('never');
      expect(
        applySessionAgentOverrides(base, { worktreeIsolation: false }).worktreeMode,
      ).toBe('never');
      expect(
        applySessionAgentOverrides(base, {
          worktreeMode: 'always',
          worktreeIsolation: false,
        }).worktreeMode,
      ).toBe('always');
    });

    it('the composer per-chat permission choice lands in the durable session preset', () => {
      // Composer permission picks call setSessionAgentOverrides; getIsYoloMode
      // reads the same durable value through loadAgentSettingsForSession.
      const root = mkdtempSync(join(tmpdir(), 'kory-yolo-durable-'));
      try {
        writeFileSync(join(root, 'koryphaios.json'), JSON.stringify({}));
        setSessionAgentOverrides('chat-yolo-write', { permissionMode: 'yolo' });
        expect(loadAgentSettingsForSession(root, 'chat-yolo-write').permissionMode).toBe(
          'yolo',
        );
      } finally {
        resetSessionAgentOverridesCache();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('drops the override when a chat clears it', () => {
    setSessionAgentOverrides('chat-clear', { permissionMode: 'yolo' });
    setSessionAgentOverrides('chat-clear', undefined);
    try {
      expect(getSessionAgentOverrides('chat-clear')).toEqual({});
    } finally {
      resetSessionAgentOverridesCache();
    }
  });
});

describe('inter-agent messaging permissions', () => {
  it('defaults to the preset table per permission mode', () => {
    expect(
      resolveMessagingPermission({ permissionMode: 'yolo' }, 'subAgent'),
    ).toBe('allow');
    expect(
      resolveMessagingPermission({ permissionMode: 'guarded' }, 'manager'),
    ).toBe('allow');
    expect(
      resolveMessagingPermission({ permissionMode: 'guarded' }, 'subAgent'),
    ).toBe('ask');
    expect(resolveMessagingPermission({ permissionMode: 'ask' }, 'manager')).toBe('ask');
    expect(resolveMessagingPermission({ permissionMode: 'custom' }, 'subAgent')).toBe('ask');
  });

  it('stored tier overrides win over the preset default', () => {
    expect(
      resolveMessagingPermission(
        {
          permissionMode: 'ask',
          messagingPermissionsByTier: { ask: { manager: 'allow' } },
        },
        'manager',
      ),
    ).toBe('allow');
    expect(
      resolveMessagingPermission(
        {
          permissionMode: 'yolo',
          messagingPermissionsByTier: { yolo: { subAgents: 'block' } },
        },
        'subAgent',
      ),
    ).toBe('block');
  });

  it('migrates legacy agentMessaging: off blocks, approval-cross-project asks, open defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-msg-migration-'));
    try {
      writeFileSync(
        join(root, 'koryphaios.json'),
        JSON.stringify({ agentSettings: { agentMessaging: 'off' } }),
      );
      const blocked = loadAgentSettings(root);
      expect(blocked.messagingPermissionsByTier).toEqual({
        yolo: { manager: 'block', subAgents: 'block' },
        guarded: { manager: 'block', subAgents: 'block' },
        edits: { manager: 'block', subAgents: 'block' },
        ask: { manager: 'block', subAgents: 'block' },
        custom: { manager: 'block', subAgents: 'block' },
      });

      writeFileSync(
        join(root, 'koryphaios.json'),
        JSON.stringify({ agentSettings: { agentMessaging: 'approval-cross-project' } }),
      );
      const asking = loadAgentSettings(root);
      expect(asking.messagingPermissionsByTier?.ask).toEqual({
        manager: 'ask',
        subAgents: 'ask',
      });
      expect(asking.messagingPermissionsByTier?.yolo).toEqual({
        manager: 'ask',
        subAgents: 'ask',
      });

      writeFileSync(
        join(root, 'koryphaios.json'),
        JSON.stringify({ agentSettings: { agentMessaging: 'open' } }),
      );
      const open = loadAgentSettings(root);
      expect(open.messagingPermissionsByTier).toEqual({});
      expect(resolveMessagingPermission(open, 'subAgent')).toBe('ask');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not migrate when messagingPermissionsByTier was already saved', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-msg-nomig-'));
    try {
      writeFileSync(
        join(root, 'koryphaios.json'),
        JSON.stringify({
          agentSettings: {
            agentMessaging: 'off',
            messagingPermissionsByTier: { yolo: { manager: 'allow' } },
          },
        }),
      );
      const loaded = loadAgentSettings(root);
      expect(loaded.messagingPermissionsByTier).toEqual({ yolo: { manager: 'allow' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips messagingPermissionsByTier through save/load', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-msg-roundtrip-'));
    try {
      const merged = mergeAgentSettings(loadAgentSettings(root), {
        messagingPermissionsByTier: {
          ask: { manager: 'allow', subAgents: 'block' },
          bogus: { manager: 'allow' },
          guarded: { manager: 'shout' },
        },
      });
      saveAgentSettings(root, merged);
      const loaded = loadAgentSettings(root);
      expect(loaded.messagingPermissionsByTier).toEqual({
        ask: { manager: 'allow', subAgents: 'block' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
