import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const OUTBOX = 'event-driven-architecture-full-task-1-individual';
const EVENT_EVOLUTION = 'event-driven-architecture-full-task-2-individual';
const LEASE_FAILOVER = 'distributed-backend-full-task-1-individual';
const REPLICATED_COUNTER = 'distributed-backend-full-task-2-individual';
const MISSING_EVENT = 'distributed-debugging-full-task-1';
const STALE_PERMISSION = 'distributed-debugging-full-task-2';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

function hasBoolean(value: unknown, key: string, expected: boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => hasBoolean(item, key, expected));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record[key] === expected) return true;
  return Object.values(record).some((item) => hasBoolean(item, key, expected));
}

function contains(text: string, patterns: RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(text));
}

const OUTBOX_SOURCE = `export type CrashPoint =
  | 'before-commit'
  | 'after-commit'
  | 'after-broker-publish'
  | 'after-broker-ack';

export interface OrderCreated {
  eventId: string;
  version: 1;
  type: 'OrderCreated';
  orderId: string;
}

export interface Snapshot {
  orders: string[];
  outbox: OrderCreated[];
  brokerEvents: OrderCreated[];
  consumerEffects: string[];
  duplicateObservations: number;
}

export class OrderEventHarness {
  private readonly orders = new Set<string>();
  private readonly outbox = new Map<string, OrderCreated>();
  private readonly brokerEvents: OrderCreated[] = [];
  private readonly consumerEffects = new Set<string>();
  private duplicateObservations = 0;

  placePaidOrder(orderId: string, crashAt?: CrashPoint): void {
    const event: OrderCreated = {
      eventId: 'order:' + orderId + ':created:v1',
      version: 1,
      type: 'OrderCreated',
      orderId,
    };
    if (crashAt === 'before-commit') throw new Error('crash:before-commit');

    // BUG: the order becomes durable before its required outbox record. A crash at this
    // boundary leaves committed business state with no replayable event.
    this.orders.add(orderId);
    if (crashAt === 'after-commit') throw new Error('crash:after-commit');
    this.outbox.set(event.eventId, event);
  }

  publishPending(crashAt?: CrashPoint): void {
    for (const event of [...this.outbox.values()]) {
      this.brokerEvents.push(structuredClone(event));
      if (crashAt === 'after-broker-publish') throw new Error('crash:after-broker-publish');
      if (crashAt === 'after-broker-ack') throw new Error('crash:after-broker-ack');
      this.outbox.delete(event.eventId);
    }
  }

  deliverAll(): void {
    for (const event of this.brokerEvents) {
      if (this.consumerEffects.has(event.eventId)) {
        this.duplicateObservations += 1;
        continue;
      }
      this.consumerEffects.add(event.eventId);
    }
  }

  snapshot(): Snapshot {
    return {
      orders: [...this.orders].sort(),
      outbox: [...this.outbox.values()].map((event) => structuredClone(event)),
      brokerEvents: this.brokerEvents.map((event) => structuredClone(event)),
      consumerEffects: [...this.consumerEffects].sort(),
      duplicateObservations: this.duplicateObservations,
    };
  }
}
`;

const outboxMaterializer: SkillEvalFixtureMaterializer = {
  id: 'event-driven-architecture/outbox-order-created@1',
  matches: (scenario) => scenario.id === OUTBOX,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-event-outbox'));
    writeFixtureFile(destination, 'src/order-events.ts', OUTBOX_SOURCE);
    writeFixtureFile(
      destination,
      'tests/order-events.test.ts',
      `import { expect, test } from 'bun:test';
import { OrderEventHarness } from '../src/order-events';

test('happy path publishes one stable OrderCreated event', () => {
  const harness = new OrderEventHarness();
  harness.placePaidOrder('o-1');
  harness.publishPending();
  harness.deliverAll();
  const state = harness.snapshot();
  expect(state.orders).toEqual(['o-1']);
  expect(state.brokerEvents).toHaveLength(1);
  expect(state.brokerEvents[0]).toMatchObject({ eventId: 'order:o-1:created:v1', version: 1 });
  expect(state.consumerEffects).toEqual(['order:o-1:created:v1']);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# OrderCreated transactional-outbox fixture

Repair the order/event durability boundary without changing the public harness API. Treat the order row and required outbox record as one atomic visibility boundary: a crash before commit leaves neither; a crash after commit may leave both but never only the order. Broker publication is at-least-once. A crash after broker publish or acknowledgement may therefore cause the same stable event id to be published again; the consumer must remain idempotent. A fully acknowledged successful flush may clean the outbox record.

Add regressions for before/after commit, publish-before-ack/ack-before-cleanup recovery, duplicate delivery, stable event id/version, consumer idempotency, and cleanup. Do not claim exactly-once transport.

Write \`.kory-eval/event-outbox.json\` with the transaction boundary, crash matrix, duplicate/recovery results, hierarchy note (broader distributed-backend; stream-processing remains adjacent), and explicit \`exactlyOnceTransport: false\` plus a synthetic/local evidence label.
`,
    );
  },
};

const outboxScorer: SkillEvalDeterministicScorer = {
  id: 'event-driven-architecture/outbox-order-created-scorer@2',
  scenarioIds: [OUTBOX],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { OrderEventHarness } from '../src/order-events';

test('hidden: commit visibility never exposes an order without its outbox event', () => {
  const before = new OrderEventHarness();
  expect(() => before.placePaidOrder('before', 'before-commit')).toThrow();
  expect(before.snapshot()).toMatchObject({ orders: [], outbox: [] });

  const after = new OrderEventHarness();
  expect(() => after.placePaidOrder('after', 'after-commit')).toThrow();
  expect(after.snapshot().orders).toEqual(['after']);
  expect(after.snapshot().outbox.map((event) => event.eventId)).toEqual(['order:after:created:v1']);
});

test('hidden: publish/ack uncertainty is recovered with stable identity and idempotent consumption', () => {
  for (const crashAt of ['after-broker-publish', 'after-broker-ack'] as const) {
    const harness = new OrderEventHarness();
    harness.placePaidOrder('recover');
    expect(() => harness.publishPending(crashAt)).toThrow();
    expect(harness.snapshot().outbox).toHaveLength(1);
    harness.publishPending();
    harness.deliverAll();
    const state = harness.snapshot();
    expect(state.outbox).toHaveLength(0);
    expect(state.brokerEvents).toHaveLength(2);
    expect(new Set(state.brokerEvents.map((event) => event.eventId))).toEqual(new Set(['order:recover:created:v1']));
    expect(new Set(state.brokerEvents.map((event) => event.version))).toEqual(new Set([1]));
    expect(state.consumerEffects).toEqual(['order:recover:created:v1']);
    expect(state.duplicateObservations).toBe(1);
  }
});
`,
    );
    const regression = hasRegressionText(workingDirectory, [
      /before.?commit|after.?commit/iu,
      /duplicate|idempoten/iu,
      /publish|ack/iu,
      /outbox/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/event-outbox.json');
    const bounded =
      Boolean(report.artifact) &&
      contains(report.text, [
        /at-least-once|at least once/u,
        /transaction|atomic/u,
        /synthetic|local/u,
      ]) &&
      hasBoolean(report.artifact, 'exactlyOnceTransport', false);
    const passed = hidden.passed && regression && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && regression ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `atomic visibility + publish/ack recovery: ${hidden.passed ? 'pass' : 'fail'}`,
        `repository regression coverage: ${regression ? 'present' : 'missing'}`,
        `bounded at-least-once evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const EVENT_EVOLUTION_SOURCE = `export type RolloutPhase = 'compatibility' | 'modern';
export type ConsumerGeneration = 'old' | 'new';

export interface Customer {
  id: string;
  email?: string;
  contacts: Array<{ method: string; value: string }>;
  preferredContact: string;
}

export interface CustomerUpdatedEvent {
  version: 1 | 2;
  customerId: string;
  email?: string;
  contacts?: Array<{ method: string; value: string }>;
  preferredContact: string;
}

export const HISTORICAL_EVENT: CustomerUpdatedEvent = {
  version: 1,
  customerId: 'historical-1',
  email: 'old@example.test',
  preferredContact: 'email',
};

export function produceCustomerUpdated(customer: Customer, _phase: RolloutPhase): CustomerUpdatedEvent {
  // BUG: the producer emits the final representation immediately, even while old independently
  // deployed consumers are still in the compatibility envelope.
  return {
    version: 2,
    customerId: customer.id,
    contacts: customer.contacts.map((contact) => ({ ...contact })),
    preferredContact: customer.preferredContact,
  };
}

export function consumeEmail(event: CustomerUpdatedEvent, generation: ConsumerGeneration): string {
  if (generation === 'old') {
    if (!event.email) throw new Error('email-required');
    return event.email;
  }
  const email = event.contacts?.find((contact) => contact.method === 'email')?.value ?? event.email;
  return email ?? 'no-email';
}

export function consumePreference(event: CustomerUpdatedEvent, generation: ConsumerGeneration): string {
  if (generation === 'old' && !['email', 'phone'].includes(event.preferredContact)) {
    throw new Error('unknown-enum:' + event.preferredContact);
  }
  // BUG: the upgraded decoder still treats future values as fatal instead of preserving an
  // observable unknown/fallback representation.
  if (!['email', 'phone', 'sms'].includes(event.preferredContact)) {
    throw new Error('unknown-enum:' + event.preferredContact);
  }
  return event.preferredContact;
}

export function consumeContacts(event: CustomerUpdatedEvent): string[] {
  if (event.contacts) return event.contacts.map((contact) => contact.method + ':' + contact.value);
  return event.email ? ['email:' + event.email] : [];
}

export class DeadLetterQueue {
  private readonly queued: CustomerUpdatedEvent[] = [];
  add(event: CustomerUpdatedEvent): void { this.queued.push(structuredClone(event)); }
  size(): number { return this.queued.length; }
  replay(consumer: (event: CustomerUpdatedEvent) => unknown): number {
    let recovered = 0;
    for (const event of [...this.queued]) {
      try {
        consumer(event);
        this.queued.shift();
        recovered += 1;
      } catch {
        break;
      }
    }
    return recovered;
  }
}
`;

const eventEvolutionMaterializer: SkillEvalFixtureMaterializer = {
  id: 'event-driven-architecture/event-schema-consumer-evolution@1',
  matches: (scenario) => scenario.id === EVENT_EVOLUTION,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-event-evolution'));
    writeFixtureFile(destination, 'src/customer-events.ts', EVENT_EVOLUTION_SOURCE);
    writeFixtureFile(
      destination,
      'tests/customer-events.test.ts',
      `import { expect, test } from 'bun:test';
import { HISTORICAL_EVENT, consumeContacts, consumeEmail, consumePreference } from '../src/customer-events';

test('historical v1 remains readable', () => {
  expect(consumeEmail(HISTORICAL_EVENT, 'old')).toBe('old@example.test');
  expect(consumePreference(HISTORICAL_EVENT, 'old')).toBe('email');
  expect(consumeContacts(HISTORICAL_EVENT)).toEqual(['email:old@example.test']);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# CustomerUpdated independent-consumer evolution fixture

Keep the three consumers independently deployable. During \`compatibility\`, the producer must emit a representation accepted by both old consumers while preserving the new contact data for an upgraded consumer. During \`modern\`, upgraded consumers must accept v1 historical replay and v2 current events, including an unknown future preferred-contact value without a fatal decode. Demonstrate a v2 event that dead-letters against the old enum consumer and is recoverable after that consumer is upgraded.

Do not solve this with an undocumented producer flag tied to a specific consumer deployment. Add old/new/historical replay, unknown-enum, and dead-letter recovery tests.

Write \`.kory-eval/event-schema-evolution.json\` with explicit rollout phases, old/new/historical compatibility matrix, dead-letter recovery evidence, hierarchy note (broader distributed-backend; realtime-systems stays adjacent), \`undocumentedDeploymentFlag: false\`, and a synthetic/local evidence label.
`,
    );
  },
};

const eventEvolutionScorer: SkillEvalDeterministicScorer = {
  id: 'event-driven-architecture/event-schema-consumer-evolution-scorer@2',
  scenarioIds: [EVENT_EVOLUTION],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import {
  DeadLetterQueue,
  HISTORICAL_EVENT,
  consumeContacts,
  consumeEmail,
  consumePreference,
  produceCustomerUpdated,
  type CustomerUpdatedEvent,
} from '../src/customer-events';

const customer = {
  id: 'c-2',
  email: 'compat@example.test',
  contacts: [
    { method: 'email', value: 'compat@example.test' },
    { method: 'sms', value: '+15550001111' },
  ],
  preferredContact: 'sms',
};

test('hidden: compatibility phase coexists with both old consumers and new contact reader', () => {
  const event = produceCustomerUpdated(customer, 'compatibility');
  expect(() => consumeEmail(event, 'old')).not.toThrow();
  expect(() => consumePreference(event, 'old')).not.toThrow();
  expect(consumeContacts(event)).toContain('sms:+15550001111');
});

test('hidden: upgraded consumers replay historical/current/future-enum inputs', () => {
  expect(() => consumeEmail(HISTORICAL_EVENT, 'new')).not.toThrow();
  expect(() => consumePreference(HISTORICAL_EVENT, 'new')).not.toThrow();
  const modern = produceCustomerUpdated(customer, 'modern');
  expect(() => consumeEmail(modern, 'new')).not.toThrow();
  expect(() => consumePreference(modern, 'new')).not.toThrow();
  const future: CustomerUpdatedEvent = { ...modern, preferredContact: 'push' };
  expect(() => consumePreference(future, 'new')).not.toThrow();
});

test('hidden: incompatible old delivery can be recovered from dead letter after upgrade', () => {
  const modern = produceCustomerUpdated(customer, 'modern');
  const incompatible: CustomerUpdatedEvent = { ...modern, preferredContact: 'sms' };
  const dlq = new DeadLetterQueue();
  try { consumePreference(incompatible, 'old'); } catch { dlq.add(incompatible); }
  expect(dlq.size()).toBe(1);
  expect(dlq.replay((event) => consumePreference(event, 'new'))).toBe(1);
  expect(dlq.size()).toBe(0);
});
`,
    );
    const regression = hasRegressionText(workingDirectory, [
      /compatib/iu,
      /historical|v1/iu,
      /unknown|future|push/iu,
      /dead.?letter|dlq/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/event-schema-evolution.json');
    const bounded =
      Boolean(report.artifact) &&
      contains(report.text, [
        /compatib/u,
        /modern|new/u,
        /historical|replay/u,
        /dead.?letter|dlq/u,
        /synthetic|local/u,
      ]) &&
      hasBoolean(report.artifact, 'undocumentedDeploymentFlag', false);
    const passed = hidden.passed && regression && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && regression ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `old/new/historical/unknown-enum behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `migration regressions: ${regression ? 'present' : 'missing'}`,
        `staged rollout + DLQ evidence: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const LEASE_SOURCE = `export type Region = 'A' | 'B';
export interface Lease { holder: Region; token: number }

export class LeaseStore {
  private nextToken = 0;
  private readonly reachable: Record<Region, boolean> = { A: true, B: true };

  setReachable(region: Region, reachable: boolean): void { this.reachable[region] = reachable; }

  acquire(region: Region): Lease | null {
    if (!this.reachable[region]) return null;
    this.nextToken += 1;
    return { holder: region, token: this.nextToken };
  }
}

export class Worker {
  private highestAuthority = 0;
  private readonly committed = new Set<string>();

  observeAuthority(token: number): void { this.highestAuthority = Math.max(this.highestAuthority, token); }

  dispatch(jobId: string, _token: number): boolean {
    // BUG: job-level de-duplication is not an authority fence. A stale region can still commit a
    // distinct dispatch after a newer region owns the shard.
    if (this.committed.has(jobId)) return false;
    this.committed.add(jobId);
    return true;
  }

  effects(): string[] { return [...this.committed].sort(); }
  authority(): number { return this.highestAuthority; }
}

export class Scheduler {
  private lease: Lease | null = null;
  constructor(
    readonly region: Region,
    private readonly store: LeaseStore,
    private readonly worker: Worker,
    readonly clockSkewMs: number,
  ) {}

  acquire(): Lease | null {
    const lease = this.store.acquire(this.region);
    if (lease) {
      this.lease = lease;
      this.worker.observeAuthority(lease.token);
    }
    return lease;
  }

  compute(jobId: string): string { return this.region + ':computed:' + jobId; }

  dispatch(jobId: string): boolean {
    if (!this.lease) return false;
    return this.worker.dispatch(jobId, this.lease.token);
  }

  localTime(authoritativeMs: number): number { return authoritativeMs + this.clockSkewMs; }
}
`;

const leaseFailoverMaterializer: SkillEvalFixtureMaterializer = {
  id: 'distributed-backend/cross-region-lease-failover@1',
  matches: (scenario) => scenario.id === LEASE_FAILOVER,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-distributed-lease'));
    writeFixtureFile(destination, 'src/lease-scheduler.ts', LEASE_SOURCE);
    writeFixtureFile(
      destination,
      'tests/lease-scheduler.test.ts',
      `import { expect, test } from 'bun:test';
import { LeaseStore, Scheduler, Worker } from '../src/lease-scheduler';

test('lease tokens increase across regions', () => {
  const store = new LeaseStore(); const worker = new Worker();
  const a = new Scheduler('A', store, worker, 90_000); const b = new Scheduler('B', store, worker, -45_000);
  expect(a.acquire()?.token).toBe(1);
  expect(b.acquire()?.token).toBe(2);
  expect(worker.authority()).toBe(2);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Cross-region lease/fencing fixture

Region A can lose access to the lease store while workers remain reachable. Region B may then acquire a newer lease. A stale scheduler may continue computing, but the externally visible worker boundary must reject its stale fencing token. Do not infer ownership from either scheduler's local clock; the supplied skews are intentionally non-zero. Preserve job de-duplication as a secondary defense, not the authority proof.

Add deterministic split-brain, skew, failover, recovery, and duplicate-dispatch regressions. After A is isolated and B acquires token 2, A/token 1 must not commit. After recovery, a newly acquired token must be monotonic and able to commit.

Write \`.kory-eval/distributed-lease.json\` with the failure/consistency model, token timeline, partition/failover/recovery results, hierarchy note (broader backend-engineering; event-driven-architecture and stream-processing remain children), \`wallClockOwnershipProof: false\`, and a synthetic/local simulation label.
`,
    );
  },
};

const leaseFailoverScorer: SkillEvalDeterministicScorer = {
  id: 'distributed-backend/cross-region-lease-failover-scorer@2',
  scenarioIds: [LEASE_FAILOVER],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { LeaseStore, Scheduler, Worker } from '../src/lease-scheduler';

test('hidden: newer lease fences stale holder even while stale holder can compute', () => {
  const store = new LeaseStore(); const worker = new Worker();
  const a = new Scheduler('A', store, worker, 120_000); const b = new Scheduler('B', store, worker, -75_000);
  expect(a.acquire()?.token).toBe(1);
  expect(a.dispatch('before-partition')).toBe(true);
  store.setReachable('A', false);
  expect(a.acquire()).toBeNull();
  expect(b.acquire()?.token).toBe(2);
  expect(a.compute('split')).toContain('computed:split');
  expect(a.dispatch('split')).toBe(false);
  expect(b.dispatch('split')).toBe(true);
  expect(worker.effects()).toEqual(['before-partition', 'split']);
});

test('hidden: recovery uses a newer fence and clock skew does not confer authority', () => {
  const store = new LeaseStore(); const worker = new Worker();
  const a = new Scheduler('A', store, worker, 600_000); const b = new Scheduler('B', store, worker, -600_000);
  expect(a.acquire()?.token).toBe(1);
  store.setReachable('A', false);
  expect(b.acquire()?.token).toBe(2);
  expect(a.localTime(1_000)).toBeGreaterThan(b.localTime(1_000));
  expect(a.dispatch('stale')).toBe(false);
  store.setReachable('A', true);
  expect(a.acquire()?.token).toBe(3);
  expect(a.dispatch('recovered')).toBe(true);
});
`,
    );
    const regression = hasRegressionText(workingDirectory, [
      /partition|reachable/iu,
      /fenc|token/iu,
      /skew|clock/iu,
      /recover|failover/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/distributed-lease.json');
    const bounded =
      Boolean(report.artifact) &&
      contains(report.text, [
        /partial|partition|failure/u,
        /fenc|token/u,
        /recover|failover/u,
        /synthetic|local|simulation/u,
      ]) &&
      hasBoolean(report.artifact, 'wallClockOwnershipProof', false);
    const passed = hidden.passed && regression && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && regression ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `split-brain fencing + recovery simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `partition/skew/fencing regressions: ${regression ? 'present' : 'missing'}`,
        `failure-model evidence: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const COUNTER_SOURCE = `export interface UsageEvent {
  eventId: string;
  units: number;
  sequence: number;
}

export type IngestResult = 'accepted' | 'duplicate' | 'conflict' | 'too-old';

export class UsageReplica {
  private readonly events = new Map<string, UsageEvent>();
  private totalUnits = 0;
  private retentionFloor = 0;

  constructor(readonly region: 'A' | 'B') {}

  ingest(event: UsageEvent): IngestResult {
    if (event.sequence < this.retentionFloor) return 'too-old';
    const prior = this.events.get(event.eventId);
    if (prior) return prior.units === event.units && prior.sequence === event.sequence ? 'duplicate' : 'conflict';
    this.events.set(event.eventId, { ...event });
    this.totalUnits += event.units;
    return 'accepted';
  }

  merge(other: UsageReplica): void {
    // BUG: summing regional aggregates treats duplicate cross-region observations as independent
    // usage. Event identities are copied only after the inflated aggregate is committed.
    this.totalUnits += other.totalUnits;
    for (const event of other.retainedEvents()) {
      if (!this.events.has(event.eventId)) this.events.set(event.eventId, { ...event });
    }
  }

  advanceRetentionFloor(sequence: number): void {
    this.retentionFloor = Math.max(this.retentionFloor, sequence);
    // BUG: identities below the replay floor are dropped without separating their settled total,
    // leaving merge/reconciliation unable to distinguish settled value from duplicate value.
    for (const [id, event] of this.events) if (event.sequence < this.retentionFloor) this.events.delete(id);
  }

  total(): number { return this.totalUnits; }
  retainedIdentityCount(): number { return this.events.size; }
  floor(): number { return this.retentionFloor; }
  retainedEvents(): UsageEvent[] { return [...this.events.values()].map((event) => ({ ...event })); }
}
`;

const replicatedCounterMaterializer: SkillEvalFixtureMaterializer = {
  id: 'distributed-backend/replicated-counter-dedup@1',
  matches: (scenario) => scenario.id === REPLICATED_COUNTER,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-replicated-counter'));
    writeFixtureFile(destination, 'src/usage-replica.ts', COUNTER_SOURCE);
    writeFixtureFile(
      destination,
      'tests/usage-replica.test.ts',
      `import { expect, test } from 'bun:test';
import { UsageReplica } from '../src/usage-replica';

test('one replica de-duplicates a repeated event id', () => {
  const a = new UsageReplica('A');
  expect(a.ingest({ eventId: 'e1', units: 5, sequence: 10 })).toBe('accepted');
  expect(a.ingest({ eventId: 'e1', units: 5, sequence: 10 })).toBe('duplicate');
  expect(a.total()).toBe(5);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Replicated usage convergence fixture

The same at-least-once usage event may arrive in both regions before asynchronous merge. Convergence is by stable event identity, not by summing already-aggregated regional counters. Preserve every unique event once logically across duplicate, reordered, delayed, and failover-replay delivery.

The replay-retention floor is a documented reconciliation boundary: first reconcile both replicas, then advance the same floor. Events older than the floor are no longer replayable and must be rejected without changing billing; settled value remains represented without retaining every old event identity forever. Conflicting reuse of an event id must be observable rather than silently merged. Do not replace the two replicas with one shared in-process database.

Add duplicate-cross-region, reordering, bidirectional convergence, retention-floor, late replay, and conflict regressions. Write \`.kory-eval/replicated-counter.json\` with the convergence rule, reconciliation-before-retention boundary, expected totals, failure/recovery trace, hierarchy note (broader backend-engineering; event-driven-architecture/stream-processing remain children), \`sharedSingleDatabase: false\`, and a synthetic/local simulation label.
`,
    );
  },
};

const replicatedCounterScorer: SkillEvalDeterministicScorer = {
  id: 'distributed-backend/replicated-counter-dedup-scorer@2',
  scenarioIds: [REPLICATED_COUNTER],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { UsageReplica } from '../src/usage-replica';

function seed() {
  const a = new UsageReplica('A'); const b = new UsageReplica('B');
  a.ingest({ eventId: 'e1', units: 5, sequence: 10 });
  a.ingest({ eventId: 'e2', units: 7, sequence: 11 });
  b.ingest({ eventId: 'e1', units: 5, sequence: 10 });
  b.ingest({ eventId: 'e3', units: 10, sequence: 12 });
  return { a, b };
}

test('hidden: reordered cross-region duplicates converge to each unique event once', () => {
  const { a, b } = seed();
  a.merge(b); b.merge(a);
  expect(a.total()).toBe(22);
  expect(b.total()).toBe(22);
  a.merge(b); b.merge(a);
  expect(a.total()).toBe(22);
  expect(b.total()).toBe(22);
});

test('hidden: reconciled retention floor bounds identity state and rejects old failover replay', () => {
  const { a, b } = seed();
  a.merge(b); b.merge(a);
  a.advanceRetentionFloor(11); b.advanceRetentionFloor(11);
  expect(a.total()).toBe(22); expect(b.total()).toBe(22);
  expect(a.retainedIdentityCount()).toBe(2); expect(b.retainedIdentityCount()).toBe(2);
  expect(a.ingest({ eventId: 'e1', units: 5, sequence: 10 })).toBe('too-old');
  expect(a.total()).toBe(22);
  expect(a.ingest({ eventId: 'e4', units: 3, sequence: 13 })).toBe('accepted');
  b.merge(a); a.merge(b);
  expect(a.total()).toBe(25); expect(b.total()).toBe(25);
});

test('hidden: conflicting reuse of a retained event id is rejected', () => {
  const a = new UsageReplica('A');
  expect(a.ingest({ eventId: 'same', units: 2, sequence: 20 })).toBe('accepted');
  expect(a.ingest({ eventId: 'same', units: 9, sequence: 20 })).toBe('conflict');
  expect(a.total()).toBe(2);
});
`,
    );
    const regression = hasRegressionText(workingDirectory, [
      /cross.?region|merge/iu,
      /duplicate|event.?id/iu,
      /retention|floor|too-old/iu,
      /conflict/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/replicated-counter.json');
    const bounded =
      Boolean(report.artifact) &&
      contains(report.text, [
        /identity|event.?id/u,
        /converg|merge/u,
        /retention|replay/u,
        /synthetic|local|simulation/u,
      ]) &&
      hasBoolean(report.artifact, 'sharedSingleDatabase', false);
    const passed = hidden.passed && regression && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && regression ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `identity convergence + bounded replay simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `duplicate/retention/conflict regressions: ${regression ? 'present' : 'missing'}`,
        `distributed failure-model evidence: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const MISSING_EVENT_SOURCE = `export interface PipelineEvent {
  traceId: string;
  eventId: string;
  schemaVersion: number;
  kind: string;
}

export type WorkerVersion = 'v12' | 'v13';
export interface DeliveryResult { acked: boolean; processed: boolean; duplicate: boolean; reason: string }

export class DurableProcessedStore {
  private readonly processed = new Set<string>();
  private readonly customerEffects = new Set<string>();

  commit(event: PipelineEvent): 'processed' | 'duplicate' {
    if (this.processed.has(event.eventId)) return 'duplicate';
    this.customerEffects.add(event.eventId);
    this.processed.add(event.eventId);
    return 'processed';
  }

  has(eventId: string): boolean { return this.processed.has(eventId); }
  effects(): string[] { return [...this.customerEffects].sort(); }
}

export function acceptApi(event: PipelineEvent, brokerAck: boolean): { status: number; traceId: string; eventId: string } {
  if (!brokerAck) return { status: 503, traceId: event.traceId, eventId: event.eventId };
  return { status: 202, traceId: event.traceId, eventId: event.eventId };
}

export function handleDelivery(
  store: DurableProcessedStore,
  event: PipelineEvent,
  version: WorkerVersion,
): DeliveryResult {
  if (version === 'v12' && event.schemaVersion >= 2) {
    return { acked: false, processed: false, duplicate: false, reason: 'unsupported-schema-retry' };
  }
  if (version === 'v13' && event.eventId === 'evt_7F3') {
    // BUG: v13 acknowledges this compatibility-filter branch before the durable processed-event
    // boundary, converting a retryable handoff into silent loss.
    return { acked: true, processed: false, duplicate: false, reason: 'compatibility-filter' };
  }
  const result = store.commit(event);
  return {
    acked: true,
    processed: result === 'processed',
    duplicate: result === 'duplicate',
    reason: result,
  };
}

export const INCIDENT_EVENT: PipelineEvent = {
  traceId: 'trace_customer_91',
  eventId: 'evt_7F3',
  schemaVersion: 2,
  kind: 'CustomerUpdated',
};
`;

const MISSING_EVENT_EVIDENCE = `${JSON.stringify(
  {
    event_id: 'evt_7F3',
    trace_id: 'trace_customer_91',
    api: { status: 202, broker_ack: true },
    broker: [
      { event_id: 'evt_7F3', delivery_attempt: 1, routed_worker: 'v12', ack: false },
      { event_id: 'evt_7F3', delivery_attempt: 2, routed_worker: 'v13', ack: true },
    ],
    workers: [
      { version: 'v12', event_id: 'evt_7F3', action: 'retry-unsupported-schema' },
      { version: 'v13', event_id: 'evt_7F3', action: 'compatibility-filter-ack' },
    ],
    processed_event_table: [],
    clock_note:
      'service clocks are not synchronized; use identities, attempts, and state transitions',
  },
  null,
  2,
)}\n`;

const missingEventMaterializer: SkillEvalFixtureMaterializer = {
  id: 'distributed-debugging/accepted-event-missing@1',
  matches: (scenario) => scenario.id === MISSING_EVENT,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'package.json',
      packageJson('kory-eval-distributed-missing-event'),
    );
    writeFixtureFile(destination, 'src/pipeline.ts', MISSING_EVENT_SOURCE);
    writeFixtureFile(destination, 'evidence/incident.json', MISSING_EVENT_EVIDENCE);
    writeFixtureFile(
      destination,
      'tests/pipeline.test.ts',
      `import { expect, test } from 'bun:test';
import { DurableProcessedStore, INCIDENT_EVENT, acceptApi, handleDelivery } from '../src/pipeline';

test('API 202 means broker accepted publication, not worker durability', () => {
  expect(acceptApi(INCIDENT_EVENT, true).status).toBe(202);
  const store = new DurableProcessedStore();
  expect(handleDelivery(store, INCIDENT_EVENT, 'v12').acked).toBe(false);
  expect(store.has(INCIDENT_EVENT.eventId)).toBe(false);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Accepted event missing from durable processing

Use \`evidence/incident.json\` as immutable incident evidence. Reconstruct \`evt_7F3\` through trace/event identity, delivery attempts, worker-version overlap, acknowledgements, and the processed-event table; do not sort causality solely by service timestamps. The API's HTTP 202 contract is correct because it means broker acknowledgement, not durable worker completion.

Fix the first worker boundary that violates the at-least-once/idempotent contract. Replay the original through v13 and then one duplicate: the original must commit at the durable boundary exactly once logically, the duplicate must acknowledge without adding another customer-visible effect. Preserve v12's retry behavior and the API 202 contract.

Add regression coverage and write \`.kory-eval/distributed-missing-event.json\` with the identity-correlated causal history, first violating boundary, narrow correction, original+duplicate replay results, hierarchy/specialist boundary, \`wallClockOrdering: false\`, and a synthetic/local evidence label.
`,
    );
  },
};

const missingEventScorer: SkillEvalDeterministicScorer = {
  id: 'distributed-debugging/accepted-event-missing-scorer@1',
  scenarioIds: [MISSING_EVENT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { DurableProcessedStore, INCIDENT_EVENT, acceptApi, handleDelivery } from '../src/pipeline';

test('hidden: v12 retry then v13 original+duplicate crosses durable boundary exactly once', () => {
  const store = new DurableProcessedStore();
  expect(acceptApi(INCIDENT_EVENT, true).status).toBe(202);
  const first = handleDelivery(store, INCIDENT_EVENT, 'v12');
  expect(first.acked).toBe(false); expect(store.has('evt_7F3')).toBe(false);
  const recovered = handleDelivery(store, INCIDENT_EVENT, 'v13');
  expect(recovered).toMatchObject({ acked: true, processed: true, duplicate: false });
  expect(store.has('evt_7F3')).toBe(true);
  const duplicate = handleDelivery(store, INCIDENT_EVENT, 'v13');
  expect(duplicate).toMatchObject({ acked: true, processed: false, duplicate: true });
  expect(store.effects()).toEqual(['evt_7F3']);
});

test('hidden: API still distinguishes publish rejection from acknowledged 202', () => {
  expect(acceptApi(INCIDENT_EVENT, false).status).toBe(503);
  expect(acceptApi(INCIDENT_EVENT, true).status).toBe(202);
});
`,
    );
    const evidencePreserved =
      readFileSync(join(workingDirectory, 'evidence/incident.json'), 'utf8') ===
      MISSING_EVENT_EVIDENCE;
    const regression = hasRegressionText(workingDirectory, [
      /evt_7F3/iu,
      /v12|attempt.?1/iu,
      /v13|attempt.?2/iu,
      /duplicate|idempoten/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/distributed-missing-event.json');
    const bounded =
      Boolean(report.artifact) &&
      contains(report.text, [
        /evt_7f3/u,
        /trace_customer_91|trace/u,
        /v12/u,
        /v13/u,
        /durable|processed-event/u,
        /worker/u,
        /duplicate|replay/u,
        /synthetic|local/u,
      ]) &&
      hasBoolean(report.artifact, 'wallClockOrdering', false);
    const passed = hidden.passed && evidencePreserved && regression && bounded;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && evidencePreserved && regression
          ? 0.75
          : hidden.passed
            ? 0.5
            : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !evidencePreserved,
      evidence: [
        `original+duplicate durable replay: ${hidden.passed ? 'pass' : 'fail'}`,
        `incident evidence preserved: ${evidencePreserved ? 'yes' : 'no'}`,
        `identity/version regression coverage: ${regression ? 'present' : 'missing'}`,
        `causal report avoids clock-only ordering: ${bounded ? 'yes' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const STALE_PERMISSION_SOURCE = `export interface PermissionRecord {
  accountId: string;
  version: number;
  role: 'viewer' | 'editor' | 'admin';
}

export interface ConsistencyToken { accountId: string; minVersion: number }

export class PermissionSystem {
  private authority: PermissionRecord = { accountId: 'acct_42', version: 117, role: 'viewer' };
  private regionBCache: PermissionRecord = { ...this.authority };
  private regionBHealthy = true;

  updateInRegionA(role: PermissionRecord['role']): ConsistencyToken {
    this.authority = { ...this.authority, version: this.authority.version + 1, role };
    return { accountId: this.authority.accountId, minVersion: this.authority.version };
  }

  setRegionBHealthy(healthy: boolean): void { this.regionBHealthy = healthy; }

  readInRegionB(token?: ConsistencyToken): PermissionRecord {
    if (this.regionBHealthy && this.regionBCache.version >= (token?.minVersion ?? 0)) {
      return { ...this.regionBCache };
    }
    // BUG: degraded fallback ignores the caller's returned consistency token and serves stale
    // cache state even when the documented token-scoped read-your-write guarantee forbids it.
    return { ...this.regionBCache };
  }

  applyInvalidation(record: PermissionRecord): void {
    // BUG: delayed/duplicate invalidations are applied without a monotonic entity-version guard.
    this.regionBCache = { ...record };
  }

  recoverRegionB(): void {
    this.regionBHealthy = true;
    this.regionBCache = { ...this.authority };
  }

  authorityRecord(): PermissionRecord { return { ...this.authority }; }
  regionBRecord(): PermissionRecord { return { ...this.regionBCache }; }
}
`;

const STALE_PERMISSION_EVIDENCE = `${JSON.stringify(
  {
    account_id: 'acct_42',
    contract: {
      token_scoped_read_your_write: true,
      token_rule: 'reads carrying update token minVersion must not return an older entity version',
      reads_without_token: 'eventual convergence is permitted during a documented degraded window',
    },
    update: {
      trace_id: 'trace-update-118',
      from_version: 117,
      committed_version: 118,
      region: 'A',
    },
    region_b: {
      cached_version: 117,
      health: 'degraded',
      fallback: 'cache',
      read_trace_id: 'trace-read-b-1',
    },
    invalidations: [
      { entity_version: 118, delivery: 'delayed' },
      { entity_version: 118, delivery: 'duplicate' },
      { entity_version: 117, delivery: 'late-stale' },
    ],
    clock_note:
      'regional clocks may be skewed; entity versions and trace/fallback state carry causality',
  },
  null,
  2,
)}\n`;

const stalePermissionMaterializer: SkillEvalFixtureMaterializer = {
  id: 'distributed-debugging/stale-permission-partial-outage@1',
  matches: (scenario) => scenario.id === STALE_PERMISSION,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-stale-permission'));
    writeFixtureFile(destination, 'src/permissions.ts', STALE_PERMISSION_SOURCE);
    writeFixtureFile(destination, 'evidence/outage.json', STALE_PERMISSION_EVIDENCE);
    writeFixtureFile(
      destination,
      'tests/permissions.test.ts',
      `import { expect, test } from 'bun:test';
import { PermissionSystem } from '../src/permissions';

test('reads without an update token may observe eventual state before convergence', () => {
  const system = new PermissionSystem();
  system.updateInRegionA('editor');
  system.setRegionBHealthy(false);
  expect(system.readInRegionB().version).toBe(117);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Partial-outage stale permission fixture

Use \`evidence/outage.json\` as immutable evidence. The documented contract is not global linearizability: ordinary reads may converge eventually during the degraded window. However, a successful update returns a consistency token; reads carrying that token must not return an entity version below \`minVersion\`. Reconstruct causality from trace IDs, entity versions, health/fallback decisions, and invalidation versions, not from regional wall clocks.

Repair the narrow fallback/version guard. During degraded region B, a token-scoped read after the 117→118 update must satisfy version 118 (for example by authoritative fallback); an ordinary tokenless read may remain 117. Recovery converges B to 118. Delayed duplicate 118 invalidation is harmless, and a later stale 117 invalidation must never downgrade B.

Add degraded/recovery/delayed-duplicate/stale-invalidation regressions. Write \`.kory-eval/stale-permission.json\` with the exact consistency contract, version/trace causal history, first invalid fallback/version check, recovery proof, hierarchy/specialist boundary, \`assumedLinearizable: false\`, \`wallClockOrdering: false\`, and a synthetic/local evidence label.
`,
    );
  },
};

const stalePermissionScorer: SkillEvalDeterministicScorer = {
  id: 'distributed-debugging/stale-permission-partial-outage-scorer@1',
  scenarioIds: [STALE_PERMISSION],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { PermissionSystem } from '../src/permissions';

test('hidden: token-scoped read-your-write is honored while tokenless reads retain eventual semantics', () => {
  const system = new PermissionSystem();
  const token = system.updateInRegionA('editor');
  expect(token.minVersion).toBe(118);
  system.setRegionBHealthy(false);
  expect(system.readInRegionB().version).toBe(117);
  expect(system.readInRegionB(token)).toMatchObject({ version: 118, role: 'editor' });
});

test('hidden: recovery and delayed duplicate invalidation never regress entity version', () => {
  const system = new PermissionSystem();
  const token = system.updateInRegionA('editor');
  system.setRegionBHealthy(false);
  expect(system.readInRegionB(token).version).toBe(118);
  system.recoverRegionB();
  expect(system.regionBRecord().version).toBe(118);
  system.applyInvalidation({ accountId: 'acct_42', version: 118, role: 'editor' });
  system.applyInvalidation({ accountId: 'acct_42', version: 118, role: 'editor' });
  system.applyInvalidation({ accountId: 'acct_42', version: 117, role: 'viewer' });
  expect(system.regionBRecord()).toMatchObject({ version: 118, role: 'editor' });
});
`,
    );
    const evidencePreserved =
      readFileSync(join(workingDirectory, 'evidence/outage.json'), 'utf8') ===
      STALE_PERMISSION_EVIDENCE;
    const regression = hasRegressionText(workingDirectory, [
      /117/iu,
      /118/iu,
      /degrad|outage/iu,
      /duplicate|invalidat/iu,
      /token|read.?your.?write/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/stale-permission.json');
    const bounded =
      Boolean(report.artifact) &&
      contains(report.text, [
        /117/u,
        /118/u,
        /trace|version/u,
        /token|read.?your.?write/u,
        /fallback/u,
        /recover/u,
        /duplicate|invalidat/u,
        /synthetic|local/u,
      ]) &&
      hasBoolean(report.artifact, 'assumedLinearizable', false) &&
      hasBoolean(report.artifact, 'wallClockOrdering', false);
    const passed = hidden.passed && evidencePreserved && regression && bounded;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && evidencePreserved && regression
          ? 0.75
          : hidden.passed
            ? 0.5
            : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !evidencePreserved,
      evidence: [
        `token-scoped outage + recovery behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `outage evidence preserved: ${evidencePreserved ? 'yes' : 'no'}`,
        `version/invalidations regressions: ${regression ? 'present' : 'missing'}`,
        `contract/causality report: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const EVENT_DISTRIBUTED_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  outboxMaterializer,
  eventEvolutionMaterializer,
  leaseFailoverMaterializer,
  replicatedCounterMaterializer,
  missingEventMaterializer,
  stalePermissionMaterializer,
];

export const EVENT_DISTRIBUTED_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  outboxScorer,
  eventEvolutionScorer,
  leaseFailoverScorer,
  replicatedCounterScorer,
  missingEventScorer,
  stalePermissionScorer,
];
