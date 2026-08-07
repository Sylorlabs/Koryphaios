import { describe, expect, it } from 'bun:test';
import { cliResearchBoundary, hasResearchCitation } from '../cli-research';

describe('CLI native research boundary', () => {
  it('requires an inspectable HTTP source URL', () => {
    expect(hasResearchCitation('Result: https://example.com/source')).toBe(true);
    expect(hasResearchCitation('Result without a source')).toBe(false);
  });
  it('admits only CLIs with an exact native tool visibility allowlist', () => {
    expect(cliResearchBoundary('grok').eligible).toBe(true);
    expect(cliResearchBoundary('claude').eligible).toBe(true);
    expect(cliResearchBoundary('devin').eligible).toBe(true);

    for (const provider of ['codex', 'antigravity', 'cursor', 'cline', 'gemini-cli']) {
      expect(cliResearchBoundary(provider).eligible).toBe(false);
      expect(cliResearchBoundary(provider).reason.length).toBeGreaterThan(0);
    }
  });

  it('does not silently admit a future provider', () => {
    expect(cliResearchBoundary('future-cli')).toEqual({
      eligible: false,
      nativeTools: [],
      reason: 'Provider has no verified native research boundary',
    });
  });
});
