import { describe, expect, test } from 'bun:test';
import {
  encodeHookDecision,
  parseArgs,
  readToolCall,
} from '../kory-hook-bridge';

describe('hook bridge argument parsing', () => {
  const argv = (...extra: string[]) => ['node', 'bridge.ts', ...extra];

  test('defaults to the Claude approve/block vocabulary', () => {
    expect(parseArgs(argv('--event', 'PreToolUse')).decisionVocabulary).toBe('claude');
  });

  test('selects the antigravity vocabulary only when asked', () => {
    expect(
      parseArgs(argv('--event', 'PreToolUse', '--decision-vocabulary', 'antigravity'))
        .decisionVocabulary,
    ).toBe('antigravity');
    // An unrecognized value must not be trusted into agy's parser.
    expect(
      parseArgs(argv('--event', 'PreToolUse', '--decision-vocabulary', 'nonsense'))
        .decisionVocabulary,
    ).toBe('claude');
  });

  test('reads the auth file and event', () => {
    const parsed = parseArgs(argv('--auth-file', '/grant.json', '--event', 'Stop'));
    expect(parsed.authFile).toBe('/grant.json');
    expect(parsed.event).toBe('Stop');
  });
});

describe('hook bridge tool-call extraction', () => {
  test("reads agy's camelCase toolCall payload", () => {
    // agy sends protojson camelCase. Reading only snake_case yielded an empty
    // tool name, which every CLI then treated as an unknown tool.
    const call = readToolCall({
      toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /', Cwd: '/w' } },
      stepIdx: 19,
      conversationId: 'abc',
    });
    expect(call.toolName).toBe('run_command');
    expect(call.toolInput).toEqual({ CommandLine: 'rm -rf /', Cwd: '/w' });
  });

  test('still reads the snake_case payload other CLIs send', () => {
    const call = readToolCall({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(call.toolName).toBe('Bash');
    expect(call.toolInput).toEqual({ command: 'ls' });
  });

  test('degrades to empty rather than throwing on a malformed payload', () => {
    expect(readToolCall({})).toEqual({ toolName: '', toolInput: {} });
    expect(readToolCall({ toolCall: null })).toEqual({ toolName: '', toolInput: {} });
    expect(readToolCall({ toolCall: { name: 'x', args: 'not-an-object' } })).toEqual({
      toolName: 'x',
      toolInput: {},
    });
    expect(readToolCall({ toolCall: ['array'] })).toEqual({ toolName: '', toolInput: {} });
  });
});

describe('hook bridge decision encoding', () => {
  test('uses a top-level decision only for events that read one', () => {
    // Stop / UserPromptSubmit / PostToolUse take { decision, reason }.
    for (const event of ['Stop', 'UserPromptSubmit', 'PostToolUse']) {
      expect(encodeHookDecision({ decision: 'block', reason: 'no' }, 'claude', event)).toEqual({
        decision: 'block',
        reason: 'no',
      });
      // Approval is the default flow; an empty object is what these expect.
      expect(encodeHookDecision({ decision: 'approve', reason: '' }, 'claude', event)).toEqual({});
    }
  });

  test('uses hookSpecificOutput.permissionDecision for PreToolUse', () => {
    // Claude Code (and Devin, whose binary parses `ClaudeHookSpecificOutput`)
    // ignore a top-level `decision` on PreToolUse and read this instead. The
    // top-level form is what silently let the native-tool gate never run.
    expect(encodeHookDecision({ decision: 'block', reason: 'no' }, 'claude', 'PreToolUse')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'no',
      },
    });
    expect(
      encodeHookDecision({ decision: 'approve', reason: '' }, 'claude', 'PreToolUse'),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: '',
      },
    });
  });

  test('uses hookSpecificOutput.decision.behavior for PermissionRequest', () => {
    expect(
      encodeHookDecision({ decision: 'block', reason: 'no' }, 'claude', 'PermissionRequest'),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny' },
      },
    });
  });

  test('speaks allow/deny to agy', () => {
    // agy rejects any other decision word ("unsupported hook decision"), so
    // Claude's approve/block must never reach it.
    expect(encodeHookDecision({ decision: 'approve', reason: 'ok' }, 'antigravity')).toEqual({
      decision: 'allow',
      reason: 'ok',
    });
    expect(encodeHookDecision({ decision: 'block', reason: 'no' }, 'antigravity')).toEqual({
      decision: 'deny',
      reason: 'no',
    });
  });

  test('never emits a decision agy would reject', () => {
    for (const internal of ['approve', 'block', 'ask', 'force_ask', 'anything']) {
      const encoded = encodeHookDecision(
        { decision: internal, reason: 'r' },
        'antigravity',
      ) as { decision: string };
      expect(['allow', 'deny']).toContain(encoded.decision);
    }
  });

  test('carries the reason through so the agent can be redirected', () => {
    const encoded = encodeHookDecision(
      { decision: 'block', reason: 'Use kory__bash via the kory MCP server instead.' },
      'antigravity',
    );
    expect(encoded.reason).toContain('kory__bash');
  });
});