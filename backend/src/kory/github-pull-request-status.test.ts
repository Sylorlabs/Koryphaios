import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError } from '../errors/types';
import {
  actionsRunIdFromUrl,
  boundText,
  parsePullRequestStatus,
  PULL_REQUEST_STATUS_FIELDS,
} from './github-pull-request-status';

const FIXTURES = join(import.meta.dir, 'fixtures', 'github-pr-status');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const REPO = 'acme/widgets';

describe('parsePullRequestStatus (recorded gh pr view JSON)', () => {
  test('normalizes a failing PR: check states, counts, review decision and mergeability', () => {
    const status = parsePullRequestStatus(fixture('open-failing.json'), {
      repository: REPO,
      number: 412,
      observedAt: 1000,
    });

    expect(status).toMatchObject({
      number: 412,
      repository: REPO,
      url: 'https://github.com/acme/widgets/pull/412',
      state: 'open',
      draft: false,
      headCommit: '9f2c1b7a4e0d3c5b6a7f8e9d0c1b2a3f4e5d6c7b',
      reviewDecision: 'changes_requested',
      mergeable: 'mergeable',
      failingCheckCount: 3,
      pendingCheckCount: 2,
      observedAt: 1000,
    });
    expect(status.checks.map((check) => [check.name, check.state])).toEqual([
      ['unit', 'failure'],
      ['lint', 'success'],
      ['e2e', 'pending'],
      ['integration', 'timed_out'],
      ['deploy/preview', 'error'],
      ['codecov/patch', 'pending'],
    ]);
    expect(status.checks[0]).toMatchObject({
      source: 'check-run',
      workflowName: 'CI',
      runId: '7710001',
    });
    expect(status.checks[4]).toMatchObject({
      source: 'status-context',
      url: 'https://ci.example.test/builds/88',
    });
    expect(status.checks[4]!.runId).toBeUndefined();
  });

  test('reviews and comments keep their authors and states', () => {
    const status = parsePullRequestStatus(fixture('open-failing.json'), {
      repository: REPO,
      number: 412,
      observedAt: 1,
    });
    expect(status.reviews.map((review) => [review.author, review.state])).toEqual([
      ['alice', 'commented'],
      ['bob', 'changes_requested'],
    ]);
    expect(status.comments).toEqual([
      expect.objectContaining({ author: 'carol', body: 'Does this work on Windows?' }),
    ]);
  });

  test('a merged PR with skipped checks reports no failures and approved review', () => {
    const status = parsePullRequestStatus(fixture('merged-clean.json'), {
      repository: REPO,
      number: 398,
      observedAt: 2,
    });
    expect(status.state).toBe('merged');
    expect(status.reviewDecision).toBe('approved');
    expect(status.mergeable).toBe('unknown');
    expect(status.failingCheckCount).toBe(0);
    expect(status.pendingCheckCount).toBe(0);
    expect(status.checks.map((check) => check.state)).toEqual(['success', 'skipped']);
  });

  test('signature ignores observedAt but changes when a check changes', () => {
    const base = fixture('open-failing.json');
    const a = parsePullRequestStatus(base, { repository: REPO, number: 412, observedAt: 1 });
    const b = parsePullRequestStatus(base, { repository: REPO, number: 412, observedAt: 99999 });
    expect(a.signature).toBe(b.signature);

    const changed = structuredClone(base) as { statusCheckRollup: Array<{ conclusion: string }> };
    changed.statusCheckRollup[0]!.conclusion = 'SUCCESS';
    const c = parsePullRequestStatus(changed, { repository: REPO, number: 412, observedAt: 1 });
    expect(c.signature).not.toBe(a.signature);
  });

  test('refuses a payload for a different PR number or an unknown state', () => {
    expect(() =>
      parsePullRequestStatus(fixture('open-failing.json'), {
        repository: REPO,
        number: 1,
        observedAt: 0,
      }),
    ).toThrow(ValidationError);
    const weird = { ...(fixture('merged-clean.json') as object), state: 'DRAFTED' };
    expect(() =>
      parsePullRequestStatus(weird, { repository: REPO, number: 398, observedAt: 0 }),
    ).toThrow(ValidationError);
    expect(() =>
      parsePullRequestStatus(null, { repository: REPO, number: 1, observedAt: 0 }),
    ).toThrow(ValidationError);
  });

  test('bounds long review bodies', () => {
    const data = structuredClone(fixture('open-failing.json')) as {
      reviews: Array<{ body: string }>;
    };
    data.reviews[1]!.body = 'x'.repeat(5000);
    const status = parsePullRequestStatus(data, { repository: REPO, number: 412, observedAt: 0 });
    expect(status.reviews[1]!.body.length).toBeLessThanOrEqual(2001);
  });

  test('requests only the documented field set', () => {
    expect(PULL_REQUEST_STATUS_FIELDS).toEqual(
      expect.arrayContaining([
        'statusCheckRollup',
        'reviews',
        'comments',
        'reviewDecision',
        'mergeable',
      ]),
    );
  });
});

describe('helpers', () => {
  test('actionsRunIdFromUrl only accepts GitHub Actions run URLs', () => {
    expect(actionsRunIdFromUrl('https://github.com/a/b/actions/runs/42/job/7')).toBe('42');
    expect(actionsRunIdFromUrl('https://github.com/a/b/actions/runs/42')).toBe('42');
    expect(actionsRunIdFromUrl('https://ci.example.test/actions/runs/42')).toBeUndefined();
    expect(actionsRunIdFromUrl('https://github.com/a/b/actions/runs/notanumber')).toBeUndefined();
    expect(actionsRunIdFromUrl(undefined)).toBeUndefined();
  });

  test('boundText trims and marks cuts', () => {
    expect(boundText('  hi  ', 10)).toBe('hi');
    expect(boundText('abcdef', 3)).toBe('abc…');
    expect(boundText(42, 10)).toBe('');
  });
});
