import { describe, expect, it } from 'bun:test';
import {
  buildModelParameters,
  sanitizeModelParameterValues,
  HARNESS_OWNED_PARAMETER_KEYS,
} from './model-parameters';

describe('buildModelParameters', () => {
  it('builds defs in the fixed panel order', () => {
    const defs = buildModelParameters(
      ['seed', 'top_p', 'temperature', 'max_tokens'],
      undefined,
      4096,
    );
    expect(defs.map((d) => d.key)).toEqual(['temperature', 'top_p', 'max_tokens', 'seed']);
  });

  it('excludes harness-owned and unknown keys', () => {
    const defs = buildModelParameters(
      ['temperature', 'tools', 'reasoning_effort', 'response_format', 'bogus_param'],
      undefined,
      4096,
    );
    expect(defs.map((d) => d.key)).toEqual(['temperature']);
    for (const key of ['tools', 'reasoning_effort', 'response_format']) {
      expect(HARNESS_OWNED_PARAMETER_KEYS.has(key)).toBe(true);
    }
  });

  it('maps max_completion_tokens onto max_tokens, capped at the output limit', () => {
    const defs = buildModelParameters(['max_completion_tokens'], undefined, 8192);
    expect(defs).toHaveLength(1);
    expect(defs[0].key).toBe('max_tokens');
    expect(defs[0].max).toBe(8192);
  });

  it('omits max_tokens when the output limit is unknown or zero', () => {
    expect(buildModelParameters(['max_tokens'], undefined, 0)).toHaveLength(0);
    expect(buildModelParameters(['max_tokens'])).toHaveLength(0);
  });

  it('uses a provider default in range over the documented default', () => {
    const defs = buildModelParameters(
      ['temperature', 'top_p'],
      { temperature: 0.7, top_p: 0.95 },
      4096,
    );
    expect(defs[0].default).toBe(0.7);
    expect(defs[0].defaultSource).toBe('provider');
    expect(defs[1].default).toBe(0.95);
    expect(defs[1].defaultSource).toBe('provider');
  });

  it('falls back to the documented default when the provider default is missing or out of range', () => {
    const defs = buildModelParameters(
      ['temperature', 'top_p'],
      { temperature: null, top_p: 9 },
      4096,
    );
    expect(defs[0].default).toBe(1);
    expect(defs[0].defaultSource).toBe('documented');
    expect(defs[1].default).toBe(1);
    expect(defs[1].defaultSource).toBe('documented');
  });

  it('accepts a provider max_tokens default under the max_completion_tokens alias', () => {
    const defs = buildModelParameters(
      ['max_completion_tokens'],
      { max_completion_tokens: 2048 },
      8192,
    );
    expect(defs[0].default).toBe(2048);
    expect(defs[0].defaultSource).toBe('provider');
  });

  it('reads enum defaults only when they match the option list', () => {
    const good = buildModelParameters(['verbosity'], { verbosity: 'high' });
    expect(good[0].default).toBe('high');
    expect(good[0].defaultSource).toBe('provider');
    const bad = buildModelParameters(['verbosity'], { verbosity: 'chatty' });
    expect(bad[0].default).toBe('medium');
    expect(bad[0].defaultSource).toBe('documented');
  });
});

describe('sanitizeModelParameterValues', () => {
  const defs = buildModelParameters(
    ['temperature', 'top_k', 'verbosity', 'max_tokens'],
    undefined,
    4096,
  );

  it('keeps only declared keys', () => {
    const out = sanitizeModelParameterValues(defs, { temperature: 0.5, seed: 42, bogus: 1 });
    expect(out).toEqual({ temperature: 0.5 });
  });

  it('clamps numbers into range and rounds integers', () => {
    const out = sanitizeModelParameterValues(defs, {
      temperature: 9,
      top_k: 3.7,
      max_tokens: 99999,
    });
    expect(out.temperature).toBe(2);
    expect(out.top_k).toBe(4);
    expect(out.max_tokens).toBe(4096);
  });

  it('accepts only listed enum values', () => {
    expect(sanitizeModelParameterValues(defs, { verbosity: 'high' })).toEqual({
      verbosity: 'high',
    });
    expect(sanitizeModelParameterValues(defs, { verbosity: 'loud' })).toEqual({});
  });

  it('drops non-finite and wrong-type values', () => {
    const out = sanitizeModelParameterValues(defs, {
      temperature: 'hot',
      top_k: Number.NaN,
      max_tokens: Number.POSITIVE_INFINITY,
    });
    expect(out).toEqual({});
  });

  it('returns an empty object for garbage input and never throws', () => {
    expect(sanitizeModelParameterValues(defs, null)).toEqual({});
    expect(sanitizeModelParameterValues(defs, 'x')).toEqual({});
    expect(sanitizeModelParameterValues(defs, [1, 2])).toEqual({});
    expect(sanitizeModelParameterValues(undefined, { temperature: 1 })).toEqual({});
    expect(sanitizeModelParameterValues([], { temperature: 1 })).toEqual({});
  });
});
