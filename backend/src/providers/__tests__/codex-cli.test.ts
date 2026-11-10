import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  buildCodexPrompt,
  codexImageArgs,
  codexJsonEvents,
  codexReasoningArgs,
  codexTransientExhaustedMessage,
  codexTransientFailureMessage,
  extractKoryToolEnvelope,
  isCodexAuthFailure,
  isCodexTurnTokenFailure,
  isTransientCodexFailure,
} from '../codex-cli';
import { createCliAttachmentScope } from '../cli-attachments';
import { supportsKoryControlPlaneTools } from '../provider-harness';

describe('Codex CLI Kory control-plane bridge', () => {
  it('converts an allowed explicit envelope without leaking it into visible content', () => {
    const result = extractKoryToolEnvelope(
      'Delegating now.\n<KORY_TOOL_CALL>{"name":"delegate_to_worker","input":{"task":"audit","domain":"review"}}</KORY_TOOL_CALL>',
      ['delegate_to_worker'],
    );

    expect(result.content).toBe('Delegating now.');
    expect(result.tool).toEqual({
      name: 'delegate_to_worker',
      input: { task: 'audit', domain: 'review' },
    });
  });

  it('allows the role-filtered resource budget tool through the envelope', () => {
    expect(
      extractKoryToolEnvelope(
        '<KORY_TOOL_CALL>{"name":"get_resource_budget","input":{}}</KORY_TOOL_CALL>',
        ['get_resource_budget'],
      ).tool,
    ).toEqual({ name: 'get_resource_budget', input: {} });
  });

  it('does not turn malformed or unauthorized text into a Kory tool call', () => {
    expect(
      extractKoryToolEnvelope(
        '<KORY_TOOL_CALL>{"name":"shell","input":{"command":"rm -rf /"}}</KORY_TOOL_CALL>',
        ['delegate_to_worker'],
      ).tool,
    ).toBeUndefined();
    expect(
      extractKoryToolEnvelope('<KORY_TOOL_CALL>not-json</KORY_TOOL_CALL>', ['delegate_to_worker'])
        .tool,
    ).toBeUndefined();
  });

  it('only exposes Kory control-plane tools to CLI harnesses with a real bridge', () => {
    for (const provider of ['codex', 'claude', 'grok', 'antigravity', 'cursor', 'devin', 'cline']) {
      expect(supportsKoryControlPlaneTools(provider)).toBe(true);
    }
    expect(supportsKoryControlPlaneTools('gemini-cli')).toBe(false);
    expect(supportsKoryControlPlaneTools('codebuff')).toBe(false);
  });

  it('requests and surfaces the official Codex reasoning summary', () => {
    expect(codexReasoningArgs('high')).toEqual([
      '--config',
      'model_reasoning_effort="high"',
      '--config',
      'model_reasoning_summary="detailed"',
    ]);
    expect(codexReasoningArgs(undefined)).toEqual([]);

    const translated = codexJsonEvents(
      {
        type: 'item.completed',
        item: { type: 'reasoning', text: '**Checking the workflow contract**' },
      },
      [],
    );
    // One thinking_delta per completed reasoning item, paragraph-delimited so
    // the WS coalescer's verbatim concatenation can't glue summaries mid-word.
    expect(translated.events).toEqual([
      { type: 'thinking_delta', thinking: '**Checking the workflow contract**\n\n' },
    ]);
  });

  it('reads newer-CLI reasoning summaries and separates them as paragraphs', () => {
    const translated = codexJsonEvents(
      {
        type: 'item.completed',
        item: {
          type: 'reasoning',
          summary: [
            { text: 'Computing repository fixes and compaction behavior' },
            { text: 'Inspecting repository and validated image failure' },
          ],
        },
      },
      [],
    );
    expect(translated.events).toEqual([
      {
        type: 'thinking_delta',
        thinking:
          'Computing repository fixes and compaction behavior\n\nInspecting repository and validated image failure\n\n',
      },
    ]);
  });

  it('keeps consecutive reasoning items separable after verbatim concatenation', () => {
    const first = codexJsonEvents(
      { type: 'item.completed', item: { type: 'reasoning', text: 'First summary' } },
      [],
    );
    const second = codexJsonEvents(
      { type: 'item.completed', item: { type: 'reasoning', text: 'Second summary' } },
      [],
    );
    // Simulate the WS coalescer joining consecutive thinking payloads with ''.
    const joined =
      (first.events[0] as { thinking: string }).thinking +
      (second.events[0] as { thinking: string }).thinking;
    expect(joined).toContain('First summary\n\nSecond summary');
    expect(joined).not.toContain('summarySecond');
  });

  it('surfaces native file/web/todo items as display-only tool rows instead of dropping them', () => {
    const file = codexJsonEvents(
      {
        type: 'item.completed',
        item: { type: 'file_change', path: 'src/a.ts', kind: 'update', diff: '+x' },
      },
      [],
    );
    expect(file.events).toEqual([
      {
        type: 'tool_executed',
        toolName: 'file_change',
        toolInput: '{"path":"src/a.ts"}',
        toolOutput: '+x',
        isError: false,
      },
    ]);

    const search = codexJsonEvents(
      { type: 'item.completed', item: { type: 'web_search', query: 'codex jsonl' } },
      [],
    );
    expect(search.events[0]).toMatchObject({ type: 'tool_executed', toolName: 'web_search', toolInput: '{"query":"codex jsonl"}' });

    const todos = codexJsonEvents(
      {
        type: 'item.completed',
        item: { type: 'todo_list', items: [{ text: 'Fix parser', completed: true }] },
      },
      [],
    );
    expect(todos.events[0]).toMatchObject({ type: 'tool_executed', toolName: 'todo_list' });
  });

  it('emits nothing for empty reasoning items', () => {
    expect(
      codexJsonEvents({ type: 'item.completed', item: { type: 'reasoning' } }, []).events,
    ).toEqual([]);
    expect(
      codexJsonEvents({ type: 'item.completed', item: { type: 'reasoning', summary: [] } }, [])
        .events,
    ).toEqual([]);
  });

  it('does not pretend private reasoning is visible when reasoning is disabled', () => {
    expect(codexReasoningArgs('none')).toEqual(['--config', 'model_reasoning_effort="none"']);
  });

  it('reports cumulative codex turn totals as estimated occupancy with explicit billing', () => {
    const translated = codexJsonEvents(
      {
        type: 'turn.completed',
        usage: { input_tokens: 211_700, cached_input_tokens: 199_200, output_tokens: 900 },
      },
      [],
    );

    // turn.completed input_tokens sums every internal request of the exec, so
    // it must never be mistaken for exact live occupancy downstream.
    expect(translated.events).toContainEqual({
      type: 'usage_update',
      tokensIn: 211_700,
      tokensOut: 900,
      estimated: true,
      usagePrecision: 'provider-reported',
      billingTokensIn: 211_700,
      billingTokensOut: 900,
      tokensCacheRead: 199_200,
      accountId: undefined,
    });
  });

  it('passes an attached screenshot to Codex through its native private image argument', () => {
    const scope = createCliAttachmentScope();
    const imageData = Buffer.from('not-in-argv-or-prompt-as-base64').toString('base64');
    let imagePath = '';
    try {
      const prompt = buildCodexPrompt(
        'Inspect the supplied screenshot.',
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What controls are visible?' },
              { type: 'image', imageData, imageMimeType: 'image/png' },
            ],
          },
        ],
        [],
        'manager',
        scope,
      );

      const args = codexImageArgs(scope);
      expect(args).toHaveLength(2);
      expect(args[0]).toBe('--image');
      imagePath = args[1]!;
      expect(existsSync(imagePath)).toBe(true);
      expect(prompt).toContain(imagePath);
      expect(prompt).not.toContain(imageData);

      // Rehydrated history containing the same image does not create a second
      // native input flag for the same bytes.
      scope.renderContent([{ type: 'image', imageData, imageMimeType: 'image/png' }]);
      expect(scope.artifacts).toHaveLength(1);
    } finally {
      scope.cleanup();
    }
    expect(existsSync(imagePath)).toBe(false);
  });
});

describe('Codex transient ChatGPT disconnect classification', () => {
  // Exact user-reported stderr: the CLI's own 1/5 retry loop exhausted on a
  // ChatGPT-side blip and the process exited nonzero.
  const REPORTED_STDERR =
    'Reconnecting... 1/5 (stream disconnected before completion: ' +
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.)";

  it('classifies the reported transient stderr as retriable', () => {
    expect(isTransientCodexFailure(REPORTED_STDERR)).toBe(true);
    expect(isCodexAuthFailure(REPORTED_STDERR)).toBe(false);
  });

  it('classifies socket/ECONNRESET/429-adjacent blips as retriable', () => {
    for (const text of [
      'socket hang up',
      'read ECONNRESET',
      'request failed with status 429',
      'ChatGPT rate limit reached, retry shortly',
      'upstream service unavailable',
      'Bad gateway from upstream',
      'Codex hit a transient ChatGPT disconnect. Nothing was lost — retry the turn.',
    ]) {
      expect(isTransientCodexFailure(text)).toBe(true);
    }
  });

  it('keeps real auth failures fail-closed', () => {
    for (const text of [
      'Codex CLI is not signed in. Run `codex login` in your terminal, then reconnect.',
      'Codex CLI authentication failed. Run "codex login", then reconnect.',
      'invalid api key',
      '401 unauthorized',
      'permission forbidden by workspace policy',
      'Not logged in - please run codex login',
      ' expired token: please sign in again',
    ]) {
      expect(isTransientCodexFailure(text)).toBe(false);
    }
    expect(isCodexAuthFailure('Not logged in - please run codex login')).toBe(true);
  });

  it('does not treat ordinary failures as transient', () => {
    expect(isTransientCodexFailure('')).toBe(false);
    expect(isTransientCodexFailure('exit code 1')).toBe(false);
    expect(isTransientCodexFailure(undefined)).toBe(false);
  });

  it('emits an honest banner without leaking upstream detail', () => {
    expect(codexTransientFailureMessage()).toContain('transient ChatGPT disconnect');
    expect(codexTransientFailureMessage()).toContain('Nothing was lost');
    expect(codexTransientFailureMessage()).not.toContain('provider said');
    const exhausted = codexTransientExhaustedMessage(3);
    expect(exhausted).toContain('after 3 attempts');
    expect(exhausted).toContain('Nothing was lost');
    expect(exhausted).not.toContain('provider said');
  });

  it('keeps the exhausted banner itself machine-recognizable as transient', () => {
    // The registry re-evaluates yielded errors; the banner it finally emits
    // must not look like a new failure class.
    expect(isTransientCodexFailure(codexTransientExhaustedMessage(3))).toBe(true);
  });

  it('translates a transient turn.failed into the honest banner', () => {
    const { events, completed } = codexJsonEvents(
      { type: 'turn.failed', error: { message: REPORTED_STDERR } },
      [],
    );
    expect(completed).toBe(true);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err?.error).toContain('transient ChatGPT disconnect');
    expect(err?.error).not.toContain('Reconnecting');
  });
});

describe('Codex stale turn-token binding classification', () => {
  // Exact broker wordings (codex-chatgpt-web turn broker `claim`/owner paths).
  // A fresh turn mints a fresh token, so these are retriable, never auth.
  const GENERIC = 'turn token is invalid, expired, or revoked';
  const OWNER_TWIN = 'turn token is invalid or expired';
  const SPECIFIC =
    'This turn_token was issued for Codex turn 92bb8870a17a, which has already finished. ' +
    'This Codex Native action can no longer run.';
  const BINDING_TWIN =
    'Codex turn 92bb8870a17a has already finished; this Codex Native action can no longer run.';

  it('classifies every stale-binding wording as retriable, never auth', () => {
    for (const text of [
      GENERIC,
      OWNER_TWIN,
      SPECIFIC,
      BINDING_TWIN,
      `mcp__kory__exec failed: ${GENERIC}`,
      'Step 2 failed — turn token is invalid, expired, or revoked before reaching the workspace.',
    ]) {
      expect(isCodexTurnTokenFailure(text)).toBe(true);
      expect(isTransientCodexFailure(text)).toBe(true);
      expect(isCodexAuthFailure(text)).toBe(false);
    }
  });

  it('keeps genuine credential failures fail-closed around token words', () => {
    // Reverse-order `invalid token` / `expired token` remain auth, and the
    // auth veto still wins over turn-token wording when both appear.
    expect(isCodexTurnTokenFailure('invalid token: please sign in again')).toBe(false);
    expect(isTransientCodexFailure(' expired token: please sign in again')).toBe(false);
    expect(isTransientCodexFailure(`${GENERIC}. Run "codex login", then reconnect.`)).toBe(false);
    expect(isTransientCodexFailure('')).toBe(false);
    expect(isCodexTurnTokenFailure(undefined)).toBe(false);
  });

  it('converts agent_message token narration into the retriable banner', () => {
    const { events, completed } = codexJsonEvents(
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'Step 1 ok. Step 2 failed — turn token is invalid, expired, or revoked.',
        },
      },
      [],
    );
    expect(completed).toBe(true);
    expect(events.some((e) => e.type === 'content_delta')).toBe(false);
    const err = events.find((e) => e.type === 'error');
    expect(err?.error).toContain('transient ChatGPT disconnect');
    expect(err?.error).not.toContain('turn token');
  });

  it('leaves ordinary agent narration untouched', () => {
    const { events, completed } = codexJsonEvents(
      { type: 'item.completed', item: { type: 'agent_message', text: 'Done. All checks pass.' } },
      [],
    );
    expect(completed).toBe(false);
    expect(events).toEqual([{ type: 'content_delta', content: 'Done. All checks pass.' }]);
  });

  it('converts an MCP tool row carrying the token error into the banner', () => {
    const { events } = codexJsonEvents(
      {
        type: 'item.completed',
        item: {
          type: 'mcp_call',
          server_name: 'kory',
          tool_name: 'exec',
          arguments: { cmd: 'pwd' },
          result: GENERIC,
        },
      },
      [],
    );
    expect(events.some((e) => e.type === 'tool_executed')).toBe(false);
    const err = events.find((e) => e.type === 'error');
    expect(err?.error).toContain('transient ChatGPT disconnect');
  });
});
