import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, runHiddenBunTest, writeFixtureFile } from './skill-eval-fixture-helpers';

const EXPORT_API = 'api-contract-design-full-task-1-individual';
const CURSOR_API = 'api-contract-design-full-task-2-individual';

const EXPORT_SOURCE = `export type ExportStatus =
  | 'queued'
  | 'running'
  | 'packaging'
  | 'complete'
  | 'cancelled'
  | 'failed';

export interface ExportRequest {
  accountId: string;
  format: 'json' | 'csv';
  includeHistory?: boolean;
}

export interface PublicFailure {
  code: string;
  retryable: boolean;
  terminal: boolean;
  message: string;
}

export interface ExportRecord {
  id: string;
  request: ExportRequest;
  status: ExportStatus;
  failure?: PublicFailure;
}

export interface ExportStore {
  exports: Map<string, ExportRecord>;
  idempotency: Map<string, string>;
  nextId: number;
}

export type StartResult =
  | { ok: true; export: ExportRecord; replayed: boolean; apiVersion: 1 }
  | { ok: false; error: PublicFailure };

export function createStore(): ExportStore {
  return { exports: new Map(), idempotency: new Map(), nextId: 1 };
}

export function startExport(store: ExportStore, key: string, request: ExportRequest): StartResult {
  // BUG: transport retries always create another logical export and key/body collisions are ignored.
  const id = 'exp_' + store.nextId++;
  const record: ExportRecord = { id, request: { ...request }, status: 'queued' };
  store.exports.set(id, record);
  store.idempotency.set(key, id);
  return { ok: true, export: record, replayed: false, apiVersion: 1 };
}

export function cancelExport(store: ExportStore, id: string): { ok: true; export: ExportRecord } | { ok: false; error: PublicFailure } {
  const record = store.exports.get(id);
  if (!record) return { ok: false, error: { code: 'not_found', retryable: false, terminal: true, message: 'Export not found' } };
  record.status = 'cancelled';
  return { ok: true, export: record };
}

export function pollExport(store: ExportStore, id: string): { ok: true; export: ExportRecord } | { ok: false; error: PublicFailure } {
  const record = store.exports.get(id);
  if (!record) return { ok: false, error: { code: 'redis_row_missing', retryable: false, terminal: true, message: 'redis shard row missing' } };
  return { ok: true, export: record };
}

export function legacyStartClientView(result: StartResult): { id: string; status: ExportStatus } | null {
  if (!result.ok) return null;
  return { id: result.export.id, status: result.export.status };
}
`;

const EXPORT_TEST = `import { expect, test } from 'bun:test';
import { createStore, startExport } from '../src/export-contract';

test('starts an export', () => {
  const store = createStore();
  const result = startExport(store, 'key-1', { accountId: 'acct', format: 'json' });
  expect(result.ok).toBe(true);
});
`;

const exportMaterializer: SkillEvalFixtureMaterializer = {
  id: 'api-contract-design/idempotent-export-api@1',
  matches: (scenario) => scenario.id === EXPORT_API,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-api-export-contract'));
    writeFixtureFile(destination, 'src/export-contract.ts', EXPORT_SOURCE);
    writeFixtureFile(destination, 'tests/export-contract.test.ts', EXPORT_TEST);
    writeFixtureFile(
      destination,
      'contract-context.md',
      `# Existing caller contract

- Clients retry the start call after transport timeout using the same idempotency key.
- Request identity is the normalized semantic body: omitted \`includeHistory\` and explicit \`false\` are equivalent.
- Reusing a key with the same normalized request must return the original logical export; reusing it for a different normalized request is a non-retryable \`idempotency_conflict\`.
- Cancellation is accepted only while status is \`queued\` or \`running\`; \`packaging\`, \`complete\`, \`cancelled\`, and \`failed\` are not cancellable.
- Public errors expose stable code, retryable/terminal classification, and safe caller guidance without queue/cache/database topology.
- Retryable failures are terminal for the current attempt only when \`terminal\` is true; polling must make the distinction explicit.
- Existing clients read only \`export.id\` and \`export.status\` and ignore additive top-level response fields.
- This fixture is the executable public contract. Do not build queue workers or persistence tables.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Account export API contract fixture

Repair the caller-visible contract in \`src/export-contract.ts\`, keep backend queue implementation out of scope, and expand the contract tests to cover retries, key collisions, cancellation boundaries, safe failure semantics, and old-client compatibility.
`,
    );
  },
};

const exportScorer: SkillEvalDeterministicScorer = {
  id: 'api-contract-design/idempotent-export-api-scorer@2',
  scenarioIds: [EXPORT_API],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { cancelExport, createStore, legacyStartClientView, pollExport, startExport } from '../src/export-contract';

test('hidden: transport retry returns one logical export', () => {
  const store = createStore();
  const body = { accountId: 'acct', format: 'json' as const };
  const first = startExport(store, 'idem-1', body);
  const retry = startExport(store, 'idem-1', { ...body, includeHistory: false });
  expect(first.ok).toBe(true);
  expect(retry.ok).toBe(true);
  if (!first.ok || !retry.ok) throw new Error('unexpected failure');
  expect(retry.export.id).toBe(first.export.id);
  expect(retry.replayed).toBe(true);
  expect(store.exports.size).toBe(1);
});

test('hidden: same key with different normalized body is rejected', () => {
  const store = createStore();
  startExport(store, 'idem-2', { accountId: 'acct', format: 'json', includeHistory: false });
  const collision = startExport(store, 'idem-2', { accountId: 'acct', format: 'csv', includeHistory: false });
  expect(collision.ok).toBe(false);
  if (collision.ok) throw new Error('expected conflict');
  expect(collision.error.code).toBe('idempotency_conflict');
  expect(collision.error.retryable).toBe(false);
  expect(store.exports.size).toBe(1);
});

test('hidden: cancellation is state constrained', () => {
  for (const state of ['queued', 'running'] as const) {
    const store = createStore();
    const started = startExport(store, 'k-' + state, { accountId: 'acct', format: 'json' });
    if (!started.ok) throw new Error('start failed');
    started.export.status = state;
    expect(cancelExport(store, started.export.id).ok).toBe(true);
  }
  for (const state of ['packaging', 'complete', 'cancelled', 'failed'] as const) {
    const store = createStore();
    const started = startExport(store, 'k-' + state, { accountId: 'acct', format: 'json' });
    if (!started.ok) throw new Error('start failed');
    started.export.status = state;
    const result = cancelExport(store, started.export.id);
    expect(result.ok).toBe(false);
    expect(started.export.status).toBe(state);
  }
});

test('hidden: public failures classify retryability without topology leakage', () => {
  const store = createStore();
  const missing = pollExport(store, 'missing');
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error('expected missing');
  expect(typeof missing.error.retryable).toBe('boolean');
  expect(typeof missing.error.terminal).toBe('boolean');
  expect(JSON.stringify(missing.error)).not.toMatch(/redis|queue|shard|table|database|worker/i);

  const started = startExport(store, 'idem-f', { accountId: 'acct', format: 'json' });
  if (!started.ok) throw new Error('start failed');
  started.export.status = 'failed';
  started.export.failure = { code: 'upstream_temporarily_unavailable', retryable: true, terminal: false, message: 'Try again later' };
  const polled = pollExport(store, started.export.id);
  expect(polled.ok).toBe(true);
  if (!polled.ok) throw new Error('poll failed');
  expect(polled.export.failure).toMatchObject({ retryable: true, terminal: false });
});

test('hidden: additive response metadata does not break the legacy view', () => {
  const store = createStore();
  const result = startExport(store, 'idem-old', { accountId: 'acct', format: 'csv' });
  const view = legacyStartClientView(result);
  expect(view?.id).toMatch(/^exp_/);
  expect(view?.status).toBe('queued');
});
`,
    );
    const tests = readFileSync(join(workingDirectory, 'tests/export-contract.test.ts'), 'utf8');
    const coverage =
      /idempot|retry/iu.test(tests) &&
      /collision|different|conflict/iu.test(tests) &&
      /cancel/iu.test(tests) &&
      /retryable|terminal|failure/iu.test(tests) &&
      /legacy|compat/iu.test(tests);
    const passed = hidden.passed && coverage;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden caller contract behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative contract regression coverage: ${coverage ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const CURSOR_SOURCE = `export type EventKind = 'created' | 'updated' | 'deleted' | 'restored';

export interface EventRecord {
  id: string;
  occurredAt: number;
  kind: EventKind;
  value: string;
}

export interface PaginationTelemetry {
  legacyPageRequests: number;
  cursorRequests: number;
}

export type ListRequest =
  | { mode: 'v1-offset'; page: number; limit: number; now: number }
  | { mode: 'v2-cursor'; cursor?: string; limit: number; now: number };

export type ListResult =
  | { ok: true; items: Array<Record<string, unknown>>; nextCursor?: string; deprecation?: string }
  | { ok: false; error: { code: 'invalid_cursor' | 'expired_cursor'; retryable: false } };

function sortEvents(events: EventRecord[]): EventRecord[] {
  return [...events].sort((a, b) => b.occurredAt - a.occurredAt || b.id.localeCompare(a.id));
}

export function listEvents(events: EventRecord[], request: ListRequest, telemetry: PaginationTelemetry): ListResult {
  const ordered = sortEvents(events);
  if (request.mode === 'v1-offset') {
    telemetry.legacyPageRequests += 1;
    const start = Math.max(0, (request.page - 1) * request.limit);
    return { ok: true, items: ordered.slice(start, start + request.limit) };
  }
  telemetry.cursorRequests += 1;
  // BUG: cursor is just an integer offset, so concurrent inserts shift continuation.
  const start = request.cursor ? Number(request.cursor) : 0;
  return { ok: true, items: ordered.slice(start, start + request.limit), nextCursor: String(start + request.limit) };
}
`;

const CURSOR_TEST = `import { expect, test } from 'bun:test';
import { listEvents, type EventRecord } from '../src/events-contract';

test('legacy page/limit remains available', () => {
  const events: EventRecord[] = [
    { id: 'e2', occurredAt: 2, kind: 'updated', value: 'b' },
    { id: 'e1', occurredAt: 1, kind: 'created', value: 'a' },
  ];
  const result = listEvents(events, { mode: 'v1-offset', page: 1, limit: 1, now: 100 }, { legacyPageRequests: 0, cursorRequests: 0 });
  expect(result.ok).toBe(true);
});
`;

const cursorMaterializer: SkillEvalFixtureMaterializer = {
  id: 'api-contract-design/cursor-pagination-versioning@1',
  matches: (scenario) => scenario.id === CURSOR_API,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-api-cursor-contract'));
    writeFixtureFile(destination, 'src/events-contract.ts', CURSOR_SOURCE);
    writeFixtureFile(destination, 'tests/events-contract.test.ts', CURSOR_TEST);
    writeFixtureFile(
      destination,
      'compatibility-contract.md',
      `# Installed-client and migration contract

- Canonical ordering is \`occurredAt DESC, id DESC\`; cursor continuation must seek strictly after the last returned tuple, so inserts newer than page 1 do not shift page 2.
- Cursors are opaque, integrity-checkable representations of the ordering tuple plus issuance time and expire after 3600 seconds. Malformed/tampered cursors return \`invalid_cursor\`; older valid cursors return \`expired_cursor\`. Cursor errors are non-retryable without restarting traversal.
- The installed v1 client continues sending \`page/limit\` for the deprecation window. Keep that request style working and record each use in \`legacyPageRequests\` telemetry. v2 cursor use increments \`cursorRequests\`.
- v1 clients recognize event kinds \`created\`, \`updated\`, and \`deleted\` only. The new server kind \`restored\` must not be emitted literally to v1; for the supported window its compatible v1 representation is \`updated\`. v2 returns the real kind.
- v1 client decoding ignores additive top-level response metadata but is strict about the event-kind enum.
- Do not redesign persistence; this fixture is the public contract/reference behavior only.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Cursor pagination contract fixture

Repair \`src/events-contract.ts\` to implement the staged compatibility contract and expand tests for concurrent inserts, invalid/expired cursors, old-client enum behavior, and deprecation telemetry.
`,
    );
  },
};

const cursorScorer: SkillEvalDeterministicScorer = {
  id: 'api-contract-design/cursor-pagination-versioning-scorer@3',
  scenarioIds: [CURSOR_API],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { listEvents, type EventRecord, type PaginationTelemetry } from '../src/events-contract';

const base: EventRecord[] = [
  { id: 'e5', occurredAt: 500, kind: 'updated', value: '5' },
  { id: 'e4', occurredAt: 400, kind: 'updated', value: '4' },
  { id: 'e3', occurredAt: 300, kind: 'updated', value: '3' },
  { id: 'e2', occurredAt: 200, kind: 'updated', value: '2' },
  { id: 'e1', occurredAt: 100, kind: 'created', value: '1' },
];

function telemetry(): PaginationTelemetry { return { legacyPageRequests: 0, cursorRequests: 0 }; }

test('hidden: cursor traversal is stable across newer concurrent insert', () => {
  const t = telemetry();
  const first = listEvents(base, { mode: 'v2-cursor', limit: 2, now: 10_000 }, t);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error('first failed');
  expect(first.items.map((x) => x.id)).toEqual(['e5', 'e4']);
  const withInsert = [{ id: 'e6', occurredAt: 600, kind: 'updated' as const, value: '6' }, ...base];
  const second = listEvents(withInsert, { mode: 'v2-cursor', cursor: first.nextCursor, limit: 2, now: 10_010 }, t);
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error('second failed');
  expect(second.items.map((x) => x.id)).toEqual(['e3', 'e2']);
  expect(t.cursorRequests).toBe(2);
});

test('hidden: cursor detects tampering and expiry distinctly', () => {
  const t = telemetry();
  const first = listEvents(base, { mode: 'v2-cursor', limit: 1, now: 1_000 }, t);
  if (!first.ok || !first.nextCursor) throw new Error('missing cursor');
  const tampered = first.nextCursor.slice(0, -1) + (first.nextCursor.endsWith('A') ? 'B' : 'A');
  expect(listEvents(base, { mode: 'v2-cursor', cursor: tampered, limit: 1, now: 1_001 }, t)).toEqual({ ok: false, error: { code: 'invalid_cursor', retryable: false } });
  expect(listEvents(base, { mode: 'v2-cursor', cursor: first.nextCursor, limit: 1, now: 4_601 }, t)).toEqual({ ok: false, error: { code: 'expired_cursor', retryable: false } });
});

test('hidden: old page client remains supported and does not receive new enum literal', () => {
  const t = telemetry();
  const events: EventRecord[] = [{ id: 'r1', occurredAt: 700, kind: 'restored', value: 'restored' }, ...base];
  const legacy = listEvents(events, { mode: 'v1-offset', page: 1, limit: 2, now: 20_000 }, t);
  expect(legacy.ok).toBe(true);
  if (!legacy.ok) throw new Error('legacy failed');
  expect(legacy.items[0]?.kind).toBe('updated');
  expect(legacy.items.map((item) => item.kind)).not.toContain('restored');
  expect(legacy.deprecation).toBeTruthy();
  expect(t.legacyPageRequests).toBe(1);

  const current = listEvents(events, { mode: 'v2-cursor', limit: 1, now: 20_000 }, t);
  expect(current.ok).toBe(true);
  if (!current.ok) throw new Error('current failed');
  expect(current.items[0]?.kind).toBe('restored');
});
`,
    );
    const tests = readFileSync(join(workingDirectory, 'tests/events-contract.test.ts'), 'utf8');
    const coverage =
      /concurrent|insert/iu.test(tests) &&
      /invalid|tamper/iu.test(tests) &&
      /expir/iu.test(tests) &&
      /legacy|page|v1/iu.test(tests) &&
      /enum|restored|compat/iu.test(tests) &&
      /telemetry|deprecat/iu.test(tests);
    const passed = hidden.passed && coverage;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden pagination/version compatibility: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative contract regression coverage: ${coverage ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const API_CONTRACT_DESIGN_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [exportMaterializer, cursorMaterializer];

export const API_CONTRACT_DESIGN_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  exportScorer,
  cursorScorer,
];
