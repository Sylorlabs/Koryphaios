import { describe, expect, test } from 'bun:test';
import type { ContextBreakdown } from '@koryphaios/shared';
import type { ProviderMessage } from '../../providers/types';
import { applyUsageOutput, estimateProviderMessagesChars } from '../manager';

const DISPATCH_BREAKDOWN: ContextBreakdown = {
  system: 10_000,
  memory: 2_000,
  skills: 1_500,
  tools: 8_000,
  chat: 40_000,
  output: 0,
};

describe('estimateProviderMessagesChars', () => {
  test('splits plain-string messages into chat vs tool results', () => {
    const split = estimateProviderMessagesChars([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world!' },
      { role: 'tool', content: '{"ok":true}' },
    ]);
    expect(split).toEqual({ chat: 11, tools: '{"ok":true}'.length });
  });

  test('splits block content into chat vs tool traffic', () => {
    const split = estimateProviderMessagesChars([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'tool_use', toolName: 'read_file', toolInput: { path: 'a' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolOutput: 'file-bytes' }],
      },
    ]);
    expect(split.chat).toBe('answer'.length);
    expect(split.tools).toBe(
      'read_file'.length + JSON.stringify({ path: 'a' }).length + 'file-bytes'.length,
    );
  });

  test('sizes images from their base64 payload instead of a flat constant', () => {
    const imageData = 'a'.repeat(1_000_000);
    const split = estimateProviderMessagesChars([
      { role: 'user', content: [{ type: 'image', imageData, imageMimeType: 'image/png' }] },
    ]);
    // Base64 → ~0.75 byte/char; /4 downstream = ~187.5k tokens for a ~750KB
    // image. The old flat 4000 chars (1k tokens) undercounted this 187x.
    expect(split.chat).toBe(Math.ceil(1_000_000 * 0.75));
    expect(split.tools).toBe(0);
  });

  test('falls back to ~1k tokens when an image block carries no payload', () => {
    const block = { type: 'image', imageMimeType: 'image/png' } as const;
    const split = estimateProviderMessagesChars([
      { role: 'user', content: [block] } as unknown as ProviderMessage,
    ]);
    expect(split.chat).toBe(4000);
  });
});

describe('applyUsageOutput', () => {
  test('passes undefined through', () => {
    expect(applyUsageOutput(undefined, 3000, true)).toBeUndefined();
  });

  test('leaves the dispatch estimate untouched while usage is unknown', () => {
    expect(applyUsageOutput(DISPATCH_BREAKDOWN, 3000, false)).toBe(DISPATCH_BREAKDOWN);
    expect(applyUsageOutput(DISPATCH_BREAKDOWN, undefined, true)).toBe(DISPATCH_BREAKDOWN);
  });

  test('patches exact provider tokensOut while keeping input buckets', () => {
    const patched = applyUsageOutput(DISPATCH_BREAKDOWN, 3000, true);
    expect(patched).toEqual({ ...DISPATCH_BREAKDOWN, output: 3000 });
    // Input buckets are the dispatch estimate — never rewritten here.
    expect(patched).toMatchObject({
      system: 10_000,
      memory: 2_000,
      skills: 1_500,
      tools: 8_000,
      chat: 40_000,
    });
    // Does not mutate the dispatch estimate in place.
    expect(DISPATCH_BREAKDOWN.output).toBe(0);
  });

  test('normalizes fractional output to whole tokens', () => {
    expect(applyUsageOutput(DISPATCH_BREAKDOWN, 12.9, true)?.output).toBe(12);
  });
});
