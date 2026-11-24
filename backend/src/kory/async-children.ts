/**
 * Per-chat ledger for worker agents the manager started without waiting
 * (`delegate_to_worker` with `wait: false`) and for compare groups.
 *
 * Pure state only. KoryManager owns when a batch is admitted (a host-authored
 * steering row at a checkpoint, or an internal turn when the chat is idle) and
 * calls into this ledger for every transition, so the ordering and dedupe rules
 * are testable without a provider, a database, or a running turn.
 *
 * Lives on SessionRuntime, so a chat's children can never be read or delivered
 * into another chat, and session deletion disposes the whole ledger at once.
 */

export type AsyncChildStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** `pending`: finished and not yet shown to the manager. `queued`: claimed by
 *  one delivery batch that has not been admitted yet. `delivered`: the manager
 *  has seen it, through a continuation or through wait_for_agents. */
export type AsyncChildDelivery = 'pending' | 'queued' | 'delivered';

export interface AsyncChildRecord {
  readonly agentId: string;
  readonly task: string;
  readonly requestedModel?: string;
  /** Model label the host actually routed to, set once routing completes. */
  routedModel?: string;
  readonly compareGroupId?: string;
  readonly startedAt: number;
  status: AsyncChildStatus;
  delivery: AsyncChildDelivery;
  batchId?: string;
  result?: string;
  finishedAt?: number;
  /** Aborts the child's own pipeline; never the manager's turn signal. */
  readonly abort: AbortController;
  /** Resolves once the child is terminal. Never rejects. */
  readonly settled: Promise<void>;
  resolveSettled(): void;
}

export interface AsyncChildStartInput {
  agentId: string;
  task: string;
  requestedModel?: string;
  compareGroupId?: string;
  abort: AbortController;
  now?: number;
}

export interface AsyncChildOutcome {
  status: Exclude<AsyncChildStatus, 'running'>;
  result: string;
  now?: number;
}

const TERMINAL: ReadonlySet<AsyncChildStatus> = new Set(['completed', 'failed', 'cancelled']);

export class AsyncChildLedger {
  private readonly records = new Map<string, AsyncChildRecord>();

  start(input: AsyncChildStartInput): AsyncChildRecord {
    if (this.records.has(input.agentId)) {
      throw new Error(`Async worker ${input.agentId} is already tracked`);
    }
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const record: AsyncChildRecord = {
      agentId: input.agentId,
      task: input.task,
      ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      ...(input.compareGroupId ? { compareGroupId: input.compareGroupId } : {}),
      startedAt: input.now ?? Date.now(),
      status: 'running',
      delivery: 'pending',
      abort: input.abort,
      settled,
      resolveSettled,
    };
    this.records.set(record.agentId, record);
    return record;
  }

  get(agentId: string): AsyncChildRecord | undefined {
    return this.records.get(agentId);
  }

  list(): AsyncChildRecord[] {
    return [...this.records.values()];
  }

  /** Record a terminal outcome. Idempotent: the first settlement wins. */
  settle(agentId: string, outcome: AsyncChildOutcome): AsyncChildRecord | undefined {
    const record = this.records.get(agentId);
    if (!record || TERMINAL.has(record.status)) return record;
    record.status = outcome.status;
    record.result = outcome.result;
    record.finishedAt = outcome.now ?? Date.now();
    record.resolveSettled();
    return record;
  }

  /** Whether any child is running or has a result the manager has not seen. */
  hasOutstanding(): boolean {
    for (const record of this.records.values()) {
      if (record.status === 'running' || record.delivery !== 'delivered') return true;
    }
    return false;
  }

  runningCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.status === 'running') count++;
    return count;
  }

  /** Finished children not yet claimed by any batch, in completion order. */
  pending(): AsyncChildRecord[] {
    return this.list()
      .filter((record) => TERMINAL.has(record.status) && record.delivery === 'pending')
      .sort(byCompletion);
  }

  /** Claim every pending finished child into one batch. Returns the claimed
   *  records in completion order; an empty array means nothing to deliver. */
  claimPending(batchId: string): AsyncChildRecord[] {
    const claimed = this.pending();
    for (const record of claimed) {
      record.delivery = 'queued';
      record.batchId = batchId;
    }
    return claimed;
  }

  /** Records still queued under this batch (a consumer may have taken some). */
  queuedBatch(batchId: string): AsyncChildRecord[] {
    return this.list()
      .filter(
        (record) =>
          record.delivery === 'queued' &&
          record.batchId === batchId &&
          TERMINAL.has(record.status),
      )
      .sort(byCompletion);
  }

  /** Mark a batch as shown to the manager. Returns the records it covered. */
  markBatchDelivered(batchId: string): AsyncChildRecord[] {
    const covered = this.list()
      .filter((record) => record.delivery === 'queued' && record.batchId === batchId)
      .sort(byCompletion);
    for (const record of covered) {
      record.delivery = 'delivered';
      record.batchId = undefined;
    }
    return covered;
  }

  /** Return a batch that was never admitted to pending, so a later attempt can
   *  claim it again. Delivered records are never reopened. */
  releaseBatch(batchId: string): number {
    let released = 0;
    for (const record of this.records.values()) {
      if (record.delivery === 'queued' && record.batchId === batchId) {
        record.delivery = 'pending';
        record.batchId = undefined;
        released++;
      }
    }
    return released;
  }

  queuedBatchIds(): string[] {
    const ids = new Set<string>();
    for (const record of this.records.values()) {
      if (record.delivery === 'queued' && record.batchId) ids.add(record.batchId);
    }
    return [...ids];
  }

  /** The children `wait_for_agents` should consider: the named ones, or every
   *  child the manager has not yet seen. Unknown ids are reported, not hidden. */
  selectForWait(agentIds?: readonly string[]): {
    records: AsyncChildRecord[];
    unknown: string[];
  } {
    if (agentIds === undefined) {
      return {
        records: this.list().filter((record) => record.delivery !== 'delivered').sort(byStart),
        unknown: [],
      };
    }
    const records: AsyncChildRecord[] = [];
    const unknown: string[] = [];
    for (const id of new Set(agentIds)) {
      const record = this.records.get(id);
      if (record) records.push(record);
      else unknown.push(id);
    }
    return { records, unknown };
  }

  /** Mark the finished members of `records` as seen by the manager. Running
   *  children stay unclaimed so their result still arrives later. */
  claimForWait(records: readonly AsyncChildRecord[]): AsyncChildRecord[] {
    const claimed: AsyncChildRecord[] = [];
    for (const record of records) {
      if (!TERMINAL.has(record.status) || record.delivery === 'delivered') continue;
      if (record.batchId) record.batchId = undefined;
      record.delivery = 'delivered';
      claimed.push(record);
    }
    return claimed.sort(byCompletion);
  }

  /** Signal every running child to stop. Their settlement arrives as cancelled. */
  abortRunning(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status !== 'running') continue;
      record.abort.abort();
      count++;
    }
    return count;
  }

  dispose(): void {
    this.records.clear();
  }
}

function byStart(a: AsyncChildRecord, b: AsyncChildRecord): number {
  return a.startedAt - b.startedAt || a.agentId.localeCompare(b.agentId);
}

function byCompletion(a: AsyncChildRecord, b: AsyncChildRecord): number {
  return (
    (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt) ||
    a.startedAt - b.startedAt ||
    a.agentId.localeCompare(b.agentId)
  );
}

// ─── Compare groups ─────────────────────────────────────────────────────────

export const COMPARE_GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** A compare group id is a short token the manager picks; invalid ids are dropped. */
export function normalizeCompareGroupId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return COMPARE_GROUP_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export interface CompareAttempt {
  agentId: string;
  model?: string;
  status: Exclude<AsyncChildStatus, 'running'>;
  result: string;
}

export const COMPARE_RESULT_CHAR_LIMIT = 2_000;

/** Attempts that ran for the same task under one group id, in recorded order. */
export class CompareGroupLedger {
  private readonly groups = new Map<string, CompareAttempt[]>();

  record(groupId: string, attempt: CompareAttempt): number {
    const attempts = this.groups.get(groupId) ?? [];
    const index = attempts.findIndex((candidate) => candidate.agentId === attempt.agentId);
    if (index >= 0) attempts[index] = attempt;
    else attempts.push(attempt);
    this.groups.set(groupId, attempts);
    return attempts.length;
  }

  attempts(groupId: string): CompareAttempt[] {
    return [...(this.groups.get(groupId) ?? [])];
  }

  has(groupId: string): boolean {
    return this.groups.has(groupId);
  }

  /** Text the critic reads to rank the attempts of one group. */
  renderRankingSection(groupId: string): string | undefined {
    const attempts = this.groups.get(groupId);
    if (!attempts || attempts.length === 0) return undefined;
    const lines = [
      `COMPARE GROUP ${groupId}: ${attempts.length} independent attempt(s) at the same task, each in its own isolated worktree.`,
      'Rank the attempts from best to worst against the objective. Judge them on evidence, not on how confident they sound, and name the best attempt in your report. Their summaries are below; inspect the real artifacts in your verification copy before ranking.',
    ];
    attempts.forEach((attempt, index) => {
      const excerpt = attempt.result.length > COMPARE_RESULT_CHAR_LIMIT
        ? `${attempt.result.slice(0, COMPARE_RESULT_CHAR_LIMIT)}\n[truncated]`
        : attempt.result;
      lines.push(
        `Attempt ${index + 1} (${attempt.agentId}, ${attempt.model ?? 'pool model'}, ${attempt.status}):\n${excerpt}`,
      );
    });
    return lines.join('\n\n');
  }

  dispose(): void {
    this.groups.clear();
  }
}

// ─── Host-authored text ─────────────────────────────────────────────────────

export const ASYNC_RESULT_CHAR_LIMIT = 6_000;
const TASK_PREVIEW_CHARS = 300;

/** The host-authored continuation for a finished batch. It is written as the
 *  host, never as the user, and names every child so the manager can match
 *  results to the work it started. */
export function renderAsyncChildEnvelope(records: readonly AsyncChildRecord[]): string {
  const header = [
    '[Host: background worker results]',
    'Workers you started with wait:false have finished. This message was written by the host, not the user. Use these results to continue the task, join any that are still running, or report them.',
  ];
  const sections: string[] = [];
  const groups = new Map<string, AsyncChildRecord[]>();
  const ungrouped: AsyncChildRecord[] = [];
  for (const record of records) {
    if (record.compareGroupId) {
      const group = groups.get(record.compareGroupId) ?? [];
      group.push(record);
      groups.set(record.compareGroupId, group);
    } else {
      ungrouped.push(record);
    }
  }
  for (const record of ungrouped) sections.push(renderRecord(record));
  for (const [groupId, members] of groups) {
    sections.push(
      `Compare group ${groupId} (${members.length} attempt(s) at the same task):\n` +
        members.map(renderRecord).join('\n\n') +
        `\nCall request_critic_review with compareGroupId "${groupId}" if the choice between these attempts needs an independent ranking.`,
    );
  }
  return [...header, ...sections].join('\n\n');
}

function renderRecord(record: AsyncChildRecord): string {
  const result = record.result ?? '';
  const body =
    result.length > ASYNC_RESULT_CHAR_LIMIT
      ? `${result.slice(0, ASYNC_RESULT_CHAR_LIMIT)}\n[truncated; ${result.length - ASYNC_RESULT_CHAR_LIMIT} more characters]`
      : result;
  const task = record.task.length > TASK_PREVIEW_CHARS
    ? `${record.task.slice(0, TASK_PREVIEW_CHARS)}…`
    : record.task;
  const model = record.routedModel ?? record.requestedModel;
  const label = model ? `${record.status}, ${model}` : record.status;
  return [`Worker ${record.agentId} (${label}).`, `Task: ${task}`, body].join('\n');
}

/** Output of wait_for_agents: finished results first, then what is still running. */
export function renderWaitResult(input: {
  finished: readonly AsyncChildRecord[];
  running: readonly AsyncChildRecord[];
  unknown: readonly string[];
}): string {
  const parts: string[] = [];
  if (input.finished.length > 0) {
    parts.push(`Finished (${input.finished.length}):`);
    for (const record of input.finished) parts.push(renderRecord(record));
  }
  if (input.running.length > 0) {
    parts.push(
      `Still running (${input.running.length}): ${input.running.map((record) => record.agentId).join(', ')}. Their results will arrive as a host message when they finish.`,
    );
  }
  if (input.unknown.length > 0) {
    parts.push(`Unknown agent ids (not started in this chat): ${input.unknown.join(', ')}.`);
  }
  if (parts.length === 0) return 'No background workers are outstanding in this chat.';
  return parts.join('\n\n');
}
