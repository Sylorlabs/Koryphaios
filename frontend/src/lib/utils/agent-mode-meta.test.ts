import { describe, expect, it } from 'vitest';
import { agentModeMetaFor } from './agent-mode-meta';

describe('agent mode metadata', () => {
  it('labels each execution mode', () => {
    expect(agentModeMetaFor('multi').label).toBe('Multi-Agent');
    expect(agentModeMetaFor('single').label).toBe('Single Agent');
    expect(agentModeMetaFor('auto').label).toBe('Auto');
  });

  it('falls back to Auto for an unknown persisted mode', () => {
    expect(agentModeMetaFor('swarm').label).toBe('Auto');
  });

  it('keeps distinct titles so the pill tooltip is unambiguous', () => {
    const titles = new Set(['multi', 'single', 'auto'].map((mode) => agentModeMetaFor(mode).title));
    expect(titles.size).toBe(3);
  });
});
