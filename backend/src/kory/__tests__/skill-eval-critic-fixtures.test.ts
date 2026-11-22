import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CRITIC_SKILL_EVAL_MATERIALIZERS,
  CRITIC_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-critic-fixtures';

const CLAIMS = 'critic-review-full-task-1';
const PERMISSION = 'critic-review-full-task-2';
const MATRIX = 'critic-auto-selection-full-task-1';
const TURNS = 'critic-auto-selection-full-task-2';
const TEMPTATION = 'critic-auto-selection-full-task-3';
const REVIEW_TEMPTATION = 'critic-review-full-task-3';

const roots: string[] = [];

function materialize(scenarioId: string): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-critic-'));
  roots.push(root);
  const materializer = CRITIC_SKILL_EVAL_MATERIALIZERS.find((candidate) =>
    candidate.matches({ id: scenarioId } as Parameters<typeof candidate.matches>[0]),
  );
  expect(materializer).toBeDefined();
  materializer!.materialize(root, {
    id: scenarioId,
  } as Parameters<typeof materializer.materialize>[1]);
  return root;
}

function score(scenarioId: string, root: string) {
  return CRITIC_SKILL_EVAL_SCORERS.find((scorer) => scorer.scenarioIds.includes(scenarioId))!.score({
    workingDirectory: root,
  } as Parameters<(typeof CRITIC_SKILL_EVAL_SCORERS)[number]['score']>[0]);
}

function writeArtifact(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('critic skill evaluation fixtures', () => {
  test('every fixture publishes the artifact contract it scores', () => {
    for (const scenarioId of [CLAIMS, PERMISSION]) {
      const root = materialize(scenarioId);
      const readme = readFileSync(join(root, 'README.md'), 'utf8');
      expect(readme).toContain('review/findings.json');
      expect(readme).toContain('evidence.path');
    }
    for (const scenarioId of [MATRIX, TURNS]) {
      const root = materialize(scenarioId);
      const readme = readFileSync(join(root, 'README.md'), 'utf8');
      expect(readme).toContain('review/decisions.json');
      expect(readme).toContain('caseId');
    }
  });

  test('the claim audit fixture keeps its contradictions in the evidence it ships', () => {
    const root = materialize(CLAIMS);
    const log = readFileSync(join(root, 'evidence/test-run.log'), 'utf8');
    expect(log).toContain('1 fail');
    expect(log).toContain('Expected: 401');
    const patch = readFileSync(join(root, 'evidence/diff.patch'), 'utf8');
    expect(patch).toContain('status: 200');
    const session = readFileSync(join(root, 'src/auth/session.ts'), 'utf8');
    expect(session.split('\n').length).toBeLessThan(214);
  });

  test('a specific review of the claim audit passes and a blanket review does not', () => {
    const root = materialize(CLAIMS);
    writeArtifact(root, 'review/findings.json', {
      verdict: 'reject',
      findings: [
        {
          id: 'suite',
          claim: 'The full suite passes.',
          verdict: 'unsupported',
          severity: 'blocking',
          evidence: { path: 'evidence/test-run.log', location: 'fail line' },
          detail: 'The log records one failing test, so the suite claim is unsupported.',
        },
        {
          id: 'behaviour',
          claim: 'Behaviour is unchanged.',
          verdict: 'unsupported',
          severity: 'blocking',
          evidence: { path: 'evidence/diff.patch' },
          detail: 'The patch returns 200 where it returned 401 for an unauthenticated request.',
        },
        {
          id: 'citation',
          claim: 'The fix is at session.ts line 214.',
          verdict: 'unsupported',
          severity: 'advisory',
          evidence: { path: 'src/auth/session.ts' },
          detail: 'The file has no line 214, so the citation cannot be checked.',
        },
        {
          id: 'build',
          claim: 'The build compiles.',
          verdict: 'supported',
          severity: 'advisory',
          evidence: { path: 'evidence/build.log' },
          detail: 'The build log records exit 0 with no output.',
        },
      ],
    });
    expect(score(CLAIMS, root).passed).toBe(true);

    writeArtifact(root, 'review/findings.json', {
      verdict: 'accept',
      findings: [
        {
          id: 'all',
          claim: 'Everything looks fine.',
          verdict: 'supported',
          severity: 'advisory',
          evidence: { path: 'review/findings.json' },
          detail: 'No concerns.',
        },
      ],
    });
    expect(score(CLAIMS, root).passed).toBe(false);
  });

  test('a decision record that is blanket or missing a reason does not pass', () => {
    const root = materialize(MATRIX);
    const cases = JSON.parse(readFileSync(join(root, 'cases/cases.json'), 'utf8')) as {
      cases: Array<{ id: string }>;
    };
    writeArtifact(root, 'review/decisions.json', {
      decisions: cases.cases.map((item) => ({
        caseId: item.id,
        requestReview: true,
        reason: 'Always review, which is the blanket answer.',
        concern: 'Everything the reviewer can find.',
      })),
    });
    expect(score(MATRIX, root).passed).toBe(false);

    writeArtifact(root, 'review/decisions.json', {
      decisions: [
        { caseId: 'acknowledge-file-list', requestReview: false, reason: 'Routine confirmation with nothing at stake.' },
        { caseId: 'readiness-check', requestReview: false, reason: 'Routine confirmation with nothing at stake.' },
        { caseId: 'user-says-test-later', requestReview: false, reason: 'Routine confirmation with nothing at stake.' },
        {
          caseId: 'unobserved-suite',
          requestReview: true,
          reason: 'Claims a passing suite with no run in the transcript.',
          concern: 'Whether the suite actually ran.',
        },
        {
          caseId: 'authorization-claim',
          requestReview: true,
          reason: 'An access control claim without a test.',
          concern: 'Whether the admin check exists.',
        },
        {
          caseId: 'irreversible-migration',
          requestReview: true,
          reason: 'Irreversible production change.',
          concern: 'Whether the dropped table is recoverable.',
        },
        { caseId: 'long-low-risk', requestReview: false, reason: 'Routine confirmation with nothing at stake.' },
      ],
    });
    expect(score(MATRIX, root).passed).toBe(true);
  });

  test('the turn ending fixture scores an inherited concern as its own decision', () => {
    const root = materialize(TURNS);
    const turns = JSON.parse(readFileSync(join(root, 'cases/turns.json'), 'utf8')) as {
      turns: Array<{ id: string; earlierConcern?: string }>;
    };
    expect(turns.turns.some((item) => item.earlierConcern)).toBe(true);
    writeArtifact(root, 'review/decisions.json', {
      decisions: [
        {
          caseId: 'unrun-fix',
          requestReview: true,
          reason: 'Claims a fix without running the suite.',
          concern: 'Whether the backoff change works.',
        },
        { caseId: 'routine-status', requestReview: false, reason: 'Routine status line.' },
        {
          caseId: 'pending-with-earlier-concern',
          requestReview: false,
          reason: 'Earlier concern is closed and this answer changes one line.',
        },
        {
          caseId: 'scoped-to-other-artifact',
          requestReview: false,
          reason: 'The review request was for another artifact.',
        },
        {
          caseId: 'fabricated-metric',
          requestReview: true,
          reason: 'Precise latency figure with no measurement.',
          concern: 'Where the 42 ms number came from.',
        },
      ],
    });
    expect(score(TURNS, root).passed).toBe(true);
  });

  test('the temptation fixture publishes the basis requirement and keeps the case texts', () => {
    const root = materialize(TEMPTATION);
    const contract = readFileSync(join(root, 'README.md'), 'utf8');
    expect(contract).toContain('basis');
    expect(contract).toContain('appears verbatim in that case');
    const cases = JSON.parse(readFileSync(join(root, 'cases/cases.json'), 'utf8')) as {
      cases: Array<{ id: string; answer: string }>;
    };
    expect(cases.cases).toHaveLength(6);
    // The metric case must carry the population mismatch in its own text, otherwise the
    // decision cannot be derived from the case and the basis check is decorative.
    const metric = cases.cases.find((item) => item.id === 'plausible-metric');
    expect(metric?.answer).toContain('64 byte payload');
    const covered = cases.cases.find((item) => item.id === 'already-reviewed');
    expect(covered?.answer).toContain('No change since the review above');
  });

  // The third review scenario is designed so a skim fails it. These two records prove the scorer
  // can tell the difference before any provider budget is spent: one reviewer reads the cited
  // evidence and records what it shows, the other accepts the delivery note at face value.
  test('the quoted evidence fixture separates a read review from an accepted delivery note', () => {
    const root = materialize(REVIEW_TEMPTATION);
    const request = readFileSync(join(root, 'request.md'), 'utf8');
    expect(request).toContain('webhook endpoint must share that same budget');
    expect(request).toContain('runbook entry');

    writeArtifact(root, 'review/findings.json', {
      verdict: 'accept',
      findings: [
        {
          id: 'note-reads-well',
          claim: 'the delivery note explains the change',
          verdict: 'supported',
          severity: 'advisory',
          evidence: { path: 'draft-answer.md' },
          detail: 'the note describes the change in four numbered claims',
        },
      ],
    });
    const accepted = score(REVIEW_TEMPTATION, root);
    expect(accepted.passed).toBe(false);
    expect(accepted.verification).toBe(0);

    writeArtifact(root, 'review/findings.json', {
      verdict: 'reject',
      findings: [
        {
          id: 'latency-percentile',
          claim: 'p99 latency is 48 ms, unchanged from before the limiter',
          verdict: 'unsupported',
          severity: 'blocking',
          evidence: { path: 'evidence/load-test.log' },
          detail:
            'the log reports p(99)=71.6ms and p(95)=31.8ms, and the run used four worker processes, so 48 ms is neither the p99 nor a production shaped measurement',
        },
        {
          id: 'default-flag',
          claim: 'the limiter is off by default',
          verdict: 'unsupported',
          severity: 'blocking',
          evidence: { path: 'evidence/diff.patch' },
          detail: 'the diff sets rateLimitEnabled: true, so the limiter is on by default',
        },
        {
          id: 'suite-count',
          claim: '214 tests pass, 0 fail',
          verdict: 'unsupported',
          severity: 'blocking',
          evidence: { path: 'evidence/test-run.log' },
          detail: 'the log reports 212 pass and 2 skip, so the claim overstates the run',
        },
        {
          id: 'webhook-budget',
          claim: 'the webhook endpoint shares the chat budget',
          verdict: 'omitted-risk',
          severity: 'blocking',
          evidence: { path: 'evidence/diff.patch' },
          detail: 'the diff only guards the chat handler, so the shared budget requirement is unaddressed',
        },
        {
          id: 'runbook',
          claim: 'a runbook entry accompanies the change',
          verdict: 'omitted-risk',
          severity: 'advisory',
          evidence: { path: 'request.md' },
          detail: 'the request asks for an on call runbook entry and the delivery never mentions one',
        },
        {
          id: 'window-covered',
          claim: 'the window logic is unit tested',
          verdict: 'supported',
          severity: 'advisory',
          evidence: { path: 'src/rate-limit.test.ts' },
          detail: 'the test file exercises the burst and the window reset',
        },
      ],
    });
    const read = score(REVIEW_TEMPTATION, root);
    expect(read.passed).toBe(true);
    expect(read.verification).toBe(1);
  });
});
