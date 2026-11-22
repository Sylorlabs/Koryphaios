#!/usr/bin/env bun
/**
 * koryphaios — command line driver for the local Koryphaios backend.
 *
 * The backend already exposes a complete session/turn API; this CLI gives it a
 * terminal surface so work can be dispatched without the desktop UI:
 *
 *   koryphaios status                       Backend health, providers, active runs
 *   koryphaios models [--provider p]        Models per configured provider
 *   koryphaios sessions                     Recent chats and their run state
 *   koryphaios run --cwd DIR --prompt-file F
 *                                        One agent turn, followed to completion
 *   koryphaios dispatch --plan plan.json    Manager fan-out: one agent per plan entry
 *   koryphaios wait <sessionId>             Follow an existing chat to completion
 *
 * Defaults to the user-mode backend on 127.0.0.1:3001 (`bun run user -- --no-window`).
 * Auth uses the local session endpoint, exactly like the app's own frontend.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

const BASE = `http://${process.env.KORYPHAIOS_HOST ?? '127.0.0.1'}:${process.env.KORYPHAIOS_PORT ?? 3001}`;
const DEFAULT_MODEL = process.env.KORY_MODEL ?? 'logfare/deepseek-v4.1-flash-1017';
const DEFAULT_REASONING = process.env.KORY_REASONING ?? 'high';

type Flags = Record<string, string | boolean>;
type Usage = { command: string; positionals: string[]; flags: Flags };
type RunState = {
  sessionId: string;
  status?: string;
  phase?: string;
  waitingReason?: string;
  terminalReason?: string | null;
  runId?: string | null;
};

const HELP = `koryphaios — drive Koryphaios agents from the terminal

Usage: koryphaios [--json] COMMAND [options]

  status                          Backend health, configured providers, active runs
  models [--provider NAME] [--grep TEXT]
                                  List models the backend can actually reach
  sessions [--limit N]            Recent chats with their run state
  targets                         Linked computers and their agent grants
  run [--cwd DIR] [--title T]
      (--prompt TEXT | --prompt-file PATH)
      [--model PROVIDER/MODEL] [--reasoning low|medium|high|xhigh]
      [--device NAME|ID] [--workspace NAME|ID] [--policy stay|return]
      [--use-local-providers]
      [--timeout SECONDS] [--out FILE]
                                  Create a chat and run one agent turn to completion.
                                  With --device, the chat runs on that computer.
  collect SESSION_ID --device NAME|ID [--out DIR] [--force]
                                  Export a returned chat's changes for local review
  dispatch --plan FILE [--out DIR] [--concurrency N] [--timeout SECONDS]
                                  Manager fan-out: one agent turn per plan entry
  wait SESSION_ID [--timeout SECONDS]
                                  Follow an existing chat until it settles
  unblock [SESSION_ID] [--answer TEXT]
                                  Answer parked ask_user questions on headless runs
  help                            This text

Environment:
  KORYPHAIOS_HOST / KORYPHAIOS_PORT   Backend address (default 127.0.0.1:3001)
  KORY_MODEL                          Default model (default ${DEFAULT_MODEL})
  KORY_REASONING                      Default reasoning level (default ${DEFAULT_REASONING})

Plan file for dispatch:
  {
    "model": "logfare/deepseek-v4.1-flash-1017",
    "reasoning": "high",
    "agents": [
      { "id": "P01", "cwd": "/path/to/worktree", "title": "P01",
        "promptFile": "/path/to/P01.md" }
    ]
  }
  Every agent gets its own chat. Transcripts are written to --out/<id>.md and a
  SUMMARY.md/SUMMARY.json is written alongside them.
`;

/** 
 * Boolean flags must never consume the next token: `--json status` used to
 * assign "status" to json and drop the command, so every invocation printed
 * help. Keep this list explicit rather than guessing from the next token.
 */
const BOOLEAN_FLAGS = new Set(['json', 'quiet', 'help']);

function parseArgs(argv: string[]): Usage {
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  const command = positionals.shift() ?? 'help';
  return { command, positionals, flags };
}

function textFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const raw = textFlag(flags, name);
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

let bearer: string | null = null;

async function rawRequest(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (bearer) headers.authorization = bearer;
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ensureBearer(): Promise<string> {
  if (bearer) return bearer;
  const response = await rawRequest('/api/auth/session', 'POST');
  if (!response.ok) {
    throw new Error(
      `Cannot open a local session token (${response.status}). Is the backend running? Try: bun run user -- --no-window`,
    );
  }
  const payload = (await response.json()) as { bearerToken?: string; data?: { bearerToken?: string } };
  const token = payload.bearerToken ?? payload.data?.bearerToken;
  if (!token) throw new Error('Backend returned no bearer token for /api/auth/session');
  bearer = token;
  return bearer;
}

async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  await ensureBearer();
  let response = await rawRequest(path, method, body);
  if (response.status === 401) {
    // The token can expire mid-run; mint a fresh one once and retry.
    bearer = null;
    await ensureBearer();
    response = await rawRequest(path, method, body);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function health(): Promise<{ ok: boolean; version?: string }> {
  try {
    const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { ok: false };
    const body = (await response.json().catch(() => ({}))) as { version?: string; data?: { version?: string } };
    return { ok: true, version: body.version ?? body.data?.version };
  } catch {
    return { ok: false };
  }
}

async function requireHealth(): Promise<void> {
  const state = await health();
  if (!state.ok) {
    throw new Error(
      `Koryphaios backend is not reachable at ${BASE}.\nStart it with: bun run user -- --no-window`,
    );
  }
}

type ProviderRow = { name: string; models?: unknown[]; configured?: boolean; status?: string };

function providerRows(rows: ProviderRow[]): ProviderRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

function modelIds(row: ProviderRow): string[] {
  return (row.models ?? []).map((model) =>
    typeof model === 'string'
      ? model
      : ((model as { id?: string; model?: string }).id ?? (model as { model?: string }).model ?? ''),
  ).filter((id) => id.length > 0);
}

async function readProviders(): Promise<ProviderRow[]> {
  const payload = await api<any>('/api/providers/status');
  const data = payload.data ?? payload;
  const rows = Array.isArray(data) ? data : (data.providers ?? []);
  return providerRows(rows as ProviderRow[]);
}

async function readRunStates(): Promise<RunState[]> {
  const payload = await api<any>('/api/sessions');
  return (payload.runStates ?? []) as RunState[];
}

async function readSessions(): Promise<any[]> {
  const payload = await api<any>('/api/sessions');
  return (payload.data ?? []) as any[];
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part === 'string' ? part : (part?.text ?? part?.content ?? ''),
      )
      .join('');
  }
  const parts = message?.parts ?? message?.displayParts ?? message?.contentParts;
  if (Array.isArray(parts)) {
    return parts
      .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? part?.content ?? '')))
      .join('');
  }
  return typeof message?.text === 'string' ? message.text : '';
}

function isAssistant(message: any): boolean {
  const role = message?.role ?? message?.author;
  return role === 'assistant' || role === 'agent';
}

async function readMessages(sessionId: string): Promise<any[]> {
  const payload = await api<any>(`/api/messages/${encodeURIComponent(sessionId)}?limit=200`);
  return (payload.data?.messages ?? payload.messages ?? []) as any[];
}

type DevicePeer = {
  id: string;
  name: string;
  os?: string;
  online?: boolean;
  allowAgents?: boolean;
  agentRouting?: boolean;
};

async function readDeviceState(): Promise<any> {
  const payload = await api<any>('/api/devices');
  return payload.data ?? payload;
}

async function resolveDevice(nameOrId: string): Promise<DevicePeer> {
  const state = await readDeviceState();
  const peers = (state.peers ?? []) as DevicePeer[];
  const wanted = nameOrId.trim().toLowerCase();
  const peer =
    peers.find((row) => row.id === nameOrId) ??
    peers.find((row) => row.name.toLowerCase() === wanted) ??
    peers.find((row) => row.name.toLowerCase().startsWith(wanted));
  if (!peer)
    throw new Error(`No linked computer matches ${JSON.stringify(nameOrId)}. Run: koryphaios targets`);
  return peer;
}

async function deviceRpc(
  deviceId: string,
  operation: string,
  input: Record<string, unknown> = {},
): Promise<any> {
  const payload = await api<any>(`/api/devices/${encodeURIComponent(deviceId)}/rpc`, 'POST', {
    operation,
    input,
  });
  return payload.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * A turn that calls `ask_user` parks the run until a question is answered, and
 * answers only travel over the websocket (`user_input`) — an HTTP message just
 * returns 409 while the parked turn holds the session. Headless runs have no
 * client watching, so this opens the socket, subscribes, and answers.
 */
async function answerPendingQuestion(sessionId: string, answer: string): Promise<boolean> {
  // The server authenticates the upgrade from the Authorization header (query
  // tokens are deprecated and rejected), and Bun's WebSocket accepts a request
  // init as its second argument — that is the only shape that survives here.
  const url = `${BASE.replace(/^http/, 'ws')}/ws`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* socket already closed */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 10000);
    const socket = new WebSocket(url, { headers: { authorization: bearer ?? '' } } as never);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
    });
    socket.addEventListener('message', (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type !== 'kory.ask_user' || message.sessionId !== sessionId) return;
      const payload = message.payload ?? {};
      socket.send(
        JSON.stringify({
          type: 'user_input',
          sessionId,
          selection: answer,
          text: 'Headless run: proceed autonomously and record the assumption.',
          questionId: payload.questionId,
        }),
      );
      setTimeout(() => finish(true), 250);
    });
    socket.addEventListener('error', () => finish(false));
    socket.addEventListener('close', () => finish(false));
  });
}

/**
 * A headless turn still calls `ask_user`. `waitForUserInput` parks the run
 * durably until a `user_input` frame arrives, so without a client the turn
 * stalls until its timeout. This holds one subscribed socket open for the whole
 * turn, answers every question as it arrives, and re-subscribes on a timer and
 * after a drop — the server replays a still-pending question on every
 * subscription, so a question asked during a reconnect is not missed.
 *
 * A single long-lived socket is the point: the earlier per-attempt socket lost
 * questions asked in the gap between attempts, which is why parked runs needed
 * a human to run `unblock` several times.
 */
class HeadlessAnswerer {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private resubscribeTimer: ReturnType<typeof setInterval> | null = null;
  private answered = 0;

  constructor(
    private readonly sessionId: string,
    private readonly onAnswer?: (question: string, answer: string) => void,
  ) {}

  start(): void {
    this.connect();
    this.resubscribeTimer = setInterval(() => this.resubscribe(), 5000);
  }

  stop(): void {
    this.stopped = true;
    if (this.resubscribeTimer) clearInterval(this.resubscribeTimer);
    if (this.reconnect) clearTimeout(this.reconnect);
    try {
      this.socket?.close();
    } catch {
      /* socket already closed */
    }
  }

  get answerCount(): number {
    return this.answered;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${BASE.replace(/^http/, 'ws')}/ws`;
    const socket = new WebSocket(url, { headers: { authorization: bearer ?? '' } } as never);
    this.socket = socket;
    socket.addEventListener('open', () => this.subscribe(socket));
    socket.addEventListener('message', (event) => this.onMessage(event));
    socket.addEventListener('error', () => this.scheduleReconnect());
    socket.addEventListener('close', () => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect();
    }, 1000);
  }

  private subscribe(socket: WebSocket): void {
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify({ type: 'subscribe_session', sessionId: this.sessionId }));
  }

  private resubscribe(): void {
    if (this.stopped) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      this.connect();
      return;
    }
    this.subscribe(socket);
  }

  private onMessage(event: { data: unknown }): void {
    let message: any;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message?.type !== 'kory.ask_user' || message?.sessionId !== this.sessionId) return;
    const payload = message.payload ?? {};
    const answer = headlessAnswer(String(payload.question ?? ''), payload.options);
    this.answered += 1;
    try {
      this.onAnswer?.(String(payload.question ?? ''), answer);
    } catch {
      /* progress logging must never break the answer */
    }
    try {
      this.socket?.send(
        JSON.stringify({
          type: 'user_input',
          sessionId: this.sessionId,
          selection: answer,
          text: 'Headless run: proceed autonomously, take the safest default, and record the assumption.',
          questionId: payload.questionId,
        }),
      );
    } catch {
      this.scheduleReconnect();
    }
  }
}

/**
 * Prefer an offered option that keeps work moving. The run resolves the
 * selection verbatim into its transcript, so never invent a choice the
 * question did not offer while real options exist.
 *
 * An unattended answerer must never widen its own authority: a safety prompt
 * offers "Allow once" next to "Allow and add command to allowlist", and
 * picking the latter turns one approval into a standing grant the user never
 * made. Permission questions therefore take the narrowest scope, and options
 * that skip or disable the guard are never selected.
 */
function headlessAnswer(question: string, options: unknown): string {
  const list = Array.isArray(options)
    ? options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
    : [];
  const permitted = list.filter(
    (option) => !/danger|skip (all|the)? ?permissions?|disable|yolo|always allow|allowlist/i.test(option),
  );
  const pool = permitted.length > 0 ? permitted : list;
  const permissionPrompt =
    /requesting|permission|approve|allow|safety check|outside the working directory/i.test(question);
  if (permissionPrompt) {
    const once = pool.find((option) => /allow once|approve once|just this once|once\b/i.test(option));
    if (once) return once;
  }
  const preferred = pool.find((option) =>
    /proceed|recommended|apply|continue|smallest|existing/i.test(option),
  );
  if (preferred) return preferred;
  return pool[0] ?? 'Proceed autonomously';
}

type RunResult = {
  ok: boolean;
  sessionId: string;
  status: string;
  text: string;
  seconds: number;
  error?: string;
};

/**
 * Poll a chat until the run settles (idle/terminal) and the assistant has
 * actually written something. The backend reports run state separately from
 * messages, so both are needed: idle alone can be the gap between accept and
 * first token, and text alone can be a partial stream.
 */
async function followSession(
  sessionId: string,
  options: { timeoutSeconds: number; baselineMessages: number; quiet: boolean },
): Promise<RunResult> {
  const started = Date.now();
  const deadline = started + options.timeoutSeconds * 1000;
  let lastText = '';
  let stablePolls = 0;
  let lastNotice = 0;
  // The run answers its own questions for as long as it is unattended.
  const answerer = new HeadlessAnswerer(sessionId, (question, answer) => {
    if (options.quiet) return;
    process.stderr.write(
      `  ↳ ${sessionId} answered (${answerer.answerCount}): ${question.slice(0, 70)} → ${answer.slice(0, 50)}\n`,
    );
  });
  answerer.start();

  try {
    while (Date.now() < deadline) {
      await sleep(2000);
      let state: RunState | undefined;
      try {
        state = (await readRunStates()).find((row) => row.sessionId === sessionId);
      } catch {
        state = undefined;
      }

      let messages: any[] = [];
      try {
        messages = await readMessages(sessionId);
      } catch {
        messages = [];
      }

      const assistant = messages.filter(isAssistant).slice(options.baselineMessages);
      const text = assistant.map(messageText).filter((chunk) => chunk.trim().length > 0).join('\n\n');
      const status = state?.status ?? (state?.phase === 'idle' ? 'idle' : 'unknown');

      if (text === lastText) stablePolls += 1;
      else {
        stablePolls = 0;
        lastText = text;
      }

      if (!options.quiet && Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        process.stderr.write(
          `  … ${sessionId} ${status} ${Math.round((Date.now() - started) / 1000)}s (answers ${answerer.answerCount})\n`,
        );
      }

      const settled = status === 'idle' || status === 'terminal' || status === 'error';
      // A turn whose answer the harness withheld did not produce a result even
      // though the run reports done; scoring it as success is how a failed
      // experiment gets counted as finished.
      const withheld = WITHHELD_NOTICE.test(text);
      if (settled && (text.trim().length > 0 || (stablePolls >= 2 && status !== 'idle'))) {
        const failed = status === 'error' || (status === 'terminal' && state?.terminalReason === 'error');
        return {
          ok: !failed && !withheld && text.trim().length > 0,
          sessionId,
          status,
          text: text.trim(),
          seconds: Math.round((Date.now() - started) / 1000),
          error: failed
            ? state?.waitingReason || state?.terminalReason || 'run ended with error'
            : withheld
              ? 'the response was withheld: the provider turn did not complete'
              : undefined,
        };
      }
      if (settled && stablePolls >= 3) {
        return {
          ok: text.trim().length > 0,
          sessionId,
          status,
          text: text.trim(),
          seconds: Math.round((Date.now() - started) / 1000),
          error: text.trim().length > 0 ? undefined : 'run settled without assistant output',
        };
      }
    }

    return {
      ok: false,
      sessionId,
      status: 'timeout',
      text: lastText.trim(),
      seconds: Math.round((Date.now() - started) / 1000),
      error: `timed out after ${options.timeoutSeconds}s`,
    };
  } finally {
    answerer.stop();
  }
}

async function createSession(title: string, workingDirectory?: string): Promise<string> {
  const payload = await api<any>('/api/sessions', 'POST', {
    title,
    ...(workingDirectory ? { workingDirectory: resolve(workingDirectory) } : {}),
  });
  const session = payload.data ?? payload;
  const id = session.id ?? session.session?.id;
  if (!id) throw new Error(`Session creation returned no id: ${JSON.stringify(payload).slice(0, 300)}`);
  return id as string;
}

/**
 * The backend splits model selections on a colon (`provider:model`) so a
 * `provider/model` string silently fails the split and falls through to the
 * configured default provider. Accept either form on the command line and send
 * the one the router actually parses.
 */
function normalizeModel(value: string): string {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash === -1) return trimmed;
  const head = trimmed.slice(0, slash);
  const tail = trimmed.slice(slash + 1);
  // `custom:<slug>/<model>` carries the provider's own colon, so the slash is
  // still the separator. A head without a colon is a plain `provider/model`.
  return `${head}:${tail}`;
}

async function sendTurn(input: {
  sessionId: string;
  prompt: string;
  model: string;
  reasoning: string;
}): Promise<void> {
  const payload = await api<any>('/api/messages', 'POST', {
    sessionId: input.sessionId,
    content: input.prompt,
    model: normalizeModel(input.model),
    reasoningLevel: input.reasoning,
  });
  if (payload.ok === false) {
    const reason = payload.error ?? JSON.stringify(payload).slice(0, 300);
    throw new Error(`Backend rejected the turn: ${reason}`);
  }
  // A rejected/blocked submission can still answer 200 with a status payload.
  const status = payload.data?.status;
  if (status === 'rejected' || status === 'blocked') {
    throw new Error(`Turn ${status}: ${JSON.stringify(payload.data).slice(0, 400)}`);
  }
}

async function readPrompt(usage: Usage): Promise<string> {
  const file = textFlag(usage.flags, 'prompt-file');
  if (file) {
    const path = resolve(file);
    if (!existsSync(path)) throw new Error(`Prompt file not found: ${path}`);
    return readFileSync(path, 'utf-8');
  }
  const inline = textFlag(usage.flags, 'prompt');
  if (inline) return inline;
  throw new Error('Provide --prompt "…" or --prompt-file path');
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function commandStatus(usage: Usage): Promise<number> {
  await requireHealth();
  const [providers, sessions, runStates] = await Promise.all([
    readProviders(),
    readSessions(),
    readRunStates(),
  ]);
  const configured = providers.filter((row) => modelIds(row).length > 0);
  const active = runStates.filter((state) => (state.status ?? 'idle') !== 'idle');
  const willing = providers.filter((row) => row.configured !== false && modelIds(row).length > 0);

  if (usage.flags.json) {
    printJson({
      base: BASE,
      configured: configured.map((row) => ({ name: row.name, models: modelIds(row).length })),
      activeRuns: active,
      sessions: sessions.length,
      defaultModel: DEFAULT_MODEL,
    });
    return 0;
  }

  process.stdout.write(`Koryphaios  ${BASE}  ✓ healthy\n`);
  process.stdout.write(`sessions    ${sessions.length} active\n`);
  process.stdout.write(`runs        ${active.length} in flight\n`);
  process.stdout.write(`providers   ${willing.length} with models\n`);
  for (const row of configured) {
    process.stdout.write(`  ${row.name.padEnd(22)} ${String(modelIds(row).length).padStart(5)} models\n`);
  }
  const [provider, ...rest] = DEFAULT_MODEL.split('/');
  const target = providers.find((row) => row.name === provider);
  const defaultModels = target ? modelIds(target) : [];
  const wanted = rest.join('/');
  if (!target || defaultModels.length === 0) {
    process.stdout.write(
      `\ndefault model ${DEFAULT_MODEL} is NOT available: provider "${provider}" is not configured ` +
        `(no credentials). Set the key, or pass --model with a provider that has models above.\n`,
    );
  } else if (!defaultModels.some((id) => id === wanted || id.endsWith(wanted))) {
    process.stdout.write(
      `\ndefault model ${DEFAULT_MODEL}: provider OK but that model id was not listed. Pass --model explicitly.\n`,
    );
  }
  return 0;
}

async function commandModels(usage: Usage): Promise<number> {
  await requireHealth();
  const providers = await readProviders();
  const only = textFlag(usage.flags, 'provider');
  const grep = textFlag(usage.flags, 'grep')?.toLowerCase();
  const rows = providers.filter((row) => !only || row.name === only);
  const output: Record<string, string[]> = {};
  for (const row of rows) {
    const ids = modelIds(row).filter((id) => !grep || id.toLowerCase().includes(grep));
    if (ids.length > 0) output[row.name] = ids;
  }
  if (usage.flags.json) {
    printJson(output);
    return 0;
  }
  if (Object.keys(output).length === 0) {
    process.stdout.write(only ? `provider "${only}" exposes no models\n` : 'no provider exposes models\n');
    return 1;
  }
  for (const [name, ids] of Object.entries(output)) {
    process.stdout.write(`${name} (${ids.length})\n`);
    for (const id of ids.slice(0, 200)) process.stdout.write(`  ${name}/${id}\n`);
  }
  return 0;
}

async function commandUnblock(usage: Usage): Promise<number> {
  await requireHealth();
  const answer = textFlag(usage.flags, 'answer') ?? 'Proceed';
  const only = usage.positionals[0];
  const [sessions, states] = await Promise.all([readSessions(), readRunStates()]);
  const titles = new Map(sessions.map((session) => [session.id as string, session.title as string]));
  const waiting = states.filter(
    (state) => state.status === 'waiting' && titles.has(state.sessionId) && (!only || state.sessionId === only),
  );
  if (waiting.length === 0) {
    process.stdout.write('no parked runs\n');
    return 0;
  }
  let answered = 0;
  for (const state of waiting) {
    const ok = await answerPendingQuestion(state.sessionId, answer);
    if (ok) answered += 1;
    process.stdout.write(
      `${ok ? '✓' : '·'} ${state.sessionId} ${String(titles.get(state.sessionId) ?? '').slice(0, 32)}\n`,
    );
  }
  process.stdout.write(`answered ${answered}/${waiting.length} parked runs\n`);
  return answered > 0 ? 0 : 1;
}

async function commandTargets(usage: Usage): Promise<number> {
  await requireHealth();
  const state = await readDeviceState();
  const peers = (state.peers ?? []) as DevicePeer[];
  if (usage.flags.json) {
    printJson({
      relay: state.relayUrl ?? null,
      connected: Boolean(state.connected),
      local: state.local ?? null,
      targets: peers,
    });
    return 0;
  }
  process.stdout.write(
    `relay ${state.relayUrl ?? '—'} ${state.connected ? 'connected' : 'offline'}\n`,
  );
  for (const peer of peers) {
    process.stdout.write(
      `${String(peer.id).padEnd(12)} ${peer.online ? 'online ' : 'offline'} ${peer.name}  ${peer.os ?? ''}  agents:${peer.agentRouting ? 'on' : 'off'}\n`,
    );
  }
  if (peers.length === 0) process.stdout.write('no linked computers\n');
  return 0;
}

/**
 * A target session is not in this backend's session list, so completion comes
 * from the target's own snapshot: run state plus assistant messages.
 */
async function followDeviceSession(
  device: DevicePeer,
  sessionId: string,
  options: { timeoutSeconds: number; quiet: boolean },
): Promise<RunResult> {
  const started = Date.now();
  const deadline = started + options.timeoutSeconds * 1000;
  let lastText = '';
  let stablePolls = 0;
  let seenRun = false;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    let snapshot: any;
    try {
      snapshot = await deviceRpc(device.id, 'snapshot', { sessionId });
    } catch {
      continue;
    }
    if (snapshot?.run) seenRun = true;
    const text = ((snapshot?.messages ?? []) as any[])
      .filter(isAssistant)
      .map(messageText)
      .filter((chunk) => chunk.trim().length > 0)
      .join('\n\n')
      .trim();
    const status = snapshot?.run?.status ?? 'idle';
    if (text === lastText) stablePolls += 1;
    else {
      stablePolls = 0;
      lastText = text;
    }
    if (!options.quiet && Date.now() - lastNotice > 15000) {
      lastNotice = Date.now();
      process.stderr.write(
        `  … ${device.name}:${sessionId} ${status} ${Math.round((Date.now() - started) / 1000)}s\n`,
      );
    }
    const settled = status === 'idle' || status === 'terminal' || status === 'error';
    if (settled && text.trim() && (seenRun || stablePolls >= 1)) {
      const failed = status === 'error';
      return {
        ok: !failed,
        sessionId,
        status,
        text,
        seconds: Math.round((Date.now() - started) / 1000),
        error: failed ? 'run ended with error on the target' : undefined,
      };
    }
    if (settled && stablePolls >= 3) {
      return {
        ok: text.trim().length > 0,
        sessionId,
        status,
        text,
        seconds: Math.round((Date.now() - started) / 1000),
        error: text.trim() ? undefined : 'target run settled without assistant output',
      };
    }
  }
  return {
    ok: false,
    sessionId,
    status: 'timeout',
    text: lastText,
    seconds: Math.round((Date.now() - started) / 1000),
    error: `timed out after ${options.timeoutSeconds}s on ${device.name}`,
  };
}

async function commandSessions(usage: Usage): Promise<number> {
  await requireHealth();
  const limit = numberFlag(usage.flags, 'limit', 20);
  const [sessions, runStates] = await Promise.all([readSessions(), readRunStates()]);
  const byId = new Map(runStates.map((state) => [state.sessionId, state]));
  const rows = sessions.slice(0, limit).map((session) => ({
    id: session.id,
    title: session.title,
    status: byId.get(session.id)?.status ?? 'idle',
    workspace: session.workingDirectory,
    updatedAt: session.updatedAt,
  }));
  if (usage.flags.json) {
    printJson(rows);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(
      `${String(row.id).padEnd(14)} ${String(row.status).padEnd(9)} ${String(row.title ?? '').slice(0, 48)}\n`,
    );
  }
  return 0;
}

async function commandRun(usage: Usage): Promise<number> {
  await requireHealth();
  const prompt = await readPrompt(usage);
  const model = textFlag(usage.flags, 'model') ?? DEFAULT_MODEL;
  const reasoning = textFlag(usage.flags, 'reasoning') ?? DEFAULT_REASONING;
  const timeoutSeconds = numberFlag(usage.flags, 'timeout', 3600);
  const cwd = textFlag(usage.flags, 'cwd');
  const title = textFlag(usage.flags, 'title') ?? `cli: ${prompt.replace(/\s+/g, ' ').slice(0, 48)}`;
  if (!usage.flags.quiet) process.stderr.write(`→ ${model} @ ${reasoning}  (${BASE})\n`);
  const deviceName = textFlag(usage.flags, 'device');
  if (deviceName) {
    const device = await resolveDevice(deviceName);
    const placement = textFlag(usage.flags, 'policy') === 'return' ? 'return' : 'stay';
    const workspaces = (await deviceRpc(device.id, 'workspaces')) as Array<{
      id: string;
      name: string;
      displayPath?: string;
    }>;
    const wanted = textFlag(usage.flags, 'workspace')?.toLowerCase();
    const workspace =
      (wanted
        ? workspaces.find(
            (row) =>
              row.id === wanted ||
              row.name.toLowerCase() === wanted ||
              row.displayPath?.toLowerCase().endsWith(wanted),
          )
        : undefined) ?? workspaces[0];
    if (!workspace)
      throw new Error(`No shared workspace on ${device.name}. Open a project there first.`);
    const chat = await deviceRpc(device.id, 'create_chat', {
      workspaceId: workspace.id,
      title,
      delegation: { placement, commit: 'none' },
    });
    process.stderr.write(
      `→ ${device.name} (${workspace.name}) placement=${placement}\n`,
    );
    const submitted = await deviceRpc(device.id, 'prompt', {
      sessionId: chat.id,
      content: prompt,
      model: normalizeModel(model),
      reasoningLevel: reasoning,
      // Explicit collaboration opt-in: stage this machine's provider login on
      // the target for this run only. It is never saved there.
      ...(usage.flags['use-local-providers'] ? { useLocalProviders: true } : {}),
    });
    if (submitted?.accepted === false)
      throw new Error(
        `Target rejected the turn: ${JSON.stringify(submitted.result ?? submitted).slice(0, 300)}`,
      );
    const result = await followDeviceSession(device, chat.id, {
      timeoutSeconds,
      quiet: Boolean(usage.flags.quiet),
    });
    const out = textFlag(usage.flags, 'out');
    if (out) writeFileSync(resolve(out), `${result.text}\n`);
    if (usage.flags.json) {
      printJson({ ...result, device: device.name, workspace: workspace.name, placement });
      return result.ok ? 0 : 1;
    }
    process.stderr.write(`✓ ${chat.id} ${result.status} ${result.seconds}s\n`);
    process.stdout.write(`${result.text}\n`);
    if (!result.ok) process.stderr.write(`✗ ${result.error ?? 'run did not produce output'}\n`);
    return result.ok ? 0 : 1;
  }

  const sessionId = await createSession(title, cwd);
  const baseline = (await readMessages(sessionId)).filter(isAssistant).length;
  await sendTurn({ sessionId, prompt, model, reasoning });
  const result = await followSession(sessionId, {
    timeoutSeconds,
    baselineMessages: baseline,
    quiet: Boolean(usage.flags.quiet),
  });
  const out = textFlag(usage.flags, 'out');
  if (out) writeFileSync(resolve(out), `${result.text}\n`);
  if (usage.flags.json) {
    printJson(result);
    return result.ok ? 0 : 1;
  }
  process.stderr.write(`✓ ${sessionId} ${result.status} ${result.seconds}s\n`);
  process.stdout.write(`${result.text}\n`);
  if (!result.ok) process.stderr.write(`✗ ${result.error ?? 'run did not produce output'}\n`);
  return result.ok ? 0 : 1;
}

async function commandWait(usage: Usage): Promise<number> {
  const sessionId = usage.positionals[0];
  if (!sessionId) throw new Error('wait requires a SESSION_ID');
  const result = await followSession(sessionId, {
    timeoutSeconds: numberFlag(usage.flags, 'timeout', 3600),
    baselineMessages: 0,
    quiet: false,
  });
  if (usage.flags.json) printJson(result);
  else process.stdout.write(`${result.text}\n`);
  return result.ok ? 0 : 1;
}

const WITHHELD_NOTICE = /response was withheld because its generation or review did not complete/i;

/**
 * A turn that ends on a withheld response is not a result. Send one
 * continuation in the same session so the agent finishes from the context it
 * already built, instead of paying for a cold restart that repeats the work.
 */
async function finishWithContinuation(
  sessionId: string,
  model: string,
  reasoning: string,
  options: { timeoutSeconds: number; baselineMessages: number; quiet: boolean },
): Promise<RunResult> {
  const first = await followSession(sessionId, options);
  if (first.ok || !first.sessionId) return first;
  const baseline = (await readMessages(sessionId)).filter(isAssistant).length;
  await sendTurn({
    sessionId,
    prompt:
      'Continue the task you were already working on. Do not restart it. Finish the analysis and deliver the required artifact or report, then state your numbers.',
    model: normalizeModel(model),
    reasoningLevel: reasoning,
  });
  const second = await followSession(sessionId, { ...options, baselineMessages: baseline });
  return {
    ...second,
    ok: second.ok,
    text: [first.text, second.text].filter((chunk) => chunk.trim().length > 0).join('\n\n'),
  };
}

type PlanAgent = { id: string; cwd?: string; title?: string; promptFile?: string; prompt?: string };
type Plan = { model?: string; reasoning?: string; timeout?: number; agents: PlanAgent[] };

async function commandCollect(usage: Usage): Promise<number> {
  await requireHealth();
  const sessionId = usage.positionals[0];
  if (!sessionId) throw new Error('collect requires a target SESSION_ID');
  const deviceName = textFlag(usage.flags, 'device');
  if (!deviceName) throw new Error('collect requires --device NAME|ID');
  const device = await resolveDevice(deviceName);
  const bundle = await deviceRpc(device.id, 'export_work', { sessionId });
  if (bundle?.placement !== 'return' && !usage.flags.force)
    throw new Error(
      'This chat is set to keep its work on the target. Pass --force only if the user explicitly asked to copy it back.',
    );
  const outDir = resolve(textFlag(usage.flags, 'out') ?? `kory-returned-${sessionId}`);
  const filesRoot = join(outDir, 'files');
  mkdirSync(filesRoot, { recursive: true });
  if (typeof bundle?.patch === 'string' && bundle.patch)
    writeFileSync(join(outDir, 'changes.patch'), bundle.patch, { mode: 0o600 });
  let written = 0;
  for (const file of (bundle?.files ?? []) as Array<{ path: string; content?: string }>) {
    if (typeof file.content !== 'string') continue;
    const relative = file.path.replaceAll('\\', '/');
    if (relative.startsWith('/') || relative.split('/').includes('..')) continue;
    const target = join(filesRoot, relative);
    if (!target.startsWith(`${filesRoot}${sep}`)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, { mode: 0o600 });
    written += 1;
  }
  writeFileSync(join(outDir, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, {
    mode: 0o600,
  });
  if (usage.flags.json) {
    printJson({ outDir, files: written, truncated: Boolean(bundle?.truncated) });
    return 0;
  }
  process.stdout.write(`${outDir}\n`);
  process.stdout.write(
    `${written} file(s) copied. Nothing was applied, committed, or pushed.\n`,
  );
  return 0;
}

async function commandDispatch(usage: Usage): Promise<number> {
  await requireHealth();
  const planPath = textFlag(usage.flags, 'plan');
  if (!planPath) throw new Error('dispatch requires --plan FILE');
  const plan = JSON.parse(readFileSync(resolve(planPath), 'utf-8')) as Plan;
  if (!Array.isArray(plan.agents) || plan.agents.length === 0) {
    throw new Error('plan.agents must be a non-empty array');
  }
  const model = textFlag(usage.flags, 'model') ?? plan.model ?? DEFAULT_MODEL;
  const reasoning = textFlag(usage.flags, 'reasoning') ?? plan.reasoning ?? DEFAULT_REASONING;
  const timeoutSeconds = numberFlag(usage.flags, 'timeout', plan.timeout ?? 7200);
  const concurrency = Math.max(1, numberFlag(usage.flags, 'concurrency', 3));
  const outDir = resolve(textFlag(usage.flags, 'out') ?? `kory-dispatch-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });

  process.stderr.write(
    `dispatch: ${plan.agents.length} agents, ${model} @ ${reasoning}, concurrency ${concurrency}\n` +
      `output:   ${outDir}\n`,
  );

  const results: RunResult[] = [];
  const queue = [...plan.agents];
  const worker = async (): Promise<void> => {
    for (;;) {
      const agent = queue.shift();
      if (!agent) return;
      const agentId = agent.id || `agent-${results.length + 1}`;
      try {
        const prompt =
          agent.prompt ??
          (agent.promptFile ? readFileSync(resolve(agent.promptFile), 'utf-8') : undefined);
        if (!prompt) throw new Error('agent has neither prompt nor promptFile');
        const sessionId = await createSession(agent.title ?? agentId, agent.cwd);
        const baseline = (await readMessages(sessionId)).filter(isAssistant).length;
        await sendTurn({ sessionId, prompt, model, reasoning });
        const result = await finishWithContinuation(sessionId, model, reasoning, {
          timeoutSeconds,
          baselineMessages: baseline,
          quiet: false,
        });
        results.push(result);
        writeFileSync(
          join(outDir, `${agentId}.md`),
          `# ${agentId}\n\n- session: ${sessionId}\n- model: ${model}\n- reasoning: ${reasoning}\n` +
            `- status: ${result.status}\n- ok: ${result.ok}\n- seconds: ${result.seconds}\n` +
            (result.error ? `- error: ${result.error}\n` : '') +
            `\n---\n\n${result.text}\n`,
        );
        process.stderr.write(`${result.ok ? '✓' : '✗'} ${agentId} → ${sessionId}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed: RunResult = {
          ok: false,
          sessionId: '',
          status: 'error',
          text: '',
          seconds: 0,
          error: message,
        };
        results.push(failed);
        writeFileSync(join(outDir, `${agentId}.md`), `# ${agentId}\n\n- error: ${message}\n`);
        process.stderr.write(`✗ ${agentId}: ${message}\n`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, plan.agents.length) }, worker));

  const summary = {
    model,
    reasoning,
    startedAgents: plan.agents.length,
    finished: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
  writeFileSync(join(outDir, 'SUMMARY.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    join(outDir, 'SUMMARY.md'),
    `# Dispatch summary\n\n- model: ${model}\n- reasoning: ${reasoning}\n` +
      `- agents: ${plan.agents.length}\n- ok: ${summary.finished}\n- failed: ${summary.failed}\n\n` +
      `| agent | session | status | seconds | ok |\n| --- | --- | --- | --- | --- |\n` +
      results
        .map((r) => `| ${r.sessionId || '—'} | ${r.sessionId || '—'} | ${r.status} | ${r.seconds} | ${r.ok ? 'yes' : 'no'} |`)
        .join('\n') +
      '\n',
  );
  if (usage.flags.json) printJson(summary);
  else process.stdout.write(`${summary.finished}/${plan.agents.length} agents finished; summary in ${outDir}\n`);
  return summary.failed === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const usage = parseArgs(process.argv.slice(2));
  switch (usage.command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case 'status':
      return commandStatus(usage);
    case 'models':
      return commandModels(usage);
    case 'sessions':
      return commandSessions(usage);
    case 'targets':
      return commandTargets(usage);
    case 'run':
      return commandRun(usage);
    case 'dispatch':
      return commandDispatch(usage);
    case 'wait':
      return commandWait(usage);
    case 'unblock':
      return commandUnblock(usage);
    case 'collect':
      return commandCollect(usage);
    default:
      process.stderr.write(`unknown command: ${usage.command}\n\n${HELP}`);
      return 64;
  }
}

const exitCode = await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`koryphaios: ${message}\n`);
  return 1;
});
process.exit(exitCode);
