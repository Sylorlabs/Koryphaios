import { describe, expect, it } from 'bun:test';
import { extractJsonObject, parseCheckpointJson } from '../compaction-json';

function checkpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectBrief: 'Continue the verified compaction implementation.',
    decisions: ['Use revisioned active context.'],
    filesAndCodeState: ['backend compaction path is active.'],
    completedWork: ['Summarization is wired.'],
    activeWork: ['Run remaining verification.'],
    openIssues: ['None invented.'],
    nextActions: ['Continue from this checkpoint.'],
    criticalContext: ['Source transcript remains in revision zero.'],
    confidenceAndRisk: 'High confidence in the contract.',
    durableMemory: '# Session Memory\n\nCompaction uses revisioned checkpoints.',
    ...overrides,
  };
}

describe('extractJsonObject', () => {
  it('returns pure JSON untouched', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('strips leading chatty prose (the "I ..." compaction failure)', () => {
    const raw = 'I summarized the session. Here is the checkpoint:\n{"projectBrief":"x"}';
    expect(extractJsonObject(raw)).toBe('{"projectBrief":"x"}');
    expect(() => JSON.parse(extractJsonObject(raw))).not.toThrow();
  });

  it('strips trailing commentary after the object', () => {
    expect(extractJsonObject('{"a":[1,2]}\nHope this helps!')).toBe('{"a":[1,2]}');
  });

  it('handles nested objects and braces inside strings', () => {
    const raw = 'Sure:\n{"a":{"b":"}{"},"c":"q\\"q"}\nDone.';
    expect(extractJsonObject(raw)).toBe('{"a":{"b":"}{"},"c":"q\\"q"}');
  });

  it('returns the input as-is when there is no balanced object', () => {
    expect(extractJsonObject('no braces here')).toBe('no braces here');
    expect(extractJsonObject('{"unclosed": true')).toBe('{"unclosed": true');
  });
});

describe('compaction parseCheckpointJson', () => {
  it('parses plain checkpoint objects directly', () => {
    expect(parseCheckpointJson(JSON.stringify(checkpoint()))).toMatchObject({
      projectBrief: 'Continue the verified compaction implementation.',
    });
  });

  it('decodes a JSON-encoded string checkpoint (the backslash regression)', () => {
    // Compactors that JSON-encode their answer produce
    // `"{\"projectBrief\": ... }"`. Brace-scanning that raw text finds the
    // first `{` inside the string and JSON.parse dies with
    // `Unrecognized token '\'` — the exact failure in the bug report.
    const wrapped = JSON.stringify(JSON.stringify(checkpoint()));
    expect(() =>
      JSON.parse(wrapped.slice(wrapped.indexOf('{'), wrapped.lastIndexOf('}') + 1)),
    ).toThrow();
    const parsed = parseCheckpointJson(wrapped);
    expect(parsed).toMatchObject({
      projectBrief: 'Continue the verified compaction implementation.',
      durableMemory: expect.stringContaining('revisioned checkpoints'),
    });
    expect(parsed.decisions).toEqual(['Use revisioned active context.']);
  });

  it('decodes string-wrapped checkpoints with fences and prose', () => {
    const wrapped = `Here is the checkpoint:\n\`\`\`json\n${JSON.stringify(JSON.stringify(checkpoint()))}\n\`\`\`\nHope this helps!`;
    expect(parseCheckpointJson(wrapped)).toMatchObject({
      projectBrief: 'Continue the verified compaction implementation.',
    });
  });

  it('still extracts prose-wrapped objects and skips escaped quotes', () => {
    const raw = `Sure:\n${JSON.stringify(checkpoint({ projectBrief: 'Quote "q\\"q" and brace }{ inside' }))}\nDone.`;
    expect(parseCheckpointJson(raw)).toMatchObject({
      projectBrief: expect.stringContaining('}{'),
    });
  });

  it('fails closed with a JSON error when nothing parses', () => {
    expect(() => parseCheckpointJson('no braces here')).toThrow();
    expect(() => parseCheckpointJson('{"unclosed": true')).toThrow();
  });
});
