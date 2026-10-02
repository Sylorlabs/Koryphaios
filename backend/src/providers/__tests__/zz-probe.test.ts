import { test, expect } from 'bun:test';
import { SAME_MODEL_MAX_RETRIES, isRetriableProviderFailure } from '../provider-retry';
test('probe', () => {
  console.log('MAX:', SAME_MODEL_MAX_RETRIES, typeof SAME_MODEL_MAX_RETRIES);
  console.log('0 < MAX:', 0 < (SAME_MODEL_MAX_RETRIES as number));
  expect(true).toBe(true);
});
