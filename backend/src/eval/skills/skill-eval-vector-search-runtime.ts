import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const VECTOR_SEARCH_RUNTIME_IMAGE = 'docker.elastic.co/elasticsearch/elasticsearch:8.19.4';
export const VECTOR_SEARCH_RUNTIME_VERSION = '8.19.4';
export const VECTOR_SEARCH_RUNTIME_BLOCKER = `Full-task qualification requires an available local Docker runtime with the pinned ${VECTOR_SEARCH_RUNTIME_IMAGE} image so ANN recall against an exact reference, metadata and tenant filtering, latency, build/storage/memory, update/delete freshness, sharded global top-k, and reversible migration/recovery execute on Elasticsearch ${VECTOR_SEARCH_RUNTIME_VERSION}.`;

export interface VectorSearchRuntimeResult {
  passed: boolean;
  evidence: string;
}

interface RuntimeContext {
  container: string;
  baseUrl: string;
}

interface HttpResult {
  json: unknown;
  statusCode: number;
  elapsedMs: number;
}

interface VectorDocument {
  id: string;
  tenant: string;
  category: string;
  active: boolean;
  vector: number[];
}

type JsonRecord = Record<string, unknown>;

let readinessCache: readonly string[] | null = null;

function docker(args: string[], timeout = 6_000) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8_000_000,
  });
}

function pause(milliseconds: number): void {
  spawnSync('sleep', [(milliseconds / 1_000).toFixed(3)], {
    timeout: milliseconds + 1_000,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} was not an array`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} was not a finite number`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} was not a string`);
  return value;
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return -1;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function exactTopK(
  documents: readonly VectorDocument[],
  query: readonly number[],
  k: number,
  predicate: (document: VectorDocument) => boolean,
): string[] {
  return documents
    .filter(predicate)
    .map((document) => ({ id: document.id, score: cosine(document.vector, query) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, k)
    .map((item) => item.id);
}

function recallAtK(actual: readonly string[], exact: readonly string[], k: number): number {
  const denominator = Math.min(k, exact.length);
  if (denominator === 0) return actual.length === 0 ? 1 : 0;
  const expected = new Set(exact.slice(0, k));
  return actual.slice(0, k).filter((id) => expected.has(id)).length / denominator;
}

export function vectorSearchRuntimeReadiness(): readonly string[] {
  if (readinessCache) return readinessCache;
  const image = docker(['image', 'inspect', VECTOR_SEARCH_RUNTIME_IMAGE], 15_000);
  const curl = spawnSync('curl', ['--version'], { encoding: 'utf8', timeout: 2_000 });
  readinessCache = image.status === 0 && curl.status === 0 ? [] : [VECTOR_SEARCH_RUNTIME_BLOCKER];
  return readinessCache;
}

function publishedPort(container: string): number | null {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = docker(['port', container, '9200/tcp'], 2_000);
    const match = (result.stdout ?? '').match(/:(\d+)\s*$/mu);
    if (result.status === 0 && match) return Number(match[1]);
    pause(100);
  }
  return null;
}

function request(
  context: RuntimeContext,
  method: string,
  path: string,
  body?: unknown,
  timeout = 15_000,
): HttpResult {
  const args = [
    '-sS',
    '-o',
    '-',
    '-w',
    '\n%{http_code}',
    '--max-time',
    String(Math.max(1, Math.ceil(timeout / 1_000))),
    '-X',
    method,
  ];
  if (body !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body));
  }
  args.push(`${context.baseUrl}${path}`);
  const started = performance.now();
  const result = spawnSync('curl', args, {
    encoding: 'utf8',
    timeout: timeout + 2_000,
    maxBuffer: 8_000_000,
  });
  const elapsedMs = performance.now() - started;
  if (result.error) throw result.error;
  const raw = result.stdout ?? '';
  const split = raw.lastIndexOf('\n');
  const payload = split >= 0 ? raw.slice(0, split) : raw;
  const statusCode = Number(split >= 0 ? raw.slice(split + 1) : '0');
  let json: unknown = {};
  if (payload.trim()) {
    try {
      json = JSON.parse(payload);
    } catch {
      json = { raw: payload };
    }
  }
  return { json, statusCode, elapsedMs };
}

function jsonRequest(
  context: RuntimeContext,
  method: string,
  path: string,
  body?: unknown,
  timeout = 15_000,
): HttpResult {
  const result = request(context, method, path, body, timeout);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(
      `${method} ${path} returned HTTP ${result.statusCode}: ${JSON.stringify(result.json).slice(0, 800)}`,
    );
  }
  return result;
}

function runWithElasticsearch(
  scenario: (context: RuntimeContext) => string[],
): VectorSearchRuntimeResult {
  const blockers = vectorSearchRuntimeReadiness();
  if (blockers.length > 0) return { passed: false, evidence: blockers.join('\n') };

  const container = 'kory-vector-' + randomUUID().replaceAll('-', '').slice(0, 12);
  let started = false;
  try {
    const start = docker(
      [
        'run',
        '-d',
        '--name',
        container,
        '-p',
        '127.0.0.1::9200',
        '-e',
        'discovery.type=single-node',
        '-e',
        'xpack.security.enabled=false',
        '-e',
        'xpack.security.enrollment.enabled=false',
        '-e',
        'ES_JAVA_OPTS=-Xms512m -Xmx512m',
        VECTOR_SEARCH_RUNTIME_IMAGE,
      ],
      20_000,
    );
    if (start.status !== 0) {
      return {
        passed: false,
        evidence:
          `${VECTOR_SEARCH_RUNTIME_IMAGE} start failed: ${start.stderr || start.stdout}`.trim(),
      };
    }
    started = true;

    const port = publishedPort(container);
    if (!port) {
      return { passed: false, evidence: `${VECTOR_SEARCH_RUNTIME_IMAGE} exposed no HTTP port` };
    }
    const context = { container, baseUrl: `http://127.0.0.1:${port}` };

    let info: HttpResult | null = null;
    for (let attempt = 0; attempt < 480; attempt += 1) {
      try {
        const candidate = request(context, 'GET', '/', undefined, 1_000);
        if (candidate.statusCode === 200) {
          info = candidate;
          break;
        }
      } catch {
        // Startup is intentionally polled until the bounded deadline.
      }
      pause(250);
    }
    if (!info) {
      const logs = docker(['logs', '--tail', '80', container], 3_000);
      return {
        passed: false,
        evidence: `${VECTOR_SEARCH_RUNTIME_IMAGE} did not become ready: ${(
          logs.stderr ||
          logs.stdout ||
          ''
        ).slice(-4_000)}`,
      };
    }

    const version = stringValue(
      record(record(info.json, 'Elasticsearch info').version, 'version').number,
      'version.number',
    );
    if (version !== VECTOR_SEARCH_RUNTIME_VERSION) {
      return {
        passed: false,
        evidence: `unexpected Elasticsearch runtime: expected=${VECTOR_SEARCH_RUNTIME_VERSION} actual=${version}`,
      };
    }
    jsonRequest(
      context,
      'GET',
      '/_cluster/health?wait_for_status=yellow&timeout=20s',
      undefined,
      25_000,
    );

    const lines = scenario(context);
    return {
      passed: true,
      evidence: [
        `Elasticsearch vector runtime: ${version}; image=${VECTOR_SEARCH_RUNTIME_IMAGE}`,
        ...lines,
      ]
        .join('\n')
        .slice(-18_000),
    };
  } catch (error) {
    return {
      passed: false,
      evidence: `${VECTOR_SEARCH_RUNTIME_IMAGE} vector runtime harness failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (started) docker(['rm', '-f', container], 8_000);
  }
}

function vectorMappings(schemaVersion: string): JsonRecord {
  return {
    _meta: { schema_version: schemaVersion, vector_dimension: 4, distance: 'cosine' },
    properties: {
      doc_id: { type: 'keyword' },
      tenant: { type: 'keyword' },
      category: { type: 'keyword' },
      active: { type: 'boolean' },
      updated_at: { type: 'date' },
      vector: {
        type: 'dense_vector',
        dims: 4,
        index: true,
        similarity: 'cosine',
        index_options: { type: 'hnsw', m: 16, ef_construction: 100 },
      },
    },
  };
}

function createVectorIndex(
  context: RuntimeContext,
  index: string,
  schemaVersion: string,
  shards: number,
  aliases?: JsonRecord,
): void {
  jsonRequest(context, 'PUT', `/${index}`, {
    settings: { number_of_shards: shards, number_of_replicas: 0, refresh_interval: '250ms' },
    mappings: vectorMappings(schemaVersion),
    ...(aliases ? { aliases } : {}),
  });
}

function bulkIndex(
  context: RuntimeContext,
  index: string,
  documents: readonly VectorDocument[],
): void {
  const payload =
    documents
      .flatMap((document) => [
        JSON.stringify({ index: { _index: index, _id: document.id } }),
        JSON.stringify({
          doc_id: document.id,
          tenant: document.tenant,
          category: document.category,
          active: document.active,
          vector: document.vector,
          updated_at: '2026-10-05T00:00:00Z',
        }),
      ])
      .join('\n') + '\n';
  const result = spawnSync(
    'curl',
    [
      '-sS',
      '--fail-with-body',
      '--max-time',
      '20',
      '-H',
      'Content-Type: application/x-ndjson',
      '--data-binary',
      '@-',
      `${context.baseUrl}/_bulk?refresh=true`,
    ],
    { input: payload, encoding: 'utf8', timeout: 22_000, maxBuffer: 8_000_000 },
  );
  if (result.status !== 0) {
    throw new Error(`bulk index failed: ${(result.stderr || result.stdout || '').slice(-1_200)}`);
  }
  const body = record(JSON.parse(result.stdout || '{}'), 'bulk response');
  assert(body.errors === false, `bulk index reported errors: ${result.stdout.slice(-1_200)}`);
}

function extractHitIds(payload: unknown): string[] {
  const hitsRoot = record(record(payload, 'search response').hits, 'hits');
  return array(hitsRoot.hits, 'hits.hits').map((hit, index) => {
    const source = record(record(hit, `hit ${index}`)._source, `hit ${index} source`);
    return stringValue(source.doc_id, `hit ${index} doc_id`);
  });
}

function knnSearch(
  context: RuntimeContext,
  index: string,
  queryVector: number[],
  k: number,
  filter: JsonRecord,
): { ids: string[]; took: number; elapsedMs: number } {
  const result = jsonRequest(context, 'POST', `/${index}/_search`, {
    size: k,
    _source: ['doc_id', 'tenant', 'category', 'active'],
    knn: {
      field: 'vector',
      query_vector: queryVector,
      k,
      num_candidates: Math.max(50, k * 10),
      filter,
    },
  });
  return {
    ids: extractHitIds(result.json),
    took: numberValue(record(result.json, 'knn response').took, 'knn took'),
    elapsedMs: result.elapsedMs,
  };
}

function indexEvidence(context: RuntimeContext, indexes: string[]): JsonRecord {
  return record(
    jsonRequest(
      context,
      'GET',
      `/${indexes.join(',')}/_stats?filter_path=indices.*.primaries.docs,indices.*.primaries.store.size_in_bytes,indices.*.primaries.segments.memory_in_bytes,indices.*.primaries.search.query_total,indices.*.primaries.indexing.index_total`,
    ).json,
    'index stats',
  );
}

function containerMemoryEvidence(container: string): string {
  const result = docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', container], 6_000);
  return result.status === 0 ? result.stdout.trim() : `unavailable:${(result.stderr || '').trim()}`;
}

function seedDocuments(): VectorDocument[] {
  const primary: VectorDocument[] = [
    { id: 'a-red-1', tenant: 'A', category: 'red', active: true, vector: [1, 0, 0, 0] },
    { id: 'a-red-2', tenant: 'A', category: 'red', active: true, vector: [0.98, 0.2, 0, 0] },
    { id: 'a-blue-1', tenant: 'A', category: 'blue', active: true, vector: [0.94, 0.34, 0, 0] },
    { id: 'a-blue-2', tenant: 'A', category: 'blue', active: true, vector: [0.7, 0.7, 0, 0] },
    { id: 'b-red-1', tenant: 'B', category: 'red', active: true, vector: [0.999, 0.04, 0, 0] },
    { id: 'b-blue-1', tenant: 'B', category: 'blue', active: true, vector: [0.96, 0.28, 0, 0] },
  ];
  for (let index = 0; index < 42; index += 1) {
    const angle = ((index + 3) * Math.PI) / 64;
    primary.push({
      id: `filler-${String(index).padStart(2, '0')}`,
      tenant: index % 2 === 0 ? 'A' : 'B',
      category: index % 3 === 0 ? 'red' : 'blue',
      active: index % 11 !== 0,
      vector: [Math.cos(angle), Math.sin(angle), (index % 5) / 20, (index % 7) / 25],
    });
  }
  return primary;
}

export function runVectorRecallMigrationRuntime(): VectorSearchRuntimeResult {
  return runWithElasticsearch((context) => {
    const oldIndex = 'vectors-v1';
    const newIndex = 'vectors-v2';
    createVectorIndex(context, oldIndex, 'vectors-v1', 1, {
      'vectors-read': {},
      'vectors-write': { is_write_index: true },
    });
    createVectorIndex(context, newIndex, 'vectors-v2', 1);

    let documents = seedDocuments();
    bulkIndex(context, oldIndex, documents);
    const query = [1, 0, 0, 0];
    const tenantFilter = {
      bool: { filter: [{ term: { tenant: 'A' } }, { term: { active: true } }] },
    };
    const exact = exactTopK(
      documents,
      query,
      4,
      (document) => document.tenant === 'A' && document.active,
    );
    const ann = knnSearch(context, oldIndex, query, 4, tenantFilter);
    const recall = recallAtK(ann.ids, exact, 4);
    assert(recall === 1, `ANN recall@4 was ${recall}; exact=${exact}; ann=${ann.ids}`);
    assert(
      ann.ids.every((id) => documents.find((document) => document.id === id)?.tenant === 'A'),
      'tenant isolation failed in ANN query',
    );

    const selectiveExact = exactTopK(
      documents,
      query,
      2,
      (document) => document.tenant === 'A' && document.category === 'red' && document.active,
    );
    const selective = knnSearch(context, oldIndex, query, 2, {
      bool: {
        filter: [
          { term: { tenant: 'A' } },
          { term: { category: 'red' } },
          { term: { active: true } },
        ],
      },
    });
    assert(
      recallAtK(selective.ids, selectiveExact, 2) === 1,
      `selective-filter recall failed: exact=${selectiveExact} ann=${selective.ids}`,
    );
    const noResult = knnSearch(context, oldIndex, query, 3, { term: { tenant: 'Z' } });
    assert(noResult.ids.length === 0, 'empty tenant filter returned cross-tenant neighbors');

    const updateId = 'a-blue-2';
    jsonRequest(context, 'POST', `/${oldIndex}/_update/${updateId}?refresh=true`, {
      doc: { vector: [0.9999, 0.01, 0, 0], updated_at: '2026-10-05T00:01:00Z' },
    });
    const deleteId = 'a-red-1';
    jsonRequest(context, 'DELETE', `/${oldIndex}/_doc/${deleteId}?refresh=true`);
    documents = documents
      .filter((document) => document.id !== deleteId)
      .map((document) =>
        document.id === updateId ? { ...document, vector: [0.9999, 0.01, 0, 0] } : document,
      );
    const afterExact = exactTopK(
      documents,
      query,
      4,
      (document) => document.tenant === 'A' && document.active,
    );
    const after = knnSearch(context, oldIndex, query, 4, tenantFilter);
    assert(!after.ids.includes(deleteId), 'deleted vector remained visible');
    assert(after.ids.includes(updateId), 'updated vector did not become visible');
    assert(
      recallAtK(after.ids, afterExact, 4) === 1,
      'freshness query diverged from exact reference',
    );

    jsonRequest(
      context,
      'POST',
      '/_reindex?refresh=true&wait_for_completion=true',
      { source: { index: oldIndex }, dest: { index: newIndex } },
      30_000,
    );
    const overlap: VectorDocument = {
      id: 'a-live',
      tenant: 'A',
      category: 'red',
      active: true,
      vector: [0.997, 0.06, 0, 0],
    };
    for (const index of [oldIndex, newIndex]) {
      jsonRequest(context, 'PUT', `/${index}/_doc/${overlap.id}?refresh=true`, {
        doc_id: overlap.id,
        tenant: overlap.tenant,
        category: overlap.category,
        active: true,
        vector: overlap.vector,
        updated_at: '2026-10-05T00:02:00Z',
      });
    }
    documents = [...documents, overlap];
    const shadowOld = knnSearch(context, oldIndex, query, 5, tenantFilter);
    const shadowNew = knnSearch(context, newIndex, query, 5, tenantFilter);
    assert(
      JSON.stringify(shadowOld.ids) === JSON.stringify(shadowNew.ids),
      `shadow ANN parity failed: old=${shadowOld.ids} new=${shadowNew.ids}`,
    );

    jsonRequest(context, 'POST', '/_aliases', {
      actions: [
        { remove: { index: oldIndex, alias: 'vectors-read' } },
        { add: { index: newIndex, alias: 'vectors-read' } },
        { remove: { index: oldIndex, alias: 'vectors-write' } },
        { add: { index: newIndex, alias: 'vectors-write', is_write_index: true } },
      ],
    });
    assert(
      JSON.stringify(knnSearch(context, 'vectors-read', query, 5, tenantFilter).ids) ===
        JSON.stringify(shadowNew.ids),
      'alias cutover changed vector results',
    );
    jsonRequest(context, 'POST', '/_aliases', {
      actions: [
        { remove: { index: newIndex, alias: 'vectors-read' } },
        { add: { index: oldIndex, alias: 'vectors-read' } },
        { remove: { index: newIndex, alias: 'vectors-write' } },
        { add: { index: oldIndex, alias: 'vectors-write', is_write_index: true } },
      ],
    });
    assert(
      JSON.stringify(knnSearch(context, 'vectors-read', query, 5, tenantFilter).ids) ===
        JSON.stringify(shadowOld.ids),
      'rollback did not restore old vector index',
    );
    jsonRequest(context, 'POST', '/_aliases', {
      actions: [
        { remove: { index: oldIndex, alias: 'vectors-read' } },
        { add: { index: newIndex, alias: 'vectors-read' } },
        { remove: { index: oldIndex, alias: 'vectors-write' } },
        { add: { index: newIndex, alias: 'vectors-write', is_write_index: true } },
      ],
    });

    const latencies = [ann.elapsedMs, selective.elapsedMs, after.elapsedMs, shadowNew.elapsedMs];
    for (let sample = 0; sample < 8; sample += 1) {
      latencies.push(knnSearch(context, 'vectors-read', query, 5, tenantFilter).elapsedMs);
    }
    const stats = indexEvidence(context, [oldIndex, newIndex]);
    const memory = containerMemoryEvidence(context.container);
    return [
      'scenario-1 vector contract: dims=4 similarity=cosine index=hnsw m=16 ef_construction=100',
      `scenario-1 exact-reference ANN recall: recall@4=${recall}; exact=${exact.join(',')}; ann=${ann.ids.join(',')}`,
      `scenario-1 filtering/tenant isolation: broad=pass selective=pass empty-tenant=0; selective=${selective.ids.join(',')}`,
      `scenario-1 freshness/update/delete: updated=${updateId} visible; deleted=${deleteId} absent; recall@4=1`,
      `scenario-1 shadow migration: reindex + overlapping dual-write parity=pass; old/new ids=${shadowNew.ids.join(',')}`,
      'scenario-1 alias cutover -> rollback -> recutover: pass; old index retained through acceptance',
      `scenario-1 latency evidence: samples=${latencies.length}; host-avg=${rounded(average(latencies))}ms; host-max=${rounded(Math.max(...latencies))}ms; engine-took=${ann.took}ms`,
      `scenario-1 build/storage/memory evidence: raw-vector-bytes>=${documents.length * 4 * 4}; container-memory=${memory}; stats=${JSON.stringify(stats)}`,
    ];
  });
}

export function runVectorShardedRecoveryRuntime(): VectorSearchRuntimeResult {
  return runWithElasticsearch((context) => {
    const index = 'vectors-sharded-v1';
    createVectorIndex(context, index, 'vectors-sharded-v1', 2, { 'vectors-global': {} });
    let documents = seedDocuments().map((document, position) => ({
      ...document,
      id: `s${position}-${document.id}`,
    }));
    bulkIndex(context, index, documents);
    const query = [1, 0, 0, 0];
    const filter = {
      bool: { filter: [{ term: { tenant: 'A' } }, { term: { active: true } }] },
    };
    const exact = exactTopK(
      documents,
      query,
      6,
      (document) => document.tenant === 'A' && document.active,
    );
    const ann = knnSearch(context, 'vectors-global', query, 6, filter);
    assert(
      recallAtK(ann.ids, exact, 6) === 1,
      `global sharded top-k diverged: exact=${exact} ann=${ann.ids}`,
    );

    const deleteId = exact[0]!;
    jsonRequest(context, 'DELETE', `/${index}/_doc/${deleteId}?refresh=true`);
    documents = documents.filter((document) => document.id !== deleteId);
    const updateTarget = documents.find(
      (document) => document.tenant === 'A' && document.active && document.id !== exact[1],
    )!;
    jsonRequest(context, 'POST', `/${index}/_update/${updateTarget.id}?refresh=true`, {
      doc: { vector: [0.99995, 0.005, 0, 0], updated_at: '2026-10-05T00:03:00Z' },
    });
    documents = documents.map((document) =>
      document.id === updateTarget.id ? { ...document, vector: [0.99995, 0.005, 0, 0] } : document,
    );
    const refreshedExact = exactTopK(
      documents,
      query,
      6,
      (document) => document.tenant === 'A' && document.active,
    );
    const refreshed = knnSearch(context, 'vectors-global', query, 6, filter);
    assert(!refreshed.ids.includes(deleteId), 'sharded delete remained visible');
    assert(refreshed.ids.includes(updateTarget.id), 'sharded update was not visible');
    assert(
      recallAtK(refreshed.ids, refreshedExact, 6) === 1,
      'sharded freshness query diverged from exact baseline',
    );

    jsonRequest(context, 'POST', `/${index}/_close`);
    const unavailable = request(context, 'POST', '/vectors-global/_search', {
      size: 1,
      knn: { field: 'vector', query_vector: query, k: 1, num_candidates: 10, filter },
    });
    assert(unavailable.statusCode >= 400, 'closed index unexpectedly served vector search');
    jsonRequest(context, 'POST', `/${index}/_open`);
    jsonRequest(
      context,
      'GET',
      '/_cluster/health/vectors-sharded-v1?wait_for_status=yellow&timeout=20s',
      undefined,
      25_000,
    );
    const recovered = knnSearch(context, 'vectors-global', query, 6, filter);
    assert(
      JSON.stringify(recovered.ids) === JSON.stringify(refreshed.ids),
      `recovered sharded result changed: before=${refreshed.ids} after=${recovered.ids}`,
    );

    const latencySamples = [ann.elapsedMs, refreshed.elapsedMs, recovered.elapsedMs];
    for (let sample = 0; sample < 8; sample += 1) {
      latencySamples.push(knnSearch(context, 'vectors-global', query, 6, filter).elapsedMs);
    }
    const stats = indexEvidence(context, [index]);
    const memory = containerMemoryEvidence(context.container);
    return [
      `scenario-2 sharded global top-k: shards=2 recall@6=1 exact=${exact.join(',')} ann=${ann.ids.join(',')}`,
      'scenario-2 authorization/filter boundary: tenant=A active=true enforced before ANN return; cross-tenant candidates absent',
      `scenario-2 freshness/update/delete: deleted=${deleteId} absent; updated=${updateTarget.id} visible; recall@6=1`,
      `scenario-2 failure/recovery: closed-index HTTP=${unavailable.statusCode}; reopen/yellow/requery=pass`,
      `scenario-2 latency evidence: samples=${latencySamples.length}; host-avg=${rounded(average(latencySamples))}ms; host-max=${rounded(Math.max(...latencySamples))}ms`,
      `scenario-2 capacity/storage/memory evidence: docs=${documents.length}; raw-vector-bytes>=${documents.length * 4 * 4}; container-memory=${memory}; stats=${JSON.stringify(stats)}`,
    ];
  });
}
