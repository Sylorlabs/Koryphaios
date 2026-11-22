import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAgentCurrentTool,
  noteAgentToolCall,
  noteAgentToolResult,
} from './agents.svelte';

describe('agent current-tool derivation', () => {
  it('sets the current tool on tool_call and clears it on tool_result', () => {
    noteAgentToolCall('s1', 'w1', { id: 'c1', name: 'bash', input: { command: 'ls' } });
    expect(getAgentCurrentTool('s1', 'w1')).toEqual({ name: 'bash', input: { command: 'ls' } });
    noteAgentToolResult('s1', 'w1', 'c1');
    expect(getAgentCurrentTool('s1', 'w1')).toBeUndefined();
  });

  it('tracks the latest in-flight call and is isolated per session/agent', () => {
    noteAgentToolCall('s1', 'w1', { id: 'a', name: 'grep' });
    noteAgentToolCall('s1', 'w1', { id: 'b', name: 'read_file' });
    noteAgentToolCall('s2', 'w1', { id: 'x', name: 'bash' });
    noteAgentToolCall('s1', 'w2', { id: 'y', name: 'edit_file' });
    noteAgentToolResult('s1', 'w1', 'b');
    expect(getAgentCurrentTool('s1', 'w1')).toEqual({ name: 'grep', input: undefined });
    expect(getAgentCurrentTool('s2', 'w1')).toEqual({ name: 'bash', input: undefined });
    expect(getAgentCurrentTool('s1', 'w2')).toEqual({ name: 'edit_file', input: undefined });
    noteAgentToolResult('s1', 'w1', 'a');
    noteAgentToolResult('s2', 'w1', 'x');
    noteAgentToolResult('s1', 'w2', 'y');
  });

  it('ignores events without a sessionId', () => {
    noteAgentToolCall(undefined, 'w1', { id: 'z', name: 'bash' });
    noteAgentToolResult(undefined, 'w1', 'z');
    expect(getAgentCurrentTool(undefined, 'w1')).toBeUndefined();
  });
});
