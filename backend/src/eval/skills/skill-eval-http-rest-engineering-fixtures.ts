import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  fixtureTextEquals,
  packageJson,
  readFixtureText,
  runCandidateBunTests,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const ETAG = 'http-rest-engineering-full-task-1-individual';
const PROBLEM = 'http-rest-engineering-full-task-2-individual';

function candidateRejectsStarter(
  workingDirectory: string,
  sourcePath: string,
  brokenSource: string,
): { passed: boolean; evidence: string[] } {
  let candidateSource: string;
  try {
    candidateSource = readFixtureText(workingDirectory, sourcePath);
  } catch {
    return {
      passed: false,
      evidence: [`candidate source is missing or unsafe: ${sourcePath}`],
    };
  }
  const repaired = runCandidateBunTests(workingDirectory);
  let rejected = false;
  let originalEvidence = 'Skipped: tests did not pass the candidate repair.';
  if (repaired.completed && repaired.passed) {
    try {
      writeFixtureFile(workingDirectory, sourcePath, brokenSource);
      const broken = runCandidateBunTests(workingDirectory);
      rejected = broken.completed && !broken.passed;
      originalEvidence = broken.evidence;
    } finally {
      writeFixtureFile(workingDirectory, sourcePath, candidateSource);
    }
  }
  return {
    passed: repaired.passed && rejected,
    evidence: [
      `candidate tests pass the repair: ${repaired.passed ? 'yes' : 'no'}`,
      `candidate tests reject the original defect: ${rejected ? 'yes' : 'no'}`,
      repaired.evidence,
      originalEvidence,
    ],
  };
}

const ETAG_SOURCE = `export interface ResourceState {
  exists: boolean;
  version: number;
  value: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export function strongEtag(state: ResourceState): string {
  return '"resource-' + state.version + '"';
}

export function getResource(state: ResourceState, headers: Record<string, string | undefined>): HttpResponse {
  if (!state.exists) return { status: 404, headers: {} };
  const etag = strongEtag(state);
  if (headers['if-none-match'] === etag) return { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, max-age=60' } };
  return { status: 200, headers: { ETag: etag, 'Cache-Control': 'private, max-age=60' }, body: { value: state.value } };
}

export function putResource(state: ResourceState, headers: Record<string, string | undefined>, value: string): HttpResponse {
  // BUG: write preconditions are optional and stale writes silently win.
  state.exists = true;
  state.value = value;
  state.version += 1;
  return { status: 200, headers: { ETag: strongEtag(state) }, body: { value } };
}

export function deleteResource(state: ResourceState, headers: Record<string, string | undefined>): HttpResponse {
  void headers;
  if (!state.exists) return { status: 404, headers: {} };
  state.exists = false;
  state.version += 1;
  return { status: 204, headers: {} };
}
`;

const ETAG_TEST = `import { expect, test } from 'bun:test';
import { getResource, type ResourceState } from '../src/resource';

test('GET preserves cache metadata', () => {
  const state: ResourceState = { exists: true, version: 1, value: 'a' };
  const response = getResource(state, {});
  expect(response.status).toBe(200);
  expect(response.headers['Cache-Control']).toBe('private, max-age=60');
});
`;

const ETAG_CONTRACT = `# Resource HTTP contract

- GET keeps the existing \`Cache-Control: private, max-age=60\` behavior and emits a strong ETag for the selected representation.
- GET \`If-None-Match\` uses weak comparison semantics: either the matching strong tag or \`W/\` form returns 304. Nonmatching tags return the representation normally.
- PUT and DELETE are destructive updates and require \`If-Match\`. Missing precondition returns 428 without mutation. A stale tag returns 412 without mutation.
- \`If-Match\` uses strong comparison: a weak validator never satisfies it. \`If-Match: *\` succeeds only when the resource currently exists.
- Successful PUT increments the representation version and returns the new strong ETag. Successful DELETE returns 204.
- Old read-only clients use only GET and existing cache headers; keep that path compatible.
`;

const etagMaterializer: SkillEvalFixtureMaterializer = {
  id: 'http-rest-engineering/conditional-update-etag@1',
  matches: (scenario) => scenario.id === ETAG,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-http-etag'));
    writeFixtureFile(destination, 'src/resource.ts', ETAG_SOURCE);
    writeFixtureFile(destination, 'tests/resource.test.ts', ETAG_TEST);
    writeFixtureFile(destination, 'http-contract.md', ETAG_CONTRACT);
    writeFixtureFile(
      destination,
      'README.md',
      `# Conditional update fixture

Repair \`src/resource.ts\` using the HTTP contract. Expand tests for concurrent/stale writers, missing preconditions, conditional GET, weak/strong validators, wildcard semantics, successful retry, and the old read-only client.
`,
    );
  },
};

const etagScorer: SkillEvalDeterministicScorer = {
  id: 'http-rest-engineering/conditional-update-etag-scorer@2',
  scenarioIds: [ETAG],
  score: ({ workingDirectory }) => {
    if (!fixtureTextEquals(workingDirectory, 'http-contract.md', ETAG_CONTRACT)) {
      return {
        passed: false,
        quality: 0,
        verification: 0,
        integrityFailure: true,
        evidence: ['The evaluator-owned HTTP resource contract was modified or removed.'],
      };
    }
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { deleteResource, getResource, putResource, strongEtag, type ResourceState } from '../src/resource';

function resource(): ResourceState { return { exists: true, version: 7, value: 'old' }; }

test('hidden: missing write precondition is 428 and non-mutating', () => {
  const s = resource();
  expect(putResource(s, {}, 'new').status).toBe(428);
  expect(s).toEqual({ exists: true, version: 7, value: 'old' });
  expect(deleteResource(s, {}).status).toBe(428);
  expect(s.exists).toBe(true);
});

test('hidden: stale and weak If-Match are 412 and non-mutating', () => {
  for (const tag of ['"resource-6"', 'W/"resource-7"']) {
    const s = resource();
    expect(putResource(s, { 'if-match': tag }, 'new').status).toBe(412);
    expect(s.value).toBe('old');
  }
});

test('hidden: concurrent writer exposes lost update and retry with fresh ETag succeeds', () => {
  const s = resource();
  const firstTag = strongEtag(s);
  const first = putResource(s, { 'if-match': firstTag }, 'writer-a');
  expect(first.status).toBe(200);
  expect(first.headers.ETag).not.toBe(firstTag);
  const stale = putResource(s, { 'if-match': firstTag }, 'writer-b');
  expect(stale.status).toBe(412);
  expect(s.value).toBe('writer-a');
  const retry = putResource(s, { 'if-match': first.headers.ETag }, 'writer-b');
  expect(retry.status).toBe(200);
  expect(s.value).toBe('writer-b');
});

test('hidden: GET revalidation uses weak comparison and preserves cache metadata', () => {
  const s = resource();
  const tag = strongEtag(s);
  for (const requestTag of [tag, 'W/' + tag]) {
    const response = getResource(s, { 'if-none-match': requestTag });
    expect(response.status).toBe(304);
    expect(response.headers['Cache-Control']).toBe('private, max-age=60');
    expect(response.headers.ETag).toBe(tag);
  }
  expect(getResource(s, { 'if-none-match': '"other"' }).status).toBe(200);
});

test('hidden: wildcard If-Match depends on current existence', () => {
  const existing = resource();
  expect(deleteResource(existing, { 'if-match': '*' }).status).toBe(204);
  expect(existing.exists).toBe(false);
  expect(deleteResource(existing, { 'if-match': '*' }).status).toBe(412);

  const absent: ResourceState = { exists: false, version: 1, value: '' };
  expect(putResource(absent, { 'if-match': '*' }, 'created?').status).toBe(412);
  expect(absent.exists).toBe(false);
});
`,
    );
    let coverage = false;
    try {
      const tests = readFixtureText(workingDirectory, 'tests/resource.test.ts');
      coverage =
        /428|precondition/iu.test(tests) &&
        /412|stale/iu.test(tests) &&
        /304|if-none-match|conditional/iu.test(tests) &&
        /wildcard|\*/iu.test(tests) &&
        /retry|concurrent/iu.test(tests);
    } catch {
      coverage = false;
    }
    const regression = candidateRejectsStarter(workingDirectory, 'src/resource.ts', ETAG_SOURCE);
    const passed = hidden.passed && coverage && regression.passed;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed && coverage && regression.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden HTTP validator/precondition behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative HTTP regression coverage: ${coverage ? 'present' : 'missing'}`,
        ...regression.evidence,
        hidden.evidence,
      ],
    };
  },
};

const PROBLEM_SOURCE = `export type Outcome =
  | 'ok'
  | 'validation'
  | 'forbidden'
  | 'conflict'
  | 'rate-limit'
  | 'dependency-unavailable';

export interface EndpointRequest {
  outcome: Outcome;
  legacy?: boolean;
}

export interface EndpointResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export function handleEndpoint(request: EndpointRequest): EndpointResponse {
  if (request.outcome === 'ok') return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { ok: true, value: 'done' } };
  // BUG: every semantic failure is tunneled through 200 and callers must inspect prose.
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { ok: false, error: 'Request failed: ' + request.outcome } };
}
`;

const PROBLEM_TEST = `import { expect, test } from 'bun:test';
import { handleEndpoint } from '../src/endpoint';

test('success remains ordinary JSON 200', () => {
  expect(handleEndpoint({ outcome: 'ok' }).status).toBe(200);
});
`;

const PROBLEM_CONTRACT = `# Error migration contract

New clients receive semantic HTTP status plus \`Content-Type: application/problem+json\` and a stable problem object with \`type\`, \`code\`, \`title\`, and boolean \`retryable\`. Do not make callers parse prose.

| Outcome | HTTP | code | retryable | extra |
| --- | ---: | --- | --- | --- |
| validation | 400 | invalid_request | false | — |
| forbidden | 403 | forbidden | false | — |
| conflict | 409 | conflict | false | — |
| rate-limit | 429 | rate_limited | true | \`Retry-After: 30\` |
| dependency-unavailable | 503 | dependency_unavailable | true | — |

- During the documented legacy window, \`legacy: true\` preserves HTTP 200 + \`{ok:false,error:{code,retryable,message}}\` while adding \`Deprecation: true\`. The legacy body still uses stable code/retryability.
- Success remains 200 JSON.
`;

const problemMaterializer: SkillEvalFixtureMaterializer = {
  id: 'http-rest-engineering/problem-details-retryability@1',
  matches: (scenario) => scenario.id === PROBLEM,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-http-problem'));
    writeFixtureFile(destination, 'src/endpoint.ts', PROBLEM_SOURCE);
    writeFixtureFile(destination, 'tests/endpoint.test.ts', PROBLEM_TEST);
    writeFixtureFile(destination, 'migration-contract.md', PROBLEM_CONTRACT);
    writeFixtureFile(
      destination,
      'README.md',
      `# Problem-details migration fixture

Repair \`src/endpoint.ts\` to implement the migration contract. Expand tests across every failure class, Retry-After, stable machine identity/retryability, success, and legacy compatibility.
`,
    );
  },
};

const problemScorer: SkillEvalDeterministicScorer = {
  id: 'http-rest-engineering/problem-details-retryability-scorer@2',
  scenarioIds: [PROBLEM],
  score: ({ workingDirectory }) => {
    if (!fixtureTextEquals(workingDirectory, 'migration-contract.md', PROBLEM_CONTRACT)) {
      return {
        passed: false,
        quality: 0,
        verification: 0,
        integrityFailure: true,
        evidence: ['The evaluator-owned HTTP error migration contract was modified or removed.'],
      };
    }
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { handleEndpoint } from '../src/endpoint';

const expected = {
  validation: [400, 'invalid_request', false],
  forbidden: [403, 'forbidden', false],
  conflict: [409, 'conflict', false],
  'rate-limit': [429, 'rate_limited', true],
  'dependency-unavailable': [503, 'dependency_unavailable', true],
} as const;

test('hidden: semantic status and stable problem body match each failure', () => {
  for (const [outcome, [status, code, retryable]] of Object.entries(expected)) {
    const response = handleEndpoint({ outcome: outcome as keyof typeof expected });
    expect(response.status).toBe(status);
    expect(response.headers['Content-Type']).toBe('application/problem+json');
    expect(response.body).toMatchObject({ code, retryable });
    expect(typeof (response.body as any).type).toBe('string');
    expect(typeof (response.body as any).title).toBe('string');
  }
});

test('hidden: rate limiting exposes bounded retry metadata', () => {
  const response = handleEndpoint({ outcome: 'rate-limit' });
  expect(response.status).toBe(429);
  expect(response.headers['Retry-After']).toBe('30');
  expect(response.body).toMatchObject({ code: 'rate_limited', retryable: true });
});

test('hidden: transient dependency failure is retryable without leaking topology', () => {
  const response = handleEndpoint({ outcome: 'dependency-unavailable' });
  expect(response.status).toBe(503);
  expect(response.body).toMatchObject({ code: 'dependency_unavailable', retryable: true });
  expect(JSON.stringify(response.body)).not.toMatch(/redis|postgres|queue|shard|worker/i);
});

test('hidden: legacy window preserves envelope but gains stable machine semantics', () => {
  const response = handleEndpoint({ outcome: 'forbidden', legacy: true });
  expect(response.status).toBe(200);
  expect(response.headers.Deprecation).toBe('true');
  expect(response.body).toMatchObject({ ok: false, error: { code: 'forbidden', retryable: false } });
});

test('hidden: success remains ordinary JSON 200', () => {
  const response = handleEndpoint({ outcome: 'ok' });
  expect(response.status).toBe(200);
  expect(response.headers['Content-Type']).toBe('application/json');
  expect(response.body).toEqual({ ok: true, value: 'done' });
});
`,
    );
    let coverage = false;
    try {
      const tests = readFixtureText(workingDirectory, 'tests/endpoint.test.ts');
      coverage =
        /validation|400/iu.test(tests) &&
        /forbidden|403/iu.test(tests) &&
        /conflict|409/iu.test(tests) &&
        /429|rate/iu.test(tests) &&
        /503|dependency|unavailable/iu.test(tests) &&
        /legacy|deprecat/iu.test(tests);
    } catch {
      coverage = false;
    }
    const regression = candidateRejectsStarter(workingDirectory, 'src/endpoint.ts', PROBLEM_SOURCE);
    const passed = hidden.passed && coverage && regression.passed;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed && coverage && regression.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden status/problem/retryability behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative HTTP regression coverage: ${coverage ? 'present' : 'missing'}`,
        ...regression.evidence,
        hidden.evidence,
      ],
    };
  },
};

export const HTTP_REST_ENGINEERING_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [etagMaterializer, problemMaterializer];

export const HTTP_REST_ENGINEERING_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  etagScorer,
  problemScorer,
];
