import { describe, expect, test } from 'bun:test';
import { classifyCodexInfrastructureFailure } from '../skill-eval-codex';

describe('Codex evaluator infrastructure boundary', () => {
  const classify = (stderr: string, overrides: Record<string, unknown> = {}) =>
    classifyCodexInfrastructureFailure({
      stderr,
      output: '',
      exitCode: 1,
      timedOut: false,
      ...overrides,
    });

  test.each([
    [
      'ERROR: error sending request for url: dns error: failed to lookup address information',
      'provider',
    ],
    [
      '2026-09-15T10:00:00Z WARN codex_core::responses_retry: stream disconnected before completion; retry limit exhausted',
      'provider',
    ],
    ['ERROR: Failed to download remote plugin catalog: connection unavailable', 'setup'],
    ['ERROR: MCP client for fixture startup timed out', 'tool'],
  ])('classifies concrete host failure: %s', (detail, kind) => {
    expect(classify(detail)).toMatchObject({ kind, evidence: [detail] });
    expect(classify(detail, { timedOut: true, exitCode: null })?.kind).toBe(kind);
  });

  test('a model budget timeout or candidate failure is not an infrastructure waiver', () => {
    for (const detail of [
      'model exceeded 120000ms',
      'ERROR: task exceeded wall-clock budget',
      'ERROR: assertion failed',
      'DNS lookup failed in the application test',
    ]) {
      expect(classify(detail, { timedOut: true, exitCode: null })).toBeUndefined();
    }
  });

  test('recovered startup warnings and completed candidate output do not suppress scoring', () => {
    const warning =
      '2026-09-15T10:00:00Z WARN codex_core::responses_retry: stream disconnected before completion';
    expect(classify(warning, { exitCode: 0 })).toBeUndefined();
    expect(
      classify(warning, { output: '<kory-eval-patch>[]</kory-eval-patch>', timedOut: true }),
    ).toBeUndefined();
    expect(
      classify(`${warning}\nERROR: candidate task exceeded wall-clock budget`, { timedOut: true }),
    ).toBeUndefined();
  });

  test('does not scan a candidate response or echoed fixture for infrastructure phrases', () => {
    expect(classify('A test should reject DNS lookup failure.')).toBeUndefined();
    expect(classify('', { output: 'ERROR: MCP startup timed out' })).toBeUndefined();
  });

  test('provider quota failures remain nonretryable and carry concrete evidence', () => {
    expect(classify("ERROR: You've hit your usage limit for gpt-reserve")).toMatchObject({
      kind: 'provider',
      retryable: false,
    });
  });
});
