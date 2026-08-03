import { describe, test, expect } from 'bun:test';
import { deriveCriticBudget, deriveSkillEvidenceCriteria, parseCriticVerdict, formatMessagesForCritic } from '../src/kory/critic-util';

describe('parseCriticVerdict', () => {
  test('accepts only a structured pass with reviewed evidence and complete coverage', () => {
    const criterion = 'Relevant checks pass';
    const report = JSON.stringify({
      verdict: 'PASS', findings: [], checksReviewed: ['bun test: 12 pass'],
      criterionCoverage: [{ criterion, evidence: 'bun test: 12 pass', status: 'verified' }],
      unmetCriteria: [],
    });
    expect(parseCriticVerdict(report, [criterion])).toBe(true);
  });

  test('returns false when last non-empty line starts with FAIL', () => {
    expect(parseCriticVerdict('Issues found.\nFAIL')).toBe(false);
    expect(parseCriticVerdict('FAIL: missing tests')).toBe(false);
    expect(parseCriticVerdict('Review.\n\nFAIL: lint errors')).toBe(false);
  });

  test('rejects empty evidence, unmet criteria, and incomplete coverage', () => {
    expect(parseCriticVerdict(JSON.stringify({ verdict: 'PASS', findings: [], checksReviewed: [], criterionCoverage: [], unmetCriteria: [] }))).toBe(false);
    expect(parseCriticVerdict(JSON.stringify({ verdict: 'PASS', findings: [], checksReviewed: ['test'], criterionCoverage: [{ criterion: 'A', evidence: 'test', status: 'unmet' }], unmetCriteria: ['A'] }), ['A'])).toBe(false);
    expect(parseCriticVerdict(JSON.stringify({ verdict: 'PASS', findings: [], checksReviewed: ['test'], criterionCoverage: [{ criterion: 'A', evidence: 'test', status: 'verified' }], unmetCriteria: [] }), ['A', 'B'])).toBe(false);
  });

  test('returns false when content says does not PASS (last line is FAIL)', () => {
    expect(parseCriticVerdict('The code does not PASS our bar.\nFAIL')).toBe(false);
  });

  test('fails closed when PASS appears only inside ambiguous prose', () => {
    expect(parseCriticVerdict('Overall assessment: PASS.')).toBe(false);
    expect(parseCriticVerdict('No issues found.')).toBe(false);
  });

  test('handles empty or whitespace', () => {
    expect(parseCriticVerdict('')).toBe(false);
    expect(parseCriticVerdict('   \n  ')).toBe(false);
  });
});

describe('deriveCriticBudget', () => {
  test('scales inspection depth with risk and change size', () => {
    const low = deriveCriticBudget({ risk: 'low' });
    const high = deriveCriticBudget({ risk: 'high', changedFiles: 12, changedLines: 900 });
    expect(high.maxTurns).toBeGreaterThan(low.maxTurns);
    expect(high.maxTokens).toBeGreaterThan(low.maxTokens);
    expect(high.transcriptChars).toBeGreaterThan(low.transcriptChars);
  });
});

test('selected skill evidence becomes exact critic coverage criteria', () => {
  expect(deriveSkillEvidenceCriteria([
    { name: 'debugging', evidence: ['Reproduction', 'Regression check'] },
    { name: 'verification', evidence: ['Regression check'] },
  ])).toEqual([
    'Skill evidence [debugging]: Reproduction',
    'Skill evidence [debugging]: Regression check',
    'Skill evidence [verification]: Regression check',
  ]);
});

describe('formatMessagesForCritic', () => {
  test('formats user, assistant, tool messages', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'tool', content: 'result' },
    ];
    const out = formatMessagesForCritic(messages);
    expect(out).toContain('[MANAGER INSTRUCTION]');
    expect(out).toContain('Hello');
    expect(out).toContain('[WORKER OUTPUT]');
    expect(out).toContain('Hi');
    expect(out).toContain('[WORKER TOOL RESULT]');
    expect(out).toContain('result');
  });

  test('truncates when over maxLength', () => {
    const long = 'x'.repeat(20_000);
    const messages = [{ role: 'user', content: long }];
    const out = formatMessagesForCritic(messages, 500);
    expect(out.length).toBeLessThanOrEqual(520);
    expect(out).toContain('...[truncated]');
  });

  test('does not truncate when under maxLength', () => {
    const messages = [{ role: 'user', content: 'short' }];
    const out = formatMessagesForCritic(messages, 1000);
    expect(out).toBe('[MANAGER INSTRUCTION]\nshort');
  });
});
