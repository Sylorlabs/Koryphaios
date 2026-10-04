import { expect, test } from 'bun:test';
import { hasAffirmativeLlvmVulnerabilityClaim } from '../skill-eval-security-review-runtime-fixtures';

test('compiler evidence distinguishes an explicit non-vulnerability statement from an LLVM vulnerability claim', () => {
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'This records a custom compiler lowering defect, not a vulnerability in LLVM or generic LLVM behavior.',
    ),
  ).toBe(false);
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'This is a custom compiler defect, not a claim of generic LLVM vulnerability.',
    ),
  ).toBe(false);
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'This is not a generic LLVM vulnerability; LLVM may optimize valid frontend assertions.',
    ),
  ).toBe(false);
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'The evidence does not establish an LLVM vulnerability; it establishes a frontend lowering defect.',
    ),
  ).toBe(false);
  expect(
    hasAffirmativeLlvmVulnerabilityClaim(
      'The evidence establishes an LLVM vulnerability in optimizer handling.',
    ),
  ).toBe(true);
});
