import { describe, expect, it } from 'bun:test';
import {
  admitComputerPolicy,
  revokeComputerAuthority,
  computerAuthorityRevision,
} from './authority';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPUTER_CAPABILITIES,
  COMPUTER_ROLES,
  COMPUTER_TIERS,
  defaultComputerUseSettings,
  type ComputerAction,
  type ComputerPlatformAdapter,
  type ComputerTarget,
} from '@koryphaios/shared';
import {
  DEFAULT_AGENT_SETTINGS,
  loadAgentSettings,
  mergeAgentSettings,
  saveAgentSettings,
  type AgentSettings,
} from '../agent-settings';
import { normalizeComputerUseSettings } from './settings';
import { decideComputerPermission } from './policy';
import { stopComputerUse, withComputerUseLock } from './control';
import { createComputerUseTools } from './tools';
import type { ToolContext } from '../tools/registry';

const target: ComputerTarget = { appId: 'host.editor', windowId: '42', pid: 123, title: 'Editor' };
function settings(): AgentSettings {
  const computerUse = defaultComputerUseSettings();
  computerUse.enabled = true;
  for (const tier of COMPUTER_TIERS)
    for (const c of COMPUTER_CAPABILITIES) computerUse.byTier[tier][c] = 'allow';
  for (const role of COMPUTER_ROLES)
    for (const c of COMPUTER_CAPABILITIES) computerUse.byRole[role][c] = 'allow';
  computerUse.apps = [
    {
      appId: target.appId,
      label: 'Untrusted label',
      capabilities: { observe: 'allow', interact: 'allow', manageWindows: 'allow' },
    },
  ];
  return { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'ask', computerUse };
}
const ctx: ToolContext = {
  sessionId: 'computer-test',
  workingDirectory: '/unused',
  callerRole: 'manager',
};
function fixture(initial = settings()) {
  let current = initial;
  let targets = [target];
  const calls: ComputerAction[] = [];
  const adapter: ComputerPlatformAdapter = {
    status: async () => ({
      platform: 'test',
      available: true,
      capabilities: ['discover', 'observe', 'interact', 'manageWindows'],
      limitations: [],
    }),
    execute: async (action) => {
      calls.push(action);
      return action.kind === 'discover'
        ? { targets }
        : action.kind === 'observe'
          ? { imageBase64: 'cG5n' }
          : { text: 'done' };
    },
  };
  const tools = createComputerUseTools({ adapter, loadSettings: () => current });
  return {
    calls,
    adapter,
    setSettings: (value: AgentSettings) => {
      current = value;
    },
    setTargets: (value: ComputerTarget[]) => {
      targets = value;
    },
    run: (
      name = 'computer_click',
      context = ctx,
      input: Record<string, unknown> = {
        appId: target.appId,
        windowId: target.windowId,
        x: 2,
        y: 3,
      },
    ) => tools.find((tool) => tool.name === name)!.run(context, { id: name, name, input }),
  };
}

describe('computer settings', () => {
  it('is off by default and deep patches do not erase other gates', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      computerUse: { enabled: true, byTier: { yolo: { observe: 'allow' } } },
    });
    expect(DEFAULT_AGENT_SETTINGS.computerUse.enabled).toBe(false);
    expect(merged.computerUse.byTier.yolo.observe).toBe('allow');
    expect(merged.computerUse.byTier.yolo.interact).toBe('allow');
    expect(merged.computerUse.byRole.critic.interact).toBe('block');
  });
  it('blocks malformed gates, duplicate apps, and oversized app collections', () => {
    const normalized = normalizeComputerUseSettings({
      enabled: 'true',
      byTier: { yolo: { observe: 'ALLOW' } },
      apps: [
        { appId: 'a', capabilities: { observe: 'allow' } },
        { appId: 'a', capabilities: { observe: 'allow' } },
      ],
    });
    expect(normalized.enabled).toBe(false);
    expect(normalized.byTier.yolo.observe).toBe('block');
    expect(normalized.apps).toEqual([]);
    expect(
      normalizeComputerUseSettings({
        apps: Array.from({ length: 201 }, (_, i) => ({ appId: String(i) })),
      }).apps,
    ).toEqual([]);
  });
  it('validates on disk load and save, and round trips configured app identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-computer-'));
    try {
      saveAgentSettings(root, settings());
      // Agent-writable workspace data alone never authorizes desktop access.
      expect(loadAgentSettings(root).computerUse.enabled).toBe(false);
      admitComputerPolicy(root, settings().computerUse);
      expect(loadAgentSettings(root).computerUse).toEqual(settings().computerUse);
      const revision = computerAuthorityRevision();
      revokeComputerAuthority();
      expect(computerAuthorityRevision()).not.toBe(revision);
      expect(loadAgentSettings(root).computerUse.enabled).toBe(false);
      admitComputerPolicy(root, settings().computerUse);
      const changed = settings();
      changed.computerUse.apps.push({
        appId: 'malicious',
        label: 'self-grant',
        capabilities: { observe: 'allow' },
      });
      saveAgentSettings(root, changed);
      expect(loadAgentSettings(root).computerUse.enabled).toBe(false);
      writeFileSync(
        join(root, 'koryphaios.json'),
        JSON.stringify({
          agentSettings: { computerUse: { enabled: 1, byRole: { manager: null } } },
        }),
      );
      expect(loadAgentSettings(root).computerUse.enabled).toBe(false);
      expect(loadAgentSettings(root).computerUse.byRole.manager.observe).toBe('block');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('computer policy', () => {
  it('combines tier, role and app gates with deny > ask > allow', () => {
    const policy = settings().computerUse;
    expect(decideComputerPermission(policy, 'yolo', 'manager', 'observe', target.appId)).toBe(
      'allow',
    );
    policy.byRole.manager.observe = 'ask';
    expect(decideComputerPermission(policy, 'ask', 'manager', 'observe', target.appId)).toBe('ask');
    expect(decideComputerPermission(policy, 'yolo', 'manager', 'observe', target.appId)).toBe(
      'allow',
    );
    policy.byTier.yolo.observe = 'block';
    expect(decideComputerPermission(policy, 'yolo', 'manager', 'observe', target.appId)).toBe(
      'block',
    );
  });
  it('requires an exact app grant, except discovery', () => {
    const policy = settings().computerUse;
    expect(decideComputerPermission(policy, 'yolo', 'manager', 'observe', 'other')).toBe('block');
    expect(decideComputerPermission(policy, 'yolo', 'manager', 'discover')).toBe('allow');
  });
  it('lets configured Plan/Critic actions ask or allow, while reserved capabilities remain unavailable', () => {
    const policy = settings().computerUse;
    for (const capability of ['interact', 'manageWindows'] as const) {
      expect(decideComputerPermission(policy, 'plan', 'manager', capability, target.appId)).toBe(
        'allow',
      );
      expect(decideComputerPermission(policy, 'yolo', 'critic', capability, target.appId)).toBe(
        'allow',
      );
    }
    for (const capability of ['clipboardRead', 'clipboardWrite', 'transfer', 'sensitive'] as const)
      expect(decideComputerPermission(policy, 'yolo', 'manager', capability, target.appId)).toBe(
        'block',
      );
  });
});

describe('computer tools', () => {
  it('never calls native discovery when policy blocks or role is absent', async () => {
    const disabled = settings();
    disabled.computerUse.enabled = false;
    const f = fixture(disabled);
    expect((await f.run()).isError).toBe(true);
    f.setSettings(settings());
    expect((await f.run('computer_click', { ...ctx, callerRole: undefined })).isError).toBe(true);
    expect(f.calls).toEqual([]);
  });
  it('host resolves app/window identity; agent-supplied pid or title is rejected', async () => {
    const f = fixture();
    expect((await f.run()).isError).toBe(false);
    expect(f.calls.at(-1)).toMatchObject({ kind: 'click', target });
    expect(
      (
        await f.run('computer_click', ctx, {
          appId: target.appId,
          windowId: '42',
          x: 1,
          y: 1,
          pid: 999,
        })
      ).isError,
    ).toBe(true);
  });
  it('refuses mismatched app ownership and ambiguous windows', async () => {
    const f = fixture();
    f.setTargets([{ ...target, appId: 'other' }]);
    expect((await f.run()).isError).toBe(true);
    f.setTargets([target, target]);
    expect((await f.run()).isError).toBe(true);
    expect(f.calls.every((call) => call.kind === 'discover')).toBe(true);
  });
  it('requires exact approval and rechecks changed app permission afterward', async () => {
    const initial = settings();
    initial.computerUse.apps[0].capabilities.interact = 'ask';
    const f = fixture(initial);
    const result = await f.run('computer_click', {
      ...ctx,
      waitForUserInput: async () => {
        const revoked = settings();
        revoked.computerUse.apps = [];
        f.setSettings(revoked);
        return 'Allow once';
      },
    });
    expect(result.isError).toBe(true);
    expect(f.calls.every((call) => call.kind === 'discover')).toBe(true);
    f.setSettings(initial);
    expect(
      (await f.run('computer_click', { ...ctx, waitForUserInput: async () => 'yes' })).isError,
    ).toBe(true);
  });
  it('re-resolves identity after approval and rejects process replacement', async () => {
    const initial = settings();
    initial.computerUse.byTier.ask.interact = 'ask';
    const f = fixture(initial);
    expect(
      (
        await f.run('computer_click', {
          ...ctx,
          waitForUserInput: async () => {
            f.setTargets([{ ...target, pid: 999 }]);
            return 'Allow once';
          },
        })
      ).isError,
    ).toBe(true);
    expect(f.calls.every((call) => call.kind === 'discover')).toBe(true);
  });
  it('uses the Plan action policy and asks rather than applying a hidden hard block', async () => {
    const f = fixture();
    const result = await f.run('computer_click', {
      ...ctx,
      permissionPolicy: { mode: 'plan' } as ToolContext['permissionPolicy'],
      waitForUserInput: async () => 'Allow once',
    });
    expect(result.isError).toBe(false);
    expect(f.calls.some((call) => call.kind === 'click')).toBe(true);
  });
  it('returns authorized screenshots in image transport, not textual base64', async () => {
    const f = fixture();
    const result = await f.run('computer_observe', ctx, {
      appId: target.appId,
      windowId: target.windowId,
    });
    expect(result.isError).toBe(false);
    expect((result as typeof result & { images: unknown }).images).toEqual([
      { mimeType: 'image/png', data: 'cG5n' },
    ]);
    expect(result.output).not.toContain('cG5n');
  });
  it('binds approval to immutable arguments even if the original call object changes', async () => {
    const initial = settings();
    initial.computerUse.byTier.ask.interact = 'ask';
    const f = fixture(initial);
    const input = { appId: target.appId, windowId: target.windowId, x: 2, y: 3 };
    const result = await f.run(
      'computer_click',
      {
        ...ctx,
        waitForUserInput: async () => {
          input.x = 900;
          input.appId = 'other';
          return 'Allow once';
        },
      },
      input,
    );
    expect(result.isError).toBe(false);
    expect(f.calls.at(-1)).toMatchObject({ kind: 'click', x: 2, target });
  });
  it('discards an observation if grants are revoked during native capture', async () => {
    const f = fixture();
    const execute = f.adapter.execute;
    f.adapter.execute = async (action, signal) => {
      const result = await execute(action, signal);
      if (action.kind === 'observe') {
        const revoked = settings();
        revoked.computerUse.apps = [];
        f.setSettings(revoked);
      }
      return result;
    };
    const result = await f.run('computer_observe', ctx, {
      appId: target.appId,
      windowId: target.windowId,
    });
    expect(result.isError).toBe(true);
    expect('images' in result).toBe(false);
  });
  it('settings persistence revokes a pending approval without waiting for the user', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-computer-revoke-'));
    const initial = settings();
    initial.computerUse.byTier.ask.interact = 'ask';
    const f = fixture(initial);
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      saveAgentSettings(root, initial);
      const run = f.run('computer_click', {
        ...ctx,
        waitForUserInput: () => {
          entered();
          return new Promise(() => undefined);
        },
      });
      await ready;
      const revoked = settings();
      revoked.computerUse.enabled = false;
      saveAgentSettings(root, revoked);
      expect((await run).isError).toBe(true);
      expect(f.calls.every((call) => call.kind === 'discover')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('stop aborts pending approval and a late approval cannot perform input', async () => {
    const initial = settings();
    initial.computerUse.byTier.ask.interact = 'ask';
    const f = fixture(initial);
    let approve!: (value: string) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = f.run('computer_click', {
      ...ctx,
      waitForUserInput: () => {
        entered();
        return new Promise((resolve) => {
          approve = resolve;
        });
      },
    });
    await ready;
    stopComputerUse();
    expect((await run).isError).toBe(true);
    approve('Allow once');
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(f.calls.every((call) => call.kind === 'discover')).toBe(true);
    expect((await fixture().run()).isError).toBe(false);
  });
});

describe('global desktop serialization', () => {
  it('serializes different callers and cancels queued work on stop', async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let secondRan = false;
    const first = withComputerUseLock(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    const second = withComputerUseLock(async () => {
      secondRan = true;
    });
    const failures = Promise.allSettled([first, second]);
    expect(secondRan).toBe(false);
    stopComputerUse();
    expect((await failures).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(secondRan).toBe(false);
    release();
    await withComputerUseLock(async () => undefined);
    expect(secondRan).toBe(false);
  });
  it('times out without releasing a still-running native operation lock', async () => {
    let release!: () => void;
    const first = withComputerUseLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      undefined,
      5,
    );
    await expect(first).rejects.toThrow('timed out');
    let ran = false;
    const second = withComputerUseLock(async () => {
      ran = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(ran).toBe(false);
    release();
    await second;
    expect(ran).toBe(true);
  });
});
