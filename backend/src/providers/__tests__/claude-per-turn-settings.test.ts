import { describe, expect, test } from 'bun:test';
import { buildClaudePerTurnSettings } from '../claude-code';
import type { CliHookConfig } from '../cli-bridge';

/** Mirrors ClaudeCodeCliBridge.serializeHooks: event name → matcher groups. */
function serialize(hooks: CliHookConfig[]): string {
  const payload: Record<
    string,
    Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string }> }>
  > = {};
  for (const hook of hooks) {
    for (const event of hook.events) {
      payload[event] = payload[event] ?? [];
      payload[event].push({
        matcher: hook.matcher ?? '',
        hooks: [{ type: 'command', command: hook.command }],
      });
    }
  }
  return JSON.stringify(payload, null, 2);
}

const hookConfigs: CliHookConfig[] = [
  {
    events: ['PreToolUse'],
    command: 'node bridge.ts --auth-file /grant.json --event PreToolUse',
    matcher: '',
  },
  { events: ['Stop'], command: 'node bridge.ts --auth-file /grant.json --event Stop', matcher: '' },
];

describe('claude per-turn settings', () => {
  test('nests hooks under the `hooks` key Claude Code reads', () => {
    const json = buildClaudePerTurnSettings(hookConfigs, serialize);
    const parsed = JSON.parse(json!);
    // Claude ignores a settings file without this key, and there is no
    // sibling hooks.json — which is why the previous file was never read.
    expect(Object.keys(parsed)).toEqual(['hooks']);
    expect(Object.keys(parsed.hooks).sort()).toEqual(['PreToolUse', 'Stop']);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('');
    expect(parsed.hooks.PreToolUse[0].hooks[0].type).toBe('command');
  });

  test('matches every tool so no native tool escapes unmatched', () => {
    const parsed = JSON.parse(buildClaudePerTurnSettings(hookConfigs, serialize)!);
    // Claude treats "*" and "" as match-all.
    for (const event of ['PreToolUse', 'Stop']) {
      expect(parsed.hooks[event][0].matcher).toBe('');
    }
  });

  test('carries the authenticated hook command through', () => {
    const parsed = JSON.parse(buildClaudePerTurnSettings(hookConfigs, serialize)!);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain('--auth-file');
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain('--event PreToolUse');
  });

  test('omits the flag entirely when there is nothing to inject', () => {
    expect(buildClaudePerTurnSettings(null, serialize)).toBeNull();
    expect(buildClaudePerTurnSettings([], serialize)).toBeNull();
  });

  test('produces valid JSON that survives argv quoting', () => {
    const json = buildClaudePerTurnSettings(hookConfigs, serialize)!;
    expect(() => JSON.parse(json)).not.toThrow();
    // No raw newlines: the value is passed as a single argv element.
    expect(json).not.toContain('\n');
    expect(json).not.toContain("'");
  });
});