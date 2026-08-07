import { describe, expect, test } from 'bun:test';
import { parseCriticReport, parseCriticVerdict } from './critic-util';

const baseReport = {
  findings: [],
  checksReviewed: ['bun test'],
  unmetCriteria: [],
};

describe('critic report parsing', () => {
  test('accepts a fully evidenced PASS report', () => {
    const report = parseCriticReport(JSON.stringify({ ...baseReport, verdict: 'PASS' }));
    expect(report?.verdict).toBe('PASS');
    expect(parseCriticVerdict(JSON.stringify({ ...baseReport, verdict: 'PASS' }))).toBe(true);
  });

  test('rejects PASS when a finding is non-minor', () => {
    const report = parseCriticReport(
      JSON.stringify({
        ...baseReport,
        verdict: 'PASS',
        findings: [{ severity: 'critical', evidence: 'src/example.ts:10', criterion: 'The implementation works', finding: 'Does not work' }],
      }),
    );
    expect(report).toBeNull();
    expect(parseCriticVerdict(JSON.stringify({ ...baseReport, verdict: 'UNVERIFIED' }))).toBe(false);
  });

  test('rejects an explicit UNVERIFIED result and never treats it as completion', () => {
    const report = parseCriticReport(
      JSON.stringify({ ...baseReport, verdict: 'UNVERIFIED', limitations: ['Runtime was unavailable.'] }),
    );
    expect(report).toBeNull();
    expect(parseCriticVerdict(JSON.stringify({ ...baseReport, verdict: 'UNVERIFIED' }))).toBe(false);
  });
});
