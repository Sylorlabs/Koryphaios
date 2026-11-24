#!/usr/bin/env bun
/**
 * Long-session soak against a running Koryphaios service (default: installed app on :3000).
 * One chat, sequential real-model turns with real tool use in a throwaway workspace,
 * every outcome verified on disk; service RSS / FDs / child processes / health latency sampled.
 *
 *   bun scripts/soak-long-session.ts --hours 8 --model logfare:glm-5.3 --context 98304
 *   bun scripts/soak-long-session.ts --turns 3            (smoke)
 *
 * Output: outputs/soak-<stamp>/{turns.jsonl,samples.jsonl,summary.json,driver.log}
 */
import { Database } from 'bun:sqlite';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const ORIGIN = arg('origin', 'http://127.0.0.1:3000')!;
const MODEL = arg('model', 'logfare:glm-5.3')!;
const CONTEXT = Number(arg('context', '98304'));
const HOURS = Number(arg('hours', '8'));
const MAX_TURNS = Number(arg('turns', '0')) || Infinity;
const DB_PATH = arg(
  'db',
  '/Users/Shared/micah/Library/Application Support/com.sylorlabs.koryphaios/data/koryphaios.db',
)!;
const TURN_DEADLINE_MS = 45 * 60_000; // above Kory's own 30-min cap, so Kory's terminal is what we observe
const IDLE_BETWEEN_TURNS_MS = 15_000;
const SAMPLE_MS = 30_000;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(import.meta.dir, '..', 'outputs', `soak-${stamp}`);
const workspace = `/private/tmp/kory-soak-${stamp}/workspace`;
mkdirSync(outDir, { recursive: true });
mkdirSync(join(workspace, 'work'), { recursive: true });
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(join(outDir, 'driver.log'), line + '\n');
};
const jsonl = (file: string, row: unknown) =>
  appendFileSync(join(outDir, file), JSON.stringify(row) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── API with token refresh ────────────────────────────────────────────────
let token = '';
async function auth() {
  const r = await fetch(`${ORIGIN}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  token = (await r.json()).data.bearerToken;
}
async function api(
  path: string,
  body?: unknown,
  method = body !== undefined ? 'POST' : 'GET',
): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 401 && attempt === 0) {
      await auth();
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }
}

// ── Service process metrics ───────────────────────────────────────────────
let servicePid = 0;
function processTable() {
  const out = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,rss=,comm=']).stdout.toString();
  return out
    .trim()
    .split('\n')
    .map((l) => {
      const [pid, ppid, rss, ...comm] = l.trim().split(/\s+/);
      return { pid: +pid, ppid: +ppid, rssKiB: +rss, comm: comm.join(' ') };
    });
}
function descendants(table: ReturnType<typeof processTable>, root: number) {
  const kids = new Map<number, number[]>();
  for (const p of table) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const seen: number[] = [];
  const stack = [...(kids.get(root) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    seen.push(p);
    stack.push(...(kids.get(p) ?? []));
  }
  return seen;
}
const fileSize = (p: string) => (existsSync(p) ? statSync(p).size : 0);
let sampleCount = 0;
async function sample(phase: string) {
  const table = processTable();
  const self = table.find((p) => p.pid === servicePid);
  const kids = descendants(table, servicePid);
  const kidRows = table.filter((p) => kids.includes(p.pid));
  let fds: number | null = null;
  if (sampleCount++ % 2 === 0) {
    const out = Bun.spawnSync(['lsof', '-n', '-P', '-p', String(servicePid)]).stdout.toString();
    fds = Math.max(0, out.trim().split('\n').length - 1);
  }
  let healthMs: number | null = null;
  let healthOk = false;
  const t0 = performance.now();
  try {
    const r = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(10_000) });
    healthOk = r.ok;
    healthMs = performance.now() - t0;
  } catch {
    /* recorded as not ok */
  }
  const row = {
    ts: Date.now(),
    phase,
    servicePid,
    alive: Boolean(self),
    serviceRssMiB: self ? self.rssKiB / 1024 : null,
    childCount: kids.length,
    childRssMiB: kidRows.reduce((s, p) => s + p.rssKiB, 0) / 1024,
    childComms: [...new Set(kidRows.map((p) => p.comm.split('/').pop()))].slice(0, 12),
    fds,
    healthOk,
    healthMs,
    dbMiB: fileSize(DB_PATH) / 1048576,
    walMiB: fileSize(`${DB_PATH}-wal`) / 1048576,
  };
  jsonl('samples.jsonl', row);
  return row;
}

// ── Transcript / compaction reads ─────────────────────────────────────────
function textOf(content: unknown): string {
  if (typeof content !== 'string')
    return Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : '';
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed.map((p: any) => p?.text ?? '').join('');
  } catch {
    /* plain string */
  }
  return content;
}
function compactions(sessionId: string) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .query(
        'SELECT automatic, source_tokens, checkpoint_tokens, created_at FROM session_compactions WHERE session_id = ? ORDER BY created_at',
      )
      .all(sessionId) as Array<{
      automatic: number;
      source_tokens: number;
      checkpoint_tokens: number;
      created_at: number;
    }>;
  } finally {
    db.close();
  }
}

// ── Workload ──────────────────────────────────────────────────────────────
const WORDS = [
  'amber',
  'basalt',
  'cobalt',
  'delta',
  'ember',
  'fjord',
  'garnet',
  'harbor',
  'indigo',
  'juniper',
  'kestrel',
  'lumen',
];
const codewords = new Map<number, string>();
const created = new Set<number>(); // build iterations whose file was verified on disk
type Turn = {
  kind: 'build' | 'bigout' | 'readback' | 'recall';
  prompt: string;
  verify: (reply: string) => { ok: boolean; detail: string };
};

function planTurn(i: number): Turn {
  if (i % 10 === 0 && i >= 10) {
    const target = [...codewords.keys()].filter((k) => k <= i - 9).at(-1);
    if (target !== undefined) {
      const word = codewords.get(target)!;
      return {
        kind: 'recall',
        prompt: `Soak recall check. Without using any tools or files, what codeword did I give you in soak iteration ${target}? Reply with exactly one line: CODEWORD: <word>`,
        verify: (reply) => ({
          ok: reply.toLowerCase().includes(word.toLowerCase()),
          detail: `expected ${word}`,
        }),
      };
    }
  }
  if (i % 7 === 0) {
    return {
      kind: 'bigout',
      prompt: `Soak iteration ${i}. Run this exact shell command: seq 1 40000 | awk '{print "line-" $1 "-" ($1*7)}'  — then tell me the exact final line it printed. End your reply with one line: LAST: <line>`,
      verify: (reply) => ({
        ok: reply.includes('line-40000-280000'),
        detail: 'expected line-40000-280000',
      }),
    };
  }
  if (i % 5 === 0 && created.size > 0) {
    const pick = [...created][Math.floor(created.size / 2)];
    const expected = readFileSync(join(workspace, 'work', `iter-${pick}.txt`), 'utf8').trim();
    return {
      kind: 'readback',
      prompt: `Soak iteration ${i}. Use your file-reading tool to read work/iter-${pick}.txt and quote its single line exactly. End your reply with one line: CONTENT: <line>`,
      verify: (reply) => ({ ok: reply.includes(expected), detail: `expected ${expected}` }),
    };
  }
  const word = `${WORDS[i % WORDS.length]}-${(i * 7919) % 10000}`;
  codewords.set(i, word);
  const line = `iteration=${i} value=${i * 37} check=${(i * 7919) % 997}`;
  return {
    kind: 'build',
    prompt: [
      `Soak iteration ${i}. Remember this codeword for later; do not write it to any file: ${word}`,
      `Task: create the file work/iter-${i}.txt containing exactly this one line: ${line}`,
      `Then run the shell command \`ls work | wc -l\` and report its output.`,
      `End your reply with one line: COUNT: <number>`,
    ].join('\n'),
    verify: (reply) => {
      const path = join(workspace, 'work', `iter-${i}.txt`);
      const onDisk = existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
      const actualCount = readdirSync(join(workspace, 'work')).length;
      const reported = reply.match(/COUNT:\s*(\d+)/)?.[1];
      const fileOk = onDisk === line;
      if (fileOk) created.add(i);
      const countOk = reported !== undefined && Number(reported) === actualCount;
      return {
        ok: fileOk && countOk,
        detail: `file=${fileOk ? 'ok' : JSON.stringify(onDisk)} reported=${reported ?? 'none'} actual=${actualCount}`,
      };
    },
  };
}

async function waitTerminal(sessionId: string, runId: string | undefined, sentAt: number) {
  const deadline = Date.now() + TURN_DEADLINE_MS;
  let last: any;
  while (Date.now() < deadline) {
    await sleep(5_000);
    try {
      const list = await api('/api/sessions');
      last = (list.runStates ?? []).find((s: any) => s?.sessionId === sessionId);
      if (
        last &&
        last.status === 'terminal' &&
        (last.finishedAt ?? last.updatedAt) >= sentAt &&
        (!runId || last.runId === runId || last.finishedAt > sentAt)
      )
        return { state: last, timedOut: false };
    } catch (error) {
      log(`poll error: ${(error as Error).message}`);
    }
  }
  return { state: last, timedOut: true };
}

// ── Main ──────────────────────────────────────────────────────────────────
const health = await (await fetch(`${ORIGIN}/api/health`)).json();
servicePid = health.data.pid;
await auth();
const session = (
  await api('/api/sessions', { title: `Soak test ${stamp}`, workingDirectory: workspace })
).data;
await api(
  `/api/sessions/${session.id}`,
  { agentOverrides: { permissionMode: 'yolo', criticMode: 'off' } },
  'PATCH',
);
writeFileSync(
  join(outDir, 'config.json'),
  JSON.stringify(
    {
      origin: ORIGIN,
      model: MODEL,
      contextWindow: CONTEXT,
      hours: HOURS,
      maxTurns: MAX_TURNS,
      workspace,
      sessionId: session.id,
      service: health.data,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
log(
  `session ${session.id} workspace ${workspace} service pid ${servicePid} v${health.data.version} out ${outDir}`,
);

const sampler = setInterval(
  () => void sample('run').catch((e) => log(`sample error ${e}`)),
  SAMPLE_MS,
);
await sample('start');
const endAt = Date.now() + HOURS * 3_600_000;
let i = 0;
let consecutiveDown = 0;
const PROVIDER_FAILURE =
  /is unavailable or failed to start|request failed\. Retry|temporarily|capacity|throttl|rate.?limit|429|502|503/i;
const MAX_ATTEMPTS = 6;
let attempt = 0;
let turn: Turn | undefined;
while (Date.now() < endAt && i < MAX_TURNS) {
  if (attempt === 0) {
    i++;
    turn = planTurn(i);
  }
  attempt++;
  const sentAt = Date.now();
  const row: Record<string, unknown> = { i, attempt, kind: turn!.kind, sentAt };
  try {
    const sent = await api('/api/messages', {
      sessionId: session.id,
      content: turn!.prompt,
      model: MODEL,
      contextWindow: CONTEXT,
      interactionMode: 'act',
      clientMessageId: `soak_${stamp.slice(0, 19).replace(/[^0-9A-Za-z]/g, '')}_${i}_${attempt}`,
    });
    row.admission = sent.data?.status;
    row.runId = sent.data?.runId;
    const { state, timedOut } = await waitTerminal(session.id, sent.data?.runId, sentAt);
    row.durationMs = Date.now() - sentAt;
    row.timedOut = timedOut;
    row.phase = state?.phase;
    row.terminalReason = state?.terminalReason;
    if (timedOut) {
      log(`turn ${i} exceeded driver deadline; cancelling`);
      await api(`/api/sessions/${session.id}/cancel`, {}).catch((e) => log(`cancel failed ${e}`));
    }
    const msgs = (await api(`/api/messages/${session.id}?limit=40`)).data.messages as any[];
    const reply = msgs
      .filter((m) => m.role === 'assistant' && (m.createdAt ?? 0) >= sentAt)
      .map((m) => textOf(m.content))
      .join('\n');
    const systemNotes = msgs
      .filter((m) => m.role === 'system' && (m.createdAt ?? 0) >= sentAt)
      .map((m) => textOf(m.content).slice(0, 200));
    row.replyChars = reply.length;
    row.replyTail = reply.slice(-300);
    row.systemNotes = systemNotes;
    Object.assign(row, turn!.verify(reply));
    row.providerError =
      row.phase === 'error' && PROVIDER_FAILURE.test(String(row.terminalReason ?? ''));
    consecutiveDown = 0;
  } catch (error) {
    row.error = (error as Error).message;
    row.ok = false;
    const alive = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.ok)
      .catch(() => false);
    row.serviceAlive = alive;
    if (!alive && ++consecutiveDown >= 40) {
      log('service down for ~10 minutes; stopping');
      jsonl('turns.jsonl', row);
      break;
    }
    if (!alive) await sleep(15_000);
  }
  const c = compactions(session.id);
  row.compactionsSoFar = c.length;
  const retry = row.providerError === true && attempt < MAX_ATTEMPTS;
  row.final = !retry;
  jsonl('turns.jsonl', row);
  log(
    `turn ${i}.${attempt} ${turn!.kind} ${row.ok ? 'PASS' : row.providerError ? 'PROVIDER' : 'FAIL'} ${row.phase ?? ''}/${String(row.terminalReason ?? row.error ?? '').slice(0, 120)} ${Math.round(Number(row.durationMs ?? 0) / 1000)}s compactions=${c.length} ${row.detail ?? ''}`,
  );
  if (retry) {
    await sleep(Math.min(600_000, 60_000 * 2 ** (attempt - 1)));
    continue;
  }
  attempt = 0;
  await sleep(IDLE_BETWEEN_TURNS_MS);
}
clearInterval(sampler);
await sample('end');

// ── Summary ───────────────────────────────────────────────────────────────
const turns = readFileSync(join(outDir, 'turns.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const samples = readFileSync(join(outDir, 'samples.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)] : null;
};
const t0 = samples[0]?.ts ?? Date.now();
const byHour = new Map<number, any[]>();
for (const s of samples)
  byHour.set(Math.floor((s.ts - t0) / 3_600_000), [
    ...(byHour.get(Math.floor((s.ts - t0) / 3_600_000)) ?? []),
    s,
  ]);
const count = (xs: any[], key: (x: any) => string) =>
  xs.reduce((m: Record<string, number>, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});
const summary = {
  sessionId: session.id,
  outDir,
  finishedAt: new Date().toISOString(),
  turns: turns.length,
  passByKind: Object.fromEntries(
    ['build', 'bigout', 'readback', 'recall'].map((k) => {
      const ts = turns.filter((t) => t.kind === k && t.final !== false);
      return [k, { total: ts.length, passed: ts.filter((t) => t.ok).length }];
    }),
  ),
  terminal: count(
    turns.filter((t) => !t.providerError),
    (t) => `${t.phase ?? 'none'}/${t.terminalReason ?? t.error?.slice(0, 80) ?? 'none'}`,
  ),
  providerErrorAttempts: turns.filter((t) => t.providerError).length,
  turnsAbandonedOnProvider: turns.filter((t) => t.providerError && t.final).length,
  driverTimeouts: turns.filter((t) => t.timedOut).length,
  turnDurationSec: {
    p50: pct(
      turns.map((t) => (t.durationMs ?? 0) / 1000),
      0.5,
    ),
    p95: pct(
      turns.map((t) => (t.durationMs ?? 0) / 1000),
      0.95,
    ),
    max: pct(
      turns.map((t) => (t.durationMs ?? 0) / 1000),
      1,
    ),
  },
  compactions: compactions(session.id),
  serviceRestarted: samples.some((s) => !s.alive),
  hourly: [...byHour.entries()].map(([h, ss]) => ({
    hour: h,
    rssMiB: {
      median: pct(
        ss.map((s) => s.serviceRssMiB ?? 0),
        0.5,
      ),
      max: pct(
        ss.map((s) => s.serviceRssMiB ?? 0),
        1,
      ),
    },
    childCountMax: pct(
      ss.map((s) => s.childCount),
      1,
    ),
    childRssMiBMax: pct(
      ss.map((s) => s.childRssMiB),
      1,
    ),
    fdsMax: pct(
      ss.filter((s) => s.fds !== null).map((s) => s.fds),
      1,
    ),
    healthMs: {
      p50: pct(
        ss.filter((s) => s.healthMs !== null).map((s) => s.healthMs),
        0.5,
      ),
      p95: pct(
        ss.filter((s) => s.healthMs !== null).map((s) => s.healthMs),
        0.95,
      ),
    },
    healthFailures: ss.filter((s) => !s.healthOk).length,
    dbMiB: ss.at(-1)?.dbMiB,
    walMiBMax: pct(
      ss.map((s) => s.walMiB),
      1,
    ),
  })),
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
log(`done: ${turns.length} turns; summary ${join(outDir, 'summary.json')}`);
process.exit(0);
