import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, runHiddenBunTest, writeFixtureFile } from './skill-eval-fixture-helpers';

const FIELD_EVOLUTION = 'grpc-protobuf-full-task-1-individual';
const STREAM_LIFECYCLE = 'grpc-protobuf-full-task-2-individual';

const INITIAL_PROTO = `syntax = "proto3";

package kory.jobs.v1;

message StartJobRequest {
  string name = 1;
  bool urgent = 2;
}
`;

const INITIAL_WIRE = `export interface OldRequest {
  name: string;
  urgent: boolean;
}

export interface NewRequest {
  name: string;
  priority: 'NORMAL' | 'HIGH' | null;
  priorityNumeric: number;
  unknownFields: Uint8Array[];
}

function field(tag: number, value: number): number[] {
  return [(tag << 3) | 0, value];
}

export function encodeOld(value: OldRequest): Uint8Array {
  const name = new TextEncoder().encode(value.name);
  return Uint8Array.from([(1 << 3) | 2, name.length, ...name, ...field(2, value.urgent ? 1 : 0)]);
}

export function decodeOld(bytes: Uint8Array): OldRequest {
  let name = '';
  let urgent = false;
  for (let i = 0; i < bytes.length;) {
    const key = bytes[i++]!;
    const tag = key >> 3;
    const wire = key & 7;
    if (wire === 2) {
      const len = bytes[i++]!;
      const data = bytes.slice(i, i + len);
      i += len;
      if (tag === 1) name = new TextDecoder().decode(data);
    } else if (wire === 0) {
      const value = bytes[i++]!;
      if (tag === 2) urgent = value !== 0;
    } else throw new Error('unsupported wire type');
  }
  return { name, urgent };
}

export function encodeNew(value: NewRequest): Uint8Array {
  // BUG: replaces field 2 in-place with enum numeric value, breaking old bool semantics.
  const name = new TextEncoder().encode(value.name);
  const priority = value.priority === 'HIGH' ? 2 : 1;
  return Uint8Array.from([(1 << 3) | 2, name.length, ...name, ...field(2, priority)]);
}

export function decodeNew(bytes: Uint8Array): NewRequest {
  const old = decodeOld(bytes);
  return {
    name: old.name,
    priority: old.urgent ? 'HIGH' : 'NORMAL',
    priorityNumeric: old.urgent ? 2 : 1,
    unknownFields: [],
  };
}
`;

const FIELD_PUBLIC_TEST = `import { expect, test } from 'bun:test';
import { decodeNew, encodeOld } from '../src/wire';

test('new reader accepts old urgent=true message', () => {
  expect(decodeNew(encodeOld({ name: 'a', urgent: true })).priority).toBe('HIGH');
});
`;

const fieldEvolutionMaterializer: SkillEvalFixtureMaterializer = {
  id: 'grpc-protobuf/proto-field-evolution@1',
  matches: (scenario) => scenario.id === FIELD_EVOLUTION,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-grpc-field-evolution'));
    writeFixtureFile(destination, 'proto/job.proto', INITIAL_PROTO);
    writeFixtureFile(destination, 'src/wire.ts', INITIAL_WIRE);
    writeFixtureFile(destination, 'tests/wire.test.ts', FIELD_PUBLIC_TEST);
    writeFixtureFile(
      destination,
      'compatibility-contract.md',
      `# Protobuf migration contract

- Existing wire contract is \`name = 1\`, \`urgent = 2\` (bool). Field 2 cannot change wire meaning while old clients/servers exist.
- During the compatibility window keep \`urgent = 2\` as a deprecated bool and add \`priority = 3\` using enum \`Priority\` with 0=UNSPECIFIED, 1=NORMAL, 2=HIGH.
- New writers send field 3 and also populate deprecated field 2 consistently (HIGH => true, NORMAL => false) while old servers remain supported.
- New readers prefer a present recognized field 3; when absent, derive priority from legacy field 2.
- Unknown future enum numerics on field 3 must remain distinguishable from known values and survive decode/re-encode; never silently coerce them to NORMAL/HIGH.
- After the compatibility window, a documented future schema may remove \`urgent\` and must reserve field number 2 and name \`urgent\`; field 3 remains priority. Do not reserve field 2 in the live compatibility schema while it is still present.
- Preserve unknown fields across decode/re-encode where this reference codec exposes them.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Protobuf field-evolution fixture

Evolve \`proto/job.proto\` and the small reference wire codec in \`src/wire.ts\` according to the compatibility contract. Add a post-window schema artifact showing the required reservation after field 2 is removed. Expand tests for old/new cross-version binary behavior and an unknown future enum numeric.
`,
    );
  },
};

const fieldEvolutionScorer: SkillEvalDeterministicScorer = {
  id: 'grpc-protobuf/proto-field-evolution-scorer@2',
  scenarioIds: [FIELD_EVOLUTION],
  score: ({ workingDirectory }) => {
    const liveProto = readFileSync(join(workingDirectory, 'proto/job.proto'), 'utf8');
    const protoDirectory = join(workingDirectory, 'proto');
    const postWindow =
      readdirSync(protoDirectory, { withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith('.proto') && entry.name !== 'job.proto',
        )
        .map((entry) => readFileSync(join(protoDirectory, entry.name), 'utf8'))
        .find(
          (source) =>
            /reserved\s+2\s*;/iu.test(source) &&
            /reserved\s+"urgent"\s*;/iu.test(source) &&
            /Priority\s+priority\s*=\s*3\s*;/iu.test(source) &&
            !/bool\s+urgent\s*=\s*2/iu.test(source),
        ) ?? '';
    const liveSchema =
      /bool\s+urgent\s*=\s*2\s*\[[^\]]*deprecated\s*=\s*true[^\]]*\]/iu.test(liveProto) &&
      /enum\s+Priority\s*\{[^}]*UNSPECIFIED\s*=\s*0[^}]*NORMAL\s*=\s*1[^}]*HIGH\s*=\s*2/isu.test(
        liveProto,
      ) &&
      /Priority\s+priority\s*=\s*3\s*;/iu.test(liveProto) &&
      !/reserved\s+2\b/iu.test(liveProto);
    const futureSchema =
      /reserved\s+2\s*;/iu.test(postWindow) &&
      /reserved\s+"urgent"\s*;/iu.test(postWindow) &&
      /Priority\s+priority\s*=\s*3\s*;/iu.test(postWindow) &&
      !/bool\s+urgent\s*=\s*2/iu.test(postWindow);
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { decodeNew, decodeOld, encodeNew, encodeOld, type NewRequest } from '../src/wire';

test('hidden: old binary remains readable by new reader', () => {
  expect(decodeNew(encodeOld({ name: 'old-high', urgent: true }))).toMatchObject({ name: 'old-high', priority: 'HIGH', priorityNumeric: 2 });
  expect(decodeNew(encodeOld({ name: 'old-normal', urgent: false }))).toMatchObject({ name: 'old-normal', priority: 'NORMAL', priorityNumeric: 1 });
});

test('hidden: new writer remains meaningful to old server during compatibility window', () => {
  const high: NewRequest = { name: 'new-high', priority: 'HIGH', priorityNumeric: 2, unknownFields: [] };
  const normal: NewRequest = { name: 'new-normal', priority: 'NORMAL', priorityNumeric: 1, unknownFields: [] };
  expect(decodeOld(encodeNew(high))).toEqual({ name: 'new-high', urgent: true });
  expect(decodeOld(encodeNew(normal))).toEqual({ name: 'new-normal', urgent: false });
  expect(Array.from(encodeNew(high))).toContain((3 << 3) | 0);
});

test('hidden: recognized priority field 3 wins over legacy field 2', () => {
  const base = Array.from(encodeOld({ name: 'mixed', urgent: false }));
  const mixed = Uint8Array.from([...base, (3 << 3) | 0, 2]);
  expect(decodeNew(mixed)).toMatchObject({ priority: 'HIGH', priorityNumeric: 2 });
});

test('hidden: unknown future enum numeric survives round trip', () => {
  const base = Array.from(encodeOld({ name: 'future', urgent: false }));
  const future = Uint8Array.from([...base, (3 << 3) | 0, 7]);
  const decoded = decodeNew(future);
  expect(decoded.priority).toBeNull();
  expect(decoded.priorityNumeric).toBe(7);
  const encoded = encodeNew(decoded);
  const roundTrip = decodeNew(encoded);
  expect(roundTrip.priority).toBeNull();
  expect(roundTrip.priorityNumeric).toBe(7);
});
`,
    );
    const tests = readFileSync(join(workingDirectory, 'tests/wire.test.ts'), 'utf8');
    const coverage =
      /old|legacy|cross[- ]version/iu.test(tests) &&
      /new|priority/iu.test(tests) &&
      /unknown|future/iu.test(tests) &&
      /round[- ]?trip|binary/iu.test(tests);
    const passed = liveSchema && futureSchema && hidden.passed && coverage;
    return {
      passed,
      quality: passed ? 1 : liveSchema && futureSchema && hidden.passed ? 0.75 : 0,
      verification: liveSchema && futureSchema && hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `live compatibility schema: ${liveSchema ? 'pass' : 'fail'}`,
        `post-window reservation schema: ${futureSchema ? 'pass' : 'fail'}`,
        `hidden old/new/unknown-enum wire behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative compatibility tests: ${coverage ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const STREAM_SOURCE = `export type RpcStatus = 'OK' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'UNAVAILABLE' | 'INTERNAL';

export interface StreamOptions {
  values: number[];
  queueLimit: number;
  clientReadEveryTicks: number;
  cancelAfterReceived?: number;
  deadlineTicks?: number;
  downstreamErrorAt?: number;
  downstreamErrorStatus?: 'UNAVAILABLE' | 'INTERNAL';
  clientHalfClosesAtTick?: number;
}

export interface StreamResult {
  received: number[];
  status: RpcStatus;
  maxQueued: number;
  produced: number;
  producerStopped: boolean;
  resourcesOpen: number;
  clientHalfClosed: boolean;
}

export async function runStream(options: StreamOptions): Promise<StreamResult> {
  const queue: number[] = [];
  const received: number[] = [];
  let maxQueued = 0;
  let clientHalfClosed = false;
  let status: RpcStatus = 'OK';
  // BUG: producer fills the entire queue before the client reads and ignores cancellation/deadline.
  for (let i = 0; i < options.values.length; i++) {
    if (options.downstreamErrorAt === i) status = options.downstreamErrorStatus ?? 'INTERNAL';
    queue.push(options.values[i]!);
    maxQueued = Math.max(maxQueued, queue.length);
  }
  while (queue.length) received.push(queue.shift()!);
  if (options.clientHalfClosesAtTick !== undefined) clientHalfClosed = true;
  return {
    received,
    status: 'OK',
    maxQueued,
    produced: options.values.length,
    producerStopped: false,
    resourcesOpen: 1,
    clientHalfClosed,
  };
}
`;

const STREAM_TEST = `import { expect, test } from 'bun:test';
import { runStream } from '../src/stream';

test('short stream completes', async () => {
  const result = await runStream({ values: [1, 2], queueLimit: 2, clientReadEveryTicks: 1 });
  expect(result.received).toEqual([1, 2]);
});
`;

const streamMaterializer: SkillEvalFixtureMaterializer = {
  id: 'grpc-protobuf/stream-cancellation-backpressure@1',
  matches: (scenario) => scenario.id === STREAM_LIFECYCLE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-grpc-stream'));
    writeFixtureFile(destination, 'src/stream.ts', STREAM_SOURCE);
    writeFixtureFile(destination, 'tests/stream.test.ts', STREAM_TEST);
    writeFixtureFile(
      destination,
      'stream-contract.md',
      `# Bidirectional stream lifecycle contract

- The RPC context owns producer lifetime. Client cancellation stops production promptly, drains/releases local resources, and terminates as CANCELLED; no later producer result may convert it to OK.
- Deadline expiry terminates as DEADLINE_EXCEEDED and stops production/resources.
- Downstream transient failure maps to UNAVAILABLE; non-transient/internal failure maps to INTERNAL. Once selected, terminal error status cannot be overwritten by normal shutdown.
- The outbound queue is bounded by \`queueLimit\`; producer progress must apply backpressure when a slow client has filled the queue. \`maxQueued\` must never exceed the configured positive limit.
- Client input half-close means no more client messages; it does not itself cancel server output. The server may finish remaining updates and return OK if no cancellation/deadline/error occurs.
- Every terminal path leaves \`producerStopped: true\` and \`resourcesOpen: 0\`.
- This deterministic harness models stream semantics; no retry policy is introduced.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# gRPC stream lifecycle fixture

Repair \`src/stream.ts\` against the lifecycle contract and expand tests for slow-reader backpressure, cancellation, deadline, downstream status mapping, half-close, and resource cleanup.
`,
    );
  },
};

const streamScorer: SkillEvalDeterministicScorer = {
  id: 'grpc-protobuf/stream-cancellation-backpressure-scorer@1',
  scenarioIds: [STREAM_LIFECYCLE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { runStream } from '../src/stream';

test('hidden: slow reader applies bounded backpressure', async () => {
  const result = await runStream({ values: [1,2,3,4,5,6], queueLimit: 2, clientReadEveryTicks: 3 });
  expect(result.status).toBe('OK');
  expect(result.received).toEqual([1,2,3,4,5,6]);
  expect(result.maxQueued).toBeLessThanOrEqual(2);
  expect(result.producerStopped).toBe(true);
  expect(result.resourcesOpen).toBe(0);
});

test('hidden: cancellation stops producer and cannot become OK', async () => {
  const result = await runStream({ values: [1,2,3,4,5,6,7,8], queueLimit: 2, clientReadEveryTicks: 1, cancelAfterReceived: 2 });
  expect(result.status).toBe('CANCELLED');
  expect(result.received).toHaveLength(2);
  expect(result.produced).toBeLessThan(8);
  expect(result.producerStopped).toBe(true);
  expect(result.resourcesOpen).toBe(0);
});

test('hidden: deadline owns terminal status and cleanup', async () => {
  const result = await runStream({ values: [1,2,3,4,5], queueLimit: 1, clientReadEveryTicks: 4, deadlineTicks: 3 });
  expect(result.status).toBe('DEADLINE_EXCEEDED');
  expect(result.producerStopped).toBe(true);
  expect(result.resourcesOpen).toBe(0);
});

test('hidden: downstream failures map and remain terminal', async () => {
  for (const status of ['UNAVAILABLE', 'INTERNAL'] as const) {
    const result = await runStream({ values: [1,2,3,4], queueLimit: 2, clientReadEveryTicks: 1, downstreamErrorAt: 2, downstreamErrorStatus: status });
    expect(result.status).toBe(status);
    expect(result.producerStopped).toBe(true);
    expect(result.resourcesOpen).toBe(0);
  }
});

test('hidden: client half-close permits server to finish output', async () => {
  const result = await runStream({ values: [1,2,3], queueLimit: 2, clientReadEveryTicks: 1, clientHalfClosesAtTick: 1 });
  expect(result.clientHalfClosed).toBe(true);
  expect(result.received).toEqual([1,2,3]);
  expect(result.status).toBe('OK');
  expect(result.producerStopped).toBe(true);
  expect(result.resourcesOpen).toBe(0);
});
`,
    );
    const tests = readFileSync(join(workingDirectory, 'tests/stream.test.ts'), 'utf8');
    const coverage =
      /backpressure|slow|queue/iu.test(tests) &&
      /cancel/iu.test(tests) &&
      /deadline/iu.test(tests) &&
      /unavailable|internal|downstream/iu.test(tests) &&
      /half[- ]close/iu.test(tests) &&
      /resource|cleanup|leak/iu.test(tests);
    const passed = hidden.passed && coverage;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden cancellation/backpressure/status lifecycle: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative stream regression coverage: ${coverage ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const GRPC_PROTOBUF_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  fieldEvolutionMaterializer,
  streamMaterializer,
];

export const GRPC_PROTOBUF_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  fieldEvolutionScorer,
  streamScorer,
];
