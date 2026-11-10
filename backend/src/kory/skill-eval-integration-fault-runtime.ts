import { randomUUID } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export const INTEGRATION_FAULT_POSTGRES_IMAGE = 'postgres:17.5';
export const INTEGRATION_FAULT_TOXIPROXY_IMAGE = 'ghcr.io/shopify/toxiproxy:2.12.0';
export const INTEGRATION_FAULT_HTTP_IMAGE = 'node:22-bookworm';

export const INTEGRATION_FAULT_RUNTIME_BLOCKER =
  'Integration-fault full-task execution requires a working local Docker daemon plus the local postgres:17.5, ghcr.io/shopify/toxiproxy:2.12.0, and node:22-bookworm images. The harness stays blocked rather than substituting mocks when those real runtimes are unavailable.';

export interface IntegrationFaultRuntimeResult {
  passed: boolean;
  evidence: string;
}

type CommandResult = SpawnSyncReturns<string>;

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleep(milliseconds: number): void {
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function docker(args: string[], options?: { input?: string; timeout?: number }): CommandResult {
  return spawnSync('docker', args, {
    input: options?.input,
    encoding: 'utf8',
    timeout: options?.timeout ?? 20_000,
    maxBuffer: 4_000_000,
  }) as CommandResult;
}

function commandText(result: CommandResult): string {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
}

let dockerServerReady = false;
const readyImages = new Set<string>();

function dockerServerAvailable(): boolean {
  if (dockerServerReady) return true;
  const result = docker(['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 });
  dockerServerReady = result.status === 0 && result.stdout.trim().length > 0;
  return dockerServerReady;
}

function imageAvailable(image: string): boolean {
  if (readyImages.has(image)) return true;
  const available = docker(['image', 'inspect', image], { timeout: 15_000 }).status === 0;
  if (available) readyImages.add(image);
  return available;
}

function scenarioBlockers(images: readonly string[]): readonly string[] {
  if (!dockerServerAvailable()) return [INTEGRATION_FAULT_RUNTIME_BLOCKER];
  if (images.some((image) => !imageAvailable(image))) return [INTEGRATION_FAULT_RUNTIME_BLOCKER];
  return [];
}

export function integrationFaultScenario1Readiness(): readonly string[] {
  return scenarioBlockers([INTEGRATION_FAULT_POSTGRES_IMAGE, INTEGRATION_FAULT_TOXIPROXY_IMAGE]);
}

export function integrationFaultScenario2Readiness(): readonly string[] {
  return scenarioBlockers([INTEGRATION_FAULT_TOXIPROXY_IMAGE, INTEGRATION_FAULT_HTTP_IMAGE]);
}

export function integrationFaultRuntimeReadiness(): readonly string[] {
  return scenarioBlockers([
    INTEGRATION_FAULT_POSTGRES_IMAGE,
    INTEGRATION_FAULT_TOXIPROXY_IMAGE,
    INTEGRATION_FAULT_HTTP_IMAGE,
  ]);
}

function uniqueName(prefix: string): string {
  return prefix + randomUUID().replaceAll('-', '').slice(0, 12);
}

function requireSuccess(result: CommandResult, label: string): string {
  if (result.status !== 0) {
    throw new Error(label + ' failed: ' + commandText(result));
  }
  return result.stdout.trim();
}

function removeContainer(name: string): void {
  docker(['rm', '-f', name], { timeout: 5_000 });
}

function removeNetwork(name: string): void {
  docker(['network', 'rm', name], { timeout: 5_000 });
}

function hostPort(container: string, containerPort: number): number {
  const output = requireSuccess(
    docker(['port', container, `${containerPort}/tcp`], { timeout: 3_000 }),
    `docker port ${container}`,
  );
  const match = output.match(/:(\d+)\s*$/u);
  if (!match) throw new Error(`could not resolve mapped port from: ${output}`);
  return Number(match[1]);
}

function curl(
  port: number,
  path: string,
  options?: { method?: 'GET' | 'POST' | 'DELETE'; json?: unknown; timeout?: number },
): CommandResult {
  const args = [
    '-fsS',
    '--max-time',
    String(Math.max(1, Math.ceil((options?.timeout ?? 3_000) / 1_000))),
    '-X',
    options?.method ?? 'GET',
  ];
  if (options?.json !== undefined) {
    args.push(
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      JSON.stringify(options.json),
    );
  }
  args.push(`http://127.0.0.1:${port}${path}`);
  return spawnSync('curl', args, {
    encoding: 'utf8',
    timeout: options?.timeout ?? 3_000,
    maxBuffer: 1_000_000,
  }) as CommandResult;
}

function waitForToxiproxy(container: string): { controlPort: number; version: string } {
  let last = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const controlPort = hostPort(container, 8474);
      const version = curl(controlPort, '/version', { timeout: 1_000 });
      if (version.status === 0) {
        const raw = version.stdout.trim();
        let value = raw.replace(/^"|"$/gu, '');
        try {
          const parsed = JSON.parse(raw) as { version?: unknown };
          if (typeof parsed.version === 'string') value = parsed.version;
        } catch {
          // Older v2-compatible builds may return a bare version string.
        }
        if (/^2\./u.test(value)) return { controlPort, version: value };
        throw new Error(`Toxiproxy runtime is not v2-compatible: ${value || 'unknown version'}`);
      }
      last = commandText(version);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    sleep(50);
  }
  const state = docker(
    [
      'inspect',
      container,
      '--format',
      'running={{.State.Running}} exit={{.State.ExitCode}} error={{.State.Error}}',
    ],
    { timeout: 3_000 },
  );
  const logs = docker(['logs', '--tail', '80', container], { timeout: 3_000 });
  const diagnostics = [
    commandText(state) && `container state: ${commandText(state)}`,
    commandText(logs) && `container logs: ${commandText(logs)}`,
  ]
    .filter(Boolean)
    .join('\n');
  throw new Error(
    `Toxiproxy API did not become ready: ${last}${diagnostics ? `\n${diagnostics}` : ''}`,
  );
}

function createToxiproxy(
  network: string,
  name: string,
): { controlPort: number; version: string; imageIdentity: string; lifecycle: string } {
  requireSuccess(
    docker(
      [
        'create',
        '--name',
        name,
        '--network',
        network,
        '--network-alias',
        'toxiproxy',
        '-p',
        '127.0.0.1::8474',
        INTEGRATION_FAULT_TOXIPROXY_IMAGE,
      ],
      { timeout: 15_000 },
    ),
    'create retained Toxiproxy container',
  );

  const autoRemove = requireSuccess(
    docker(['inspect', name, '--format', '{{.HostConfig.AutoRemove}}'], { timeout: 3_000 }),
    'inspect Toxiproxy lifecycle',
  );
  if (autoRemove !== 'false') {
    throw new Error(
      `Toxiproxy container must be retained for startup diagnostics: AutoRemove=${autoRemove}`,
    );
  }

  const imageIdentity = requireSuccess(
    docker(['inspect', name, '--format', '{{.Image}}']),
    'inspect Toxiproxy image',
  );
  requireSuccess(
    docker(['start', name], { timeout: 15_000 }),
    'start retained Toxiproxy container',
  );
  const ready = waitForToxiproxy(name);
  return { ...ready, imageIdentity, lifecycle: 'retained container AutoRemove=false' };
}

function createProxy(
  controlPort: number,
  name: string,
  listenPort: number,
  upstream: string,
): void {
  requireSuccess(
    curl(controlPort, '/proxies', {
      method: 'POST',
      json: { name, listen: `0.0.0.0:${listenPort}`, upstream },
    }),
    `create Toxiproxy proxy ${name}`,
  );
}

function addResetPeerToxic(controlPort: number, proxy: string, toxic: string): void {
  requireSuccess(
    curl(controlPort, `/proxies/${proxy}/toxics`, {
      method: 'POST',
      json: {
        name: toxic,
        type: 'reset_peer',
        stream: 'downstream',
        toxicity: 1,
        attributes: { timeout: 0 },
      },
    }),
    `add reset_peer toxic ${toxic}`,
  );
}

function removeToxic(controlPort: number, proxy: string, toxic: string): void {
  requireSuccess(
    curl(controlPort, `/proxies/${proxy}/toxics/${toxic}`, { method: 'DELETE' }),
    `remove toxic ${toxic}`,
  );
}

function waitForPostgres(container: string): void {
  let last = '';
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const logs = docker(['logs', container], { timeout: 2_000 });
    const initialized = /PostgreSQL init process complete; ready for start up\./u.test(
      (logs.stdout ?? '') + (logs.stderr ?? ''),
    );
    const probe = docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], {
      timeout: 2_000,
    });
    if (initialized && probe.status === 0) return;
    last = [commandText(logs), commandText(probe)].filter(Boolean).join('\n');
    sleep(50);
  }
  throw new Error(`PostgreSQL did not become ready: ${last}`);
}

function psql(container: string, sql: string): string {
  return requireSuccess(
    docker([
      'exec',
      '-e',
      'PGPASSWORD=kory',
      container,
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      sql,
    ]),
    'PostgreSQL query',
  );
}

function waitForContainerFile(container: string, path: string, timeoutMs = 10_000): string {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const result = docker(['exec', container, 'sh', '-c', `test -f ${path} && cat ${path}`], {
      timeout: 2_000,
    });
    if (result.status === 0 && result.stdout.trim().length > 0) return result.stdout.trim();
    last = commandText(result);
    sleep(50);
  }
  throw new Error(`timed out waiting for ${path} in ${container}: ${last}`);
}

function startIdleContainer(name: string, network: string, image: string, alias?: string): void {
  const args = ['run', '--rm', '-d', '--name', name, '--network', network];
  if (alias) args.push('--network-alias', alias);
  args.push('--entrypoint', 'sh', image, '-c', 'while :; do sleep 3600; done');
  requireSuccess(docker(args, { timeout: 15_000 }), `start ${name}`);
}

function tailEvidence(value: string, limit = 800): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= limit ? normalized : normalized.slice(-limit);
}

export function runIntegrationFaultScenario1Runtime(): IntegrationFaultRuntimeResult {
  const blockers = integrationFaultScenario1Readiness();
  if (blockers.length > 0) return { passed: false, evidence: blockers.join('\n') };

  const network = uniqueName('kory-if-net-');
  const postgres = uniqueName('kory-if-pg-');
  const proxy = uniqueName('kory-if-tox-');
  const client = uniqueName('kory-if-client-');
  const appName = uniqueName('kory-if-s1-');
  const importKey = uniqueName('import-');
  const toxic = 'reset-after-first-child';
  let controlPort = 0;
  let toxicInstalled = false;

  try {
    requireSuccess(docker(['network', 'create', network]), 'create integration-fault network');
    requireSuccess(
      docker(
        [
          'run',
          '--rm',
          '-d',
          '--name',
          postgres,
          '--network',
          network,
          '--network-alias',
          'postgres',
          '--tmpfs',
          '/var/lib/postgresql/data:rw',
          '-e',
          'POSTGRES_PASSWORD=kory',
          '-e',
          'POSTGRES_INITDB_ARGS=--no-sync',
          INTEGRATION_FAULT_POSTGRES_IMAGE,
        ],
        { timeout: 15_000 },
      ),
      'start PostgreSQL',
    );
    waitForPostgres(postgres);

    const postgresVersion = psql(postgres, 'show server_version;');
    if (!/^17\.5(?:\s|\(|\.|$)/u.test(postgresVersion)) {
      throw new Error(`unexpected PostgreSQL runtime: ${postgresVersion}`);
    }
    const postgresIdentity = requireSuccess(
      docker(['inspect', postgres, '--format', '{{.Image}}']),
      'inspect PostgreSQL image',
    );

    const toxiproxy = createToxiproxy(network, proxy);
    controlPort = toxiproxy.controlPort;
    createProxy(controlPort, 'postgres', 15432, 'postgres:5432');
    startIdleContainer(client, network, INTEGRATION_FAULT_POSTGRES_IMAGE);

    psql(
      postgres,
      `CREATE TABLE import_headers(
         import_key text PRIMARY KEY,
         expected_children integer NOT NULL CHECK (expected_children > 0)
       );
       CREATE TABLE import_children(
         import_key text NOT NULL REFERENCES import_headers(import_key),
         ordinal integer NOT NULL,
         body text NOT NULL,
         PRIMARY KEY(import_key, ordinal)
       );`,
    );

    const initialState = psql(
      postgres,
      "select (select count(*) from import_headers)||'|'||(select count(*) from import_children);",
    );
    if (initialState !== '0|0') throw new Error(`scenario 1 did not start empty: ${initialState}`);

    const failedScript = `set +e
PGPASSWORD=kory PGAPPNAME=${appName} psql -X -v ON_ERROR_STOP=1 -h toxiproxy -p 15432 -U postgres -d postgres > /tmp/scenario1.out 2>&1 <<'SQL'
BEGIN;
INSERT INTO import_headers(import_key, expected_children) VALUES ('${importKey}', 2);
INSERT INTO import_children(import_key, ordinal, body) VALUES ('${importKey}', 1, 'first');
SELECT pg_advisory_xact_lock(731911), pg_sleep(3);
INSERT INTO import_children(import_key, ordinal, body) VALUES ('${importKey}', 2, 'second');
COMMIT;
SQL
status=$?
echo "$status" > /tmp/scenario1.status
exit 0`;
    requireSuccess(
      docker(['exec', '-d', client, 'sh', '-c', failedScript]),
      'start scenario 1 faulted import',
    );

    let checkpointObserved = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const checkpoint = psql(
        postgres,
        `select count(*)
         from pg_stat_activity a
         join pg_locks l on l.pid = a.pid
         where a.application_name = '${appName}'
           and a.state = 'active'
           and position('pg_sleep' in a.query) > 0
           and l.locktype = 'advisory'
           and l.granted;`,
      );
      if (checkpoint === '1') {
        checkpointObserved = true;
        break;
      }
      sleep(50);
    }
    if (!checkpointObserved) {
      throw new Error(
        'did not observe the after-first-child, before-COMMIT transaction checkpoint',
      );
    }

    addResetPeerToxic(controlPort, 'postgres', toxic);
    toxicInstalled = true;
    const failedStatus = Number(waitForContainerFile(client, '/tmp/scenario1.status', 8_000));
    const failedOutput = requireSuccess(
      docker(['exec', client, 'cat', '/tmp/scenario1.out']),
      'read scenario 1 caller output',
    );
    if (!Number.isInteger(failedStatus) || failedStatus === 0) {
      throw new Error(`faulted import did not report dependency failure: exit=${failedStatus}`);
    }

    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (
        psql(
          postgres,
          `select count(*) from pg_stat_activity where application_name='${appName}';`,
        ) === '0'
      ) {
        break;
      }
      if (attempt === 59) throw new Error('faulted PostgreSQL transaction connection stayed alive');
      sleep(50);
    }

    const failedState = psql(
      postgres,
      `select
         (select count(*) from import_headers where import_key='${importKey}')||'|'||
         (select count(*) from import_children where import_key='${importKey}');`,
    );
    if (failedState !== '0|0') {
      throw new Error(`faulted import left durable partial state: ${failedState}`);
    }

    removeToxic(controlPort, 'postgres', toxic);
    toxicInstalled = false;

    const readiness = docker([
      'exec',
      '-e',
      'PGPASSWORD=kory',
      client,
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      'toxiproxy',
      '-p',
      '15432',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      'select 1;',
    ]);
    if (readiness.status !== 0 || readiness.stdout.trim() !== '1') {
      throw new Error(
        `PostgreSQL was not ready through the recovered proxy: ${commandText(readiness)}`,
      );
    }

    const recoveredScript = `BEGIN;
INSERT INTO import_headers(import_key, expected_children) VALUES ('${importKey}', 2);
INSERT INTO import_children(import_key, ordinal, body) VALUES ('${importKey}', 1, 'first');
INSERT INTO import_children(import_key, ordinal, body) VALUES ('${importKey}', 2, 'second');
COMMIT;`;
    const recovered = docker([
      'exec',
      '-e',
      'PGPASSWORD=kory',
      client,
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      'toxiproxy',
      '-p',
      '15432',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      recoveredScript,
    ]);
    if (recovered.status !== 0) {
      throw new Error(`recovered import failed: ${commandText(recovered)}`);
    }

    const recoveredState = psql(
      postgres,
      `select
         (select count(*) from import_headers where import_key='${importKey}')||'|'||
         (select count(*) from import_children where import_key='${importKey}')||'|'||
         (select expected_children from import_headers where import_key='${importKey}');`,
    );
    if (recoveredState !== '1|2|2') {
      throw new Error(`recovered import was not exactly one complete import: ${recoveredState}`);
    }

    return {
      passed: true,
      evidence: [
        `PostgreSQL runtime: ${postgresVersion}; image=${postgresIdentity}`,
        `Toxiproxy runtime: ${toxiproxy.version}; image=${toxiproxy.imageIdentity}`,
        `Toxiproxy lifecycle: ${toxiproxy.lifecycle}`,
        'scenario 1 start state: headers=0 children=0',
        'scenario 1 fault placement: observed active advisory checkpoint after child insert 1 and before COMMIT',
        'scenario 1 reset configuration: reset_peer downstream timeout=0',
        `scenario 1 caller-visible dependency failure: exit=${failedStatus}; ${tailEvidence(failedOutput)}`,
        'scenario 1 independent failed state: headers=0 children=0',
        'scenario 1 toxic removal and PostgreSQL readiness through proxy: pass',
        'scenario 1 independent recovered state: headers=1 children=2 expected_children=2',
        'scenario 1 exactly one complete recovered import: pass',
      ].join('\n'),
    };
  } catch (error) {
    return {
      passed: false,
      evidence: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (toxicInstalled && controlPort > 0) {
      curl(controlPort, `/proxies/postgres/toxics/${toxic}`, { method: 'DELETE', timeout: 1_000 });
    }
    removeContainer(client);
    removeContainer(proxy);
    removeContainer(postgres);
    removeNetwork(network);
  }
}

const dependencyServerSource = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = '/data';
fs.mkdirSync(dataDir, { recursive: true });

function safeKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : null;
}

function dispatchPath(key) {
  return path.join(dataDir, 'dispatch-' + key + '.json');
}

function commitDispatch(key, payload) {
  const target = dispatchPath(key);
  const serialized = JSON.stringify({ key, payload });
  try {
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.writeFileSync(path.join(dataDir, 'commit-' + key), 'committed\n', 'utf8');
    return { created: true, row: JSON.parse(serialized) };
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    const row = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (JSON.stringify(row.payload) !== JSON.stringify(payload)) {
      return { created: false, conflict: true, row };
    }
    return { created: false, conflict: false, row };
  }
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/dispatch') {
    response.writeHead(404);
    response.end();
    return;
  }

  const key = safeKey(request.headers['idempotency-key']);
  if (!key) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'invalid idempotency key' }));
    return;
  }

  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }

    const result = commitDispatch(key, payload);
    const delay = Math.min(5000, Math.max(0, Number(request.headers['x-kory-response-delay-ms'] || 0)));
    setTimeout(() => {
      if (result.conflict) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'idempotency-conflict', key }));
        return;
      }
      response.writeHead(result.created ? 201 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: result.created ? 'created' : 'duplicate', key }));
    }, delay);
  });
});

server.listen(8080, '0.0.0.0');
`;

function nodeFetchScript(
  url: string,
  key: string,
  payload: string,
  delayMs: number,
  outputPath?: string,
): string {
  const write = outputPath
    ? `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(result));`
    : 'console.log(JSON.stringify(result));';
  return `
(async () => {
  let result;
  try {
    const response = await fetch(${JSON.stringify(url)}, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': ${JSON.stringify(key)},
        'x-kory-response-delay-ms': ${JSON.stringify(String(delayMs))},
      },
      body: ${JSON.stringify(payload)},
      signal: AbortSignal.timeout(7000),
    });
    result = { kind: 'response', status: response.status, body: await response.text() };
  } catch (error) {
    result = { kind: 'uncertain', name: error?.name ?? 'Error', message: error?.message ?? String(error) };
  }
  ${write}
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

function inspectDispatches(container: string): Array<{ key: string; payload: unknown }> {
  const script = `
const fs = require('node:fs');
const rows = fs.readdirSync('/data')
  .filter((name) => name.startsWith('dispatch-') && name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(fs.readFileSync('/data/' + name, 'utf8')));
console.log(JSON.stringify(rows));
`;
  const output = requireSuccess(
    docker(['exec', container, 'node', '-e', script]),
    'inspect committed dispatch records',
  );
  return JSON.parse(output) as Array<{ key: string; payload: unknown }>;
}

function runNodeFetch(
  container: string,
  script: string,
  label: string,
): {
  kind: string;
  status?: number;
  body?: string;
  name?: string;
  message?: string;
} {
  const output = requireSuccess(
    docker(['exec', container, 'node', '-e', script], { timeout: 10_000 }),
    label,
  );
  return JSON.parse(output) as {
    kind: string;
    status?: number;
    body?: string;
    name?: string;
    message?: string;
  };
}

export function runIntegrationFaultScenario2Runtime(): IntegrationFaultRuntimeResult {
  const blockers = integrationFaultScenario2Readiness();
  if (blockers.length > 0) return { passed: false, evidence: blockers.join('\n') };

  const network = uniqueName('kory-if-net-');
  const proxy = uniqueName('kory-if-tox-');
  const dependency = uniqueName('kory-if-http-');
  const client = uniqueName('kory-if-client-');
  const stableKey = uniqueName('dispatch-');
  const freshKey = uniqueName('dispatch-');
  const toxic = 'reset-after-dispatch-commit';
  const payload = JSON.stringify({ orderId: 'order-42', destination: 'warehouse-a' });
  let controlPort = 0;
  let toxicInstalled = false;

  try {
    requireSuccess(docker(['network', 'create', network]), 'create integration-fault network');
    requireSuccess(
      docker(
        [
          'run',
          '--rm',
          '-d',
          '--name',
          dependency,
          '--network',
          network,
          '--network-alias',
          'dependency',
          INTEGRATION_FAULT_HTTP_IMAGE,
          'node',
          '-e',
          dependencyServerSource,
        ],
        { timeout: 15_000 },
      ),
      'start synthetic fulfillment dependency',
    );
    startIdleContainer(client, network, INTEGRATION_FAULT_HTTP_IMAGE);

    const nodeVersion = requireSuccess(
      docker(['exec', dependency, 'node', '--version']),
      'read synthetic dependency runtime version',
    );
    const dependencyIdentity = requireSuccess(
      docker(['inspect', dependency, '--format', '{{.Image}}']),
      'inspect synthetic dependency image',
    );

    const toxiproxy = createToxiproxy(network, proxy);
    controlPort = toxiproxy.controlPort;
    createProxy(controlPort, 'dispatch', 18080, 'dependency:8080');

    let dependencyReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const probe = docker(
        [
          'exec',
          client,
          'node',
          '-e',
          "fetch('http://toxiproxy:18080/health').then(r=>{if(!r.ok)process.exit(2)}).catch(()=>process.exit(3))",
        ],
        { timeout: 2_000 },
      );
      if (probe.status === 0) {
        dependencyReady = true;
        break;
      }
      sleep(50);
    }
    if (!dependencyReady)
      throw new Error('synthetic dependency did not become ready through Toxiproxy');

    const firstResultPath = '/tmp/scenario2-first.json';
    const firstScript = nodeFetchScript(
      'http://toxiproxy:18080/dispatch',
      stableKey,
      payload,
      3_000,
      firstResultPath,
    );
    requireSuccess(
      docker(['exec', '-d', client, 'node', '-e', firstScript]),
      'start scenario 2 ambiguous dispatch',
    );

    const commitMarker = waitForContainerFile(dependency, `/data/commit-${stableKey}`, 5_000);
    if (commitMarker !== 'committed') {
      throw new Error(`unexpected commit marker before response cut: ${commitMarker}`);
    }
    const committedBeforeCut = inspectDispatches(dependency);
    if (committedBeforeCut.length !== 1 || committedBeforeCut[0]?.key !== stableKey) {
      throw new Error(
        `dispatch was not durably committed before response cut: ${JSON.stringify(committedBeforeCut)}`,
      );
    }

    addResetPeerToxic(controlPort, 'dispatch', toxic);
    toxicInstalled = true;
    const firstResultRaw = waitForContainerFile(client, firstResultPath, 8_000);
    const firstResult = JSON.parse(firstResultRaw) as {
      kind: string;
      status?: number;
      message?: string;
    };
    if (firstResult.kind !== 'uncertain') {
      throw new Error(`first dispatch falsely produced a confirmed response: ${firstResultRaw}`);
    }
    const afterCut = inspectDispatches(dependency);
    if (afterCut.filter((row) => row.key === stableKey).length !== 1 || afterCut.length !== 1) {
      throw new Error(`response cut changed durable dispatch count: ${JSON.stringify(afterCut)}`);
    }

    removeToxic(controlPort, 'dispatch', toxic);
    toxicInstalled = false;

    const recoveredHealth = docker(
      [
        'exec',
        client,
        'node',
        '-e',
        "fetch('http://toxiproxy:18080/health').then(async r=>{console.log(r.status); if(!r.ok)process.exit(2)}).catch(()=>process.exit(3))",
      ],
      { timeout: 5_000 },
    );
    if (recoveredHealth.status !== 0 || recoveredHealth.stdout.trim() !== '200') {
      throw new Error(
        `synthetic dependency was not ready after toxic removal: ${commandText(recoveredHealth)}`,
      );
    }

    const replay = runNodeFetch(
      client,
      nodeFetchScript('http://toxiproxy:18080/dispatch', stableKey, payload, 0),
      'replay stable idempotency key',
    );
    if (
      replay.kind !== 'response' ||
      replay.status !== 200 ||
      !replay.body?.includes('"status":"duplicate"')
    ) {
      throw new Error(`same-key replay was not duplicate-safe: ${JSON.stringify(replay)}`);
    }
    const afterReplay = inspectDispatches(dependency);
    if (
      afterReplay.filter((row) => row.key === stableKey).length !== 1 ||
      afterReplay.length !== 1
    ) {
      throw new Error(`same-key replay duplicated durable state: ${JSON.stringify(afterReplay)}`);
    }

    const fresh = runNodeFetch(
      client,
      nodeFetchScript('http://toxiproxy:18080/dispatch', freshKey, payload, 0),
      'dispatch fresh idempotency key',
    );
    if (
      fresh.kind !== 'response' ||
      fresh.status !== 201 ||
      !fresh.body?.includes('"status":"created"')
    ) {
      throw new Error(`fresh-key request did not succeed after recovery: ${JSON.stringify(fresh)}`);
    }
    const finalRows = inspectDispatches(dependency);
    const stableCount = finalRows.filter((row) => row.key === stableKey).length;
    const freshCount = finalRows.filter((row) => row.key === freshKey).length;
    if (finalRows.length !== 2 || stableCount !== 1 || freshCount !== 1) {
      throw new Error(
        `final dispatch state violated idempotency/recovery invariants: ${JSON.stringify(finalRows)}`,
      );
    }

    return {
      passed: true,
      evidence: [
        `Synthetic dependency runtime: ${nodeVersion}; image=${dependencyIdentity}`,
        `Toxiproxy runtime: ${toxiproxy.version}; image=${toxiproxy.imageIdentity}`,
        `Toxiproxy lifecycle: ${toxiproxy.lifecycle}`,
        'scenario 2 start state: dispatches=0',
        `scenario 2 commit-before-cut evidence: key=${stableKey} fsync-complete marker observed; durable count=1`,
        'scenario 2 reset configuration: reset_peer downstream timeout=0 after commit marker and before delayed response',
        `scenario 2 caller-visible uncertain result: ${tailEvidence(firstResultRaw)}`,
        'scenario 2 independent post-cut state: stable-key dispatches=1 total=1',
        'scenario 2 toxic removal and dependency readiness through proxy: pass',
        'scenario 2 same-key replay: HTTP 200 duplicate; stable-key dispatches=1 total=1',
        'scenario 2 fresh-key recovery: HTTP 201 created; stable-key=1 fresh-key=1 total=2',
      ].join('\n'),
    };
  } catch (error) {
    return {
      passed: false,
      evidence: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (toxicInstalled && controlPort > 0) {
      curl(controlPort, `/proxies/dispatch/toxics/${toxic}`, { method: 'DELETE', timeout: 1_000 });
    }
    removeContainer(client);
    removeContainer(proxy);
    removeContainer(dependency);
    removeNetwork(network);
  }
}
