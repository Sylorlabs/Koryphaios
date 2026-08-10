import { describe, expect, it } from 'vitest';
import { KeyedRequestGate } from './keyed-request-gate';

describe('KeyedRequestGate', () => {
  it('invalidates stale responses without conflating independent Memory sources', () => {
    const gate = new KeyedRequestGate<'project' | 'rules'>();
    const firstProject = gate.begin('project');
    const rules = gate.begin('rules');
    const latestProject = gate.begin('project');

    expect(gate.isCurrent('project', firstProject)).toBe(false);
    expect(gate.isCurrent('project', latestProject)).toBe(true);
    expect(gate.isCurrent('rules', rules)).toBe(true);
  });

  it('invalidates every in-flight response at a project transition', () => {
    const gate = new KeyedRequestGate<'documents'>();
    const request = gate.begin('documents');
    gate.reset();
    expect(gate.isCurrent('documents', request)).toBe(false);

    const replacement = gate.begin('documents');
    expect(replacement).not.toBe(request);
    expect(gate.isCurrent('documents', request)).toBe(false);
    expect(gate.isCurrent('documents', replacement)).toBe(true);
  });
});
