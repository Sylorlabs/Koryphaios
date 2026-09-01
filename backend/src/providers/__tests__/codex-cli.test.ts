import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  buildCodexPrompt,
  codexImageArgs,
  codexJsonEvents,
  codexReasoningArgs,
  extractKoryToolEnvelope,
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

  it('reports cached Codex input as included explanatory metadata', () => {
    const translated = codexJsonEvents(
      {
        type: 'turn.completed',
        usage: { input_tokens: 211_700, cached_input_tokens: 199_200, output_tokens: 900 },
      },
      [],
    );

    expect(translated.events).toContainEqual({
      type: 'usage_update',
      tokensIn: 211_700,
      tokensOut: 900,
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
      scope.renderContent([
        { type: 'image', imageData, imageMimeType: 'image/png' },
      ]);
      expect(scope.artifacts).toHaveLength(1);
    } finally {
      scope.cleanup();
    }
    expect(existsSync(imagePath)).toBe(false);
  });
});
