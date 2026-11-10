import { describe, expect, test } from 'bun:test';
import { parseAntigravityStreamLine, parseAntigravityTranscriptTools } from '../antigravity';

describe('Antigravity stream-json parser', () => {
  test('streams agent response deltas without waiting for process exit', () => {
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: 'step_update',
          step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hello' },
        }),
      ),
    ).toEqual([{ type: 'content_delta', content: 'Hello' }]);
  });

  test('keeps final turn accounting separate from exact live context evidence', () => {
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            usage: { input_tokens: 18_867, output_tokens: 18, cache_read_tokens: 4_000 },
          },
        }),
      ),
    ).toEqual([
      {
        type: 'usage_update',
        tokensIn: 18_867,
        tokensOut: 18,
        estimated: true,
        tokensCache: 4_000,
        tokensCacheRead: 4_000,
      },
    ]);
  });

  test('does not leak stream protocol or malformed lines into chat', () => {
    expect(parseAntigravityStreamLine('{not-json')).toEqual([]);
    expect(parseAntigravityStreamLine(JSON.stringify({ event: 'init' }))).toEqual([]);
  });

  test('reports the CLI authentication reason instead of a bare ERROR status', () => {
    const events = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: { status: 'ERROR', error: 'authentication failed or timed out' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('Antigravity authentication failed');
    expect(events[0].error).toContain('authentication failed or timed out');
    expect(events[0].errorTransient).toBe(false);
  });

  test('marks upstream 503 errors retryable before truncating the reason', () => {
    const events = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: {
          status: 'ERROR',
          error: `Eligibility check failed: ${'detail '.repeat(50)}UNAVAILABLE (code 503): The service is currently unavailable.`,
        },
      }),
    );
    expect(events[0].errorTransient).toBe(true);
    expect(events[0].error).toContain('temporary upstream service error');
    expect(events[0].error!.length).toBeLessThan(450);
  });

  test('redacts credentials in result errors and retains useful model failures', () => {
    const events = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: {
          status: 'ERROR',
          error: 'invalid model selection; access_token=synthetic-secret-value',
        },
      }),
    );
    expect(events[0].error).toContain('invalid model selection');
    expect(events[0].error).not.toContain('synthetic-secret-value');
    expect(events[0].errorTransient).toBe(false);
  });

  test('retains a useful fallback when an older CLI supplies no error reason', () => {
    const events = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: { status: 'ERROR' },
      }),
    );
    expect(events[0].type).toBe('error');
    expect(events[0].error).toContain('Turn ended with status ERROR');
    expect(events[0].errorTransient).toBe(false);
  });
});

describe('Antigravity transcript tool identity', () => {
  test('pairs generic denied results with exact planner tool names and arguments across polls', () => {
    const pending: Array<{ name: string; args?: Record<string, unknown> }> = [];
    expect(parseAntigravityTranscriptTools({
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        { name: 'view_file', args: { AbsolutePath: '/workspace/AGENTS.md' } },
        { name: 'run_command', args: { CommandLine: 'git status' } },
      ],
    }, pending)).toEqual([]);

    expect(parseAntigravityTranscriptTools({
      type: 'GENERIC', status: 'ERROR', error: 'Permission denied',
      content: 'Encountered error in step execution: Permission denied',
    }, pending)).toEqual([{
      type: 'tool_executed', toolName: 'view_file',
      toolInput: '{"AbsolutePath":"/workspace/AGENTS.md"}',
      toolOutput: 'Encountered error in step execution: Permission denied', isError: true,
    }]);
    expect(parseAntigravityTranscriptTools({
      type: 'RUN_COMMAND', status: 'DONE', content: 'clean',
    }, pending)).toEqual([{
      type: 'tool_executed', toolName: 'run_command',
      toolInput: '{"CommandLine":"git status"}', toolOutput: 'clean', isError: false,
    }]);
    expect(pending).toEqual([]);
  });

  test('keeps function names when result classifications differ and results have no output', () => {
    const pending = [{ name: 'replace_file_content', args: { TargetFile: '/workspace/app.ts' } }];
    expect(parseAntigravityTranscriptTools({ type: 'CODE_ACTION', status: 'DONE' }, pending)).toEqual([{
      type: 'tool_executed', toolName: 'replace_file_content',
      toolInput: '{"TargetFile":"/workspace/app.ts"}', toolOutput: '', isError: false,
    }]);
    expect(pending).toEqual([]);
  });

  test('identifies the destination MCP tool and its input', () => {
    const pending = [{ name: 'call_mcp_tool', args: {
      server_name: 'kory', tool_name: 'kory__read_file', arguments: { path: 'README.md' },
    } }];
    expect(parseAntigravityTranscriptTools({ type: 'GENERIC', status: 'DONE', content: 'contents' }, pending)).toEqual([{
      type: 'tool_executed', toolName: 'mcp__kory__kory__read_file',
      toolInput: '{"path":"README.md"}', toolOutput: 'contents', isError: false,
    }]);
  });

  test('retains a third-party MCP server and decodes serialized arguments', () => {
    const pending = [{ name: 'call_mcp_tool', args: {
      server_name: 'github', tool_name: 'list_issues', arguments: '{"repo":"app"}',
    } }];
    expect(parseAntigravityTranscriptTools({ type: 'GENERIC', status: 'DONE', content: 'issues' }, pending)).toEqual([{
      type: 'tool_executed', toolName: 'mcp__github__list_issues',
      toolInput: '{"repo":"app"}', toolOutput: 'issues', isError: false,
    }]);
  });

  test('normalizes Kory MCP destinations with hyphenated names', () => {
    const pending = [{ name: 'call_mcp_tool', args: {
      ServerName: 'kory', ToolName: 'kory__suggest-fixes', Arguments: { error: 'bad import' },
    } }];
    expect(parseAntigravityTranscriptTools({ type: 'GENERIC', status: 'DONE', content: 'suggestion' }, pending)).toEqual([{
      type: 'tool_executed', toolName: 'mcp__kory__kory__suggest-fixes',
      toolInput: '{"error":"bad import"}', toolOutput: 'suggestion', isError: false,
    }]);
  });

  test('resolves Antigravity native MCP argument casing', () => {
    const pending = [{ name: 'call_mcp_tool', args: {
      ServerName: 'kory', ToolName: 'kory__rename_session', Arguments: { title: 'Rename support' },
    } }];
    expect(parseAntigravityTranscriptTools({ type: 'GENERIC', status: 'DONE', content: 'renamed' }, pending)).toEqual([{
      type: 'tool_executed', toolName: 'mcp__kory__kory__rename_session',
      toolInput: '{"title":"Rename support"}', toolOutput: 'renamed', isError: false,
    }]);
  });

  test('retains server identity when a dispatcher does not report its destination tool', () => {
    const pending = [{ name: 'call_mcp_tool', args: { server_name: 'github', arguments: {} } }];
    const result = parseAntigravityTranscriptTools({ type: 'GENERIC', status: 'DONE', content: 'done' }, pending);
    expect(result[0]?.toolName).toBe('call_mcp_tool');
    expect(JSON.parse(result[0]?.toolInput ?? '{}')).toMatchObject({ server_name: 'github' });
  });

  test('surfaces unpaired generic failures without inventing a tool name', () => {
    expect(parseAntigravityTranscriptTools({ type: 'GENERIC', status: 'ERROR', error: 'Tool denied' }, [])).toEqual([
      { type: 'error', error: 'Tool denied' },
    ]);
    expect(parseAntigravityTranscriptTools({ type: 'USER_INPUT', content: 'Hello' }, [])).toEqual([]);
  });
});
