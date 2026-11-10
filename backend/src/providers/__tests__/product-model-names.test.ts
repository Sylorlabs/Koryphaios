import { describe, expect, it } from 'bun:test';
import {
  productModelCreditLabel,
  productModelDisplayNames,
  type ProductModelLabelInput,
} from '../product-model-names';

describe('productModelCreditLabel', () => {
  it('turns a zero-credit label into "free"', () => {
    expect(productModelCreditLabel('x0.00 credits')).toBe('free');
    expect(productModelCreditLabel('0 credits')).toBe('free');
    expect(productModelCreditLabel('  x0.00  credits ')).toBe('free');
  });

  it('keeps a real price label verbatim', () => {
    expect(productModelCreditLabel('x0.03 credits')).toBe('x0.03 credits');
  });

  it('returns undefined for empty or missing input', () => {
    expect(productModelCreditLabel(undefined)).toBeUndefined();
    expect(productModelCreditLabel('')).toBeUndefined();
    expect(productModelCreditLabel('   ')).toBeUndefined();
  });
});

describe('productModelDisplayNames (duplicate-model disambiguation)', () => {
  it('leaves a name used once untouched', () => {
    const entries: ProductModelLabelInput[] = [
      { id: 'a', name: 'Solo', credits: 'x0.01 credits' },
    ];
    expect(productModelDisplayNames(entries)).toEqual(['Solo']);
  });

  it('suffixes duplicate names with their distinct credit price', () => {
    // Real shape: WorkBuddy AI 5.9.4 ships two "Deepseek-V4.1-Flash" rows,
    // one free and one at x0.03 credits. Every other field is identical, so
    // the name alone cannot tell the user what they are choosing.
    const entries: ProductModelLabelInput[] = [
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00 credits' },
      { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', credits: 'x0.03 credits' },
    ];
    expect(productModelDisplayNames(entries)).toEqual([
      'Deepseek-V4.1-Flash (free)',
      'Deepseek-V4.1-Flash (x0.03 credits)',
    ]);
  });

  it('always yields a distinct name per entry (no two identical rows)', () => {
    const entries: ProductModelLabelInput[] = [
      { id: 'a', name: 'Dup', credits: 'x0.00 credits' },
      { id: 'b', name: 'Dup', credits: 'x0.03 credits' },
      { id: 'c', name: 'Unique', credits: 'x0.01 credits' },
      { id: 'd', name: 'Dup', credits: 'x0.05 credits' },
    ];
    const names = productModelDisplayNames(entries);
    expect(new Set(names).size).toBe(names.length);
  });

  it('falls back to the raw model id when credit prices do not distinguish', () => {
    const entries: ProductModelLabelInput[] = [
      { id: 'dup-a', name: 'Dup', credits: 'x0.03 credits' },
      { id: 'dup-b', name: 'Dup', credits: 'x0.03 credits' },
    ];
    expect(productModelDisplayNames(entries)).toEqual([
      'Dup (dup-a)',
      'Dup (dup-b)',
    ]);
  });

  it('uses an ordinal guard when even the id repeats (malformed catalog)', () => {
    const entries: ProductModelLabelInput[] = [
      { id: 'dup', name: 'Dup', credits: 'x0.03 credits' },
      { id: 'dup', name: 'Dup', credits: 'x0.03 credits' },
    ];
    expect(productModelDisplayNames(entries)).toEqual([
      'Dup (dup #1)',
      'Dup (dup #2)',
    ]);
  });
});
