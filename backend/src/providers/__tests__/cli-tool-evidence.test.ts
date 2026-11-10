import { describe, expect, test } from 'bun:test';
import { parseGrokToolUpdate } from '../grok-build';
import { parseCursorToolCalls } from '../cursor';
import { freebuffToolEvents } from '../freebuff-cli';
import { DevinCliBridge } from '../devin-bridge';
import { DevinAcpClient } from '../devin-acp';
import { recordedToolInput, recordedToolName } from '../recorded-tool';
import type { ProviderEvent } from '../types';

describe('CLI tool identity and result evidence', () => {
  test('prefers recorded identifiers and preserves textual input without invented names', () => {
    expect(recordedToolName({ toolName: 'generic', function: { name: 'kory__read_file' } })).toBe('kory__read_file');
    expect(recordedToolName({ name: 'tool' })).toBeUndefined();
    expect(recordedToolInput('{"path":"README.md"}')).toEqual({ path: 'README.md' });
    expect(recordedToolInput('git status')).toEqual({ input: 'git status' });
  });

  test('Grok keeps exact names and full arguments across out-of-order updates', () => {
    const calls = new Map();
    expect(parseGrokToolUpdate({
      sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Reading documentation',
      toolName: 'kory__read_file', rawInput: { path: 'README.md', offset: 12 },
    }, calls)).toEqual([]);
    parseGrokToolUpdate({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'run_command', rawInput: { command: 'git status', cwd: '/workspace' } }, calls);
    const command = { sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed', rawOutput: 'Permission denied' };
    expect(parseGrokToolUpdate(command, calls)).toEqual([{
      type: 'tool_executed', toolCallId: 'b', toolName: 'run_command',
      toolInput: '{"command":"git status","cwd":"/workspace"}', toolOutput: 'Permission denied', isError: true,
    }]);
    expect(parseGrokToolUpdate(command, calls)).toEqual([]);
    expect(parseGrokToolUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawInput: { limit: 4 }, rawOutput: 'contents' }, calls)[0]).toMatchObject({
      toolName: 'kory__read_file', toolInput: '{"path":"README.md","offset":12,"limit":4}', toolOutput: 'contents', isError: false,
    });
  });

  test('Grok does not label a display sentence as a function or fabricate output', () => {
    const events = parseGrokToolUpdate({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Reading a file', status: 'completed' }, new Map());
    expect(events[0]).toMatchObject({ toolName: undefined, toolOutput: '' });
  });

  test('Grok emits a named tool row while retaining successful file previews', () => {
    const events = parseGrokToolUpdate({
      sessionUpdate: 'tool_call', toolCallId: 'a', title: 'create_file', status: 'completed',
      rawInput: { path: 'a.ts', content: 'new' }, rawOutput: 'written',
    }, new Map());
    expect(events).toContainEqual({ type: 'file_edit', filePath: 'a.ts', fileContent: 'new', fileOperation: 'create' });
    expect(events.find((event) => event.type === 'tool_executed')?.toolName).toBe('create_file');
  });

  test('Cursor resolves MCP destinations, retains all payloads, and reports failures', () => {
    const events = parseCursorToolCalls({ subtype: 'completed', call_id: 'cursor-1', tool_call: {
      mcpToolCall: { args: { tool_name: 'kory__read_file', arguments: '{"path":"a.ts"}' }, result: 'contents' },
      shellToolCall: { name: 'run_command', args: { command: 'git status' }, result: { isError: true, error: 'denied' } },
    } });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ toolName: 'kory__read_file', toolInput: '{"path":"a.ts"}', toolOutput: 'contents', isError: false });
    expect(events[1]).toMatchObject({ toolName: 'run_command', toolInput: '{"command":"git status"}', isError: true });
    expect(parseCursorToolCalls({ subtype: 'completed', tool_call: {} })).toEqual([]);
    expect(parseCursorToolCalls({ subtype: 'failed', tool_call: { generic: { result: 'denied' } } })[0]).toMatchObject({ toolName: undefined, isError: true });
  });

  test('Freebuff waits for results in later polls and matches them by ID exactly once', () => {
    const calls = new Map();
    const results = new Map();
    const emitted = new Set<string>();
    expect(freebuffToolEvents({ toolCalls: [
      { toolCallId: 'a', toolName: 'kory__read_file', input: { path: 'a.ts' } },
      { toolCallId: 'b', toolName: 'read_file', input: { path: 'b.ts', limit: 3 } },
    ] }, calls, results, emitted)).toEqual([]);
    expect(freebuffToolEvents({ toolResults: [{ toolCallId: 'b', content: 'sandbox contents', isError: false }] }, calls, results, emitted)).toEqual([{
      type: 'tool_executed', toolCallId: 'b', toolName: 'freebuff_sandbox__read_file',
      toolInput: '{"path":"b.ts","limit":3}', toolOutput: 'sandbox contents', isError: false,
    }]);
    expect(freebuffToolEvents({ toolResults: [{ toolCallId: 'a', content: 'denied', isError: true }] }, calls, results, emitted)[0]).toMatchObject({ toolName: 'kory__read_file', isError: true });
    expect(freebuffToolEvents({ toolCalls: [{ toolCallId: 'a', toolName: 'kory__read_file' }], toolResults: [{ toolCallId: 'a', content: 'duplicate' }] }, calls, results, emitted)).toEqual([]);
    expect(calls.size).toBe(0);
    expect(results.size).toBe(0);
  });

  test('Freebuff retains result-first evidence without replacing a missing name', () => {
    const calls = new Map();
    const results = new Map();
    const emitted = new Set<string>();
    expect(freebuffToolEvents({ toolResults: [{ toolCallId: 'a', content: 'done' }] }, calls, results, emitted)).toEqual([]);
    expect(freebuffToolEvents({ toolCalls: [{ toolCallId: 'a', input: '{"query":"term"}' }] }, calls, results, emitted)[0]).toMatchObject({ toolName: undefined, toolInput: '{"query":"term"}', toolOutput: 'done' });
  });

  test('Devin trajectories attach individual observations to the right calls', () => {
    const { events } = new DevinCliBridge().parseTrajectory(JSON.stringify({ steps: [
      { source: 'agent', tool_calls: [
        { tool_call_id: 'a', function_name: 'kory__read_file', arguments: '{"path":"a.ts"}' },
        { tool_call_id: 'b', function: { name: 'kory__bash', arguments: '{"command":"git status"}' } },
      ] },
      { source: 'tool', observation: { results: [
        { source_call_id: 'b', content: 'denied', is_error: true },
        { source_call_id: 'a', content: 'contents' },
      ] } },
      { source: 'agent', tool_calls: [{ arguments: { path: 'unknown' } }] },
    ] }));
    expect(events[0]).toMatchObject({ toolCallId: 'a', toolName: 'kory__read_file', toolInput: '{"path":"a.ts"}', toolOutput: 'contents', isError: false });
    expect(events[1]).toMatchObject({ toolCallId: 'b', toolName: 'kory__bash', toolInput: '{"command":"git status"}', toolOutput: 'denied', isError: true });
    expect(events[2]?.toolName).toBeUndefined();
    expect(events.every((event) => event.type === 'tool_executed')).toBe(true);
  });

  test('Devin ACP retains call identity on results without sending executable Kory tool events', async () => {
    const client = new DevinAcpClient({ binaryPath: '/fixture/devin', devinHome: '/fixture/home' });
    const transport = client as unknown as {
      sessionId: string;
      sendNotification: () => Promise<void>;
      sendRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      handleNotification: (notification: { method: string; params: Record<string, unknown> }) => void;
    };
    transport.sessionId = 'fixture-session';
    transport.sendNotification = async () => {};
    transport.sendRequest = async (_method, params) => {
      const notify = (method: string, event: Record<string, unknown>) => transport.handleNotification({ method, params: { messageId: params.messageId, ...event } });
      notify('event/tool_call', { toolCallId: 'a', toolName: 'kory__read_file', input: { path: 'a.ts' } });
      notify('event/tool_call', { toolCallId: 'b', toolName: 'kory__bash', input: { command: 'git status' } });
      notify('event/tool_result', { toolCallId: 'b', output: 'denied', isError: true });
      notify('event/tool_result', { toolCallId: 'a', output: 'contents' });
      notify('event/complete', { sessionId: 'fixture-session' });
      return {};
    };
    const events: ProviderEvent[] = [];
    for await (const event of client.sendMessage('Fixture turn')) events.push(event);
    expect(events[0]).toMatchObject({ type: 'tool_executed', toolCallId: 'b', toolName: 'kory__bash', toolInput: '{"command":"git status"}', toolOutput: 'denied', isError: true });
    expect(events[1]).toMatchObject({ type: 'tool_executed', toolCallId: 'a', toolName: 'kory__read_file', toolInput: '{"path":"a.ts"}', toolOutput: 'contents' });
    expect(events.some((event) => event.type.startsWith('tool_use'))).toBe(false);
  });
});
