/**
 * Reasoning config (shared): data-driven via buildReasoningConfigFromLevels.
 *
 * There are no static per-provider tables. Reasoning config is built at
 * runtime from each model's live-reported reasoningLevels array. These
 * tests verify that buildReasoningConfigFromLevels produces correct
 * configs and that the legacy helpers return null/default.
 */
import { describe, test, expect } from 'bun:test';
import {
  getReasoningConfig,
  hasReasoningSupport,
  normalizeReasoningLevel,
  getDefaultReasoning,
  buildReasoningConfigFromLevels,
} from '@koryphaios/shared';

describe('buildReasoningConfigFromLevels (data-driven)', () => {
  test('builds config from effort levels', () => {
    const config = buildReasoningConfigFromLevels(['low', 'medium', 'high', 'max']);
    expect(config).not.toBeNull();
    const values = config!.options.map((o) => o.value);
    expect(values).toContain('low');
    expect(values).toContain('medium');
    expect(values).toContain('high');
    expect(values).toContain('max');
    expect(config!.defaultValue).toBe('medium');
  });

  test('builds config from budget-token levels', () => {
    const config = buildReasoningConfigFromLevels(['0', '1024', '8192', '24576']);
    expect(config).not.toBeNull();
    const values = config!.options.map((o) => o.value);
    expect(values).toContain('0');
    expect(values).toContain('1024');
    expect(values).toContain('8192');
    expect(values).toContain('24576');
  });

  test('returns null for empty or undefined levels', () => {
    expect(buildReasoningConfigFromLevels(undefined)).toBeNull();
    expect(buildReasoningConfigFromLevels([])).toBeNull();
    expect(buildReasoningConfigFromLevels(null)).toBeNull();
  });

  test('handles unknown level strings with generic labels', () => {
    const config = buildReasoningConfigFromLevels(['turbo', 'mega']);
    expect(config).not.toBeNull();
    const values = config!.options.map((o) => o.value);
    expect(values).toContain('turbo');
    expect(values).toContain('mega');
  });

  test('picks medium as default when available', () => {
    const config = buildReasoningConfigFromLevels(['low', 'medium', 'high']);
    expect(config!.defaultValue).toBe('medium');
  });

  test('picks middle element as default when medium absent', () => {
    const config = buildReasoningConfigFromLevels(['low', 'high']);
    expect(config!.defaultValue).toBe('high');
  });
});

describe('Legacy helpers (no static tables)', () => {
  test('getReasoningConfig always returns null', () => {
    expect(getReasoningConfig('anthropic', 'claude-opus-4-6')).toBeNull();
    expect(getReasoningConfig('openai', 'gpt-5')).toBeNull();
    expect(getReasoningConfig('cursor', 'gpt-5')).toBeNull();
  });

  test('hasReasoningSupport always returns false', () => {
    expect(hasReasoningSupport('anthropic', 'claude-opus-4-6')).toBe(false);
    expect(hasReasoningSupport('openai', 'gpt-5')).toBe(false);
  });

  test('getDefaultReasoning always returns medium', () => {
    expect(getDefaultReasoning('anthropic', 'claude-opus-4-6')).toBe('medium');
    expect(getDefaultReasoning('openai', 'gpt-5')).toBe('medium');
  });
});

describe('normalizeReasoningLevel (pass-through)', () => {
  test('passes through standard levels unchanged', () => {
    expect(normalizeReasoningLevel('openai', 'gpt-5', 'high')).toBe('high');
    expect(normalizeReasoningLevel('anthropic', 'claude-opus-4-6', 'max')).toBe('max');
    expect(normalizeReasoningLevel('codex', 'gpt-5.6-terra', 'xhigh')).toBe('xhigh');
  });

  test('passes through budget-token values', () => {
    expect(normalizeReasoningLevel('anthropic', 'claude-haiku-4-5', '8192')).toBe('8192');
    expect(normalizeReasoningLevel('anthropic', 'claude-haiku-4-5', '0')).toBe('0');
  });

  test('returns undefined for antigravity', () => {
    expect(normalizeReasoningLevel('antigravity', 'gemini-2.5-pro', 'high')).toBeUndefined();
  });

  test('returns undefined for adaptive', () => {
    expect(normalizeReasoningLevel('openai', 'gpt-5', 'adaptive')).toBeUndefined();
  });

  test('returns auto for auto', () => {
    expect(normalizeReasoningLevel('openai', 'gpt-5', 'auto')).toBe('auto');
  });

  test('returns undefined for empty input', () => {
    expect(normalizeReasoningLevel('openai', 'gpt-5', undefined)).toBeUndefined();
    expect(normalizeReasoningLevel('openai', 'gpt-5', '')).toBeUndefined();
  });
});
