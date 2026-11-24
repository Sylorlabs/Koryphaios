#!/usr/bin/env bun
/**
 * Credential-free integration benchmark. Run `bun run build:frontend:static`
 * first, then `bun scripts/benchmark-harness.ts --output outputs/harness.json`.
 * Real production frontend + real source backend + disposable SQLite/HOME.
 * Provider output alone is synthetic (injected through the browser WS boundary).
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, arch, cpus, loadavg, freemem, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium, type WebSocketRoute, type Page } from 'playwright';
import { createIsolatedTestEnvironment } from './test-backend-isolated';
import { injectAuthIntoPage } from '../e2e/helpers/auth';
import { hostOS, isUnix } from '../backend/src/runtime/platform';

const root = resolve(import.meta.dir, '..');
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]?.endsWith('.json')) {
  throw new Error('--output requires a .json path');
}
const output = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : 'outputs/harness.json');
const deadlineIndex = process.argv.indexOf('--deadline-ms');
const deadlineMs = deadlineIndex >= 0 ? Number(process.argv[deadlineIndex + 1]) : 180_000;
if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 180_000) {
  throw new Error('--deadline-ms must be between 1 and 180000');
}
const port = 39323;
const origin = `http://127.0.0.1:${port}`;
const smoke = process.argv.includes('--smoke');
const sessions = smoke ? 8 : 40;
const messagesPerSession = 120;
const rounds = smoke ? 1 : 3;
const streamBatches = smoke ? 30 : 300;
const profiling = process.argv.includes('--profile');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0;
  return { count: values.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};
if (!existsSync(join(root, 'frontend/build/client/index.html'))) {
  throw new Error('Run bun run build:frontend:static first');
}
// Refuse to use an already-running service, including another benchmark.
await new Promise<void>((done, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close((error) => (error ? reject(error) : done())));
});
const temp = mkdtempSync(join(tmpdir(), 'kory-harness-benchmark-'));
const home = join(temp, 'home');
const workspace = join(temp, 'project');
mkdirSync(join(home, 'tmp'), { recursive: true });
mkdirSync(workspace);
mkdirSync(join(temp, 'data'), { mode: 0o700 });
const databasePath = join(temp, 'data', 'benchmark.db');
const environment = createIsolatedTestEnvironment({}, home);
Object.assign(environment, {
  PATH: process.env.PATH,
  NODE_ENV: 'test', // Disposable local KMS is intentionally forbidden in production.
  KORY_BENCHMARK_CHILD: '1',
  KORYPHAIOS_HOST: '127.0.0.1',
  KORYPHAIOS_PORT: String(port),
  PROJECT_ROOT: workspace,
  DATABASE_URL: `sqlite:${databasePath}`,
  KORYPHAIOS_FRONTEND_DIST: join(root, 'frontend/build/client'),
});
let phase = 'startup';
const samples: Array<{ phase: string; rss: number; heapUsed: number; timerDelayMs: number }> = [];
const report: Record<string, unknown> = {
  completed: false,
  startedAt: new Date().toISOString(),
  revision: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(),
  dirtyWorktree: Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root }).stdout.length > 0,
  frontendEntrySha256: new Bun.CryptoHasher('sha256')
    .update(await Bun.file(join(root, 'frontend/build/client/index.html')).arrayBuffer())
    .digest('hex'),
  bun: Bun.version,
  platform: hostOS(),
  arch: arch(),
  host: {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    loadAverage: loadavg(),
    freeMiB: freemem() / 1048576,
    totalMiB: totalmem() / 1048576,
  },
  workload: {
    sessions,
    messagesPerSession,
    rounds,
    streamBatches,
    deadlineMs,
    syntheticProvider: true,
    profiling,
    backendMode: 'source, NODE_ENV=test',
  },
  budgets: {
    apiP95Ms: 100,
    switchP95Ms: 250,
    inputP95Ms: 100,
    backendPeakMiB: 512,
    rendererHeapPeakMiB: 512,
  },
};
const backend = Bun.spawn(
  [process.execPath, '--no-env-file', join(import.meta.dir, 'benchmark-harness-server.ts')],
  {
    cwd: workspace,
    env: environment,
    stdout: 'ignore',
    stderr: 'pipe',
    ipc(message) {
      if (message?.kind === 'sample') samples.push({ phase, ...message });
    },
  },
);
let errorTail = '';
const drain = (async () => {
  for await (const chunk of backend.stderr)
    errorTail = (errorTail + new TextDecoder().decode(chunk)).slice(-16_384);
})();
let deadlineExceeded = false;
const cutoff = setTimeout(() => {
  deadlineExceeded = true;
  backend.kill('SIGKILL');
  void activePage?.close().catch(() => {});
}, deadlineMs);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let activePage: Page | undefined;
let token = '';
async function api(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  if (deadlineExceeded) throw new Error('Benchmark deadline exceeded');
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  return response.json();
}

try {
  const startup = performance.now();
  while (performance.now() - startup < 30_000) {
    if (deadlineExceeded) throw new Error('Benchmark deadline exceeded during startup');
    if (backend.exitCode !== null) throw new Error(`Backend startup failed: ${errorTail}`);
    try {
      await api('/api/health');
      break;
    } catch {
      await sleep(100);
    }
  }
  await api('/api/health');
  report.startupMs = performance.now() - startup;
  token = (await api('/api/auth/session', {})).data.bearerToken;
  phase = 'idle';
  await sleep(5_000);
  phase = 'seed';
  const ids: string[] = [];
  for (let s = 0; s < sessions; s++) {
    ids.push(
      (await api('/api/sessions', { title: `Stress chat ${s}`, workingDirectory: workspace })).data
        .id,
    );
  }
  const db = new Database(databasePath);
  try {
    const insert =
      db.prepare(`INSERT INTO messages (id, session_id, role, content, cost, created_at,
      variant_index, context_revision, parent_message_id) VALUES (?, ?, ?, ?, 0, ?, 0, 0, ?)`);
    const update = db.prepare(
      'UPDATE sessions SET active_message_id = ?, message_count = ?, updated_at = ? WHERE id = ?',
    );
    db.transaction(() => {
      for (let s = 0; s < sessions; s++) {
        let previousId: string | null = null;
        for (let m = 0; m < messagesPerSession; m++) {
          const id = `bench-${s}-${m}`;
          const text =
            `BENCHMARK-${s}-${m}\n\n` +
            (m % 2
              ? '## Measured result\n\nA reproducible paragraph with **formatting** and `inline code`.\n\n```ts\nconst result = 42;\n```\n\n'.repeat(
                  24,
                )
              : 'Inspect this fixture and explain the result.');
          insert.run(
            id,
            ids[s],
            m % 2 ? 'assistant' : 'user',
            JSON.stringify([{ type: 'text', text }]),
            Date.now() - 100_000 + m,
            previousId,
          );
          previousId = id;
        }
        update.run(previousId, messagesPerSession, Date.now(), ids[s]);
      }
    })();
  } finally {
    db.close();
  }

  // Bounded concurrent real history reads; no provider generation endpoint.
  phase = 'api';
  const apiRounds = [];
  for (let r = 0; r < rounds; r++) {
    const latencies: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, async (_, lane) => {
        for (let i = 0; i < 30; i++) {
          const start = performance.now();
          const body = await api(`/api/messages/${ids[(lane * 30 + i) % sessions]}`);
          if (!body.data.messages.length) throw new Error('History workload returned no messages');
          latencies.push(performance.now() - start);
        }
      }),
    );
    apiRounds.push(stats(latencies));
  }
  report.apiLatencyMs = apiRounds;
  console.log('API', JSON.stringify(apiRounds));

  phase = 'browser-launch';
  browser = await chromium.launch({ headless: true, timeout: 15_000 });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // No network beyond this benchmark's loopback origin from the browser.
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  report.pageErrors = pageErrors;
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws*', (ws) => {
    socket = ws;
    ws.connectToServer(); // Keep real subscriptions, auth, and server events.
  });
  await injectAuthIntoPage(page, token);
  await page.addInitScript(() => {
    const metrics = { frames: [] as number[], longTasks: [] as number[], last: performance.now() };
    (window as any).__harnessMetrics = metrics;
    const frame = (now: number) => {
      if (metrics.frames.length < 20_000) metrics.frames.push(now - metrics.last);
      metrics.last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (metrics.longTasks.length < 2_000) metrics.longTasks.push(entry.duration);
      }
    }).observe({ type: 'longtask' });
  });
  const cdp = await context.newCDPSession(page);
  const browserCdp = await browser.newBrowserCDPSession();
  await cdp.send('Performance.enable');
  const checkpoints: unknown[] = [];
  report.browserCheckpoints = checkpoints;
  async function checkpoint(name: string) {
    const values = Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
    );
    // PIDs come from this browser's own CDP connection, not from name matching
    // that would accidentally count the user's other browser/WebKit processes.
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const rss = isUnix()
      ? Bun.spawnSync(['ps', '-o', 'rss=', '-p', processInfo.map((p) => p.id).join(',')])
      : null;
    const browserRssMiB =
      rss?.exitCode === 0
        ? rss.stdout
            .toString()
            .trim()
            .split(/\s+/)
            .reduce((sum, n) => sum + Number(n), 0) / 1024
        : null;
    checkpoints.push({
      name,
      heapMiB: values.JSHeapUsedSize / 1048576,
      browserRssMiB,
      backendRssMiB: (samples.at(-1)?.rss ?? 0) / 1048576,
      nodes: values.Nodes,
      documents: values.Documents,
      layoutCount: values.LayoutCount,
      hostLoadAverage: loadavg(),
    });
  }
  const painted = (target: Page) =>
    target.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
  phase = 'browser-startup';
  const openStart = performance.now();
  await page.goto(origin);
  await page.getByRole('button', { name: 'Open session Stress chat 0', exact: true }).waitFor();
  report.browserReadyMs = performance.now() - openStart;
  phase = 'browser-idle';
  await sleep(5_000);
  await checkpoint('idle');
  async function openChat(s: number) {
    const start = performance.now();
    await page.getByRole('button', { name: `Open session Stress chat ${s}`, exact: true }).click();
    await page
      .getByText(`BENCHMARK-${s}-${messagesPerSession - 1}`, { exact: false })
      .last()
      .waitFor();
    await painted(page);
    return performance.now() - start;
  }
  phase = 'switching';
  const switchRounds = [];
  for (let r = 0; r < rounds; r++) {
    const times = [];
    for (let i = 0; i < sessions; i++) times.push(await openChat(i));
    switchRounds.push(stats(times));
    await checkpoint(`switch-round-${r + 1}`);
  }
  report.switchLatencyMs = switchRounds;
  console.log('Switch', JSON.stringify(switchRounds));

  await openChat(0);
  if (!socket) throw new Error('No browser WebSocket connection');
  const send = (sessionId: string, type: string, payload: unknown) => {
    if (deadlineExceeded) throw new Error('Benchmark deadline exceeded');
    socket!.send(JSON.stringify({ type, sessionId, payload, timestamp: Date.now() }));
  };
  // Eight chats, each with a manager and three workers: 32 streaming lanes.
  const lanes = ids
    .slice(0, 8)
    .flatMap((id, s) =>
      ['kory-manager', ...Array.from({ length: 3 }, (_, w) => `bench-worker-${s}-${w}`)].map(
        (agentId) => ({ id, agentId }),
      ),
    );
  // The seeded message-only history has no ordered terminal event. Close that
  // historical turn before starting a distinct synthetic turn (no user send).
  for (const id of ids.slice(0, 8)) send(id, 'stream.complete', { agentId: 'kory-manager' });
  for (const lane of lanes) {
    if (lane.agentId !== 'kory-manager') {
      send(lane.id, 'agent.spawned', {
        agent: {
          id: lane.agentId,
          name: lane.agentId,
          role: 'coder',
          model: 'fixture',
          provider: 'local',
          domain: 'backend',
          glowColor: '',
        },
        task: 'Synthetic streaming benchmark',
      });
    }
    send(lane.id, 'agent.status', { agentId: lane.agentId, status: 'streaming' });
  }
  phase = 'streaming';
  if (profiling) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  await page.evaluate(() => {
    (window as any).__harnessMetrics.frames = [];
    (window as any).__harnessMetrics.longTasks = [];
  });
  const inputTimes: number[] = [];
  const editor = page.getByTestId('composer-input');
  await editor.click();
  const streamingStart = performance.now();
  const stream = (async () => {
    for (let batch = 0; batch < streamBatches; batch++) {
      for (const lane of lanes)
        send(lane.id, 'stream.delta', {
          agentId: lane.agentId,
          content: `Chunk ${batch}: deterministic text with **formatting** and code.\n\n`,
        });
      await sleep(20);
    }
    for (const lane of lanes) {
      send(lane.id, 'stream.delta', { agentId: lane.agentId, content: '\n\nSTREAM-END-MARKER\n' });
      send(lane.id, 'stream.complete', { agentId: lane.agentId });
    }
  })();
  const typing = (async () => {
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      await page.keyboard.insertText('x');
      await painted(page);
      inputTimes.push(performance.now() - start);
      await sleep(100);
    }
  })();
  await Promise.all([stream, typing]);
  report.streaming = {
    lanes: lanes.length,
    events: lanes.length * (streamBatches + 2),
    elapsedMs: performance.now() - streamingStart,
    inputToPaintMs: stats(inputTimes),
  };
  await page.getByText('STREAM-END-MARKER', { exact: false }).first().waitFor();
  await painted(page);
  if (profiling) {
    const { profile } = await cdp.send('Profiler.stop');
    await Bun.write(output.replace(/\.json$/, '.cpuprofile'), JSON.stringify(profile));
    const names = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
    const counts = new Map<number, number>();
    for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    report.cpuHotspots = [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([id, count]) => ({ count, frame: names.get(id) }));
  }
  const browserMetrics = await page.evaluate(() => {
    const m = (window as any).__harnessMetrics;
    return { frames: m.frames as number[], longTasks: m.longTasks as number[] };
  });
  report.streamingFramesMs = stats(browserMetrics.frames);
  report.streamingLongTasksMs = stats(browserMetrics.longTasks);
  await checkpoint('stream-complete');
  console.log('Streaming', JSON.stringify(report.streaming));
  phase = 'recovery';
  for (const id of ids) await api(`/api/sessions/${id}`, undefined, 'DELETE');
  await sleep(10_000);
  await checkpoint('deleted-idle-10s');
  // Separate diagnostic of reachable retained heap, NOT the normal idle budget.
  await cdp.send('HeapProfiler.collectGarbage');
  await checkpoint('deleted-after-forced-gc-diagnostic-only');
  report.browserCheckpoints = checkpoints;
  report.budgetFailures = [
    ...apiRounds.flatMap((r, i) => (r.p95 > 100 ? [`API round ${i + 1} p95 exceeds 100 ms`] : [])),
    ...switchRounds.flatMap((r, i) =>
      r.p95 > 250 ? [`Switch round ${i + 1} p95 exceeds 250 ms`] : [],
    ),
    ...(stats(inputTimes).p95 > 100 ? ['Streaming input p95 exceeds 100 ms'] : []),
    ...(Math.max(...samples.map((s) => s.rss)) > 512 * 1048576
      ? ['Backend peak exceeds 512 MiB']
      : []),
    ...((checkpoints as Array<{ heapMiB: number }>).some((c) => c.heapMiB > 512)
      ? ['Renderer heap exceeds 512 MiB']
      : []),
    ...(pageErrors.length ? ['Browser page errors'] : []),
  ];
  report.completed = true;
  report.budgetsPassed = (report.budgetFailures as string[]).length === 0;
  if ((report.budgetFailures as string[]).length) process.exitCode = 1;
} catch (error) {
  report.error = deadlineExceeded
    ? `Benchmark exceeded its ${deadlineMs} ms cutoff during ${phase}`
    : String(error);
  report.stoppedAtPhase = phase;
  if (activePage && !activePage.isClosed() && !deadlineExceeded) {
    report.visibleTextOnFailure = (
      await activePage
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(-4000);
    await activePage.screenshot({ path: output.replace(/\.json$/, '.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  clearTimeout(cutoff);
  await browser?.close();
  backend.kill('SIGKILL');
  backend.disconnect();
  await backend.exited;
  await drain;
  report.backend = Object.fromEntries(
    [...new Set(samples.map((s) => s.phase))].map((name) => {
      const values = samples.filter((s) => s.phase === name);
      return [
        name,
        {
          rssMiB: stats(values.map((s) => s.rss / 1048576)),
          heapUsedMiB: stats(values.map((s) => s.heapUsed / 1048576)),
          timerDelayMs: stats(values.map((s) => s.timerDelayMs)),
        },
      ];
    }),
  );
  report.backendSamples = samples;
  report.deadlineExceeded = deadlineExceeded;
  report.finishedAt = new Date().toISOString();
  await Bun.write(output, JSON.stringify(report, null, 2) + '\n');
  rmSync(temp, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        output,
        completed: report.completed,
        deadlineExceeded,
        budgetFailures: report.budgetFailures,
        error: report.error,
        backend: report.backend,
      },
      null,
      2,
    ),
  );
}
