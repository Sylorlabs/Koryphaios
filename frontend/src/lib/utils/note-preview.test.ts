import { describe, expect, it } from 'vitest';
import { notePreviewText } from './note-preview';

describe('notePreviewText', () => {
  it('strips Markdown syntax and the repeated title heading', () => {
    const content =
      '# Analytics Dashboard\n\n- Revenue over time (line)\n- **Top** sources\n\nData comes from the [[API contract]]. See [docs](https://x.dev).';
    expect(notePreviewText(content, 'markdown', 'Analytics Dashboard')).toBe(
      'Revenue over time (line) Top sources Data comes from the API contract. See docs.',
    );
  });

  it('uses wikilink aliases and drops code fences, embeds and front matter', () => {
    const content =
      '---\ntags: [a]\n---\nIntro [[target|the alias]] ![[image.png]]\n```ts\nconst x = 1;\n```\nAfter `code`.';
    expect(notePreviewText(content)).toBe('Intro the alias After code.');
  });

  it('summarizes canvas documents instead of showing JSON', () => {
    const canvas = JSON.stringify({
      v: 1,
      name: 'Map',
      cards: [{ id: 'a' }, { id: 'b' }],
      edges: [{ id: 'e' }],
    });
    expect(notePreviewText(canvas)).toBe('Canvas · 2 cards · 1 link');
  });

  it('strips HTML notes to text', () => {
    expect(notePreviewText('<style>p{}</style><h1>Hi</h1><p>there &amp; back</p>', 'html')).toBe(
      'Hi there & back',
    );
  });

  it('truncates long bodies with an ellipsis', () => {
    const preview = notePreviewText('word '.repeat(100));
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(121);
  });

  it('returns empty for empty content', () => {
    expect(notePreviewText('')).toBe('');
    expect(notePreviewText(undefined)).toBe('');
  });
});
