/**
 * Pull request status for a chat's linked PR: `gh pr view --json` readers and a
 * pure parser for the recorded JSON. Every read is fixed-argv, GitHub.com only,
 * run from the home directory with prompts disabled, and bounded in size.
 */

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type {
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestCommentSummary,
  PullRequestReviewSummary,
  PullRequestStatusSnapshot,
} from '@koryphaios/shared';
import { ValidationError } from '../errors/types';
import { getSafeSubprocessEnv } from '../runtime/safe-env';
import { githubRepositoryFromRemote } from './github-pull-requests';

const execFileAsync = promisify(execFile);

/** Fields requested from `gh pr view`; the fixture in tests records exactly these. */
export const PULL_REQUEST_STATUS_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'headRefOid',
  'reviewDecision',
  'mergeable',
  'statusCheckRollup',
  'reviews',
  'comments',
] as const;

const PR_JSON_MAX_BYTES = 8 * 1024 * 1024;
const PR_TIMEOUT_MS = 30_000;
/** Bounds on what is copied from GitHub into a snapshot or a steering message. */
export const PR_TEXT_LIMIT = 2_000;
export const PR_ITEM_LIMIT = 50;
export const FAILED_LOG_TAIL_CHARS = 12_000;
const FAILED_LOG_TIMEOUT_MS = 60_000;
const FAILED_LOG_MAX_STDERR_CHARS = 1_000;

export function boundText(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function login(value: unknown): string {
  const author = value as { login?: unknown } | null | undefined;
  return typeof author?.login === 'string' ? author.login.slice(0, 100) : '';
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The Actions run id in a check URL, or undefined for any other host or shape. */
export function actionsRunIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d{1,15})(?:\/|$|\?)/.exec(url);
  return match?.[1];
}

function checkRunState(status: unknown, conclusion: unknown): PullRequestCheckState {
  if (status !== 'COMPLETED') return 'pending';
  switch (conclusion) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'NEUTRAL':
      return 'neutral';
    case 'CANCELLED':
    case 'STALE':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'TIMED_OUT':
      return 'timed_out';
    case 'ACTION_REQUIRED':
      return 'action_required';
    case 'STARTUP_FAILURE':
      return 'error';
    default:
      return 'neutral';
  }
}

function statusContextState(state: unknown): PullRequestCheckState {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'ERROR':
      return 'error';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'neutral';
  }
}

function parseCheck(item: unknown): PullRequestCheck | null {
  const raw = item as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.__typename === 'StatusContext') {
    const url = typeof raw.targetUrl === 'string' ? raw.targetUrl : undefined;
    return {
      name: boundText(raw.context, 200) || 'status',
      source: 'status-context',
      state: statusContextState(raw.state),
      ...(url ? { url: url.slice(0, 2048) } : {}),
      ...(actionsRunIdFromUrl(url) ? { runId: actionsRunIdFromUrl(url) } : {}),
    };
  }
  // CheckRun is the default: gh omits __typename on some older payloads.
  const url = typeof raw.detailsUrl === 'string' ? raw.detailsUrl : undefined;
  const workflowName = boundText(raw.workflowName, 200);
  return {
    name: boundText(raw.name, 200) || 'check',
    source: 'check-run',
    state: checkRunState(raw.status, raw.conclusion),
    ...(workflowName ? { workflowName } : {}),
    ...(url ? { url: url.slice(0, 2048) } : {}),
    ...(actionsRunIdFromUrl(url) ? { runId: actionsRunIdFromUrl(url) } : {}),
  };
}

function parseReview(item: unknown, index: number): PullRequestReviewSummary {
  const raw = item as Record<string, unknown>;
  const state = raw.state;
  const mapped: PullRequestReviewSummary['state'] =
    state === 'APPROVED'
      ? 'approved'
      : state === 'CHANGES_REQUESTED'
        ? 'changes_requested'
        : state === 'DISMISSED'
          ? 'dismissed'
          : state === 'PENDING'
            ? 'pending'
            : 'commented';
  const submittedAt = timestamp(raw.submittedAt);
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 200) : `review-${index}`,
    author: login(raw.author),
    state: mapped,
    body: boundText(raw.body, PR_TEXT_LIMIT),
    ...(submittedAt !== undefined ? { submittedAt } : {}),
  };
}

function parseComment(item: unknown, index: number): PullRequestCommentSummary {
  const raw = item as Record<string, unknown>;
  const createdAt = timestamp(raw.createdAt);
  const url = typeof raw.url === 'string' ? raw.url.slice(0, 2048) : undefined;
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 200) : `comment-${index}`,
    author: login(raw.author),
    body: boundText(raw.body, PR_TEXT_LIMIT),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(url ? { url } : {}),
  };
}

/** Stable digest of the content a UI renders; `observedAt` is excluded. */
function signatureOf(snapshot: Omit<PullRequestStatusSnapshot, 'signature' | 'observedAt'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`;
}

/**
 * Normalize recorded or live `gh pr view --json` output. Throws ValidationError
 * for anything that is not a pull request with the expected number.
 */
export function parsePullRequestStatus(
  input: unknown,
  context: { repository: string; number: number; observedAt: number },
): PullRequestStatusSnapshot {
  const raw = input as Record<string, any> | null;
  if (!raw || typeof raw !== 'object' || raw.number !== context.number) {
    throw new ValidationError('GitHub returned invalid pull request status.');
  }
  const state =
    raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : raw.state === 'OPEN' ? 'open' : null;
  if (!state) throw new ValidationError('GitHub returned invalid pull request status.');

  const checks = (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [])
    .map(parseCheck)
    .filter((check): check is PullRequestCheck => check !== null)
    .slice(0, 200);
  const failingStates: PullRequestCheckState[] = ['failure', 'timed_out', 'error'];
  const reviews = (Array.isArray(raw.reviews) ? raw.reviews : [])
    .slice(-PR_ITEM_LIMIT)
    .map((item: unknown, index: number) => parseReview(item, index));
  const comments = (Array.isArray(raw.comments) ? raw.comments : [])
    .slice(-PR_ITEM_LIMIT)
    .map((item: unknown, index: number) => parseComment(item, index));
  const headCommit = typeof raw.headRefOid === 'string' && /^[a-f0-9]{40,64}$/i.test(raw.headRefOid)
    ? raw.headRefOid
    : undefined;

  const body: Omit<PullRequestStatusSnapshot, 'signature' | 'observedAt'> = {
    number: context.number,
    repository: context.repository,
    url: `https://github.com/${context.repository}/pull/${context.number}`,
    title: boundText(raw.title, 500),
    state,
    draft: raw.isDraft === true,
    ...(headCommit ? { headCommit } : {}),
    reviewDecision:
      raw.reviewDecision === 'APPROVED'
        ? 'approved'
        : raw.reviewDecision === 'CHANGES_REQUESTED'
          ? 'changes_requested'
          : raw.reviewDecision === 'REVIEW_REQUIRED'
            ? 'review_required'
            : 'none',
    mergeable:
      raw.mergeable === 'MERGEABLE' ? 'mergeable' : raw.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
    checks,
    failingCheckCount: checks.filter((check) => failingStates.includes(check.state)).length,
    pendingCheckCount: checks.filter((check) => check.state === 'pending').length,
    reviews,
    comments,
  };
  return { ...body, observedAt: context.observedAt, signature: signatureOf(body) };
}

function assertRepository(repository: string): void {
  if (githubRepositoryFromRemote(`https://github.com/${repository}`) !== repository) {
    throw new ValidationError('A GitHub.com repository is required.');
  }
}

/** Read the linked PR's status with `gh pr view`; gh owns the login. */
export async function readPullRequestStatusJson(repository: string, number: number): Promise<unknown> {
  assertRepository(repository);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) {
    throw new ValidationError('Enter a valid pull request number.');
  }
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', String(number), '--repo', repository, '--json', PULL_REQUEST_STATUS_FIELDS.join(',')],
      {
        cwd: homedir(),
        env: getSafeSubprocessEnv({ GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }),
        timeout: PR_TIMEOUT_MS,
        maxBuffer: PR_JSON_MAX_BYTES,
        encoding: 'utf8',
      },
    );
    return JSON.parse(stdout);
  } catch {
    throw new ValidationError(
      'Could not read pull request status. Install GitHub CLI (gh), run gh auth login, and check access to this repository.',
    );
  }
}

/**
 * Last FAILED_LOG_TAIL_CHARS of `gh run view <id> --log-failed`. The stream is
 * consumed incrementally and only its tail is kept, so a very large log never
 * sits in memory, and the process is killed after a fixed deadline.
 */
export async function readFailedRunLogTail(
  repository: string,
  runId: string,
): Promise<{ text: string; truncated: boolean }> {
  assertRepository(repository);
  if (!/^\d{1,15}$/.test(runId)) throw new ValidationError('Invalid Actions run id.');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'gh',
      ['run', 'view', runId, '--repo', repository, '--log-failed'],
      {
        cwd: homedir(),
        env: getSafeSubprocessEnv({ GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let tail = '';
    let truncated = false;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), FAILED_LOG_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      tail += chunk;
      if (tail.length > FAILED_LOG_TAIL_CHARS) {
        tail = tail.slice(-FAILED_LOG_TAIL_CHARS);
        truncated = true;
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < FAILED_LOG_MAX_STDERR_CHARS) stderr += chunk.slice(0, FAILED_LOG_MAX_STDERR_CHARS);
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new ValidationError('Could not read the failed-step log. Install GitHub CLI (gh) and run gh auth login.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ValidationError(`Could not read the failed-step log. ${stderr.trim().slice(0, 200)}`));
        return;
      }
      resolvePromise({ text: tail, truncated });
    });
  });
}
