import { describe, expect, test } from 'bun:test';
import {
  buildHookBody,
  encodeHookDecision,
  parseArgs,
  readToolCall,
  resolveHookAuthFile,
} from '../kory-hook-bridge';
import { createKoryBridgeGrantLease } from '../bridge-grant';

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
    expect(encodeHookDecision({ decision: 'block', reason: 'no' }, 'claude', 'PreToolUse')).toEqual(
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'no',
        },
      },
    );
    expect(encodeHookDecision({ decision: 'approve', reason: '' }, 'claude', 'PreToolUse')).toEqual(
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: '',
        },
      },
    );
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
      const encoded = encodeHookDecision({ decision: internal, reason: 'r' }, 'antigravity') as {
        decision: string;
      };
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

  test('prefers a live KORY_BRIDGE_AUTH_FILE over a stale CLI --auth-file', () => {
    const lease = createKoryBridgeGrantLease('session-live', 'worker');
    try {
      const grant = lease.grant(['hook:pre-tool']);
      expect(resolveHookAuthFile('/stale/revoked/bridge-grant.json', grant.path)).toBe(grant.path);
      expect(resolveHookAuthFile('/cli/grant.json', '/missing/env-grant.json')).toBe(
        '/cli/grant.json',
      );
    } finally {
      lease.cleanup();
    }
  });
});

describe('hook bridge request body', () => {
  // The backend re-digests the body after Elysia normalizes it to the route's
  // declared schema — undeclared keys are stripped, which silently 401s any
  // request that signed them. These contracts mirror the t.Object schemas in
  // routes/v1/mcp-bridge.ts.
  const sid = 'sess-1';
  const toolPayload = {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { success: true },
  };

  test('pre-tool and permission sign session_id + tool_name + tool_input', () => {
    for (const endpoint of ['pre-tool', 'permission']) {
      expect(buildHookBody(endpoint, toolPayload, sid)).toEqual({
        session_id: sid,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
    }
  });

  test('post-tool signs tool_response and never tool_input', () => {
    const body = buildHookBody('post-tool', toolPayload, sid);
    expect(body).toEqual({
      session_id: sid,
      tool_name: 'Bash',
      tool_response: { success: true },
    });
    expect('tool_input' in body).toBe(false);
  });

  test('non-tool events sign session_id only', () => {
    for (const endpoint of ['prompt-submit', 'stop', 'session-start', 'session-end']) {
      const body = buildHookBody(endpoint, toolPayload, sid);
      expect(body).toEqual({ session_id: sid });
    }
  });

  test('tool fields do not leak into non-tool bodies even when payload carries them', () => {
    // Non-tool hook payloads leave tool_name ''/tool_input {} — sending those
    // undeclared keys is what desynced the HMAC and caused the 401 storm.
    const body = buildHookBody('stop', { tool_name: '', tool_input: {} }, sid);
    expect(body).toEqual({ session_id: sid });
  });
});

describe('hook bridge provider hint', () => {
  const sid = 'session-1';
  const toolPayload = { tool_name: 'Bash', tool_input: { command: 'ls' } };

  test('parseArgs reads --provider and defaults to empty', () => {
    expect(parseArgs(['node', 'bridge.ts', '--event', 'PreToolUse']).provider).toBe('');
    expect(
      parseArgs(['node', 'bridge.ts', '--event', 'PreToolUse', '--provider', 'devin']).provider,
    ).toBe('devin');
  });

  test('buildHookBody signs provider only when configured', () => {
    expect(buildHookBody('pre-tool', toolPayload, sid, 'devin')).toEqual({
      session_id: sid,
      provider: 'devin',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    // Absent or empty stays undeclared so the signed digest still matches a
    // schema that only knows provider as optional.
    expect('provider' in buildHookBody('pre-tool', toolPayload, sid)).toBe(false);
    expect('provider' in buildHookBody('pre-tool', toolPayload, sid, '')).toBe(false);
    // Non-tool endpoints never sign provider — their schemas don't declare it.
    expect(buildHookBody('stop', toolPayload, sid, 'devin')).toEqual({ session_id: sid });
    expect(buildHookBody('prompt-submit', toolPayload, sid, 'devin')).toEqual({
      session_id: sid,
    });
  });
});
