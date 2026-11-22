import { describe, expect, it } from 'vitest';
import type { FeedEntryLocal } from '$lib/types';
import { narrateToolGroup } from './tool-narration';

let seq = 0;
function step(name: string, input: Record<string, unknown>, done = true): FeedEntryLocal {
  seq += 1;
  return {
    id: `s${seq}`,
    type: done ? 'tool_result' : 'tool_call',
    timestamp: seq,
    agentId: 'kory-manager',
    text: '',
    metadata: {
      toolCall: { name, input },
      ...(done ? { toolResult: { name, output: 'ok', isError: false } } : {}),
    },
  } as unknown as FeedEntryLocal;
}

describe('narrateToolGroup', () => {
  it('names up to two files and merges consecutive reads', () => {
    expect(narrateToolGroup([step('read_file', { path: 'src/a.ts' }), step('read_file', { path: 'b.ts' })])).toBe(
      'Read a.ts and b.ts',
    );
    expect(
      narrateToolGroup([
        step('read_file', { path: 'a.ts' }),
        step('read_file', { path: 'b.ts' }),
        step('read_file', { path: 'c.ts' }),
      ]),
    ).toBe('Read 3 files');
  });

  it('keeps the order the agent worked in', () => {
    expect(
      narrateToolGroup([
        step('read_file', { path: 'a.ts' }),
        step('grep', { pattern: 'surface' }),
        step('list_directory', { path: 'src' }),
      ]),
    ).toBe('Read a.ts → searched “surface” → listed src');
  });

  it('narrates a running step in the present tense', () => {
    expect(narrateToolGroup([step('read_file', { path: 'a.ts' }), step('grep', { pattern: 'x' }, false)])).toBe(
      'Read a.ts → searching “x”…',
    );
  });

  it('folds the oldest clauses into a count so the live end stays visible', () => {
    const line = narrateToolGroup([
      step('read_file', { path: 'a.ts' }),
      step('grep', { pattern: 'one' }),
      step('read_file', { path: 'b.ts' }),
      step('grep', { pattern: 'two' }),
    ]);
    expect(line).toBe('1 earlier step → searched “one” → read b.ts → searched “two”');
  });

  it('returns an empty string for no steps', () => {
    expect(narrateToolGroup([])).toBe('');
  });
});
