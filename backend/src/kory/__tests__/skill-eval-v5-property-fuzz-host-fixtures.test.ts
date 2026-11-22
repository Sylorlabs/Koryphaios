import { expect, test } from 'bun:test';
import {
  hasHypothesisSettingsDecorator,
  hasJqwikDiscardContract,
} from '../../eval/skills/skill-eval-v5-property-fuzz-host-fixtures';

test('Hypothesis settings can be applied through a named decorator', () => {
  expect(
    hasHypothesisSettingsDecorator(
      '@settings(max_examples=100)\n@given(st.integers())\ndef p(x): pass',
    ),
  ).toBe(true);
  expect(
    hasHypothesisSettingsDecorator(
      'CAMPAIGN = settings(max_examples=100, deadline=None)\n@CAMPAIGN\n@given(st.integers())\ndef p(x): pass',
    ),
  ).toBe(true);
  expect(
    hasHypothesisSettingsDecorator('CAMPAIGN = settings(max_examples=100)\n@given(st.integers())'),
  ).toBe(false);
});

test('jqwik discard contract accepts either explicit filtering or a bounded discard ratio', () => {
  expect(hasJqwikDiscardContract('Assume.that(depth(expr) <= 4);')).toBe(true);
  expect(hasJqwikDiscardContract('@Property(tries = 2000, maxDiscardRatio = 1)')).toBe(true);
  expect(hasJqwikDiscardContract('@Property(tries = 2000)')).toBe(false);
});
