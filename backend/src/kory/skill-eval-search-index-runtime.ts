import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const SEARCH_INDEX_RUNTIME_IMAGE = 'docker.elastic.co/elasticsearch/elasticsearch:8.19.4';
export const SEARCH_INDEX_RUNTIME_VERSION = '8.19.4';
export const SEARCH_INDEX_RUNTIME_BLOCKER = `Full-task qualification requires an available local Docker runtime with the pinned ${SEARCH_INDEX_RUNTIME_IMAGE} image so analyzer/mapping versioning, reindex/cutover/rollback, authorization filtering, freshness, update/delete visibility, relevance, latency, and index evidence execute on a real Elasticsearch ${SEARCH_INDEX_RUNTIME_VERSION} engine.`;

export interface SearchIndexRuntimeResult {
  passed: boolean;
  evidence: string;
}

interface RuntimeContext {
  container: string;
  baseUrl: string;
}

interface HttpResult {
  json: unknown;
  elapsedMs: number;
  statusCode: number;
}

type JsonRecord = Record<string, unknown>;

function docker(args: string[], options?: { input?: string; timeout?: number }) {
  return spawnSync('docker', args, {
    input: options?.input,
    encoding: 'utf8',
    timeout: options?.timeout ?? 5_000,
    maxBuffer: 8_000_000,
  });
}

function pause(milliseconds: number): void {
  spawnSync('sleep', [(milliseconds / 1_000).toFixed(3)], { timeout: milliseconds + 1_000 });
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

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} was not a string`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} was not a finite number`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} was not a boolean`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function http(
  context: RuntimeContext,
  method: string,
  path: string,
  body?: string,
  contentType = 'application/json',
  timeout = 30_000,
): HttpResult {
  const args = [
    '-sS',
    '--max-time',
    String(Math.max(1, Math.ceil(timeout / 1_000))),
    '-X',
    method,
    '-H',
    `Content-Type: ${contentType}`,
    '-w',
    '\n%{http_code}',
  ];
  if (body !== undefined) args.push('--data-binary', '@-');
  args.push(context.baseUrl + path);

  const started = performance.now();
  const result = spawnSync('curl', args, {
    input: body,
    encoding: 'utf8',
    timeout: timeout + 2_000,
    maxBuffer: 8_000_000,
  });
  const elapsedMs = performance.now() - started;
  if (result.status !== 0) {
    throw new Error(
      `HTTP ${method} ${path} failed before a response: ${(result.stderr || result.error?.message || result.stdout).trim()}`,
    );
  }
  const output = result.stdout ?? '';
  const split = output.lastIndexOf('\n');
  if (split < 0) throw new Error(`HTTP ${method} ${path} returned no status code`);
  const rawBody = output.slice(0, split);
  const statusCode = Number(output.slice(split + 1));
  if (!Number.isInteger(statusCode)) {
    throw new Error(`HTTP ${method} ${path} returned an invalid status code`);
  }

  let json: unknown = null;
  if (rawBody.trim()) {
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new Error(`HTTP ${method} ${path} returned non-JSON content: ${rawBody.slice(0, 500)}`);
    }
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`HTTP ${method} ${path} returned ${statusCode}: ${rawBody.slice(0, 1_000)}`);
  }
  return { json, elapsedMs, statusCode };
}

function jsonRequest(
  context: RuntimeContext,
  method: string,
  path: string,
  body?: unknown,
  timeout?: number,
): HttpResult {
  return http(
    context,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    'application/json',
    timeout,
  );
}

function bulkRequest(context: RuntimeContext, lines: string[]): HttpResult {
  const result = http(
    context,
    'POST',
    '/_bulk?refresh=true',
    lines.join('\n') + '\n',
    'application/x-ndjson',
  );
  const payload = record(result.json, 'bulk response');
  assert(
    payload.errors === false,
    `bulk indexing reported errors: ${JSON.stringify(payload).slice(0, 1_500)}`,
  );
  return result;
}

function bulkIndexLine(index: string, id: string, source: JsonRecord): string[] {
  return [JSON.stringify({ index: { _index: index, _id: id } }), JSON.stringify(source)];
}

function extractSources(response: unknown): JsonRecord[] {
  const root = record(response, 'search response');
  const hitsEnvelope = record(root.hits, 'search hits');
  return array(hitsEnvelope.hits, 'search hit list').map((hit, index) => {
    const hitRecord = record(hit, `search hit ${index}`);
    return record(hitRecord._source, `search hit ${index} _source`);
  });
}

function extractDocIds(response: unknown): string[] {
  return extractSources(response).map((source, index) =>
    stringValue(source.doc_id, `search source ${index}.doc_id`),
  );
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function searchIndexRuntimeReadiness(): readonly string[] {
  const image = docker(['image', 'inspect', SEARCH_INDEX_RUNTIME_IMAGE], { timeout: 10_000 });
  const curl = spawnSync('curl', ['--version'], { encoding: 'utf8', timeout: 2_000 });
  return image.status === 0 && curl.status === 0 ? [] : [SEARCH_INDEX_RUNTIME_BLOCKER];
}

function publishedPort(container: string): number | null {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = docker(['port', container, '9200/tcp'], { timeout: 2_000 });
    const match = (result.stdout ?? '').match(/:(\d+)\s*$/mu);
    if (result.status === 0 && match) return Number(match[1]);
    pause(100);
  }
  return null;
}

function runWithElasticsearch(
  scenario: (context: RuntimeContext) => string[],
): SearchIndexRuntimeResult {
  const blockers = searchIndexRuntimeReadiness();
  if (blockers.length > 0) return { passed: false, evidence: blockers.join('\n') };

  const container = 'kory-search-' + randomUUID().replaceAll('-', '').slice(0, 12);
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
        SEARCH_INDEX_RUNTIME_IMAGE,
      ],
      { timeout: 20_000 },
    );
    if (start.status !== 0) {
      return {
        passed: false,
        evidence: (
          `${SEARCH_INDEX_RUNTIME_IMAGE} start failed: ` + (start.stderr || start.stdout)
        ).trim(),
      };
    }
    started = true;

    const port = publishedPort(container);
    if (!port)
      return { passed: false, evidence: `${SEARCH_INDEX_RUNTIME_IMAGE} exposed no HTTP port` };
    const context = { container, baseUrl: `http://127.0.0.1:${port}` };

    let info: HttpResult | null = null;
    let lastStartupError = '';
    // An Elasticsearch cold boot under the pinned x64 Colima/QEMU runtime can
    // take longer than 120 seconds before HTTP is available. Bound startup by
    // elapsed time while retaining the real engine/version/health checks.
    const startupDeadline = Date.now() + 210_000;
    while (Date.now() < startupDeadline) {
      try {
        info = jsonRequest(context, 'GET', '/', undefined, 1_000);
        break;
      } catch (error) {
        lastStartupError = error instanceof Error ? error.message : String(error);
      }

      const state = docker(
        [
          'inspect',
          '--format',
          '{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}',
          container,
        ],
        { timeout: 2_000 },
      );
      if (state.status === 0 && !(state.stdout ?? '').trim().startsWith('running')) {
        lastStartupError = [lastStartupError, (state.stdout ?? '').trim()]
          .filter(Boolean)
          .join('; ');
        break;
      }
      pause(250);
    }
    if (!info) {
      const state = docker(['inspect', '--format', '{{json .State}}', container], {
        timeout: 2_000,
      });
      const logs = docker(['logs', '--tail', '80', container], { timeout: 3_000 });
      const diagnostics = [
        lastStartupError ? `last HTTP probe: ${lastStartupError}` : '',
        state.status === 0 ? `container state: ${(state.stdout ?? '').trim()}` : '',
        (logs.stderr || logs.stdout || '').trim()
          ? `container logs:\n${(logs.stderr || logs.stdout || '').trim().slice(-4_000)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        passed: false,
        evidence: `${SEARCH_INDEX_RUNTIME_IMAGE} did not become ready${diagnostics ? `:\n${diagnostics}` : ''}`,
      };
    }

    const infoRoot = record(info.json, 'Elasticsearch info');
    const version = stringValue(
      record(infoRoot.version, 'Elasticsearch version').number,
      'version.number',
    );
    if (version !== SEARCH_INDEX_RUNTIME_VERSION) {
      return {
        passed: false,
        evidence: `unexpected Elasticsearch runtime: expected=${SEARCH_INDEX_RUNTIME_VERSION} actual=${version}`,
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
      evidence: [`Elasticsearch runtime: ${version}; image=${SEARCH_INDEX_RUNTIME_IMAGE}`, ...lines]
        .join('\n')
        .slice(-16_000),
    };
  } catch (error) {
    return {
      passed: false,
      evidence: `${SEARCH_INDEX_RUNTIME_IMAGE} runtime harness failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (started) docker(['rm', '-f', container], { timeout: 8_000 });
  }
}

function analyzerV1Settings(): JsonRecord {
  return {
    number_of_shards: 1,
    number_of_replicas: 0,
    refresh_interval: '1s',
    analysis: {
      filter: { fold: { type: 'asciifolding', preserve_original: false } },
      analyzer: {
        product_text_v1: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'fold'],
        },
      },
    },
  };
}

function analyzerV2Settings(): JsonRecord {
  return {
    number_of_shards: 1,
    number_of_replicas: 0,
    refresh_interval: '1s',
    analysis: {
      filter: {
        fold: { type: 'asciifolding', preserve_original: false },
        sku_capture: {
          type: 'pattern_capture',
          preserve_original: false,
          patterns: ['([\\p{L}\\p{N}]+-[\\p{L}\\p{N}-]+)'],
        },
      },
      analyzer: {
        product_text_v2: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'fold'],
        },
        product_sku_v2: {
          type: 'custom',
          tokenizer: 'keyword',
          filter: ['lowercase', 'fold', 'sku_capture'],
        },
      },
    },
  };
}

function productMappings(version: string, withSkuField: boolean): JsonRecord {
  return {
    _meta: { schema_version: version },
    properties: {
      doc_id: { type: 'keyword' },
      name: {
        type: 'text',
        analyzer: withSkuField ? 'product_text_v2' : 'product_text_v1',
        ...(withSkuField
          ? {
              fields: {
                sku: {
                  type: 'text',
                  analyzer: 'product_sku_v2',
                  search_analyzer: 'product_sku_v2',
                },
              },
            }
          : {}),
      },
      updated_at: { type: 'date' },
    },
  };
}

function searchProduct(
  context: RuntimeContext,
  index: string,
  query: string,
  mode: 'natural' | 'sku' = 'natural',
): { ids: string[]; took: number } {
  const body = {
    size: 20,
    track_total_hits: true,
    query: {
      match: {
        [mode === 'sku' ? 'name.sku' : 'name']: { query, operator: 'and' },
      },
    },
    sort: [{ _score: 'desc' }, { doc_id: 'asc' }],
  };
  const result = jsonRequest(context, 'POST', `/${index}/_search`, body);
  return {
    ids: extractDocIds(result.json),
    took: numberValue(record(result.json, 'product search').took, 'product search took'),
  };
}

function waitForTask(context: RuntimeContext, taskId: string): JsonRecord {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const result = jsonRequest(context, 'GET', `/_tasks/${encodeURIComponent(taskId)}`);
    const payload = record(result.json, 'task response');
    if (payload.completed === true) return payload;
    pause(100);
  }
  throw new Error(`reindex task ${taskId} did not complete`);
}

export function runSearchAnalyzerVersioningRuntime(): SearchIndexRuntimeResult {
  return runWithElasticsearch((context) => {
    const oldIndex = 'products-v1';
    const targetIndex = 'products-v2';

    jsonRequest(context, 'PUT', `/${oldIndex}`, {
      settings: analyzerV1Settings(),
      mappings: productMappings('products-v1', false),
      aliases: {
        'products-read': {},
        'products-write': { is_write_index: true },
      },
    });
    jsonRequest(context, 'PUT', `/${targetIndex}`, {
      settings: analyzerV2Settings(),
      mappings: productMappings('products-v2', true),
    });

    const now = '2026-10-04T00:00:00Z';
    const seed: Array<[string, string]> = [
      ['sku-1', 'Café ABC-123 Travel Mug'],
      ['split-sku', 'ABC 123 Budget Mug'],
      ['sku-2', 'Résumé Sleeve DEF-456'],
      ['natural-cafe', 'Café travel mug gift'],
    ];
    for (let index = 0; index < 196; index += 1) {
      seed.push([
        `filler-${String(index).padStart(3, '0')}`,
        `Catalog filler ${index} ordinary item`,
      ]);
    }
    const bulkLines = seed.flatMap(([docId, name]) =>
      bulkIndexLine(oldIndex, docId, { doc_id: docId, name, updated_at: now }),
    );
    bulkRequest(context, bulkLines);

    const v1ExactBefore = searchProduct(context, oldIndex, 'ABC-123', 'natural').ids;
    assert(
      v1ExactBefore.includes('sku-1') && v1ExactBefore.includes('split-sku'),
      `v1 baseline did not reproduce hyphen ambiguity: ${v1ExactBefore.join(',')}`,
    );

    const reindexStart = jsonRequest(
      context,
      'POST',
      '/_reindex?wait_for_completion=false&requests_per_second=20',
      {
        source: { index: oldIndex, size: 20 },
        dest: { index: targetIndex },
      },
    );
    const taskId = stringValue(record(reindexStart.json, 'reindex start').task, 'reindex task id');
    const overlapProbe = record(
      jsonRequest(context, 'GET', `/_tasks/${encodeURIComponent(taskId)}`).json,
      'reindex overlap probe',
    );
    assert(overlapProbe.completed !== true, 'reindex finished before the live-write overlap probe');

    const journal = [
      { op: 'create', id: 'live-1', name: 'Café GHI-789 Live Arrival' },
      { op: 'update', id: 'sku-2', name: 'Résumé Sleeve DEF-456 Updated' },
      { op: 'delete', id: 'filler-050' },
    ] as const;
    const liveWriteLatencies: number[] = [];
    for (const entry of journal) {
      if (entry.op === 'create') {
        liveWriteLatencies.push(
          jsonRequest(context, 'PUT', `/${oldIndex}/_doc/${entry.id}`, {
            doc_id: entry.id,
            name: entry.name,
            updated_at: '2026-10-04T00:01:00Z',
          }).elapsedMs,
        );
      } else if (entry.op === 'update') {
        liveWriteLatencies.push(
          jsonRequest(context, 'POST', `/${oldIndex}/_update/${entry.id}`, {
            doc: { name: entry.name, updated_at: '2026-10-04T00:01:01Z' },
          }).elapsedMs,
        );
      } else {
        liveWriteLatencies.push(
          jsonRequest(context, 'DELETE', `/${oldIndex}/_doc/${entry.id}`).elapsedMs,
        );
      }
      pause(80);
    }

    const completedTask = waitForTask(context, taskId);
    const reindexResponse = record(completedTask.response, 'reindex task completion');
    assert(
      numberValue(reindexResponse.total, 'reindex total') >= seed.length - 1,
      'reindex copied too few documents',
    );

    for (const entry of journal) {
      if (entry.op === 'create') {
        jsonRequest(context, 'PUT', `/${targetIndex}/_doc/${entry.id}`, {
          doc_id: entry.id,
          name: entry.name,
          updated_at: '2026-10-04T00:01:00Z',
        });
      } else if (entry.op === 'update') {
        jsonRequest(context, 'POST', `/${targetIndex}/_update/${entry.id}`, {
          doc: { name: entry.name, updated_at: '2026-10-04T00:01:01Z' },
        });
      } else {
        jsonRequest(context, 'POST', `/${targetIndex}/_delete_by_query?refresh=false`, {
          query: { term: { doc_id: entry.id } },
        });
      }
    }
    jsonRequest(context, 'POST', `/${oldIndex},${targetIndex}/_refresh`);

    const oldCount = numberValue(
      record(jsonRequest(context, 'GET', `/${oldIndex}/_count`).json, 'old count').count,
      'old count',
    );
    const targetCount = numberValue(
      record(jsonRequest(context, 'GET', `/${targetIndex}/_count`).json, 'target count').count,
      'target count',
    );
    assert(
      oldCount === targetCount,
      `document-count parity failed: old=${oldCount} target=${targetCount}`,
    );
    assert(oldCount === seed.length, `write journal final count was unexpected: ${oldCount}`);

    const skuAnalyze = record(
      jsonRequest(context, 'POST', `/${targetIndex}/_analyze`, {
        analyzer: 'product_sku_v2',
        text: 'Café ABC-123 Travel Mug',
      }).json,
      'sku analyzer result',
    );
    const skuTokens = array(skuAnalyze.tokens, 'sku analyzer tokens').map((token, index) =>
      stringValue(record(token, `sku token ${index}`).token, `sku token ${index}.token`),
    );
    assert(
      skuTokens.includes('abc-123'),
      `target SKU analyzer did not preserve ABC-123: ${skuTokens.join(',')}`,
    );

    const accentAnalyze = record(
      jsonRequest(context, 'POST', `/${targetIndex}/_analyze`, {
        analyzer: 'product_text_v2',
        text: 'Café Résumé',
      }).json,
      'accent analyzer result',
    );
    const accentTokens = array(accentAnalyze.tokens, 'accent analyzer tokens').map((token, index) =>
      stringValue(record(token, `accent token ${index}`).token, `accent token ${index}.token`),
    );
    assert(
      accentTokens.includes('cafe') && accentTokens.includes('resume'),
      `accent normalization failed: ${accentTokens.join(',')}`,
    );

    const skuGolden = searchProduct(context, targetIndex, 'ABC-123', 'sku');
    assert(
      skuGolden.ids.length === 1 && skuGolden.ids[0] === 'sku-1',
      `exact SKU golden failed: ${skuGolden.ids.join(',')}`,
    );
    const naturalGolden = searchProduct(context, targetIndex, 'cafe travel');
    assert(
      naturalGolden.ids.includes('sku-1') && naturalGolden.ids.includes('natural-cafe'),
      `natural-language golden failed: ${naturalGolden.ids.join(',')}`,
    );
    const accentGolden = searchProduct(context, targetIndex, 'resume');
    assert(
      accentGolden.ids.includes('sku-2'),
      `accent golden failed: ${accentGolden.ids.join(',')}`,
    );
    const liveGolden = searchProduct(context, targetIndex, 'GHI-789', 'sku');
    assert(
      liveGolden.ids.join(',') === 'live-1',
      `write-during-reindex replay failed: ${liveGolden.ids.join(',')}`,
    );
    const updateGolden = searchProduct(context, targetIndex, 'updated');
    assert(
      updateGolden.ids.includes('sku-2'),
      `update replay was not visible: ${updateGolden.ids.join(',')}`,
    );
    const deleteGolden = searchProduct(context, targetIndex, 'Catalog filler 50 ordinary item');
    assert(!deleteGolden.ids.includes('filler-050'), 'delete replay left filler-050 searchable');
    const noResultGolden = searchProduct(context, targetIndex, 'definitely-no-such-product');
    assert(
      noResultGolden.ids.length === 0,
      `no-result control returned ids: ${noResultGolden.ids.join(',')}`,
    );

    const mapping = record(
      jsonRequest(context, 'GET', `/${targetIndex}/_mapping`).json,
      'target mapping',
    );
    const targetMapping = record(mapping[targetIndex], 'target mapping index');
    const targetMeta = record(
      record(targetMapping.mappings, 'target mappings')._meta,
      'target mapping _meta',
    );
    assert(
      targetMeta.schema_version === 'products-v2',
      'target mapping schema version was not products-v2',
    );

    jsonRequest(context, 'POST', '/_aliases', {
      actions: [
        { remove: { index: oldIndex, alias: 'products-read' } },
        { add: { index: targetIndex, alias: 'products-read' } },
        { remove: { index: oldIndex, alias: 'products-write' } },
        { add: { index: targetIndex, alias: 'products-write', is_write_index: true } },
      ],
    });
    let aliases = record(
      jsonRequest(context, 'GET', '/_alias/products-read').json,
      'cutover aliases',
    );
    assert(
      targetIndex in aliases && !(oldIndex in aliases),
      'read alias did not cut over to products-v2',
    );

    jsonRequest(context, 'POST', '/_aliases', {
      actions: [
        { remove: { index: targetIndex, alias: 'products-read' } },
        { add: { index: oldIndex, alias: 'products-read' } },
        { remove: { index: targetIndex, alias: 'products-write' } },
        { add: { index: oldIndex, alias: 'products-write', is_write_index: true } },
      ],
    });
    aliases = record(jsonRequest(context, 'GET', '/_alias/products-read').json, 'rollback aliases');
    assert(
      oldIndex in aliases && !(targetIndex in aliases),
      'rollback did not restore products-v1 alias',
    );

    jsonRequest(context, 'POST', '/_aliases', {
      actions: [
        { remove: { index: oldIndex, alias: 'products-read' } },
        { add: { index: targetIndex, alias: 'products-read' } },
        { remove: { index: oldIndex, alias: 'products-write' } },
        { add: { index: targetIndex, alias: 'products-write', is_write_index: true } },
      ],
    });

    const latencySamples = [skuGolden.took, naturalGolden.took, accentGolden.took, liveGolden.took];
    for (let index = 0; index < 8; index += 1)
      latencySamples.push(searchProduct(context, 'products-read', 'cafe').took);
    const stats = record(
      jsonRequest(
        context,
        'GET',
        `/${oldIndex},${targetIndex}/_stats?filter_path=indices.*.primaries.docs,indices.*.primaries.indexing.index_total,indices.*.primaries.search.query_total,indices.*.primaries.store.size_in_bytes`,
      ).json,
      'index stats',
    );

    return [
      'scenario-1 versioned mapping boundary: products-v1 -> products-v2; _meta.schema_version=products-v2',
      `scenario-1 analyzer inspection: sku_tokens=${skuTokens.join(',')}; accent_tokens=${accentTokens.join(',')}`,
      `scenario-1 baseline ambiguity reproduced on v1: query=ABC-123 ids=${v1ExactBefore.join(',')}`,
      `scenario-1 asynchronous reindex + overlapping write journal: pass; task=${taskId}; reindex-total=${reindexResponse.total}; reindex-took=${reindexResponse.took}ms`,
      `scenario-1 write replay create/update/delete: pass; final-count=${targetCount}; live-write-host-latency-avg=${rounded(average(liveWriteLatencies))}ms`,
      `scenario-1 relevance goldens: exact-sku=${skuGolden.ids.join(',')}; natural=${naturalGolden.ids.join(',')}; accent=${accentGolden.ids.join(',')}; no-result=0`,
      'scenario-1 document-count parity: pass',
      'scenario-1 alias cutover -> rollback -> recutover: pass; old index retained through acceptance',
      `scenario-1 query latency evidence: samples=${latencySamples.length}; engine-took-avg=${rounded(average(latencySamples))}ms; engine-took-max=${Math.max(...latencySamples)}ms`,
      `scenario-1 index evidence: ${JSON.stringify(stats)}`,
    ];
  });
}

interface CachedTenantResult {
  tenant: string;
  ids: string[];
}

function tenantSearchBody(
  tenant: string,
  query: string,
  page: number,
  pageSize: number,
  profile = false,
) {
  return {
    from: (page - 1) * pageSize,
    size: pageSize,
    track_total_hits: true,
    profile,
    query: {
      function_score: {
        query: {
          bool: {
            filter: [{ term: { tenant } }],
            must: [{ match: { text: { query, operator: 'and' } } }],
          },
        },
        field_value_factor: { field: 'rank', factor: 10, missing: 0 },
        boost_mode: 'sum',
      },
    },
    sort: [{ _score: 'desc' }, { doc_id: 'asc' }],
  };
}

export function runSearchTenantAuthorizationRuntime(): SearchIndexRuntimeResult {
  return runWithElasticsearch((context) => {
    const index = 'tenant-products-v1';
    jsonRequest(context, 'PUT', `/${index}`, {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        refresh_interval: '1s',
        analysis: {
          filter: { fold: { type: 'asciifolding', preserve_original: false } },
          analyzer: {
            tenant_text: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'fold'] },
          },
        },
      },
      mappings: {
        _meta: { schema_version: 'tenant-products-v1', authorization_boundary: 'tenant' },
        properties: {
          tenant: { type: 'keyword' },
          doc_id: { type: 'keyword' },
          text: { type: 'text', analyzer: 'tenant_text' },
          rank: { type: 'integer' },
          updated_at: { type: 'date' },
        },
      },
    });

    const documents = [
      ['A::shared-1', { tenant: 'A', doc_id: 'shared-1', text: 'alpha alpha premium', rank: 30 }],
      ['A::a-2', { tenant: 'A', doc_id: 'a-2', text: 'alpha standard', rank: 20 }],
      ['A::a-3', { tenant: 'A', doc_id: 'a-3', text: 'alpha basic', rank: 10 }],
      ['A::a-beta', { tenant: 'A', doc_id: 'a-beta', text: 'beta only', rank: 50 }],
      [
        'B::shared-1',
        { tenant: 'B', doc_id: 'shared-1', text: 'alpha alpha alpha enterprise', rank: 40 },
      ],
      ['B::b-2', { tenant: 'B', doc_id: 'b-2', text: 'alpha standard', rank: 25 }],
      ['B::b-3', { tenant: 'B', doc_id: 'b-3', text: 'alpha basic', rank: 5 }],
      ['B::b-beta', { tenant: 'B', doc_id: 'b-beta', text: 'beta only', rank: 60 }],
    ] as const;
    const bulkLines = documents.flatMap(([id, source]) =>
      bulkIndexLine(index, id, { ...source, updated_at: '2026-10-04T00:00:00Z' }),
    );
    bulkRequest(context, bulkLines);

    const cache = new Map<string, CachedTenantResult>();
    const cacheKey = (tenant: string, query: string, page: number, pageSize: number) =>
      `${tenant}|${query}|${page}|${pageSize}`;
    const ownerById = new Map<string, Set<string>>();
    for (const [, source] of documents) {
      const owners = ownerById.get(source.doc_id) ?? new Set<string>();
      owners.add(source.tenant);
      ownerById.set(source.doc_id, owners);
    }

    const search = (
      tenant: string,
      query: string,
      page: number,
      pageSize: number,
    ): {
      key: string;
      ids: string[];
      cacheHit: boolean;
      engineTook: number | null;
      hostMs: number;
    } => {
      const key = cacheKey(tenant, query, page, pageSize);
      const started = performance.now();
      const cached = cache.get(key);
      if (
        cached &&
        cached.tenant === tenant &&
        cached.ids.every((id) => ownerById.get(id)?.has(tenant) === true)
      ) {
        return {
          key,
          ids: [...cached.ids],
          cacheHit: true,
          engineTook: null,
          hostMs: performance.now() - started,
        };
      }
      const response = jsonRequest(
        context,
        'POST',
        `/${index}/_search`,
        tenantSearchBody(tenant, query, page, pageSize),
      );
      const sources = extractSources(response.json);
      assert(
        sources.every((source) => source.tenant === tenant),
        `authorization filter returned another tenant for ${tenant}`,
      );
      const ids = sources.map((source, sourceIndex) =>
        stringValue(source.doc_id, `tenant search source ${sourceIndex}.doc_id`),
      );
      cache.set(key, { tenant, ids: [...ids] });
      return {
        key,
        ids,
        cacheHit: false,
        engineTook: numberValue(record(response.json, 'tenant search').took, 'tenant search took'),
        hostMs: performance.now() - started,
      };
    };

    cache.set(cacheKey('A', 'alpha', 1, 2), { tenant: 'B', ids: ['shared-1', 'b-2'] });
    const aCold = search('A', 'alpha', 1, 2);
    assert(!aCold.cacheHit, 'cross-tenant poisoned cache entry was accepted');
    assert(
      aCold.ids.join(',') === 'shared-1,a-2',
      `tenant A ranking changed: ${aCold.ids.join(',')}`,
    );
    const aWarm = search('A', 'alpha', 1, 2);
    assert(
      aWarm.cacheHit && aWarm.ids.join(',') === aCold.ids.join(','),
      'tenant A warm cache did not reuse exact identity',
    );

    const bCold = search('B', 'alpha', 1, 2);
    assert(!bCold.cacheHit, 'tenant B unexpectedly reused tenant A cache');
    assert(
      bCold.ids.join(',') === 'shared-1,b-2',
      `tenant B ranking changed: ${bCold.ids.join(',')}`,
    );
    const bWarm = search('B', 'alpha', 1, 2);
    assert(
      bWarm.cacheHit && bWarm.ids.join(',') === bCold.ids.join(','),
      'tenant B warm cache failed',
    );

    const emptyTenant = search('C', 'alpha', 1, 10);
    assert(emptyTenant.ids.length === 0, `empty tenant leaked ids: ${emptyTenant.ids.join(',')}`);
    const aPage2 = search('A', 'alpha', 2, 2);
    assert(aPage2.ids.join(',') === 'a-3', `tenant A pagination failed: ${aPage2.ids.join(',')}`);

    const profiled = jsonRequest(
      context,
      'POST',
      `/${index}/_search`,
      tenantSearchBody('A', 'alpha', 1, 3, true),
    );
    const profiledSources = extractSources(profiled.json);
    assert(
      profiledSources.every((source) => source.tenant === 'A'),
      'profiled query crossed the tenant boundary',
    );
    const profile = record(record(profiled.json, 'profiled response').profile, 'search profile');
    const profiledShards = array(profile.shards, 'profile shards').length;
    assert(profiledShards >= 1, 'search profile returned no shard evidence');

    const msearchLines: string[] = [];
    const expectedTenants: string[] = [];
    for (let request = 0; request < 40; request += 1) {
      const tenant = request % 2 === 0 ? 'A' : 'B';
      expectedTenants.push(tenant);
      msearchLines.push(JSON.stringify({ index }));
      msearchLines.push(JSON.stringify(tenantSearchBody(tenant, 'alpha', 1, 3)));
    }
    const msearch = http(
      context,
      'POST',
      '/_msearch',
      msearchLines.join('\n') + '\n',
      'application/x-ndjson',
      30_000,
    );
    const responses = array(
      record(msearch.json, 'msearch response').responses,
      'msearch responses',
    );
    assert(
      responses.length === expectedTenants.length,
      'msearch returned an unexpected response count',
    );
    responses.forEach((response, responseIndex) => {
      const expectedTenant = expectedTenants[responseIndex]!;
      const sources = extractSources(response);
      assert(
        sources.every((source) => source.tenant === expectedTenant),
        `msearch response ${responseIndex} leaked across tenant ${expectedTenant}`,
      );
    });

    const update = jsonRequest(context, 'POST', `/${index}/_update/A%3A%3Aa-3?refresh=wait_for`, {
      doc: {
        text: 'alpha fresh-marker',
        rank: 35,
        updated_at: '2026-10-04T00:02:00Z',
      },
    });
    cache.clear();
    const fresh = search('A', 'fresh-marker', 1, 10);
    assert(
      fresh.ids.join(',') === 'a-3',
      `updated document was not fresh after refresh=wait_for: ${fresh.ids.join(',')}`,
    );
    const aReranked = search('A', 'alpha', 1, 3);
    assert(
      aReranked.ids[0] === 'a-3',
      `updated rank did not affect tenant-local order: ${aReranked.ids.join(',')}`,
    );

    const deletion = jsonRequest(context, 'DELETE', `/${index}/_doc/B%3A%3Ab-3?refresh=wait_for`);
    cache.clear();
    const bAfterDelete = search('B', 'alpha', 1, 10);
    assert(!bAfterDelete.ids.includes('b-3'), 'deleted tenant B document remained searchable');

    const stats = record(
      jsonRequest(
        context,
        'GET',
        `/${index}/_stats?filter_path=indices.*.primaries.docs,indices.*.primaries.indexing.index_total,indices.*.primaries.indexing.delete_total,indices.*.primaries.search.query_total,indices.*.primaries.store.size_in_bytes`,
      ).json,
      'tenant index stats',
    );
    const count = numberValue(
      record(jsonRequest(context, 'GET', `/${index}/_count`).json, 'tenant count').count,
      'tenant count',
    );
    assert(
      count === documents.length - 1,
      `tenant index count after delete was unexpected: ${count}`,
    );

    return [
      'scenario-2 authorization boundary: tenant term filter is inside the scored search request before results are exposed',
      `scenario-2 cache identity: ${aCold.key} and ${bCold.key}; poisoned cross-tenant cache rejected; exact warm hits pass`,
      `scenario-2 relevance goldens: tenant-A=${aCold.ids.join(',')}; tenant-B=${bCold.ids.join(',')}; page2=${aPage2.ids.join(',')}; empty-tenant=0`,
      `scenario-2 profiled tenant-filtered relevance: pass; profile-shards=${profiledShards}; engine-took=${record(profiled.json, 'profiled search').took}ms`,
      `scenario-2 batched authorization load: 40 alternating tenant searches passed; host-latency=${rounded(msearch.elapsedMs)}ms`,
      `scenario-2 freshness/update visibility: pass; refresh=wait_for host-latency=${rounded(update.elapsedMs)}ms; reranked=${aReranked.ids.join(',')}`,
      `scenario-2 delete visibility: pass; refresh=wait_for host-latency=${rounded(deletion.elapsedMs)}ms; remaining-count=${count}`,
      `scenario-2 cache latency evidence: cold-engine-took=${aCold.engineTook}ms; cold-host=${rounded(aCold.hostMs)}ms; warm-host=${rounded(aWarm.hostMs)}ms`,
      `scenario-2 index/search evidence: ${JSON.stringify(stats)}`,
    ];
  });
}

export const runSearchIndexAnalyzerRuntime = runSearchAnalyzerVersioningRuntime;
export const runSearchIndexTenantRuntime = runSearchTenantAuthorizationRuntime;
