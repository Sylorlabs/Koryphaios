import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeVerifiedContextWindow } from './context-window';

describe('mergeVerifiedContextWindow', () => {
  it('does not let incomplete usage telemetry erase a verified model limit', () => {
    expect(
      mergeVerifiedContextWindow(
        { max: 262_144, known: true },
        { max: 0, known: false },
      ),
    ).toEqual({ max: 262_144, known: true });
  });

  it('accepts a newer verified limit after a model switch', () => {
    expect(
      mergeVerifiedContextWindow(
        { max: 262_144, known: true },
        { max: 1_000_000, known: true },
      ),
    ).toEqual({ max: 1_000_000, known: true });
  });

  it('sends model-preview bodies as JSON so backend schema validation can parse them', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/CommandInput.svelte'),
      'utf8',
    );
    const request = source.slice(
      source.indexOf("context/model-preview`), {"),
      source.indexOf('const result =', source.indexOf("context/model-preview`), {")),
    );
    expect(request).toContain("headers: { 'content-type': 'application/json' }");
    expect(request).toContain('body: JSON.stringify({ model, provider })');
  });
});
