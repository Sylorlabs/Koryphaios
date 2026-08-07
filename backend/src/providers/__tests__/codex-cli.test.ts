import { describe, expect, it } from 'bun:test';
import { codexJsonEvents, codexReasoningArgs, extractKoryToolEnvelope } from '../codex-cli';
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
    expect(translated.events).toEqual([
      { type: 'thinking_delta', thinking: '**Checking the workflow contract**' },
    ]);
  });

  it('does not pretend private reasoning is visible when reasoning is disabled', () => {
    expect(codexReasoningArgs('none')).toEqual(['--config', 'model_reasoning_effort="none"']);
  });
});
