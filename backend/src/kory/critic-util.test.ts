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
        findings: [
          {
            severity: 'critical',
            evidence: 'src/example.ts:10',
            criterion: 'The implementation works',
            finding: 'Does not work',
          },
        ],
      }),
    );
    expect(report).toBeNull();
    expect(parseCriticVerdict(JSON.stringify({ ...baseReport, verdict: 'UNVERIFIED' }))).toBe(
      false,
    );
  });

  test('rejects an explicit UNVERIFIED result and never treats it as completion', () => {
    const report = parseCriticReport(
      JSON.stringify({
        ...baseReport,
        verdict: 'UNVERIFIED',
        limitations: ['Runtime was unavailable.'],
      }),
    );
    expect(report).toBeNull();
    expect(parseCriticVerdict(JSON.stringify({ ...baseReport, verdict: 'UNVERIFIED' }))).toBe(
      false,
    );
  });

  test('requires one exact adherence review for every delivered worker skill', () => {
    const skill = { name: 'verification', hash: 'a'.repeat(64) };
    const content = JSON.stringify({
      ...baseReport,
      verdict: 'PASS',
      skillReviews: [
        {
          ...skill,
          adherence: 'followed',
          evidence: 'The worker tied each completion claim to a fresh check.',
          qualityImpact: 'helpful',
        },
      ],
      verifierAssessment: {
        status: 'supported',
        evidence: 'The deterministic check observes the requested state and a valid alternative.',
      },
    });
    expect(parseCriticReport(content, [skill])?.verdict).toBe('PASS');
    expect(
      parseCriticReport(JSON.stringify({ ...baseReport, verdict: 'PASS' }), [skill]),
    ).toBeNull();
    expect(parseCriticReport(content, [{ ...skill, hash: 'b'.repeat(64) }])).toBeNull();
  });

  test('preserves verifier suspicion as evidence without allowing a false PASS', () => {
    const skill = { name: 'verification', hash: 'c'.repeat(64) };
    const report = parseCriticReport(
      JSON.stringify({
        ...baseReport,
        verdict: 'FAIL',
        findings: [
          {
            severity: 'major',
            evidence: 'alternative fixture output',
            criterion: 'Verifier accepts valid implementations',
            finding: 'The check rejects a semantically valid alternative.',
          },
        ],
        skillReviews: [
          {
            ...skill,
            adherence: 'followed',
            evidence: 'The worker followed the delivered verification guidance.',
            qualityImpact: 'neutral',
          },
        ],
        verifierAssessment: {
          status: 'suspect',
          evidence: 'A valid alternative contradicts the deterministic rejection.',
        },
      }),
      [skill],
    );
    expect(report?.verifierAssessment?.status).toBe('suspect');
    expect(report?.verdict).toBe('FAIL');
  });

  test('rejects a passing verdict with an unresolved verifier or no reviewed evidence', () => {
    for (const status of ['suspect', 'unverifiable']) {
      expect(
        parseCriticReport(
          JSON.stringify({
            ...baseReport,
            verdict: 'PASS',
            skillReviews: [],
            verifierAssessment: { status, evidence: 'Consumer result contradicts the check.' },
          }),
          [],
        ),
      ).toBeNull();
    }
    expect(
      parseCriticReport(JSON.stringify({ ...baseReport, checksReviewed: ['  '], verdict: 'PASS' })),
    ).toBeNull();
  });

  test('rejects duplicated skill reviews and missing adherence evidence', () => {
    const skill = { name: 'verification', hash: 'a'.repeat(64) };
    const review = {
      ...skill,
      adherence: 'followed',
      evidence: 'Observed result',
      qualityImpact: 'neutral',
    };
    const report = {
      ...baseReport,
      verdict: 'PASS',
      skillReviews: [review, review],
      verifierAssessment: { status: 'supported', evidence: 'Actual consumer result' },
    };
    expect(parseCriticReport(JSON.stringify(report), [skill, skill])).toBeNull();
    for (const adherence of ['violated', 'unverifiable']) {
      expect(
        parseCriticReport(JSON.stringify({ ...report, skillReviews: [{ ...review, adherence }] }), [
          skill,
        ]),
      ).toBeNull();
    }
  });
});
