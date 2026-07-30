import { describe, expect, it } from 'bun:test';
import { extractKoryToolEnvelope } from '../codex-cli';
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

  it('does not turn malformed or unauthorized text into a Kory tool call', () => {
    expect(
      extractKoryToolEnvelope(
        '<KORY_TOOL_CALL>{"name":"shell","input":{"command":"rm -rf /"}}</KORY_TOOL_CALL>',
        ['delegate_to_worker'],
      ).tool,
    ).toBeUndefined();
    expect(
      extractKoryToolEnvelope('<KORY_TOOL_CALL>not-json</KORY_TOOL_CALL>', ['delegate_to_worker']).tool,
    ).toBeUndefined();
  });

  it('only exposes Kory control-plane tools to CLI harnesses with a real bridge', () => {
    expect(supportsKoryControlPlaneTools('codex')).toBe(true);
    for (const provider of ['claude', 'grok', 'antigravity', 'cursor', 'cline']) {
      expect(supportsKoryControlPlaneTools(provider)).toBe(false);
    }
  });
});
