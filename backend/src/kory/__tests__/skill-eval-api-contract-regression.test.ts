import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_CONTRACT_DESIGN_SKILL_EVAL_MATERIALIZERS,
  API_CONTRACT_DESIGN_SKILL_EVAL_SCORERS,
} from '../skill-eval-api-contract-design-fixtures';
import { readFixtureText, writeFixtureFile } from '../skill-eval-fixture-helpers';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const repairedExport = `export type ExportStatus = 'queued' | 'running' | 'packaging' | 'complete' | 'cancelled' | 'failed';
export interface ExportRequest { accountId: string; format: 'json' | 'csv'; includeHistory?: boolean; }
export interface PublicFailure { code: string; retryable: boolean; terminal: boolean; message: string; }
export interface ExportRecord { id: string; request: ExportRequest; status: ExportStatus; failure?: PublicFailure; }
export interface ExportStore { exports: Map<string, ExportRecord>; idempotency: Map<string, string>; nextId: number; }
export type StartResult =
  | { ok: true; export: ExportRecord; replayed: boolean; apiVersion: 1 }
  | { ok: false; error: PublicFailure };
export function createStore(): ExportStore { return { exports: new Map(), idempotency: new Map(), nextId: 1 }; }
function identity(request: ExportRequest): string {
  return JSON.stringify([request.accountId, request.format, Boolean(request.includeHistory)]);
}
export function startExport(store: ExportStore, key: string, request: ExportRequest): StartResult {
  const priorId = store.idempotency.get(key);
  if (priorId) {
    const previous = store.exports.get(priorId)!;
    if (identity(previous.request) !== identity(request))
      return { ok: false, error: { code: 'idempotency_conflict', retryable: false, terminal: true, message: 'Request differs from original' } };
    return { ok: true, export: previous, replayed: true, apiVersion: 1 };
  }
  const id = 'exp_' + store.nextId++;
  const record: ExportRecord = { id, request: { ...request }, status: 'queued' };
  store.exports.set(id, record);
  store.idempotency.set(key, id);
  return { ok: true, export: record, replayed: false, apiVersion: 1 };
}
export function cancelExport(store: ExportStore, id: string):
  { ok: true; export: ExportRecord } | { ok: false; error: PublicFailure } {
  const record = store.exports.get(id);
  if (!record) return { ok: false, error: { code: 'not_found', retryable: false, terminal: true, message: 'Export not found' } };
  if (record.status !== 'queued' && record.status !== 'running')
    return { ok: false, error: { code: 'not_cancellable', retryable: false, terminal: true, message: 'Export can no longer be cancelled' } };
  record.status = 'cancelled';
  return { ok: true, export: record };
}
export function pollExport(store: ExportStore, id: string):
  { ok: true; export: ExportRecord } | { ok: false; error: PublicFailure } {
  const record = store.exports.get(id);
  if (!record) return { ok: false, error: { code: 'not_found', retryable: false, terminal: true, message: 'Export not found' } };
  return { ok: true, export: record };
}
export function legacyStartClientView(result: StartResult): { id: string; status: ExportStatus } | null {
  if (!result.ok) return null;
  return { id: result.export.id, status: result.export.status };
}
`;

const exportRegressions = `import { expect, test } from 'bun:test';
import { cancelExport, createStore, legacyStartClientView, pollExport, startExport } from '../src/export-contract';
test('idempotency transport retry and normalized collision', () => {
  const store = createStore();
  const first = startExport(store, 'key', { accountId: 'acct', format: 'json' });
  const again = startExport(store, 'key', { accountId: 'acct', format: 'json', includeHistory: false });
  expect(first.ok).toBe(true);
  expect(again.ok).toBe(true);
  if (!first.ok || !again.ok) return;
  expect(again.replayed).toBe(true);
  expect(again.export.id).toBe(first.export.id);
  const collision = startExport(store, 'key', { accountId: 'acct', format: 'csv' });
  expect(collision.ok).toBe(false);
  if (!collision.ok) expect(collision.error.code).toBe('idempotency_conflict');
  expect(store.exports.size).toBe(1);
});
test('cancel fails after packaging and safe failures classify retryable and terminal', () => {
  const store = createStore();
  const started = startExport(store, 'second', { accountId: 'acct', format: 'csv' });
  if (!started.ok) throw new Error('start failed');
  started.export.status = 'packaging';
  expect(cancelExport(store, started.export.id).ok).toBe(false);
  expect(started.export.status).toBe('packaging');
  const missing = pollExport(store, 'missing');
  expect(missing.ok).toBe(false);
  if (!missing.ok) {
    expect(missing.error.retryable).toBe(false);
    expect(missing.error.terminal).toBe(true);
    expect(missing.error.message).not.toMatch(/redis|shard|queue/i);
  }
  expect(legacyStartClientView(started)).toEqual({ id: started.export.id, status: 'packaging' });
});
`;

const repairedCursor = `import { createHmac } from 'node:crypto';
export type EventKind = 'created' | 'updated' | 'deleted' | 'restored';
export interface EventRecord { id: string; occurredAt: number; kind: EventKind; value: string; }
export interface PaginationTelemetry { legacyPageRequests: number; cursorRequests: number; }
export type ListRequest =
  | { mode: 'v1-offset'; page: number; limit: number; now: number }
  | { mode: 'v2-cursor'; cursor?: string; limit: number; now: number };
export type ListResult =
  | { ok: true; items: Array<Record<string, unknown>>; nextCursor?: string; deprecation?: string }
  | { ok: false; error: { code: 'invalid_cursor' | 'expired_cursor'; retryable: false } };
type Cursor = { id: string; occurredAt: number; issued: number };
function sortEvents(events: EventRecord[]): EventRecord[] {
  return [...events].sort((a, b) => b.occurredAt - a.occurredAt || b.id.localeCompare(a.id));
}
function sign(raw: string): string { return createHmac('sha256', 'fixture-cursor-secret').update(raw).digest('hex'); }
function makeCursor(last: EventRecord, now: number): string {
  const raw = Buffer.from(JSON.stringify({ id: last.id, occurredAt: last.occurredAt, issued: now })).toString('base64url');
  return raw + '.' + sign(raw);
}
function decodeCursor(cursor: string): Cursor | null {
  const parts = cursor.split('.');
  if (parts.length !== 2 || parts[1] !== sign(parts[0]!)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    if (typeof value.id !== 'string' || !Number.isFinite(value.occurredAt) || !Number.isFinite(value.issued)) return null;
    return value;
  } catch { return null; }
}
export function listEvents(events: EventRecord[], request: ListRequest, telemetry: PaginationTelemetry): ListResult {
  const ordered = sortEvents(events);
  if (request.mode === 'v1-offset') {
    telemetry.legacyPageRequests++;
    const start = Math.max(0, (request.page - 1) * request.limit);
    return { ok: true, items: ordered.slice(start, start + request.limit).map(e => ({ ...e, kind: e.kind === 'restored' ? 'updated' : e.kind })), deprecation: 'Upgrade to v2 cursor pagination' };
  }
  telemetry.cursorRequests++;
  let remaining = ordered;
  if (request.cursor) {
    const cursor = decodeCursor(request.cursor);
    if (!cursor) return { ok: false, error: { code: 'invalid_cursor', retryable: false } };
    if (request.now - cursor.issued > 3600) return { ok: false, error: { code: 'expired_cursor', retryable: false } };
    remaining = ordered.filter(e => e.occurredAt < cursor.occurredAt || (e.occurredAt === cursor.occurredAt && e.id < cursor.id));
  }
  const page = remaining.slice(0, request.limit);
  return { ok: true, items: page, nextCursor: remaining.length > request.limit && page.length ? makeCursor(page[page.length - 1]!, request.now) : undefined };
}
`;

const cursorRegressions = `import { expect, test } from 'bun:test';
import { listEvents, type EventRecord } from '../src/events-contract';
const events: EventRecord[] = [
  { id: 'c', occurredAt: 300, kind: 'created', value: 'c' },
  { id: 'b', occurredAt: 200, kind: 'updated', value: 'b' },
  { id: 'a', occurredAt: 100, kind: 'deleted', value: 'a' },
];
test('concurrent insert cannot shift cursor and telemetry increments', () => {
  const telemetry = { legacyPageRequests: 0, cursorRequests: 0 };
  const first = listEvents(events, { mode: 'v2-cursor', limit: 1, now: 1000 }, telemetry);
  if (!first.ok || !first.nextCursor) throw new Error('cursor missing');
  const newer: EventRecord = { id: 'd', occurredAt: 400, kind: 'created', value: 'd' };
  const next = listEvents([newer, ...events], { mode: 'v2-cursor', cursor: first.nextCursor, limit: 1, now: 1010 }, telemetry);
  expect(next.ok && next.items[0]?.id).toBe('b');
  expect(telemetry.cursorRequests).toBe(2);
});
test('tamper gives invalid cursor, expiry gives expired cursor', () => {
  const t = { legacyPageRequests: 0, cursorRequests: 0 };
  const first = listEvents(events, { mode: 'v2-cursor', limit: 1, now: 1000 }, t);
  if (!first.ok || !first.nextCursor) throw new Error('cursor missing');
  const changed = first.nextCursor.slice(0, -1) + (first.nextCursor.endsWith('a') ? 'b' : 'a');
  expect(listEvents(events, { mode: 'v2-cursor', limit: 1, cursor: changed, now: 1001 }, t)).toMatchObject({ ok: false, error: { code: 'invalid_cursor' } });
  const atBoundary = listEvents(events, { mode: 'v2-cursor', limit: 1, cursor: first.nextCursor, now: 4600 }, t);
  expect(atBoundary.ok && atBoundary.items[0]?.id).toBe('b');
  expect(listEvents(events, { mode: 'v2-cursor', limit: 1, cursor: first.nextCursor, now: 4601 }, t)).toMatchObject({ ok: false, error: { code: 'expired_cursor' } });
});
test('legacy page enum mapping and deprecation preserves compatibility', () => {
  const t = { legacyPageRequests: 0, cursorRequests: 0 };
  const restored: EventRecord = { id: 'd', occurredAt: 400, kind: 'restored', value: 'd' };
  const legacy = listEvents([restored, ...events], { mode: 'v1-offset', page: 1, limit: 1, now: 1000 }, t);
  expect(legacy.ok && legacy.items[0]?.kind).toBe('updated');
  expect(legacy.ok && legacy.deprecation).toBeTruthy();
  expect(t.legacyPageRequests).toBe(1);
});
`;

async function evaluate(
  scenarioId: string,
  sourcePath: string,
  repair: string,
  testsPath: string,
  tests: string,
  tamperContract?: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'kory-api-contract-regression-'));
  roots.push(root);
  const materializer = API_CONTRACT_DESIGN_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches({ id: scenarioId } as never),
  )!;
  const scorer = API_CONTRACT_DESIGN_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenarioId),
  )!;
  await materializer.materialize(root, { id: scenarioId } as never);
  writeFixtureFile(root, sourcePath, repair);
  writeFixtureFile(root, testsPath, tests);
  if (tamperContract) writeFixtureFile(root, tamperContract, 'contract silently weakened\n');
  const result = await scorer.score({ workingDirectory: root } as never);
  expect(readFixtureText(root, sourcePath)).toBe(repair);
  return result;
}

describe('API contract evaluator requires executed regression detection', () => {
  test('export repair passes when the authored tests detect the original defect', async () => {
    const result = await evaluate(
      'api-contract-design-full-task-1-individual', 'src/export-contract.ts', repairedExport,
      'tests/export-contract.test.ts', exportRegressions,
    );
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.evidence).toContain('candidate tests reject the original defect: yes');
  });

  test('export keyword-only tests cannot claim regression coverage', async () => {
    const result = await evaluate(
      'api-contract-design-full-task-1-individual', 'src/export-contract.ts', repairedExport,
      'tests/export-contract.test.ts',
      `import { expect, test } from 'bun:test';\ntest('idempotency retry collision cancel retryable terminal failure legacy compatibility', () => expect(true).toBe(true));\n`,
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('candidate tests reject the original defect: no');
  });

  test('cursor repair passes when tests detect unstable pagination', async () => {
    const result = await evaluate(
      'api-contract-design-full-task-2-individual', 'src/events-contract.ts', repairedCursor,
      'tests/events-contract.test.ts', cursorRegressions,
    );
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.evidence).toContain('candidate tests reject the original defect: yes');
  });

  test('cursor expiry boundary mutant is rejected at the exact allowed lifetime', async () => {
    const mutant = repairedCursor.replace('request.now - cursor.issued > 3600', 'request.now - cursor.issued >= 3600');
    expect(mutant).not.toBe(repairedCursor);
    const result = await evaluate(
      'api-contract-design-full-task-2-individual', 'src/events-contract.ts', mutant,
      'tests/events-contract.test.ts', cursorRegressions,
    );
    expect(result.passed).toBe(false);
    expect(result.evidence.join('\n')).toContain('hidden pagination/version compatibility: fail');
  });

  test('cursor keyword-only tests cannot claim regression coverage', async () => {
    const result = await evaluate(
      'api-contract-design-full-task-2-individual', 'src/events-contract.ts', repairedCursor,
      'tests/events-contract.test.ts',
      `import { expect, test } from 'bun:test';\ntest('concurrent insert invalid tamper expiry legacy page enum restored compatibility telemetry deprecation', () => expect(true).toBe(true));\n`,
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('candidate tests reject the original defect: no');
  });

  test('export missing repair-only import cannot count as behavioral regression', async () => {
    const result = await evaluate(
      'api-contract-design-full-task-1-individual', 'src/export-contract.ts',
      `${repairedExport}\nexport const repairOnly = true;\n`,
      'tests/export-contract.test.ts',
      `import { expect, test } from 'bun:test';
import { repairOnly } from '../src/export-contract';
test('idempotent retry collision cancel retryable terminal failure legacy compatibility', () => {
  expect(repairOnly).toBe(true);
});
`,
    );
    expect(result.passed, result.evidence.join('\n')).toBe(false);
    expect(result.evidence).toContain('candidate tests reject the original defect: no');
  });

  test('cursor missing repair-only import cannot count as behavioral regression', async () => {
    const result = await evaluate(
      'api-contract-design-full-task-2-individual', 'src/events-contract.ts',
      `${repairedCursor}\nexport const repairOnly = true;\n`,
      'tests/events-contract.test.ts',
      `import { expect, test } from 'bun:test';
import { repairOnly } from '../src/events-contract';
test('concurrent insert invalid tamper expiry legacy page restored enum compatibility telemetry deprecation', () => {
  expect(repairOnly).toBe(true);
});
`,
    );
    expect(result.passed, result.evidence.join('\n')).toBe(false);
    expect(result.evidence).toContain('candidate tests reject the original defect: no');
  });

  test('export and cursor evaluator-owned contracts are immutable', async () => {
    const cases = [
      {
        scenario: 'api-contract-design-full-task-1-individual',
        source: 'src/export-contract.ts',
        repair: repairedExport,
        testPath: 'tests/export-contract.test.ts',
        tests: exportRegressions,
        contract: 'contract-context.md',
      },
      {
        scenario: 'api-contract-design-full-task-2-individual',
        source: 'src/events-contract.ts',
        repair: repairedCursor,
        testPath: 'tests/events-contract.test.ts',
        tests: cursorRegressions,
        contract: 'compatibility-contract.md',
      },
    ];
    for (const item of cases) {
      const result = await evaluate(
        item.scenario, item.source, item.repair, item.testPath, item.tests, item.contract,
      );
      expect(result).toMatchObject({ passed: false, integrityFailure: true });
    }
  });
});
