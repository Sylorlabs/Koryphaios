import { describe, expect, test } from 'bun:test';
import { parseNoteProperties, removeNoteProperty, setNoteProperty } from './NoteProperties';

describe('Note Properties', () => {
  test('parses supported typed YAML while preserving the body', () => {
    const parsed = parseNoteProperties(`---
status: "active"
estimate: 3.5
approved: true
due: 2026-09-02
reviewedAt: 2026-09-02T08:30:00-07:00
owners: ["Ada", 'Grace']
tags:
  - agent-work-note
  - evidence
---
# Body
`);

    expect(parsed.properties).toEqual([
      { key: 'status', type: 'text', value: 'active' },
      { key: 'estimate', type: 'number', value: 3.5 },
      { key: 'approved', type: 'checkbox', value: true },
      { key: 'due', type: 'date', value: '2026-09-02' },
      { key: 'reviewedAt', type: 'datetime', value: '2026-09-02T08:30:00-07:00' },
      { key: 'owners', type: 'list', value: ['Ada', 'Grace'] },
      { key: 'tags', type: 'tags', value: ['agent-work-note', 'evidence'] },
    ]);
    expect(parsed.body).toBe('# Body\n');
    expect(parsed.warnings).toEqual([]);
  });

  test('upserts one property without rewriting unrelated or unsupported YAML', () => {
    const source = `---\nstatus: old\nnested:\n  owner: Ada\n# keep this\n---\nBody`;
    const next = setNoteProperty(source, { key: 'status', type: 'text', value: 'ready' });
    expect(next).toContain('status: "ready"');
    expect(next).toContain('nested:\n  owner: Ada\n# keep this');
    expect(next.endsWith('---\nBody')).toBe(true);
    expect(parseNoteProperties(next).warnings).toEqual([
      { key: 'nested', message: 'Nested or unsupported YAML is preserved in source mode.' },
    ]);
  });

  test('adds and removes properties without frontmatter loss', () => {
    const added = setNoteProperty('Body', { key: 'approved', type: 'checkbox', value: false });
    expect(added).toBe('---\napproved: false\n---\nBody');
    expect(removeNoteProperty(added, 'approved')).toBe('---\n---\nBody');
  });

  test('refuses duplicate keys and unsafe values instead of guessing', () => {
    expect(() =>
      setNoteProperty('---\nstatus: one\nstatus: two\n---\n', {
        key: 'status',
        type: 'text',
        value: 'three',
      }),
    ).toThrow('duplicated');
    expect(() => setNoteProperty('', { key: 'bad:key', type: 'text', value: 'value' })).toThrow(
      'Invalid property key',
    );
    expect(() =>
      setNoteProperty('', { key: 'estimate', type: 'number', value: Number.NaN }),
    ).toThrow('finite');
  });

  test('fails closed on an unterminated frontmatter document', () => {
    const source = '---\nstatus: active\n# body was never closed';
    const parsed = parseNoteProperties(source);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.warnings[0]?.message).toContain('closing');
    expect(() => setNoteProperty(source, { key: 'owner', type: 'text', value: 'Micah' })).toThrow(
      'malformed',
    );
    expect(() => removeNoteProperty(source, 'status')).toThrow('malformed');
  });

  test('uses projection normalization for equivalent Unicode keys and rejects controls', () => {
    const composed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';
    const parsed = parseNoteProperties(`---\n${composed}: first\n${decomposed}: second\n---\n`);

    expect(parsed.properties).toEqual([{ key: composed, type: 'text', value: 'first' }]);
    expect(parsed.warnings).toEqual([
      { key: decomposed, message: 'Duplicate property key was ignored.' },
    ]);

    const replaced = setNoteProperty(`---\n${composed}: first\n---\n`, {
      key: decomposed,
      type: 'text',
      value: 'updated',
    });
    expect(parseNoteProperties(replaced).properties).toEqual([
      { key: decomposed, type: 'text', value: 'updated' },
    ]);
    expect(() =>
      setNoteProperty('', { key: 'unsafe\u0000key', type: 'text', value: 'value' }),
    ).toThrow(/invalid property key/i);
  });
});
