import { describe, expect, test } from 'bun:test';
import { browserReportToQualityGate, type BrowserVerificationReport } from '../browser-verification';

const report = (overrides: Partial<BrowserVerificationReport> = {}): BrowserVerificationReport => ({
  verdict: 'passed',
  journeys: [],
  consoleErrors: [],
  runtimeErrors: [],
  claimAudit: [],
  evidenceBundle: '/tmp/visual-evidence.json',
  artifacts: ['/tmp/desktop.png', '/tmp/mobile.png', '/tmp/visual-evidence.json'],
  reasons: [],
  ...overrides,
});

describe('browser visual evidence gate', () => {
  test('passes only when runtime collection and every declared claim pass', () => {
    const gate = browserReportToQualityGate(
      report({
        claimAudit: [
          {
            id: 'primary-action-visible',
            criterion: 'The primary action is visible at every required viewport.',
            verdict: 'passed',
            evidence: ['[desktop] selector [data-primary] is visible', '[mobile] selector [data-primary] is visible'],
          },
        ],
      }),
    );
    expect(gate.verdict).toBe('passed');
    expect(gate.artifacts).toContain('/tmp/visual-evidence.json');
  });

  test('fails closed when a declared visual claim fails', () => {
    const gate = browserReportToQualityGate(
      report({
        claimAudit: [
          {
            id: 'primary-action-visible',
            criterion: 'The primary action is visible at every required viewport.',
            verdict: 'failed',
            evidence: ['[mobile] selector [data-primary] was not verified'],
          },
        ],
      }),
    );
    expect(gate.verdict).toBe('failed');
    expect(gate.criticFindings[0]?.severity).toBe('major');
    expect(gate.unmetCriteria).toEqual(['The primary action is visible at every required viewport.']);
  });

  test('preserves blocked collection as a blocked quality gate', () => {
    expect(browserReportToQualityGate(report({ verdict: 'blocked', reasons: ['Chromium unavailable'] })).verdict).toBe(
      'blocked',
    );
  });
});
