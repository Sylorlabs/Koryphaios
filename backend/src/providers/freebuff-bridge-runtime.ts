import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import type { CliMcpServerConfig } from './cli-bridge';
import { readBridgeGrantScopeFromFile } from './bridge-grant';
import { BRIDGE_CATALOG_TIMEOUT_MS, BRIDGE_EXECUTE_TIMEOUT_MS } from './kory-mcp-bridge';
import { isCompiledStandalone } from '../runtime/standalone';

const CATALOG = '/api/v1/mcp-bridge/catalog';
const EXECUTE = '/api/v1/mcp-bridge/execute';
export const FREEBUFF_RELAY_BODY_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const RELAY_LIFETIME_MS = 10 * 60_000;
const SIGNED_HEADERS = [
  'x-kory-bridge-grant',
  'x-kory-bridge-timestamp',
  'x-kory-bridge-nonce',
  'x-kory-bridge-signature',
] as const;

/** Never resolve a caller-selected network target or forward a URL supplied in
 * a request. Even a server configured on all interfaces is reached on loopback. */
function loopbackBackend(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !['127.0.0.1', 'localhost', '[::1]', '0.0.0.0', '[::]'].includes(url.hostname)
  ) {
    throw new Error('Freebuff bridge requires a fixed loopback HTTP backend');
  }
  if (url.hostname === 'localhost' || url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  if (url.hostname === '[::]') url.hostname = '[::1]';
  return url.origin;
}

function authorizedToken(value: string | string[] | undefined, expected: Buffer): boolean {
  if (typeof value !== 'string') return false;
  const received = Buffer.from(value);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(JSON.stringify({ error: 'Bridge relay request rejected' }));
}

export interface FreebuffBridgeRelay {
  /** Host-loopback URL for tests; Docker uses the same port at hostGateway. */
  url: string;
  token: string;
  cleanup(): Promise<void>;
}

/** A relay is NOT a new authorization authority: the original backend still
 * verifies the nonce-bound signature, session, role, workspace, action and
 * permissions. This listener requires an additional per-turn secret, pins the
 * grant id, and never forwards cookies, authorization, redirects or other APIs. */
export async function createFreebuffBridgeRelay(options: {
  backendUrl: string;
  grantId: string;
  signal?: AbortSignal;
}): Promise<FreebuffBridgeRelay> {
  options.signal?.throwIfAborted();
  const backend = loopbackBackend(options.backendUrl);
  if (!options.grantId) throw new Error('Freebuff bridge relay requires a grant');
  const token = randomBytes(32).toString('base64url');
  const expectedToken = Buffer.from(token);
  const requests = new Set<AbortController>();
  let active = 0;
  let closed = false;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (closed) return reply(response, 503);
    if (!authorizedToken(request.headers['x-kory-bridge-relay'], expectedToken))
      return reply(response, 401);
    // Compare the raw request target. URL normalization must not open aliases,
    // encoded paths, queries, absolute proxy targets or traversal variants.
    const path = request.url;
    if (request.method !== 'POST' || (path !== CATALOG && path !== EXECUTE))
      return reply(response, 404);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const name of SIGNED_HEADERS) {
      const value = request.headers[name];
      if (typeof value !== 'string' || !value || value.length > 256) return reply(response, 401);
      headers[name] = value;
    }
    if (
      headers['x-kory-bridge-grant'] !== options.grantId ||
      !/^\d{13}$/.test(headers['x-kory-bridge-timestamp']) ||
      !/^[A-Za-z0-9_-]{24}$/.test(headers['x-kory-bridge-nonce']) ||
      !/^[A-Za-z0-9_-]{43}$/.test(headers['x-kory-bridge-signature'])
    )
      return reply(response, 401);
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? '')))
      return reply(response, 415);
    if (Number(request.headers['content-length'] ?? 0) > FREEBUFF_RELAY_BODY_LIMIT)
      return reply(response, 413);
    if (active >= 16) return reply(response, 429);
    active++;
    const controller = new AbortController();
    requests.add(controller);
    // Reading a slow body cannot borrow the longer human-approval deadline.
    const bodyTimer = setTimeout(() => {
      controller.abort();
      request.destroy();
    }, BRIDGE_CATALOG_TIMEOUT_MS);
    const deadline = setTimeout(
      () => controller.abort(),
      path === CATALOG ? BRIDGE_CATALOG_TIMEOUT_MS : BRIDGE_EXECUTE_TIMEOUT_MS,
    );
    const disconnected = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.on('close', disconnected);
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > FREEBUFF_RELAY_BODY_LIMIT) {
          reply(response, 413);
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      clearTimeout(bodyTimer);
      const body = Buffer.concat(chunks);
      // Reject malformed JSON before forwarding, but do not rewrite signed
      // request bodies or decide session/role scope on the client's behalf.
      try {
        JSON.parse(body.toString('utf8'));
      } catch {
        reply(response, 400);
        return;
      }
      const upstream = await fetch(`${backend}${path}`, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      if (Number(upstream.headers.get('content-length') ?? 0) > RESPONSE_LIMIT) {
        await upstream.body?.cancel();
        reply(response, 502);
        return;
      }
      const reader = upstream.body?.getReader();
      const output: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > RESPONSE_LIMIT) {
            await reader.cancel();
            reply(response, 502);
            return;
          }
          output.push(next.value);
        }
      }
      response.writeHead(upstream.status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(Buffer.concat(output));
    } catch {
      if (!response.headersSent && !response.destroyed)
        reply(response, controller.signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(bodyTimer);
      clearTimeout(deadline);
      response.off('close', disconnected);
      requests.delete(controller);
      active--;
    }
  };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    // Drain rejected uploads without buffering so a sender is not left blocked
    // while the small rejection response waits behind its request body.
    void handle(request, response)
      .finally(() => {
        if (!request.complete) request.resume();
      })
      .catch(() => {
        request.destroy();
        response.destroy();
      });
  });
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = BRIDGE_CATALOG_TIMEOUT_MS;
  server.maxHeadersCount = 32;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    // Colima forwards host.docker.internal to the host network, not loopback.
    // This is intentionally only this token-protected, fixed-route listener.
    server.listen(0, '0.0.0.0', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Bridge relay listener unavailable');
  }
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    closed = true;
    clearTimeout(lifetime);
    options.signal?.removeEventListener('abort', abort);
    for (const request of requests) request.abort();
    cleanupPromise = new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    return cleanupPromise;
  };
  const abort = () => {
    void cleanup();
  };
  const lifetime = setTimeout(abort, RELAY_LIFETIME_MS);
  lifetime.unref();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) {
    await cleanup();
    options.signal.throwIfAborted();
  }
  return { url: `http://127.0.0.1:${address.port}`, token, cleanup };
}

export interface PrepareFreebuffBridgeOptions {
  runRoot: string;
  servers: CliMcpServerConfig[];
  bunBinary: string;
  runtimeKind: 'native' | 'docker';
  hostGateway?: string;
  signal?: AbortSignal;
}

export interface PreparedFreebuffBridge {
  servers: CliMcpServerConfig[];
  readyPath: string;
  probeArgs: string[];
  cleanup(): Promise<void>;
}

/** How the turn-private bridge bundle is produced for `dir`:
 * - `prebuilt` set → copy that shipped sibling bundle (bundled backend layout,
 *   where only `kory-mcp-bridge.js` exists next to `server.js`).
 * - `prebuilt` unset → `bun build` `source` (dev/source layout).
 * The compiled-standalone guard rejects `/$bunfs` before this is consulted. */
export function freebuffBridgeStagePlan(dir: string): {
  source: string;
  prebuilt?: string;
} {
  const source = join(dir, 'kory-mcp-bridge.ts');
  const prebuilt = join(dir, 'kory-mcp-bridge.js');
  return existsSync(source)
    ? { source }
    : { source, prebuilt: existsSync(prebuilt) ? prebuilt : undefined };
}

/** Stage a single self-contained JS bundle plus a grant in the only mounted
 * per-turn root. No project checkout, node_modules or host runtime mounts. */
export async function prepareFreebuffBridge(
  options: PrepareFreebuffBridgeOptions,
): Promise<PreparedFreebuffBridge> {
  options.signal?.throwIfAborted();
  if (
    options.servers.length !== 1 ||
    options.servers[0].name !== 'kory' ||
    options.servers[0].transport !== 'stdio'
  ) {
    throw new Error('Freebuff requires exactly the Kory stdio bridge');
  }
  const server = options.servers[0];
  const authSource = server.env?.KORY_BRIDGE_AUTH_FILE;
  if (!authSource) throw new Error('Kory bridge grant is missing');
  readBridgeGrantScopeFromFile(authSource); // Validate private file, owner and expiry before copying.
  const backend = loopbackBackend(server.env?.KORY_BACKEND_URL ?? 'http://127.0.0.1:3001');
  const root = resolve(options.runRoot);
  const rootStat = lstatSync(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())
  )
    throw new Error('Freebuff turn root must be private');
  const directory = join(root, 'bridge');
  // Do not follow an existing attacker-controlled staging directory.
  mkdirSync(directory, { mode: 0o700 });
  let relay: FreebuffBridgeRelay | undefined;
  const cleanup = async () => {
    await relay?.cleanup();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const grantPath = join(directory, 'grant.json');
    copyFileSync(authSource, grantPath);
    chmodSync(grantPath, 0o600);
    const readyPath = join(directory, 'ready.json');
    const env: Record<string, string> = {
      KORY_BACKEND_URL: backend,
      KORY_BRIDGE_AUTH_FILE: grantPath,
      KORY_BRIDGE_READY_FILE: readyPath,
    };
    if (options.runtimeKind === 'docker') {
      if (options.hostGateway && options.hostGateway !== 'host.docker.internal')
        throw new Error('Unsupported Freebuff Docker host gateway');
      const grantId = (JSON.parse(readFileSync(grantPath, 'utf8')) as { grantId: string }).grantId;
      relay = await createFreebuffBridgeRelay({
        backendUrl: backend,
        grantId,
        signal: options.signal,
      });
      env.KORY_BACKEND_URL = relay.url.replace('127.0.0.1', 'host.docker.internal');
      env.KORY_BRIDGE_RELAY_TOKEN = relay.token;
    }
    // A compiled backend has no bridge source under import.meta.dir — Bun's
    // virtual root cannot feed `bun build` — so staging the sandbox bridge
    // would fail as an opaque build error. Fail closed with the real reason.
    if (isCompiledStandalone()) {
      throw new Error(
        'Freebuff managed turns are unavailable in the packaged backend: the compiled binary cannot restage the Kory bridge source for the Linux sandbox.',
      );
    }
    const stagedBundle = join(directory, 'kory-mcp-bridge.js');
    const stage = freebuffBridgeStagePlan(import.meta.dir);
    if (stage.prebuilt) {
      // The bundled backend ships the bridge as a sibling bundle — the exact
      // artifact `bun build` would produce from source — so stage it directly.
      copyFileSync(stage.prebuilt, stagedBundle);
    } else {
      // Use a fresh bundler process: Bun's in-process build cache can retain
      // stale source descriptors across repeated turns after stdio child cleanup.
      const build = Bun.spawn(
        [
          process.execPath,
          'build',
          stage.source,
          '--target=bun',
          '--format=esm',
          '--minify',
          '--outfile',
          stagedBundle,
        ],
        {
          env: { PATH: '/usr/bin:/bin' },
          stdout: 'ignore',
          stderr: 'ignore',
        },
      );
      const cancelBuild = () => {
        build.kill();
      };
      options.signal?.addEventListener('abort', cancelBuild, { once: true });
      const buildDeadline = setTimeout(cancelBuild, BRIDGE_CATALOG_TIMEOUT_MS);
      try {
        if ((await build.exited) !== 0) throw new Error('Unable to stage standalone Kory bridge');
      } finally {
        clearTimeout(buildDeadline);
        options.signal?.removeEventListener('abort', cancelBuild);
      }
    }
    chmodSync(stagedBundle, 0o600);
    const configPath = join(directory, 'environment.json');
    writeFileSync(configPath, JSON.stringify(env), { mode: 0o600 });
    const runner = join(directory, 'run.js');
    // Config contents are never placed in process argv or inherited host env.
    writeFileSync(
      runner,
      `import { readFileSync } from 'node:fs';\nimport { runBridge } from './kory-mcp-bridge.js';\nconst env = JSON.parse(readFileSync(new URL('./environment.json', import.meta.url), 'utf8'));\ndelete process.env.KORY_BRIDGE_RELAY_TOKEN;\nObject.assign(process.env, env);\ntry { await runBridge(); } catch { process.stderr.write('[kory-mcp-bridge] startup failed\\n'); process.exitCode = 1; }\n`,
      { mode: 0o600 },
    );
    options.signal?.throwIfAborted();
    return {
      servers: [
        { name: 'kory', command: options.bunBinary, args: [runner], env: {}, transport: 'stdio' },
      ],
      readyPath,
      probeArgs: [runner, '--probe'],
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
