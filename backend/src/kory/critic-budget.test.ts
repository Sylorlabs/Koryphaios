import { expect, test } from 'bun:test';
import { criticOutputTokenBudget } from './critic-budget';

test('gives Cline reasoning models a structured-output floor', () => {
  expect(criticOutputTokenBudget({ provider: 'cline', evidenceChars: 1_000 })).toBe(8_192);
});

test('scales review budget with evidence and changed paths', () => {
  const small = criticOutputTokenBudget({ provider: 'cline', evidenceChars: 1_000 });
  const large = criticOutputTokenBudget({
    provider: 'cline',
    evidenceChars: 60_000,
    changedPathCount: 40,
    skillCount: 12,
  });
  expect(large).toBeGreaterThan(small);
});

test('never exceeds a verified model ceiling', () => {
  expect(
    criticOutputTokenBudget({
      provider: 'cline',
      modelMaxOutputTokens: 4_000,
      evidenceChars: 100_000,
    }),
  ).toBe(4_000);
});
