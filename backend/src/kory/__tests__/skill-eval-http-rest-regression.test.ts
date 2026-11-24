import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HTTP_REST_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  HTTP_REST_ENGINEERING_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-http-rest-engineering-fixtures';
import { readFixtureText, writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const etagRepair = `export interface ResourceState { exists: boolean; version: number; value: string; }
export interface HttpResponse { status: number; headers: Record<string, string>; body?: unknown; }
export function strongEtag(state: ResourceState): string { return '"resource-' + state.version + '"'; }
export function getResource(state: ResourceState, headers: Record<string, string | undefined>): HttpResponse {
  if (!state.exists) return { status: 404, headers: {} };
  const etag = strongEtag(state);
  const cacheHeaders = { ETag: etag, 'Cache-Control': 'private, max-age=60' };
  if (headers['if-none-match'] === etag || headers['if-none-match'] === 'W/' + etag)
    return { status: 304, headers: cacheHeaders };
  return { status: 200, headers: cacheHeaders, body: { value: state.value } };
}
function checkWrite(state: ResourceState, headers: Record<string, string | undefined>): number | null {
  const validator = headers['if-match'];
  if (!validator) return 428;
  if (!state.exists) return 412;
  if (validator !== '*' && validator !== strongEtag(state)) return 412;
  return null;
}
export function putResource(state: ResourceState, headers: Record<string, string | undefined>, value: string): HttpResponse {
  const failed = checkWrite(state, headers);
  if (failed) return { status: failed, headers: {} };
  state.value = value;
  state.version += 1;
  return { status: 200, headers: { ETag: strongEtag(state) }, body: { value } };
}
export function deleteResource(state: ResourceState, headers: Record<string, string | undefined>): HttpResponse {
  const failed = checkWrite(state, headers);
  if (failed) return { status: failed, headers: {} };
  state.exists = false;
  state.version += 1;
  return { status: 204, headers: {} };
}
`;

const etagTests = `import { expect, test } from 'bun:test';
import { deleteResource, getResource, putResource, strongEtag, type ResourceState } from '../src/resource';
test('conditional GET and old read-only clients preserve cache', () => {
  const state: ResourceState = { exists: true, version: 1, value: 'a' };
  const read = getResource(state, {});
  expect(read.status).toBe(200);
  expect(read.headers['Cache-Control']).toBe('private, max-age=60');
  expect(getResource(state, { 'if-none-match': 'W/' + strongEtag(state) }).status).toBe(304);
});
test('stale concurrent retry and missing precondition', () => {
  const state: ResourceState = { exists: true, version: 1, value: 'a' };
  const old = strongEtag(state);
  expect(putResource(state, {}, 'bad').status).toBe(428);
  expect(putResource(state, { 'if-match': old }, 'first').status).toBe(200);
  expect(putResource(state, { 'if-match': old }, 'stale').status).toBe(412);
  expect(putResource(state, { 'if-match': strongEtag(state) }, 'retry').status).toBe(200);
  expect(state.value).toBe('retry');
});
test('wildcard and weak If-Match validators never bypass preconditions', () => {
  const state: ResourceState = { exists: true, version: 3, value: 'a' };
  expect(putResource(state, { 'if-match': 'W/' + strongEtag(state) }, 'bad').status).toBe(412);
  expect(deleteResource(state, { 'if-match': '*' }).status).toBe(204);
  expect(deleteResource(state, { 'if-match': '*' }).status).toBe(412);
});
`;

const problemRepair = `export type Outcome = 'ok' | 'validation' | 'forbidden' | 'conflict' | 'rate-limit' | 'dependency-unavailable';
export interface EndpointRequest { outcome: Outcome; legacy?: boolean; }
export interface EndpointResponse { status: number; headers: Record<string, string>; body: unknown; }
const failures = {
  validation: [400, 'invalid_request', false],
  forbidden: [403, 'forbidden', false],
  conflict: [409, 'conflict', false],
  'rate-limit': [429, 'rate_limited', true],
  'dependency-unavailable': [503, 'dependency_unavailable', true],
} as const;
export function handleEndpoint(request: EndpointRequest): EndpointResponse {
  if (request.outcome === 'ok')
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { ok: true, value: 'done' } };
  const [status, code, retryable] = failures[request.outcome];
  if (request.legacy) return {
    status: 200, headers: { 'Content-Type': 'application/json', Deprecation: 'true' },
    body: { ok: false, error: { code, retryable, message: 'Request cannot proceed' } },
  };
  return {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...(request.outcome === 'rate-limit' ? { 'Retry-After': '30' } : {}) },
    body: { type: 'https://example.org/problems/' + code, code, title: 'Request cannot proceed', retryable },
  };
}
`;

const problemTests = `import { expect, test } from 'bun:test';
import { handleEndpoint, type Outcome } from '../src/endpoint';
test('validation forbidden conflict rate-limit and dependency-unavailable have correct stable statuses', () => {
  const cases: Array<[Outcome, number, boolean]> = [
    ['validation', 400, false], ['forbidden', 403, false], ['conflict', 409, false],
    ['rate-limit', 429, true], ['dependency-unavailable', 503, true],
  ];
  for (const [outcome, status, retryable] of cases) {
    const r = handleEndpoint({ outcome });
    expect(r.status).toBe(status);
    expect(r.headers['Content-Type']).toBe('application/problem+json');
    expect((r.body as {retryable: boolean}).retryable).toBe(retryable);
  }
  expect(handleEndpoint({ outcome: 'rate-limit' }).headers['Retry-After']).toBe('30');
});
test('legacy deprecation and success preserve existing shape', () => {
  const r = handleEndpoint({ outcome: 'forbidden', legacy: true });
  expect(r.status).toBe(200);
  expect(r.headers.Deprecation).toBe('true');
  expect(r.body).toMatchObject({ ok: false, error: { code: 'forbidden', retryable: false } });
  expect(handleEndpoint({ outcome: 'ok' }).body).toEqual({ ok: true, value: 'done' });
});
`;

async function scoreFixture(
  scenario: string,
  scorerId: string,
  sourcePath: string,
  source: string,
  testPath: string,
  tests: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'kory-http-regression-'));
  roots.push(root);
  const materializer = HTTP_REST_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches({ id: scenario } as never),
  );
  const scorer = HTTP_REST_ENGINEERING_SKILL_EVAL_SCORERS.find((item) => item.id === scorerId);
  expect(materializer).toBeDefined();
  expect(scorer).toBeDefined();
  await materializer!.materialize(root, { id: scenario } as never);
  writeFixtureFile(root, sourcePath, source);
  writeFixtureFile(root, testPath, tests);
  const scored = await scorer!.score({ workingDirectory: root } as never);
  expect(readFixtureText(root, sourcePath)).toBe(source);
  return scored;
}

describe('HTTP/REST scorer requires executed candidate regression proof', () => {
  test('accepts valid ETag repair with tests detecting broken write preconditions', async () => {
    const result = await scoreFixture(
      'http-rest-engineering-full-task-1-individual',
      'http-rest-engineering/conditional-update-etag-scorer@2',
      'src/resource.ts',
      etagRepair,
      'tests/resource.test.ts',
      etagTests,
    );
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.evidence).toContain('candidate tests reject the original defect: yes');
  });

  test('rejects ETag tests that only name missing requirements', async () => {
    const result = await scoreFixture(
      'http-rest-engineering-full-task-1-individual',
      'http-rest-engineering/conditional-update-etag-scorer@2',
      'src/resource.ts',
      etagRepair,
      'tests/resource.test.ts',
      `import { expect, test } from 'bun:test';
test('428 precondition 412 stale 304 conditional wildcard concurrent retry', () => expect(true).toBe(true));\n`,
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('candidate tests reject the original defect: no');
  });

  test('accepts repaired Problem Details responses with semantic regression tests', async () => {
    const result = await scoreFixture(
      'http-rest-engineering-full-task-2-individual',
      'http-rest-engineering/problem-details-retryability-scorer@2',
      'src/endpoint.ts',
      problemRepair,
      'tests/endpoint.test.ts',
      problemTests,
    );
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.evidence).toContain('candidate tests reject the original defect: yes');
  });

  test('rejects Problem Details tests that only list outcomes', async () => {
    const result = await scoreFixture(
      'http-rest-engineering-full-task-2-individual',
      'http-rest-engineering/problem-details-retryability-scorer@2',
      'src/endpoint.ts',
      problemRepair,
      'tests/endpoint.test.ts',
      `import { expect, test } from 'bun:test';
test('validation forbidden conflict 429 rate-limit 503 dependency legacy deprecation', () => expect(true).toBe(true));\n`,
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('candidate tests reject the original defect: no');
  });
});
