import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, runHiddenBunTest, writeFixtureFile } from './skill-eval-fixture-helpers';

const RAW_SIGNATURE = 'webhook-integration-full-task-1-individual';
const ORDERING = 'webhook-integration-full-task-2-individual';

const RAW_RECEIVER = `import { createHmac } from 'node:crypto';

export interface WebhookEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ReceiverState {
  handledIds: Set<string>;
  businessCalls: WebhookEvent[];
}

export interface WebhookRequest {
  rawBody: string;
  signature: string;
  timestamp: number;
  now: number;
  secret: string;
  maxBodyBytes?: number;
  replayToleranceSeconds?: number;
}

export type ReceiveResult =
  | { ok: true; duplicate: boolean; eventId: string }
  | { ok: false; reason: 'invalid-signature' | 'stale' | 'malformed' | 'too-large' };

export function signWebhook(rawBody: string, timestamp: number, secret: string): string {
  return createHmac('sha256', secret).update(String(timestamp) + '.' + rawBody).digest('hex');
}

export function handleWebhook(request: WebhookRequest, state: ReceiverState): ReceiveResult {
  // BUG: parsing and JSON reserialization happen before signature verification.
  const event = JSON.parse(request.rawBody) as WebhookEvent;
  const normalized = JSON.stringify(event);
  const expected = signWebhook(normalized, request.timestamp, request.secret);
  if (expected !== request.signature) return { ok: false, reason: 'invalid-signature' };
  state.businessCalls.push(event);
  state.handledIds.add(event.id);
  return { ok: true, duplicate: false, eventId: event.id };
}
`;

const RAW_PUBLIC_TEST = `import { expect, test } from 'bun:test';
import { handleWebhook, signWebhook, type ReceiverState } from '../src/receiver';

test('canonical happy path is accepted', () => {
  const rawBody = '{"id":"evt_1","type":"resource.created","data":{"name":"A"}}';
  const state: ReceiverState = { handledIds: new Set(), businessCalls: [] };
  const result = handleWebhook({
    rawBody,
    timestamp: 1_000,
    now: 1_010,
    secret: 'secret',
    signature: signWebhook(rawBody, 1_000, 'secret'),
  }, state);
  expect(result.ok).toBe(true);
});
`;

const rawSignatureMaterializer: SkillEvalFixtureMaterializer = {
  id: 'webhook-integration/raw-body-signature-replay@1',
  matches: (scenario) => scenario.id === RAW_SIGNATURE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-webhook-raw-signature'));
    writeFixtureFile(destination, 'src/receiver.ts', RAW_RECEIVER);
    writeFixtureFile(destination, 'tests/receiver.test.ts', RAW_PUBLIC_TEST);
    writeFixtureFile(
      destination,
      'provider-contract.md',
      `# Provider webhook contract

- Signature input is the exact received body bytes prefixed with the decimal timestamp and a dot: \`<timestamp>.<raw-body>\`.
- Signature algorithm is HMAC-SHA256 with the configured endpoint secret and lowercase hex encoding.
- Requests older/newer than 300 seconds from the receiver clock are rejected.
- Maximum accepted body is 4096 UTF-8 bytes.
- Event \`id\` is stable across retries; delivery is at least once.
- Authentication and replay checks occur before JSON/business parsing. Duplicate authenticated event ids are acknowledged without repeating business work.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Webhook receiver fixture

Repair \`src/receiver.ts\` against the provider contract. Preserve the exported API. Add representative regression tests in \`tests/receiver.test.ts\` for the repaired trust boundary and failure cases.
`,
    );
  },
};

const rawSignatureScorer: SkillEvalDeterministicScorer = {
  id: 'webhook-integration/raw-body-signature-replay-scorer@1',
  scenarioIds: [RAW_SIGNATURE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { handleWebhook, signWebhook, type ReceiverState } from '../src/receiver';

function state(): ReceiverState {
  return { handledIds: new Set(), businessCalls: [] };
}

test('hidden: signature is verified over exact raw representation', () => {
  const rawBody = '{ \\"type\\": \\"resource.created\\", \\"id\\": \\"evt-space\\", \\"data\\": { \\"x\\": 1 } }';
  const s = state();
  const result = handleWebhook({ rawBody, timestamp: 10_000, now: 10_050, secret: 's3', signature: signWebhook(rawBody, 10_000, 's3') }, s);
  expect(result.ok).toBe(true);
  expect(s.businessCalls).toHaveLength(1);
});

test('hidden: invalid signature cannot reach parsing or business mutation', () => {
  const s = state();
  const result = handleWebhook({ rawBody: '{not json', timestamp: 10_000, now: 10_010, secret: 's3', signature: '0'.repeat(64) }, s);
  expect(result).toEqual({ ok: false, reason: 'invalid-signature' });
  expect(s.businessCalls).toHaveLength(0);
});

test('hidden: stale timestamps fail before business work', () => {
  const rawBody = '{"id":"evt-old","type":"resource.updated","data":{}}';
  const s = state();
  const result = handleWebhook({ rawBody, timestamp: 1_000, now: 1_301, secret: 's3', signature: signWebhook(rawBody, 1_000, 's3') }, s);
  expect(result).toEqual({ ok: false, reason: 'stale' });
  expect(s.businessCalls).toHaveLength(0);
});

test('hidden: duplicate authenticated ids do not repeat business work', () => {
  const rawBody = '{"id":"evt-dup","type":"resource.updated","data":{"n":2}}';
  const s = state();
  const request = { rawBody, timestamp: 10_000, now: 10_001, secret: 's3', signature: signWebhook(rawBody, 10_000, 's3') };
  expect(handleWebhook(request, s)).toEqual({ ok: true, duplicate: false, eventId: 'evt-dup' });
  expect(handleWebhook(request, s)).toEqual({ ok: true, duplicate: true, eventId: 'evt-dup' });
  expect(s.businessCalls).toHaveLength(1);
});

test('hidden: authenticated malformed and oversized bodies fail closed', () => {
  const malformed = '{bad';
  const malformedState = state();
  expect(handleWebhook({ rawBody: malformed, timestamp: 5_000, now: 5_001, secret: 's3', signature: signWebhook(malformed, 5_000, 's3') }, malformedState)).toEqual({ ok: false, reason: 'malformed' });
  expect(malformedState.businessCalls).toHaveLength(0);

  const oversized = JSON.stringify({ id: 'evt-big', type: 'resource.created', data: { value: 'é'.repeat(3000) } });
  const oversizedState = state();
  expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(4096);
  expect(handleWebhook({ rawBody: oversized, timestamp: 5_000, now: 5_001, secret: 's3', signature: signWebhook(oversized, 5_000, 's3') }, oversizedState)).toEqual({ ok: false, reason: 'too-large' });
  expect(oversizedState.businessCalls).toHaveLength(0);
});
`,
    );
    const tests = readFileSync(join(workingDirectory, 'tests/receiver.test.ts'), 'utf8');
    const regressionCoverage =
      /signature/iu.test(tests) &&
      /stale|replay|timestamp/iu.test(tests) &&
      /duplicate|dedup/iu.test(tests) &&
      /malformed/iu.test(tests) &&
      /size|oversiz/iu.test(tests);
    const passed = hidden.passed && regressionCoverage;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden raw-auth/replay/dedup behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative regression coverage: ${regressionCoverage ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const ORDERING_SOURCE = `export type EventType = 'resource.created' | 'resource.updated' | 'resource.deleted';

export interface ResourceSnapshot {
  id: string;
  version: number;
  name: string;
  deleted: boolean;
}

export interface ProviderEvent {
  eventId: string;
  type: EventType;
  resourceId: string;
  version: number;
  name?: string;
}

export interface WebhookState {
  resources: Map<string, ResourceSnapshot>;
  seenEventIds: Set<string>;
  audit: string[];
}

export type FetchCanonical = (resourceId: string) => Promise<ResourceSnapshot>;

export async function processEvent(
  state: WebhookState,
  event: ProviderEvent,
  fetchCanonical: FetchCanonical,
): Promise<'applied' | 'duplicate' | 'stale' | 'reconciled' | 'retry'> {
  // BUG: arrival order is treated as truth; late updates can resurrect deleted resources.
  if (state.seenEventIds.has(event.eventId)) return 'duplicate';
  state.seenEventIds.add(event.eventId);
  state.audit.push(event.eventId);
  if (event.type === 'resource.deleted') {
    state.resources.set(event.resourceId, { id: event.resourceId, version: event.version, name: '', deleted: true });
  } else {
    state.resources.set(event.resourceId, { id: event.resourceId, version: event.version, name: event.name ?? '', deleted: false });
  }
  void fetchCanonical;
  return 'applied';
}
`;

const ORDERING_TEST = `import { expect, test } from 'bun:test';
import { processEvent, type WebhookState } from '../src/order';

test('applies a simple create', async () => {
  const state: WebhookState = { resources: new Map(), seenEventIds: new Set(), audit: [] };
  expect(await processEvent(state, { eventId: 'e1', type: 'resource.created', resourceId: 'r1', version: 1, name: 'A' }, async () => ({ id: 'r1', version: 1, name: 'A', deleted: false }))).toBe('applied');
  expect(state.resources.get('r1')?.name).toBe('A');
});
`;

const orderingMaterializer: SkillEvalFixtureMaterializer = {
  id: 'webhook-integration/webhook-out-of-order-reconcile@1',
  matches: (scenario) => scenario.id === ORDERING,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-webhook-ordering'));
    writeFixtureFile(destination, 'src/order.ts', ORDERING_SOURCE);
    writeFixtureFile(destination, 'tests/order.test.ts', ORDERING_TEST);
    writeFixtureFile(
      destination,
      'provider-contract.md',
      `# Provider event contract

- Delivery is at least once and may be out of order after retries/outages.
- \`eventId\` is stable for duplicate delivery detection.
- \`version\` is a monotonically increasing per-resource version assigned by the provider and is authoritative for ordering.
- created/updated events contain the complete current display name for that event version.
- deleted events establish a versioned tombstone. Older events must never resurrect it.
- An event with the same resource version but conflicting semantics is ambiguous; fetch the canonical provider snapshot before local mutation.
- If canonical reconciliation fails, retain current local state/tombstone and request retry. Never guess from arrival order.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Out-of-order webhook fixture

Repair \`src/order.ts\` so local state converges using provider-supported resource versions and explicit reconciliation. Preserve the exported API. Expand \`tests/order.test.ts\` with duplicate, reordering/tombstone, outage replay, ambiguity, and reconciliation-failure coverage.
`,
    );
  },
};

const orderingScorer: SkillEvalDeterministicScorer = {
  id: 'webhook-integration/webhook-out-of-order-reconcile-scorer@1',
  scenarioIds: [ORDERING],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { processEvent, type WebhookState, type ResourceSnapshot } from '../src/order';

function state(): WebhookState {
  return { resources: new Map(), seenEventIds: new Set(), audit: [] };
}

const canonical = (snapshot: ResourceSnapshot) => async () => snapshot;

test('hidden: duplicate delivery is idempotent', async () => {
  const s = state();
  const event = { eventId: 'e1', type: 'resource.created' as const, resourceId: 'r1', version: 1, name: 'A' };
  expect(await processEvent(s, event, canonical({ id: 'r1', version: 1, name: 'A', deleted: false }))).toBe('applied');
  expect(await processEvent(s, event, canonical({ id: 'r1', version: 1, name: 'A', deleted: false }))).toBe('duplicate');
  expect(s.audit.filter((id) => id === 'e1')).toHaveLength(1);
});

test('hidden: update-before-create follows resource version rather than event type sequence', async () => {
  const s = state();
  await processEvent(s, { eventId: 'u2', type: 'resource.updated', resourceId: 'r1', version: 2, name: 'B' }, canonical({ id: 'r1', version: 2, name: 'B', deleted: false }));
  expect(s.resources.get('r1')).toMatchObject({ version: 2, name: 'B', deleted: false });
  expect(await processEvent(s, { eventId: 'c1', type: 'resource.created', resourceId: 'r1', version: 1, name: 'A' }, canonical({ id: 'r1', version: 2, name: 'B', deleted: false }))).toBe('stale');
  expect(s.resources.get('r1')).toMatchObject({ version: 2, name: 'B', deleted: false });
});

test('hidden: deleted tombstone cannot be resurrected by older update', async () => {
  const s = state();
  await processEvent(s, { eventId: 'd5', type: 'resource.deleted', resourceId: 'r1', version: 5 }, canonical({ id: 'r1', version: 5, name: '', deleted: true }));
  expect(await processEvent(s, { eventId: 'u4', type: 'resource.updated', resourceId: 'r1', version: 4, name: 'old' }, canonical({ id: 'r1', version: 5, name: '', deleted: true }))).toBe('stale');
  expect(s.resources.get('r1')).toMatchObject({ version: 5, deleted: true });
});

test('hidden: conflicting same-version event reconciles to canonical state', async () => {
  const s = state();
  await processEvent(s, { eventId: 'u3', type: 'resource.updated', resourceId: 'r1', version: 3, name: 'A' }, canonical({ id: 'r1', version: 3, name: 'A', deleted: false }));
  const result = await processEvent(s, { eventId: 'd3', type: 'resource.deleted', resourceId: 'r1', version: 3 }, canonical({ id: 'r1', version: 4, name: 'B', deleted: false }));
  expect(result).toBe('reconciled');
  expect(s.resources.get('r1')).toEqual({ id: 'r1', version: 4, name: 'B', deleted: false });
});

test('hidden: reconciliation failure keeps current state and remains retryable', async () => {
  const s = state();
  await processEvent(s, { eventId: 'd8', type: 'resource.deleted', resourceId: 'r1', version: 8 }, canonical({ id: 'r1', version: 8, name: '', deleted: true }));
  const before = structuredClone(s.resources.get('r1'));
  const result = await processEvent(s, { eventId: 'u8-conflict', type: 'resource.updated', resourceId: 'r1', version: 8, name: 'wrong' }, async () => { throw new Error('provider unavailable'); });
  expect(result).toBe('retry');
  expect(s.resources.get('r1')).toEqual(before);
  expect(s.seenEventIds.has('u8-conflict')).toBe(false);
});

test('hidden: outage replay converges despite reversed delivery', async () => {
  const s = state();
  const fetch = canonical({ id: 'r1', version: 6, name: '', deleted: true });
  await processEvent(s, { eventId: 'd6', type: 'resource.deleted', resourceId: 'r1', version: 6 }, fetch);
  await processEvent(s, { eventId: 'u5', type: 'resource.updated', resourceId: 'r1', version: 5, name: 'late' }, fetch);
  await processEvent(s, { eventId: 'c1', type: 'resource.created', resourceId: 'r1', version: 1, name: 'old' }, fetch);
  expect(s.resources.get('r1')).toMatchObject({ version: 6, deleted: true });
});
`,
    );
    const tests = readFileSync(join(workingDirectory, 'tests/order.test.ts'), 'utf8');
    const regressionCoverage =
      /duplicate|dedup/iu.test(tests) &&
      /tombstone|delete/iu.test(tests) &&
      /reconcil/iu.test(tests) &&
      /outage|replay|out[- ]of[- ]order/iu.test(tests) &&
      /fail|unavailable|retry/iu.test(tests);
    const passed = hidden.passed && regressionCoverage;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden version/tombstone/reconciliation behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative regression coverage: ${regressionCoverage ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const WEBHOOK_INTEGRATION_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [rawSignatureMaterializer, orderingMaterializer];

export const WEBHOOK_INTEGRATION_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  rawSignatureScorer,
  orderingScorer,
];
