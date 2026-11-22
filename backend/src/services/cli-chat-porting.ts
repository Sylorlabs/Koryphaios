// CLI Chat Porting & Discovery Service
//
// Scans local storage directories of ALL supported CLI coding agents across the
// machine—unconditionally, regardless of whether their CLI binary is currently
// on PATH—groups discoverable conversations per project directory, and ports
// user-selected conversations into Koryphaios sessions + message lineages.

import { Database } from 'bun:sqlite';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nanoid } from 'nanoid';
import {
  reduceTurnParts,
  type ProviderName,
  type Session as SharedSession,
  type MessageAttachment,
  type SubagentTranscript,
  type SubagentTurn,
  type TranscriptPart,
  type TurnEvent,
} from '@koryphaios/shared';
import { ID, MESSAGE, SESSION } from '../constants';
import { db, messages, sessions } from '../db';
import { eq } from 'drizzle-orm';
import { serverLog } from '../logger';
import { isContainedBy, isMac, isWindows } from '../runtime/platform';
import {
  genericMessagesToRows,
  listProjectTranscriptFiles,
  loadAntigravityConversation,
  parseCodeBuddyTranscript,
  parsePiSessionFile,
  readAntigravityRelations,
  scanCursorAgentChats,
  scanGrokSessions,
  scanKimiSessions,
  antigravityTranscriptPath,
  type AntigravityRelations,
  type PortedChat,
  type PortingHelpers,
} from './cli-chat-porting-providers';

export interface CliProviderScanSummary {
  id: string;
  provider: ProviderName;
  displayName: string;
  checked: true;
  storageFound: boolean;
  checkedPaths: string[];
  chatCount: number;
  projectCount: number;
}

export interface DiscoveredCliChatMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  model?: string;
}

export interface DiscoveredCliChat {
  /** Globally unique key across providers: `${provider}:${externalId}` */
  id: string;
  externalId: string;
  provider: ProviderName;
  providerDisplayName: string;
  projectPath: string;
  projectName: string;
  title: string;
  preview: string;
  model?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  alreadyImported: boolean;
  importedSessionId?: string;
  sampleMessages: DiscoveredCliChatMessage[];
}

export interface DiscoveredCliProjectGroup {
  projectPath: string;
  projectName: string;
  chatCount: number;
  providers: Array<{
    provider: ProviderName;
    displayName: string;
    chatCount: number;
  }>;
  latestUpdatedAt: number;
  chats: DiscoveredCliChat[];
}

export interface CliChatDiscoveryResult {
  providers: CliProviderScanSummary[];
  projects: DiscoveredCliProjectGroup[];
  totalChats: number;
  totalProjects: number;
}

export interface ImportCliChatsInput {
  chatIds: string[];
}

export interface ImportedCliSessionSummary {
  chatId: string;
  sessionId: string;
  provider: ProviderName;
  projectPath: string;
  title: string;
  messageCount: number;
  status: 'imported' | 'already_imported';
}

export interface ImportCliChatsResult {
  importedCount: number;
  alreadyImportedCount: number;
  sessions: SharedSession[];
  items: ImportedCliSessionSummary[];
}

export interface CliChatPortingOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  maxChatsPerProvider?: number;
}

/**
 * A transcript row as read from a CLI's storage at import time. Assistant rows
 * may carry the turn's structured activity (reasoning, tool calls and tool
 * results) as `events`; a row with events but no text (for example a Claude
 * Code `tool_result` line) still belongs to the surrounding assistant turn.
 * Events never leave the backend: discovery samples are text-only.
 */
interface ImportedCliMessage extends DiscoveredCliChatMessage {
  events?: TurnEvent[];
  /** The source recorded no time for this row; `timestamp` only orders it. */
  timeUnknown?: true;
  /** Images or files the user attached in the source (base64 payloads). */
  attachments?: MessageAttachment[];
}

interface InternalDiscoveredChat extends DiscoveredCliChat {
  loadMessages: () => ImportedCliMessage[];
}

interface CliProviderCatalogEntry {
  id: string;
  provider: ProviderName;
  displayName: string;
  resolveCandidateRoots: (home: string, env: NodeJS.ProcessEnv) => string[];
  scanRoot: (root: string, maxChats: number) => InternalDiscoveredChat[];
}

const MAX_DISCOVERY_JSONL_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_JSON_BYTES = 64 * 1024 * 1024;
/** Import reads a whole transcript: a head/tail splice silently drops the middle of a long chat. */
const MAX_IMPORT_JSONL_BYTES = 256 * 1024 * 1024;
const MAX_SAMPLE_MESSAGES = 4;
const MAX_SAMPLE_CONTENT_CHARS = 600;
/**
 * Safety valve on persisted turns (a user message or one merged assistant turn)
 * per imported chat. Real chats never reach it; hitting it logs a warning.
 */
const MAX_IMPORTED_MESSAGES_PER_CHAT = 1_000_000;
/**
 * Safety valve on raw source rows read for one chat (tool calls and results are
 * separate rows). Real chats never reach it; hitting it logs a warning.
 */
const MAX_RAW_SOURCE_ROWS = 5_000_000;
/**
 * Import keeps every value whole. Only a single pathological value (one tool
 * output, one argument string, one message) is cut, and always with an explicit
 * "[truncated N characters on import]" marker.
 */
const MAX_IMPORTED_VALUE_CHARS = 2 * 1024 * 1024;
const MAX_IMPORTED_TOOL_INPUT_DEPTH = 32;
const MAX_IMPORTED_TOOL_INPUT_ITEMS = 10_000;
/** Largest attachment file read from a source's disk (e.g. a pasted image). */
const MAX_IMPORTED_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Same block type `message-store.ts` persists an assistant turn's ordered display parts under. */
const TRANSCRIPT_PARTS_BLOCK = 'kory_transcript_parts';
/** Same block type `message-store.ts` persists row metadata (e.g. `timeUnknown`) under. */
const MESSAGE_META_BLOCK = 'kory_message_meta';

function caseInsensitiveFs(): boolean {
  return isMac() || isWindows();
}

function projectKey(projectPath: string): string {
  return caseInsensitiveFs() ? projectPath.toLowerCase() : projectPath;
}

function expandSiblingProfiles(baseDir: string, prefix: string): string[] {
  const results = new Set<string>([join(baseDir, prefix)]);
  try {
    if (!existsSync(baseDir)) return [...results];
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name === prefix ||
        entry.name.startsWith(`${prefix}-`) ||
        entry.name.startsWith(`${prefix}_`)
      ) {
        results.add(join(baseDir, entry.name));
      }
    }
  } catch {
    // Ignore unreadable parent directory.
  }
  return [...results];
}

function normalizeTimestampMs(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Seconds vs milliseconds heuristic (timestamps < 1e11 are unix seconds).
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num) && num > 0) {
        return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
      }
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      // Reject sentinel years like 0001-01-01
      if (parsed < Date.UTC(2000, 0, 1)) return fallback;
      return parsed;
    }
    // Handle Freebuff timestamp directory names like 2026-10-15T04-39-46.594Z
    const isoFixed = trimmed.replace(
      /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z?)$/,
      '$1:$2:$3',
    );
    const parsedFixed = Date.parse(isoFixed);
    if (Number.isFinite(parsedFixed) && parsedFixed >= Date.UTC(2000, 0, 1)) {
      return parsedFixed;
    }
  }
  return fallback;
}

/** A timestamp the source actually recorded, or undefined. Never invents "now". */
function sourceTimestampMs(value: unknown): number | undefined {
  const none = -1;
  const ms = normalizeTimestampMs(value, none);
  return ms === none ? undefined : ms;
}

const realpathCache = new Map<string, string>();

function canonicalizeProjectPath(rawPath: string | null | undefined, fallbackHome: string): string {
  const trimmed = (rawPath ?? '').trim();
  if (!trimmed) return fallbackHome;

  let normalized = trimmed;
  if (normalized.startsWith('file://')) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      normalized = normalized.replace(/^file:\/\//, '');
    }
  }

  // Strip trailing slashes except root "/"
  if (normalized.length > 1) {
    normalized = normalized.replace(/[\\/]+$/, '');
  }

  const cached = realpathCache.get(normalized);
  if (cached) return cached;

  let resolved = normalized;
  try {
    if (existsSync(normalized)) {
      resolved = realpathSync.native(normalized);
    } else {
      resolved = resolve(normalized);
    }
  } catch {
    resolved = normalized;
  }

  realpathCache.set(normalized, resolved);
  return resolved;
}

function projectNameFromPath(projectPath: string): string {
  const clean = projectPath.replace(/[\\/]+$/, '');
  if (!clean || clean === '/') return 'Root';
  return basename(clean) || clean;
}

function cleanMessageText(raw: string): string {
  if (!raw) return "";
  let text = raw;

  // Extract inner <user_request> or <USER_REQUEST> when wrapped in Antigravity/T3 harness tags.
  const exactLowerMatch = text.match(/<user_request>\s*([\s\S]*?)\s*<\/user_request>/);
  if (exactLowerMatch?.[1]) {
    text = exactLowerMatch[1].trim();
  } else {
    const exactUpperMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    if (exactUpperMatch?.[1]) {
      text = exactUpperMatch[1].trim();
    }
  }

  // Strip common CLI harness wrapper blocks if still present.
  text = text
    .replace(/<t3_code_instructions\b[^>]*>[\s\S]*?<\/t3_code_instructions>/gi, "")
    .replace(/<pull_request_linking\b[^>]*>[\s\S]*?<\/pull_request_linking>/gi, "")
    .replace(/<runtime_info\b[^>]*>[\s\S]*?<\/runtime_info>/gi, "")
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<local-command-caveat\b[^>]*>[\s\S]*?<\/local-command-caveat>/gi, "")
    .trim();

  // Imported text is kept whole; only a pathological value is cut, and visibly.
  return capText(text, MAX_IMPORTED_VALUE_CHARS);
}

function isNoiseUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<local-command-stdout>') ||
    trimmed.startsWith('<local-command-stderr>') ||
    trimmed.startsWith('<system-reminder') ||
    trimmed.startsWith('<task-notification>')
  ) {
    return true;
  }
  return false;
}

function isGenericAutoTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    lower === 'new session' ||
    lower === 'new chat' ||
    lower === 'untitled' ||
    lower === 'start new conversation' ||
    /^new session\s*-\s*\d{4}-\d{2}-\d{2}/i.test(title)
  );
}

function deriveChatTitle(explicitTitle: string | null | undefined, firstUserText: string): string {
  const cleanExplicit = cleanMessageText(explicitTitle ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanExplicit && !isGenericAutoTitle(cleanExplicit)) {
    return cleanExplicit.slice(0, SESSION.MAX_TITLE_LENGTH);
  }
  const cleanFirst = cleanMessageText(firstUserText).replace(/\s+/g, ' ').trim();
  if (cleanFirst) {
    return cleanFirst.length > 72 ? `${cleanFirst.slice(0, 69)}...` : cleanFirst;
  }
  if (cleanExplicit) {
    return cleanExplicit.slice(0, SESSION.MAX_TITLE_LENGTH);
  }
  return 'Imported CLI Chat';
}

function derivePreview(
  explicitPreview: string | null | undefined,
  msgs: DiscoveredCliChatMessage[],
): string {
  const fromMessages =
    msgs.find((m) => m.role === 'user' && m.content.trim())?.content ??
    msgs.find((m) => m.content.trim())?.content ??
    '';
  const candidate = cleanMessageText(fromMessages || (explicitPreview ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!candidate) return 'No message preview available';
  return candidate.length > 160 ? `${candidate.slice(0, 157)}...` : candidate;
}

function extractTextFromContentField(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type : '';
    if (
      type === 'text' ||
      type === 'input_text' ||
      type === 'output_text' ||
      (!type && typeof block.text === 'string')
    ) {
      if (typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text);
      } else if (typeof block.content === 'string' && block.content.trim()) {
        parts.push(block.content);
      }
    }
  }
  return parts.join('\n\n');
}

function readHeadAndTailText(filePath: string, maxBytes = MAX_DISCOVERY_JSONL_BYTES): string {
  const stat = statSync(filePath);
  if (stat.size <= maxBytes) {
    return readFileSync(filePath, 'utf8');
  }
  const fd = openSync(filePath, 'r');
  try {
    const half = Math.floor(maxBytes / 2);
    const headBuf = Buffer.alloc(half);
    const tailBuf = Buffer.alloc(half);
    const headRead = readSync(fd, headBuf, 0, half, 0);
    const tailRead = readSync(fd, tailBuf, 0, half, Math.max(0, stat.size - half));
    const headStr = headBuf.subarray(0, headRead).toString('utf8');
    const tailStr = tailBuf.subarray(0, tailRead).toString('utf8');
    const lastHeadNewline = headStr.lastIndexOf('\n');
    const firstTailNewline = tailStr.indexOf('\n');
    return (
      (lastHeadNewline >= 0 ? headStr.slice(0, lastHeadNewline) : headStr) +
      '\n' +
      (firstTailNewline >= 0 ? tailStr.slice(firstTailNewline + 1) : tailStr)
    );
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a transcript file. Discovery may use the bounded head/tail splice; import
 * reads the whole file so a long chat is never ported with its middle missing.
 */
function readTranscriptText(filePath: string, forImport: boolean): string {
  return readHeadAndTailText(filePath, forImport ? MAX_IMPORT_JSONL_BYTES : MAX_DISCOVERY_JSONL_BYTES);
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters on import]`;
}

/**
 * Flatten a tool result payload (string, content-block array or JSON) into
 * display text. The whole output is kept; only a single value past the 2 MB
 * safety valve is cut, with an explicit marker.
 */
function toolOutputText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return capText(value, MAX_IMPORTED_VALUE_CHARS);
  if (Array.isArray(value)) {
    const pieces: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') pieces.push(item);
      else if (item && typeof item === 'object') {
        const block = item as Record<string, unknown>;
        if (typeof block.text === 'string') pieces.push(block.text);
        else if (block.type === 'image' || block.type === 'input_image') pieces.push('[image]');
      }
    }
    if (pieces.length > 0) return capText(pieces.join('\n'), MAX_IMPORTED_VALUE_CHARS);
  }
  try {
    return capText(JSON.stringify(value), MAX_IMPORTED_VALUE_CHARS);
  } catch {
    return '';
  }
}

/**
 * Keep a tool call's arguments whole. Only pathological shapes are bounded
 * (nesting past 32 levels, an array past 10,000 items, one string past 2 MB),
 * and each cut leaves an explicit marker instead of silently dropping data.
 */
function capToolInputValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return capText(value, MAX_IMPORTED_VALUE_CHARS);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_IMPORTED_TOOL_INPUT_DEPTH) {
    let serialized = '';
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
    return `[nested deeper than ${MAX_IMPORTED_TOOL_INPUT_DEPTH} levels; kept as JSON on import] ${capText(serialized, MAX_IMPORTED_VALUE_CHARS)}`;
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_IMPORTED_TOOL_INPUT_ITEMS)
      .map((item) => capToolInputValue(item, depth + 1));
    if (value.length > MAX_IMPORTED_TOOL_INPUT_ITEMS) {
      kept.push(`[truncated ${value.length - MAX_IMPORTED_TOOL_INPUT_ITEMS} items on import]`);
    }
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = capToolInputValue(inner, depth + 1);
  }
  return out;
}

/** Normalize a tool call's arguments (object, JSON string or raw string) into a bounded record. */
function toolInputRecord(value: unknown): Record<string, unknown> {
  let candidate = value;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (trimmed.startsWith('{')) {
      try {
        candidate = JSON.parse(trimmed);
      } catch {
        candidate = { input: trimmed };
      }
    } else {
      candidate = trimmed ? { input: trimmed } : {};
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return candidate === undefined || candidate === null ? {} : { input: candidate };
  }
  return capToolInputValue(candidate, 0) as Record<string, unknown>;
}

/** Public discovery samples carry text only; structured turn events stay server-side. */
function toPublicSamples(msgs: readonly ImportedCliMessage[]): DiscoveredCliChatMessage[] {
  const samples: DiscoveredCliChatMessage[] = [];
  for (const msg of msgs) {
    if (!msg.content.trim()) continue;
    const sample: DiscoveredCliChatMessage = {
      role: msg.role,
      // The picker shows a three-line preview; whole messages made the
      // discovery payload several megabytes on a real machine.
      content: msg.content.length > MAX_SAMPLE_CONTENT_CHARS
        ? `${msg.content.slice(0, MAX_SAMPLE_CONTENT_CHARS)}…`
        : msg.content,
      createdAt: msg.createdAt,
    };
    if (msg.model) sample.model = msg.model;
    samples.push(sample);
    if (samples.length >= MAX_SAMPLE_MESSAGES) break;
  }
  return samples;
}

interface ImportTurn {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** No source time for this turn; `createdAt` only orders it. */
  timeUnknown?: true;
  model?: string;
  /** Present only when the turn has reasoning or tool activity to display. */
  parts?: TranscriptPart[];
  attachments?: MessageAttachment[];
}

// ─── Honest time and display helpers shared by every parser ─────────────────

/** A recorded duration, or one computed from a recorded start and end. Never a guess. */
function knownDurationMs(opts: {
  durationMs?: unknown;
  startedAt?: number;
  endedAt?: number;
}): number | undefined {
  const d = opts.durationMs;
  if (typeof d === 'number' && Number.isFinite(d) && d >= 0) return Math.round(d);
  if (
    opts.startedAt !== undefined &&
    opts.endedAt !== undefined &&
    Number.isFinite(opts.startedAt) &&
    Number.isFinite(opts.endedAt) &&
    opts.endedAt >= opts.startedAt
  ) {
    return Math.round(opts.endedAt - opts.startedAt);
  }
  return undefined;
}

/**
 * A tool result event. Without a recorded duration it is marked `timeUnknown`
 * and carries no `durationMs`, so the UI can never render a made-up "0.0s".
 */
function toolResultEvent(input: {
  callId: string;
  name: string;
  output: string;
  isError?: boolean;
  timestamp: number;
  durationMs?: number;
  subagent?: SubagentTranscript;
}): TurnEvent {
  const event: Extract<TurnEvent, { type: 'tool_result' }> = {
    type: 'tool_result',
    callId: input.callId,
    name: input.name,
    output: input.output,
    isError: input.isError === true,
    timestamp: input.timestamp,
  };
  if (input.durationMs !== undefined) event.durationMs = input.durationMs;
  else event.timeUnknown = true;
  if (input.subagent) event.subagent = input.subagent;
  return event;
}

/**
 * Reasoning events. The block's duration is known only when the source recorded
 * its own start and end (or a duration anchored to one of them); then the part
 * is closed at its real end with a `complete` event. Otherwise the reasoning is
 * `timeUnknown` — several blocks sharing one message timestamp is not a 0 ms
 * thought.
 */
function reasoningEvents(
  text: string,
  opts: {
    timestamp: number;
    startedAt?: number;
    endedAt?: number;
    durationMs?: unknown;
    thinkingTokens?: number;
  },
): TurnEvent[] {
  if (!text.trim() && opts.thinkingTokens === undefined) return [];
  const duration =
    typeof opts.durationMs === 'number' && Number.isFinite(opts.durationMs) && opts.durationMs >= 0
      ? opts.durationMs
      : undefined;
  let start = opts.startedAt;
  let end = opts.endedAt;
  if (duration !== undefined) {
    if (end !== undefined && start === undefined) start = end - duration;
    else if (start !== undefined && end === undefined) end = start + duration;
  }
  const reasoning: Extract<TurnEvent, { type: 'reasoning' }> = {
    type: 'reasoning',
    text,
    timestamp: opts.timestamp,
  };
  if (opts.thinkingTokens !== undefined) reasoning.thinkingTokens = opts.thinkingTokens;
  if (start !== undefined && end !== undefined && end >= start) {
    reasoning.timestamp = Math.round(start);
    return [reasoning, { type: 'complete', timestamp: Math.round(end) }];
  }
  reasoning.timeUnknown = true;
  return [reasoning];
}

/**
 * A system notice the source showed in its own transcript (an API error, an
 * interruption, a session-limit message). It is display-only: a tool part named
 * `notice`, never assistant text, so it is not replayed to a provider.
 */
function noticeEvents(
  key: string,
  kind: string,
  text: string,
  timestamp: number,
  isError = false,
): TurnEvent[] {
  const callId = `notice:${key}`;
  return [
    { type: 'tool_call', callId, name: 'notice', input: { kind }, timestamp },
    toolResultEvent({ callId, name: 'notice', output: text, isError, timestamp }),
  ];
}

/** The sub-agent's last assistant text: what it handed back to its parent. */
function subagentFinalAnswer(sub: SubagentTranscript): string {
  for (let i = sub.turns.length - 1; i >= 0; i--) {
    const turn = sub.turns[i];
    if (turn.role !== 'assistant') continue;
    for (let j = turn.parts.length - 1; j >= 0; j--) {
      const part = turn.parts[j];
      if (part.kind === 'text' && part.text.trim()) return part.text;
    }
  }
  return '';
}

/**
 * A synthetic tool part for a sub-agent whose spawning call the source does not
 * identify (or for a context compaction run). Placed where the run happened.
 */
function synthesizedSubagentEvents(
  sub: SubagentTranscript,
  timestamp: number,
  opts: { key?: string; durationMs?: number; isError?: boolean } = {},
): TurnEvent[] {
  const callId = `subagent:${opts.key ?? sub.agentId ?? sub.name}`;
  return [
    { type: 'tool_call', callId, name: 'subagent', input: { task: sub.task ?? '' }, timestamp },
    toolResultEvent({
      callId,
      name: 'subagent',
      output: subagentFinalAnswer(sub),
      isError: opts.isError,
      timestamp,
      durationMs: opts.durationMs,
      subagent: sub,
    }),
  ];
}

/**
 * Fold a sub-agent's own transcript rows into a nested transcript with the same
 * turn builder the parent uses. Turns whose time the source never recorded
 * carry no `createdAt`.
 */
function buildSubagentTranscript(
  meta: { agentId?: string; name: string; task?: string; model?: string; provider?: string },
  raw: readonly ImportedCliMessage[],
  startMs?: number,
): SubagentTranscript {
  const turns: SubagentTurn[] = [];
  for (const turn of buildImportTurns(raw, startMs)) {
    const createdAt = turn.timeUnknown ? undefined : turn.createdAt;
    if (turn.role === 'user') {
      turns.push(createdAt === undefined ? { role: 'user', text: turn.content } : { role: 'user', text: turn.content, createdAt });
      continue;
    }
    const parts: TranscriptPart[] =
      turn.parts ?? (turn.content ? [{ kind: 'text', text: turn.content, startedAt: turn.createdAt }] : []);
    turns.push(createdAt === undefined ? { role: 'assistant', parts } : { role: 'assistant', parts, createdAt });
  }
  const sub: SubagentTranscript = { name: meta.name, turns };
  if (meta.agentId) sub.agentId = meta.agentId;
  if (meta.task) sub.task = meta.task;
  if (meta.model) sub.model = meta.model;
  if (meta.provider) sub.provider = meta.provider;
  return sub;
}

/**
 * Give rows the source recorded no time for an ordering-only timestamp:
 * interpolated between their known neighbours, else anchored on the chat's
 * known start. The rows stay `timeUnknown`; their reasoning and tool results
 * are marked unknown too, so nothing downstream presents the placeholder as a
 * real time or duration. Never uses the import time.
 */
function assignOrderingTimes(
  raw: readonly ImportedCliMessage[],
  chatStartMs?: number,
): ImportedCliMessage[] {
  if (!raw.some((m) => m.timeUnknown)) return raw.slice();
  const out = raw.slice();
  let i = 0;
  while (i < out.length) {
    if (!out[i].timeUnknown) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < out.length && out[j].timeUnknown) j += 1;
    const count = j - i;
    const before = i > 0 ? out[i - 1].createdAt : undefined;
    const after = j < out.length ? out[j].createdAt : undefined;
    let start: number;
    let step: number;
    if (before !== undefined && after !== undefined && after > before) {
      step = (after - before) / (count + 1);
      start = before + step;
    } else if (before !== undefined) {
      step = 1;
      start = before + 1;
    } else if (after !== undefined) {
      const lo =
        chatStartMs !== undefined && chatStartMs > 0 && chatStartMs < after
          ? chatStartMs
          : after - count - 1;
      step = (after - lo) / (count + 1);
      start = lo;
    } else {
      start = chatStartMs !== undefined && chatStartMs > 0 ? chatStartMs : out[i].createdAt;
      step = 1;
    }
    for (let k = i; k < j; k++) {
      const t = Math.round(start + (k - i) * step);
      const row = out[k];
      out[k] = {
        ...row,
        createdAt: t,
        events: row.events?.map((event): TurnEvent => {
          if (event.type === 'reasoning') return { ...event, timestamp: t, timeUnknown: true };
          if (event.type === 'tool_result') {
            return event.durationMs !== undefined && !event.timeUnknown
              ? { ...event, timestamp: t }
              : { ...event, timestamp: t, timeUnknown: true };
          }
          return { ...event, timestamp: t };
        }),
      };
    }
    i = j;
  }
  return out;
}

/**
 * Fold raw transcript rows into persisted turns.
 *
 * CLIs store one assistant turn as many rows (Claude Code writes one line per
 * content block, Codex/OpenCode one row per step, tool results as separate
 * rows). Consecutive assistant rows are one turn here, folded through the shared
 * `reduceTurnParts` reducer, so ordering inside the turn is decided by the same
 * code that orders a live Koryphaios turn. Text stays the provider-facing
 * content; reasoning and tool activity are display-only `parts`.
 */
function buildImportTurns(input: readonly ImportedCliMessage[], chatStartMs?: number): ImportTurn[] {
  const raw = assignOrderingTimes(input, chatStartMs);
  const turns: ImportTurn[] = [];
  let pending:
    | {
        parts: TranscriptPart[];
        createdAt: number;
        lastAt: number;
        /** At least one of the turn's rows carries a time the source recorded. */
        anyKnownTime: boolean;
        model?: string;
        /** Source call id -> call id of its most recent call in this turn. */
        callAliases: Map<string, string>;
      }
    | null = null;

  const flush = () => {
    if (!pending) return;
    // A call the source never recorded a result for has no duration either.
    const parts = reduceTurnParts(pending.parts, { type: 'complete', timestamp: pending.lastAt }).map(
      (part): TranscriptPart =>
        part.kind === 'tool' && part.endedAt === undefined && !part.timeUnknown
          ? { ...part, timeUnknown: true }
          : part,
    );
    const content = capText(
      parts
        .filter((part): part is Extract<TranscriptPart, { kind: 'text' }> => part.kind === 'text')
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join('\n\n'),
      MAX_IMPORTED_VALUE_CHARS,
    );
    const structured = parts.some((part) => part.kind !== 'text');
    if (content || structured) {
      const turn: ImportTurn = { role: 'assistant', content, createdAt: pending.createdAt };
      if (!pending.anyKnownTime) turn.timeUnknown = true;
      if (pending.model) turn.model = pending.model;
      if (structured) turn.parts = parts;
      turns.push(turn);
    }
    pending = null;
  };

  for (const msg of raw) {
    if (msg.role === 'user') {
      flush();
      const hasAttachments = (msg.attachments?.length ?? 0) > 0;
      if (!msg.content.trim() && !hasAttachments) continue;
      const turn: ImportTurn = { role: 'user', content: msg.content, createdAt: msg.createdAt };
      if (msg.timeUnknown) turn.timeUnknown = true;
      if (msg.model) turn.model = msg.model;
      if (hasAttachments) turn.attachments = msg.attachments;
      turns.push(turn);
      continue;
    }

    const events: TurnEvent[] =
      msg.events ??
      (msg.content.trim() ? [{ type: 'text', text: msg.content, timestamp: msg.createdAt }] : []);
    if (events.length === 0) continue;
    if (!pending) {
      pending = {
        parts: [],
        createdAt: msg.createdAt,
        lastAt: msg.createdAt,
        anyKnownTime: false,
        callAliases: new Map(),
      };
    }
    if (!msg.timeUnknown) pending.anyKnownTime = true;
    if (!pending.model && msg.model) pending.model = msg.model;
    for (const event of events) {
      let next = event;
      if (event.type === 'tool_call') {
        // Some CLIs reuse step-local call ids (`call_1`) across steps; merged
        // into one turn, a reused id would fold two calls into one part.
        let callId = event.callId;
        if (pending.callAliases.has(event.callId)) {
          callId = `${event.callId}#${pending.parts.length}`;
        }
        pending.callAliases.set(event.callId, callId);
        if (callId !== event.callId) next = { ...event, callId };
      } else if (event.type === 'tool_result') {
        const callId = pending.callAliases.get(event.callId) ?? event.callId;
        if (callId !== event.callId) next = { ...event, callId };
      } else if (event.type === 'text') {
        if (!event.text.trim()) continue;
        // Separate rows' text would otherwise be glued mid-sentence by the
        // reducer's same-kind merge.
        const last = pending.parts[pending.parts.length - 1];
        if (last && last.kind === 'text' && !/\s$/.test(last.text)) {
          next = { ...event, text: `\n\n${event.text}` };
        }
      }
      pending.parts = reduceTurnParts(pending.parts, next);
      if (event.timestamp > pending.lastAt) pending.lastAt = event.timestamp;
    }
  }
  flush();
  return turns;
}

/** Number of persisted turns a transcript folds into (what discovery should advertise). */
function countImportTurns(msgs: readonly ImportedCliMessage[]): number {
  let count = 0;
  let previous: 'user' | 'assistant' | null = null;
  for (const msg of msgs) {
    if (msg.role === 'user') {
      if (!msg.content.trim() && !(msg.attachments?.length ?? 0)) continue;
      count += 1;
      previous = 'user';
    } else if (previous !== 'assistant' && (msg.content.trim() || (msg.events?.length ?? 0) > 0)) {
      count += 1;
      previous = 'assistant';
    }
  }
  return count;
}

/**
 * Open another tool's SQLite store read-only.
 *
 * A WAL-mode database whose `-shm` sidecar is absent cannot be opened read-only
 * (SQLITE_CANTOPEN surfaces lazily at the first prepare), and creating the
 * sidecar would write into the tool's storage. Codex's `thread_history_*.sqlite`
 * is routinely in that state, and the uncaught prepare failure used to abort the
 * whole Codex scan. Fall back to an immutable snapshot read, and return null when
 * the store is unreadable so callers use their file-based fallback.
 */
function openReadonlySqlite(dbPath: string): Database | null {
  const probe = (conn: Database): Database | null => {
    try {
      conn.query('SELECT 1 FROM sqlite_master LIMIT 1').get();
      return conn;
    } catch {
      try {
        conn.close();
      } catch {}
      return null;
    }
  };
  try {
    const conn = probe(new Database(dbPath, { readonly: true }));
    if (conn) return conn;
  } catch {
    // Fall through to the immutable snapshot.
  }
  try {
    return probe(new Database(`${pathToFileURL(dbPath).href}?immutable=1`, { readonly: true }));
  } catch {
    return null;
  }
}

/**
 * Decode a Claude/CodeBuddy/WorkBuddy encoded project directory slug
 * (e.g. `-Users-Shared-micah-Documents-koryphaios`) when no `cwd` field is
 * present inside the JSONL lines.
 */
function decodeEncodedProjectDir(encodedName: string, fallbackHome: string): string {
  if (!encodedName.startsWith('-')) return fallbackHome;
  const naive = encodedName.replace(/^-/, '/').replace(/-/g, '/');
  if (existsSync(naive)) return naive;

  // Greedy segment resolver from `/` downwards so hyphenated folder names
  // like `koryphaios-worktrees` or `my-app` resolve accurately when on disk.
  const tokens = encodedName.replace(/^-+/, '').split('-').filter(Boolean);
  let current = '/';
  let i = 0;
  while (i < tokens.length) {
    let matched: string | null = null;
    for (let j = tokens.length; j > i; j--) {
      const candidateSegment = tokens.slice(i, j).join('-');
      const candidatePath = join(current, candidateSegment);
      if (existsSync(candidatePath)) {
        matched = candidatePath;
        i = j;
        break;
      }
    }
    if (matched) {
      current = matched;
    } else {
      current = join(current, tokens[i]);
      i++;
    }
  }
  return current;
}

// ─── 1. Claude Code & CodeBuddy & WorkBuddy JSONL Parser ────────────────────

interface ParsedJsonlTranscript {
  externalId: string;
  cwd: string | null;
  title: string | null;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messages: ImportedCliMessage[];
}

/**
 * Per-transcript state the Claude-style parser threads through its rows: when
 * each tool call started (to compute a real duration from the result row's own
 * timestamp), call names and inputs, and how to find the sub-agent a call
 * spawned.
 */
interface ClaudeImportContext {
  callStarts: Map<string, number | undefined>;
  callNames: Map<string, string>;
  callInputs: Map<string, Record<string, unknown>>;
  resolveSubagent?: (
    callId: string,
    agentId: string | undefined,
    input: Record<string, unknown> | undefined,
  ) => SubagentTranscript | undefined;
  /** Claude stores outputs over its size limit in a side file under this directory. */
  persistedOutputRoot?: string;
}

function newClaudeImportContext(
  persistedOutputRoot?: string,
  resolveSubagent?: ClaudeImportContext['resolveSubagent'],
): ClaudeImportContext {
  return {
    callStarts: new Map(),
    callNames: new Map(),
    callInputs: new Map(),
    resolveSubagent,
    persistedOutputRoot,
  };
}

/**
 * Claude Code replaces a tool output over its size limit with a
 * `<persisted-output>` preview and saves the whole output next to the
 * transcript. Import the whole output when that file is still there.
 */
function resolveClaudePersistedOutput(output: string, root: string | undefined): string {
  if (!root || !output.includes('<persisted-output>')) return output;
  const match = output.match(/Full output saved to:\s*(\S+)/);
  if (!match?.[1]) return output;
  const target = resolve(match[1]);
  try {
    if (!isContainedBy(resolve(root), target) || !existsSync(target)) return output;
    const st = statSync(target);
    if (!st.isFile() || st.size > MAX_IMPORT_JSONL_BYTES) return output;
    return capText(readFileSync(target, 'utf8'), MAX_IMPORTED_VALUE_CHARS);
  } catch {
    return output;
  }
}

/** Claude's structured edit patch (what its UI renders as a diff), as unified-diff text. */
function claudeStructuredPatchText(patch: unknown): string {
  if (!Array.isArray(patch)) return '';
  const hunks: string[] = [];
  for (const hunk of patch) {
    if (!hunk || typeof hunk !== 'object') continue;
    const h = hunk as { oldStart?: unknown; oldLines?: unknown; newStart?: unknown; newLines?: unknown; lines?: unknown };
    if (!Array.isArray(h.lines)) continue;
    hunks.push(
      `@@ -${String(h.oldStart ?? '?')},${String(h.oldLines ?? '?')} +${String(h.newStart ?? '?')},${String(h.newLines ?? '?')} @@\n` +
        h.lines.filter((line): line is string => typeof line === 'string').join('\n'),
    );
  }
  return hunks.join('\n');
}

/**
 * Turn events for one Claude-style content array, in block order. Thinking,
 * text and tool_use blocks come from assistant lines; tool_result blocks arrive
 * on the following user line and belong to the same assistant turn.
 *
 * Time is reported only as recorded: a thinking block's duration comes from the
 * line's `thinkingDurationMs`, a tool's from its call line and result line
 * timestamps. Without them the event is marked `timeUnknown`.
 */
function claudeContentEvents(
  content: unknown,
  ts: number,
  opts: {
    known?: boolean;
    thinkingDurationMs?: unknown;
    toolUseResult?: unknown;
    ctx?: ClaudeImportContext;
  } = {},
): TurnEvent[] {
  if (!Array.isArray(content)) return [];
  const known = opts.known !== false;
  const ctx = opts.ctx ?? newClaudeImportContext();
  const blocks = content.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  const thinkingBlocks = blocks.filter((block) => block.type === 'thinking').length;
  const resultBlocks = blocks.filter((block) => block.type === 'tool_result').length;
  const toolUseResult =
    resultBlocks === 1 && opts.toolUseResult && typeof opts.toolUseResult === 'object' && !Array.isArray(opts.toolUseResult)
      ? (opts.toolUseResult as Record<string, unknown>)
      : undefined;
  const events: TurnEvent[] = [];
  for (const block of blocks) {
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      events.push(
        ...reasoningEvents(block.thinking, {
          timestamp: ts,
          endedAt: known ? ts : undefined,
          // The duration belongs to the line; with several blocks it is not theirs.
          durationMs: thinkingBlocks === 1 ? opts.thinkingDurationMs : undefined,
        }),
      );
    } else if (block.type === 'text' && typeof block.text === 'string') {
      const text = cleanMessageText(block.text);
      if (text) events.push({ type: 'text', text, timestamp: ts });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
      const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
      const input = toolInputRecord(block.input);
      ctx.callStarts.set(block.id, known ? ts : undefined);
      ctx.callNames.set(block.id, name);
      ctx.callInputs.set(block.id, input);
      events.push({ type: 'tool_call', callId: block.id, name, input, timestamp: ts });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
      const callId = block.tool_use_id;
      let output = resolveClaudePersistedOutput(toolOutputText(block.content), ctx.persistedOutputRoot);
      const patch = claudeStructuredPatchText(toolUseResult?.structuredPatch);
      if (patch && !output.includes(patch)) output = output ? `${output}\n\n${patch}` : patch;
      const agentId = typeof toolUseResult?.agentId === 'string' ? toolUseResult.agentId : undefined;
      const subagent = ctx.resolveSubagent?.(callId, agentId, ctx.callInputs.get(callId));
      events.push(
        toolResultEvent({
          callId,
          name: ctx.callNames.get(callId) ?? 'tool',
          output,
          isError: block.is_error === true,
          timestamp: ts,
          durationMs: knownDurationMs({
            durationMs: toolUseResult?.durationMs ?? toolUseResult?.totalDurationMs,
            startedAt: ctx.callStarts.get(callId),
            endedAt: known ? ts : undefined,
          }),
          subagent,
        }),
      );
    }
  }
  return events;
}

/** User-attached images in a Claude content array, as Koryphaios attachments. */
function claudeImageAttachments(content: unknown, keyPrefix: string): MessageAttachment[] {
  if (!Array.isArray(content)) return [];
  const out: MessageAttachment[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
    if (block.type !== 'image' || block.source?.type !== 'base64' || typeof block.source.data !== 'string') continue;
    const mimeType = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png';
    const ext = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
    out.push({ type: 'image', data: block.source.data, name: `${keyPrefix}-${out.length + 1}.${ext}`, mimeType });
  }
  return out;
}

/** Read a JSONL file into parsed objects (whole file on import, head/tail on discovery). */
function readJsonlEntries(filePath: string, forImport: boolean): Record<string, unknown>[] | null {
  let raw: string;
  try {
    raw = readTranscriptText(filePath, forImport);
  } catch {
    return null;
  }
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const entry = JSON.parse(trimmed) as unknown;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        entries.push(entry as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * Convert Claude Code rows (main transcript, a sidechain group or a sub-agent
 * file) into import rows. `forImport` adds structured activity; discovery reads
 * text only.
 */
function claudeEntriesToMessages(
  entries: readonly Record<string, unknown>[],
  fallbackMtimeMs: number,
  forImport: boolean,
  ctx: ClaudeImportContext,
  defaultModel?: string,
): ImportedCliMessage[] {
  const parsedMessages: ImportedCliMessage[] = [];
  let model = defaultModel;
  let rowIndex = 0;
  let warnedRowCap = false;
  /** A compaction boundary whose summary row has not arrived yet. */
  let openCompaction: { sub: SubagentTranscript; result: Extract<TurnEvent, { type: 'tool_result' }> } | null =
    null;

  for (const entry of entries) {
    rowIndex += 1;
    if (parsedMessages.length >= MAX_RAW_SOURCE_ROWS) {
      if (!warnedRowCap) {
        warnedRowCap = true;
        serverLog.warn({ cap: MAX_RAW_SOURCE_ROWS }, 'CLI chat import hit the raw row safety cap');
      }
      break;
    }
    const sourceTs = sourceTimestampMs(entry.timestamp ?? entry.createdAt);
    const known = sourceTs !== undefined;
    const rowTs = sourceTs ?? fallbackMtimeMs;
    const unknownFlag: { timeUnknown?: true } = known ? {} : { timeUnknown: true };
    const type = typeof entry.type === 'string' ? entry.type : '';
    const rowKey = typeof entry.uuid === 'string' ? entry.uuid : String(rowIndex);

    if (type === 'session-meta' || type === 'session_meta') {
      const payload = (entry.payload as Record<string, unknown> | undefined) ?? entry;
      if (!model && typeof payload.model === 'string' && payload.model.trim()) model = payload.model.trim();
      continue;
    }

    if (forImport && type === 'system') {
      const subtype = typeof entry.subtype === 'string' ? entry.subtype : '';
      if (subtype === 'compact_boundary') {
        const meta = (entry.compactMetadata as Record<string, unknown> | undefined) ?? {};
        const trigger = typeof meta.trigger === 'string' ? meta.trigger : 'unknown';
        const taskParts = [`Context compaction (${trigger})`];
        if (typeof meta.preTokens === 'number') taskParts.push(`${meta.preTokens} tokens before`);
        if (typeof meta.postTokens === 'number') taskParts.push(`${meta.postTokens} after`);
        const sub: SubagentTranscript = { name: 'Context compaction', task: taskParts.join(', '), turns: [] };
        const events = synthesizedSubagentEvents(sub, rowTs, {
          key: `compaction-${rowKey}`,
          durationMs: knownDurationMs({ durationMs: meta.durationMs }),
        });
        openCompaction = {
          sub,
          result: events[1] as Extract<TurnEvent, { type: 'tool_result' }>,
        };
        parsedMessages.push({ role: 'assistant', content: '', createdAt: rowTs, events, ...unknownFlag });
        continue;
      }
      if (subtype === 'api_error' || subtype === 'informational') {
        const error = entry.error as Record<string, unknown> | undefined;
        let text =
          (typeof error?.formatted === 'string' && error.formatted) ||
          (typeof error?.message === 'string' && error.message) ||
          (typeof entry.content === 'string' && entry.content) ||
          '';
        if (subtype === 'api_error' && typeof entry.retryAttempt === 'number') {
          text = `${text} (retry ${entry.retryAttempt}${typeof entry.maxRetries === 'number' ? ` of ${entry.maxRetries}` : ''})`;
        }
        if (text.trim()) {
          parsedMessages.push({
            role: 'assistant',
            content: '',
            createdAt: rowTs,
            events: noticeEvents(rowKey, subtype, text, rowTs, subtype === 'api_error'),
            ...unknownFlag,
          });
        }
        continue;
      }
      continue;
    }

    // Claude Code format: type === 'user' | 'assistant' with entry.message
    if ((type === 'user' || type === 'assistant') && entry.message && typeof entry.message === 'object') {
      if (entry.isMeta === true) continue;
      const msgObj = entry.message as Record<string, unknown>;
      const role = msgObj.role === 'assistant' || type === 'assistant' ? 'assistant' : 'user';
      const msgModel =
        typeof msgObj.model === 'string' && msgObj.model.trim() && msgObj.model !== '<synthetic>'
          ? msgObj.model.trim()
          : undefined;
      if (!model && msgModel) model = msgModel;
      const rowModel = msgModel ?? model;

      // Compaction summaries are not prompts: discovery never counts them.
      if (!forImport && entry.isCompactSummary === true) continue;
      if (forImport && entry.isCompactSummary === true) {
        // The summary Claude continues from after a compaction belongs to the
        // compaction run, not to the user's prompts.
        const summary = cleanMessageText(extractTextFromContentField(msgObj.content));
        if (openCompaction) {
          openCompaction.sub.turns.push(
            known
              ? { role: 'assistant', parts: [{ kind: 'text', text: summary, startedAt: rowTs }], createdAt: rowTs }
              : { role: 'assistant', parts: [{ kind: 'text', text: summary, startedAt: rowTs }] },
          );
          openCompaction.result.output = summary;
          openCompaction = null;
        } else if (summary) {
          const sub: SubagentTranscript = {
            name: 'Context compaction',
            turns: [{ role: 'assistant', parts: [{ kind: 'text', text: summary, startedAt: rowTs }] }],
          };
          parsedMessages.push({
            role: 'assistant',
            content: '',
            createdAt: rowTs,
            events: synthesizedSubagentEvents(sub, rowTs, { key: `compaction-${rowKey}` }),
            ...unknownFlag,
          });
        }
        continue;
      }

      if (forImport && role === 'assistant' && entry.isApiErrorMessage === true) {
        const text = cleanMessageText(extractTextFromContentField(msgObj.content));
        if (text) {
          parsedMessages.push({
            role: 'assistant',
            content: '',
            createdAt: rowTs,
            events: noticeEvents(rowKey, 'api_error', text, rowTs, true),
            ...unknownFlag,
          });
        }
        continue;
      }

      if (forImport) {
        const events = claudeContentEvents(msgObj.content, rowTs, {
          known,
          thinkingDurationMs: entry.thinkingDurationMs,
          toolUseResult: entry.toolUseResult,
          ctx,
        });
        if (role === 'assistant') {
          const text = events
            .filter((event): event is Extract<TurnEvent, { type: 'text' }> => event.type === 'text')
            .map((event) => event.text)
            .join('\n\n');
          if (events.length > 0) {
            parsedMessages.push({ role, content: text, createdAt: rowTs, model: rowModel, events, ...unknownFlag });
          }
          continue;
        }
        // A user line carrying tool results is the tail of the assistant
        // turn, not a user message.
        const results = events.filter((event) => event.type === 'tool_result');
        if (results.length > 0) {
          parsedMessages.push({ role: 'assistant', content: '', createdAt: rowTs, events: results, ...unknownFlag });
        }
      }
      const text = cleanMessageText(extractTextFromContentField(msgObj.content));
      if (!forImport && role === 'user' && /^\[Request interrupted by user/.test(text)) continue;
      if (forImport && role === 'user' && /^\[Request interrupted by user/.test(text)) {
        parsedMessages.push({
          role: 'assistant',
          content: '',
          createdAt: rowTs,
          events: noticeEvents(rowKey, 'interrupted', text, rowTs),
          ...unknownFlag,
        });
        continue;
      }
      const attachments = forImport && role === 'user' ? claudeImageAttachments(msgObj.content, `image-${rowKey}`) : [];
      if (role === 'user' && text && isNoiseUserPrompt(text) && attachments.length === 0) continue;
      if (!text && attachments.length === 0) continue;
      const row: ImportedCliMessage = { role, content: text, createdAt: rowTs, model: rowModel, ...unknownFlag };
      if (attachments.length > 0) row.attachments = attachments;
      parsedMessages.push(row);
      continue;
    }

    // CodeBuddy / WorkBuddy format: type === 'message' with top-level role & content
    if (type === 'message' && (entry.role === 'user' || entry.role === 'assistant')) {
      if (entry.skipRun === true) continue;
      const role = entry.role;
      const providerData = entry.providerData as Record<string, unknown> | undefined;
      const msgModel =
        (typeof providerData?.model === 'string' ? providerData.model : undefined) ??
        (typeof entry.model === 'string' ? entry.model : undefined);
      if (!model && msgModel) model = msgModel;
      const text = cleanMessageText(extractTextFromContentField(entry.content));
      if (!text || (role === 'user' && isNoiseUserPrompt(text))) continue;
      parsedMessages.push({ role, content: text, createdAt: rowTs, model: msgModel ?? model, ...unknownFlag });
      continue;
    }

    // Omnirush / generic message wrapper: type === 'message' with entry.message.{role, content}
    if (type === 'message' && entry.message && typeof entry.message === 'object') {
      const msgObj = entry.message as Record<string, unknown>;
      if (msgObj.role !== 'user' && msgObj.role !== 'assistant') continue;
      const role = msgObj.role;
      const msgModel = typeof msgObj.model === 'string' ? msgObj.model : undefined;
      if (!model && msgModel) model = msgModel;
      const text = cleanMessageText(extractTextFromContentField(msgObj.content));
      if (!text || (role === 'user' && isNoiseUserPrompt(text))) continue;
      parsedMessages.push({ role, content: text, createdAt: rowTs, model: msgModel ?? model, ...unknownFlag });
    }
  }
  return parsedMessages;
}

/** Insert a row before the first row the source dated after it (or append). */
function insertRowByTime(msgs: ImportedCliMessage[], row: ImportedCliMessage): void {
  const index = msgs.findIndex((m) => !m.timeUnknown && m.createdAt > row.createdAt);
  if (index < 0) msgs.push(row);
  else msgs.splice(index, 0, row);
}

function firstKnownTime(msgs: readonly ImportedCliMessage[]): number | undefined {
  return msgs.find((m) => !m.timeUnknown)?.createdAt;
}

interface ClaudeSubagentSource {
  key: string;
  agentId?: string;
  toolUseId?: string;
  name: string;
  description?: string;
  modelAlias?: string;
  entries: Record<string, unknown>[];
  /** First prompt text, used to match an old-format sidechain to its Task call. */
  prompt: string;
  transcript?: SubagentTranscript;
  building?: boolean;
  claimed?: boolean;
  startMs?: number;
}

/**
 * Claude Code sub-agents. Current versions write each sub-agent's transcript to
 * `<session>/subagents/agent-<agentId>.jsonl` with an `agent-<agentId>.meta.json`
 * naming the spawning `toolUseId`; the spawning call's result also carries the
 * `agentId`. Older versions wrote `isSidechain: true` rows into the main file.
 * Sub-agents that spawn sub-agents resolve through the same registry.
 */
function createClaudeSubagentRegistry(
  filePath: string,
  sidechainEntries: readonly Record<string, unknown>[],
  fallbackMtimeMs: number,
  persistedOutputRoot: string,
) {
  const sources: ClaudeSubagentSource[] = [];
  const firstPrompt = (entries: readonly Record<string, unknown>[]): string => {
    for (const entry of entries) {
      if (entry.type !== 'user' || entry.isMeta === true) continue;
      const message = entry.message as Record<string, unknown> | undefined;
      const text = extractTextFromContentField(message?.content).trim();
      if (text) return text;
    }
    return '';
  };

  const subDir = join(filePath.replace(/\.jsonl$/, ''), 'subagents');
  try {
    if (existsSync(subDir)) {
      for (const file of readdirSync(subDir)) {
        const match = file.match(/^agent-(.+)\.jsonl$/);
        if (!match) continue;
        const agentId = match[1];
        const entries = readJsonlEntries(join(subDir, file), true) ?? [];
        let meta: Record<string, unknown> = {};
        try {
          const metaPath = join(subDir, `agent-${agentId}.meta.json`);
          if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
        } catch {
          meta = {};
        }
        sources.push({
          key: agentId,
          agentId,
          toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined,
          name: typeof meta.agentType === 'string' && meta.agentType ? meta.agentType : 'agent',
          description: typeof meta.description === 'string' ? meta.description : undefined,
          modelAlias: typeof meta.model === 'string' ? meta.model : undefined,
          entries,
          prompt: firstPrompt(entries),
        });
      }
    }
  } catch {
    // An unreadable sub-agent directory leaves the main transcript intact.
  }

  // Old format: sidechain rows inside the main file, grouped by agent id or by
  // the root of their parentUuid chain.
  if (sidechainEntries.length > 0) {
    const parentOf = new Map<string, string | null>();
    for (const entry of sidechainEntries) {
      if (typeof entry.uuid === 'string') {
        parentOf.set(entry.uuid, typeof entry.parentUuid === 'string' ? entry.parentUuid : null);
      }
    }
    const rootOf = (uuid: string): string => {
      let current = uuid;
      const seen = new Set<string>();
      while (!seen.has(current)) {
        seen.add(current);
        const parent = parentOf.get(current);
        if (!parent || !parentOf.has(parent)) return current;
        current = parent;
      }
      return current;
    };
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const entry of sidechainEntries) {
      const key =
        typeof entry.agentId === 'string' && entry.agentId
          ? entry.agentId
          : typeof entry.uuid === 'string'
            ? `chain-${rootOf(entry.uuid)}`
            : 'sidechain';
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const [key, entries] of groups) {
      if (sources.some((source) => source.key === key)) continue;
      sources.push({
        key,
        agentId: key.startsWith('chain-') || key === 'sidechain' ? undefined : key,
        name: 'agent',
        entries,
        prompt: firstPrompt(entries),
      });
    }
  }

  const build = (source: ClaudeSubagentSource): SubagentTranscript | undefined => {
    if (source.transcript) return source.transcript;
    if (source.building) return undefined;
    source.building = true;
    const ctx = newClaudeImportContext(persistedOutputRoot, resolveSubagent);
    const msgs = claudeEntriesToMessages(source.entries, fallbackMtimeMs, true, ctx);
    const firstAssistantModel = msgs.find((m) => m.role === 'assistant' && m.model)?.model;
    source.startMs = firstKnownTime(msgs);
    source.transcript = buildSubagentTranscript(
      {
        agentId: source.agentId,
        name: source.name,
        task: source.description || source.prompt || undefined,
        model: firstAssistantModel ?? source.modelAlias,
      },
      msgs,
      source.startMs,
    );
    source.building = false;
    return source.transcript;
  };

  function resolveSubagent(
    callId: string,
    agentId: string | undefined,
    input: Record<string, unknown> | undefined,
  ): SubagentTranscript | undefined {
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
    const source =
      sources.find((s) => !s.claimed && s.toolUseId === callId) ??
      (agentId ? sources.find((s) => !s.claimed && s.agentId === agentId) : undefined) ??
      (prompt ? sources.find((s) => !s.claimed && !s.toolUseId && s.prompt === prompt) : undefined);
    if (!source) return undefined;
    const transcript = build(source);
    if (transcript) source.claimed = true;
    return transcript;
  }

  return {
    resolve: resolveSubagent,
    /** Sub-agents no call claimed become synthetic parts where they ran. */
    placeLeftovers(msgs: ImportedCliMessage[]): void {
      for (const source of sources) {
        if (source.claimed) continue;
        const transcript = build(source);
        if (!transcript) continue;
        source.claimed = true;
        const at = source.startMs ?? firstKnownTime(msgs) ?? fallbackMtimeMs;
        insertRowByTime(msgs, {
          role: 'assistant',
          content: '',
          createdAt: at,
          events: synthesizedSubagentEvents(transcript, at, { key: source.key }),
          ...(source.startMs === undefined ? { timeUnknown: true as const } : {}),
        });
      }
    },
  };
}

function parseClaudeOrCodeBuddyJsonlFile(
  filePath: string,
  defaultExternalId: string,
  fallbackMtimeMs: number,
  forImport = false,
): ParsedJsonlTranscript | null {
  const entries = readJsonlEntries(filePath, forImport);
  if (!entries) return null;

  let externalId = defaultExternalId;
  let cwd: string | null = null;
  let explicitTitle: string | null = null;
  let model: string | undefined;
  let createdAt = 0;
  let updatedAt = 0;
  const mainEntries: Record<string, unknown>[] = [];
  const sidechainEntries: Record<string, unknown>[] = [];

  for (const entry of entries) {
    if (typeof entry.sessionId === 'string' && entry.sessionId.trim()) {
      externalId = entry.sessionId.trim();
    }
    if (!cwd && typeof entry.cwd === 'string' && entry.cwd.trim()) {
      cwd = entry.cwd.trim();
    }
    const ts = sourceTimestampMs(entry.timestamp ?? entry.createdAt);
    if (ts !== undefined) {
      if (createdAt === 0 || ts < createdAt) createdAt = ts;
      if (ts > updatedAt) updatedAt = ts;
    }
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
      explicitTitle = entry.customTitle.trim();
      continue;
    }
    if (type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
      if (!explicitTitle) explicitTitle = entry.aiTitle.trim();
      continue;
    }
    if (type === 'summary' && typeof entry.summary === 'string' && entry.summary.trim()) {
      if (!explicitTitle) explicitTitle = entry.summary.trim();
      continue;
    }
    if (type === 'session-meta' || type === 'session_meta') {
      const payload = (entry.payload as Record<string, unknown> | undefined) ?? entry;
      if (!cwd && typeof payload.cwd === 'string' && payload.cwd.trim()) cwd = payload.cwd.trim();
      if (!model && typeof payload.model === 'string' && payload.model.trim()) model = payload.model.trim();
      continue;
    }
    if (type === 'assistant' && !model) {
      const msgModel = (entry.message as Record<string, unknown> | undefined)?.model;
      if (typeof msgModel === 'string' && msgModel.trim() && msgModel !== '<synthetic>') model = msgModel.trim();
    }
    // A sidechain is a sub-agent's conversation, never the user's.
    if (entry.isSidechain === true) sidechainEntries.push(entry);
    else mainEntries.push(entry);
  }

  const persistedOutputRoot = filePath.replace(/\.jsonl$/, '');
  const registry = forImport
    ? createClaudeSubagentRegistry(filePath, sidechainEntries, fallbackMtimeMs, persistedOutputRoot)
    : null;
  const ctx = newClaudeImportContext(persistedOutputRoot, registry?.resolve);
  const parsedMessages = claudeEntriesToMessages(mainEntries, fallbackMtimeMs, forImport, ctx, model);
  if (parsedMessages.length === 0) return null;
  registry?.placeLeftovers(parsedMessages);

  return {
    externalId,
    cwd,
    title: explicitTitle,
    model,
    createdAt: createdAt || fallbackMtimeMs,
    updatedAt: updatedAt || fallbackMtimeMs,
    messages: parsedMessages,
  };
}

function scanClaudeStyleProjectsDir(
  root: string,
  provider: ProviderName,
  providerDisplayName: string,
  maxChats: number,
): InternalDiscoveredChat[] {
  const projectsDir = join(root, 'projects');
  if (!existsSync(projectsDir)) return [];

  const discovered: InternalDiscoveredChat[] = [];
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const encodedDir of projectDirs) {
    const fullProjectDir = join(projectsDir, encodedDir);
    let files: string[] = [];
    try {
      files = readdirSync(fullProjectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(fullProjectDir, file);
      let mtimeMs = Date.now();
      try {
        const st = statSync(filePath);
        if (st.size === 0) continue;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }

      const defaultId = file.replace(/\.jsonl$/, '');
      const parsed = parseClaudeOrCodeBuddyJsonlFile(filePath, defaultId, mtimeMs);
      if (!parsed || parsed.messages.length === 0) continue;

      const resolvedPath = canonicalizeProjectPath(
        parsed.cwd ?? decodeEncodedProjectDir(encodedDir, root),
        root,
      );
      const firstUser = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
      const title = deriveChatTitle(parsed.title, firstUser);
      const preview = derivePreview(null, parsed.messages);

      discovered.push({
        id: `${provider}:${parsed.externalId}`,
        externalId: parsed.externalId,
        provider,
        providerDisplayName,
        projectPath: resolvedPath,
        projectName: projectNameFromPath(resolvedPath),
        title,
        preview,
        model: parsed.model,
        messageCount: countImportTurns(parsed.messages),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        alreadyImported: false,
        sampleMessages: toPublicSamples(parsed.messages),
        loadMessages: () =>
          parseClaudeOrCodeBuddyJsonlFile(filePath, defaultId, mtimeMs, true)?.messages ??
          parsed.messages,
      });
    }
  }

  return discovered
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxChats);
}

// ─── 2. WorkBuddy Desktop Scanner (SQLite + JSONL) ──────────────────────────

function scanWorkBuddyRoot(root: string, maxChats: number): InternalDiscoveredChat[] {
  const byExternalId = new Map<string, InternalDiscoveredChat>();

  // First scan JSONL transcripts under projects/
  for (const chat of scanClaudeStyleProjectsDir(root, 'workbuddy-desktop', 'WorkBuddy', maxChats * 2)) {
    byExternalId.set(chat.externalId, chat);
  }

  // Enrich/augment with workbuddy.db sessions table
  const dbPath = join(root, 'workbuddy.db');
  if (existsSync(dbPath)) {
    let sqlite: Database | null = null;
    try {
      // WorkBuddy keeps the store in WAL mode; a plain read-only open fails without its `-shm`.
      sqlite = openReadonlySqlite(dbPath);
      if (!sqlite) throw new Error('workbuddy.db is unreadable');
      const rows = sqlite
        .query(
          `SELECT id, cwd, title, custom_title, model, created_at, updated_at, deleted_at
           FROM sessions
           WHERE deleted_at IS NULL
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(maxChats * 2) as Array<{
        id: string;
        cwd: string | null;
        title: string | null;
        custom_title: string | null;
        model: string | null;
        created_at: number | string | null;
        updated_at: number | string | null;
      }>;

      for (const row of rows) {
        const existing = byExternalId.get(row.id);
        const dbTitle = (row.custom_title || row.title || '').trim();
        if (existing) {
          if (dbTitle && !isGenericAutoTitle(dbTitle)) {
            existing.title = deriveChatTitle(dbTitle, existing.preview);
          }
          if (row.cwd) {
            existing.projectPath = canonicalizeProjectPath(row.cwd, root);
            existing.projectName = projectNameFromPath(existing.projectPath);
          }
          if (row.model && !existing.model) {
            existing.model = row.model;
          }
        }
      }
    } catch {
      // Ignore SQLite errors on corrupt/locked external DB
    } finally {
      try {
        sqlite?.close();
      } catch {}
    }
  }

  const chats = [...byExternalId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxChats);
  attachCodeBuddyFullImport(root, chats);
  return chats;
}

/**
 * CodeBuddy CLI and the WorkBuddy desktop app write responses-style transcripts
 * (`message`, `reasoning`, `function_call`, `function_call_result` rows, with
 * sub-agents under `<session>/subagents/`). Discovery keeps the Claude-style
 * text scan; import reads the whole transcript with tool calls, reasoning,
 * errors and nested sub-agents.
 */
function attachCodeBuddyFullImport(root: string, chats: InternalDiscoveredChat[]): void {
  const files = listProjectTranscriptFiles(root);
  for (const chat of chats) {
    const filePath = files.get(chat.externalId);
    if (!filePath) continue;
    const textOnly = chat.loadMessages;
    chat.loadMessages = () => {
      const parsed = parseCodeBuddyTranscript(filePath, portingHelpers());
      return parsed?.codeBuddyFormat && parsed.messages.length > 0 ? parsed.messages : textOnly();
    };
  }
}

function scanCodeBuddyRoot(root: string, maxChats: number): InternalDiscoveredChat[] {
  const chats = scanClaudeStyleProjectsDir(root, 'codebuddy', 'CodeBuddy', maxChats);
  attachCodeBuddyFullImport(root, chats);
  return chats;
}

// ─── 3. Codex CLI Scanner (state_5.sqlite + thread_history_1.sqlite + JSONL) ─

function findHighestVersionedSqlite(root: string, prefix: string): string | null {
  try {
    const candidates = readdirSync(root)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.sqlite'))
      .sort((a, b) => {
        const numA = Number(a.match(/(\d+)\.sqlite$/)?.[1] ?? 0);
        const numB = Number(b.match(/(\d+)\.sqlite$/)?.[1] ?? 0);
        return numB - numA;
      });
    return candidates[0] ? join(root, candidates[0]) : null;
  } catch {
    return null;
  }
}

function parseCodexThreadItemJson(
  itemType: string,
  itemJsonRaw: string,
  createdAtMs: number,
): DiscoveredCliChatMessage | null {
  try {
    const parsed = JSON.parse(itemJsonRaw) as Record<string, unknown>;
    if (itemType === 'userMessage' || parsed.type === 'userMessage') {
      const text = cleanMessageText(extractTextFromContentField(parsed.content));
      if (!text || isNoiseUserPrompt(text)) return null;
      return { role: 'user', content: text, createdAt: createdAtMs };
    }
    if (itemType === 'agentMessage' || parsed.type === 'agentMessage') {
      const directText = typeof parsed.text === 'string' ? parsed.text : '';
      const text = cleanMessageText(directText || extractTextFromContentField(parsed.content));
      if (!text) return null;
      return { role: 'assistant', content: text, createdAt: createdAtMs };
    }
    if (itemType === 'message' || parsed.type === 'message') {
      const role = parsed.role === 'assistant' ? 'assistant' : parsed.role === 'user' ? 'user' : null;
      if (!role) return null;
      const text = cleanMessageText(extractTextFromContentField(parsed.content));
      if (!text || (role === 'user' && isNoiseUserPrompt(text))) return null;
      return { role, content: text, createdAt: createdAtMs };
    }
  } catch {
    return null;
  }
  return null;
}

function isCodexInjectedContext(text: string): boolean {
  return (
    text.startsWith('<environment_context>') ||
    text.startsWith('<permissions instructions>') ||
    text.startsWith('<user_instructions>') ||
    text.startsWith('<turn_aborted>') ||
    text.startsWith('<subagent_notification>') ||
    text.startsWith('# AGENTS.md instructions')
  );
}

const MAX_CODEX_ZST_BYTES = 64 * 1024 * 1024;

/**
 * Read a Codex rollout. Codex compresses finished rollouts to `<name>.jsonl.zst`
 * while `threads.rollout_path` keeps the uncompressed name, so a thread whose
 * file was compressed used to import as text from the history store only, with
 * every tool call and reasoning summary dropped.
 */
function readCodexRollout(filePath: string | null | undefined, forImport: boolean): string | null {
  if (!filePath) return null;
  const plain = filePath.endsWith('.zst') ? filePath.slice(0, -4) : filePath;
  try {
    if (existsSync(plain)) return readTranscriptText(plain, forImport);
  } catch {
    return null;
  }
  const compressed = `${plain}.zst`;
  if (!forImport || !existsSync(compressed)) return null;
  const decompress = (Bun as { zstdDecompressSync?: (data: Uint8Array) => Uint8Array })
    .zstdDecompressSync;
  if (typeof decompress !== 'function') return null;
  try {
    if (statSync(compressed).size > MAX_CODEX_ZST_BYTES) return null;
    const bytes = decompress(readFileSync(compressed));
    if (bytes.length > MAX_IMPORT_JSONL_BYTES) return null;
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('utf8');
  } catch {
    return null;
  }
}

function codexRolloutAvailable(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const plain = filePath.endsWith('.zst') ? filePath.slice(0, -4) : filePath;
  return existsSync(plain) || existsSync(`${plain}.zst`);
}

function parseCodexRolloutJsonl(
  filePath: string,
  fallbackTs: number,
  forImport = false,
  opts: {
    /** Sub-agent thread a `spawn_agent` call started, by call id or thread id. */
    resolveChild?: (
      callId: string,
      threadId: string | undefined,
      prompt?: string,
    ) => SubagentTranscript | undefined;
    /** Item ids of the parent's history: a forked child starts with a copy of it. */
    skipItemIds?: ReadonlySet<string>;
    /** Receives every item id this rollout holds (for its own forked children). */
    collectItemIds?: Set<string>;
  } = {},
): {
  cwd: string | null;
  model?: string;
  messages: ImportedCliMessage[];
} {
  const raw = readCodexRollout(filePath, forImport);
  if (raw === null) return { cwd: null, messages: [] };
  let cwd: string | null = null;
  let model: string | undefined;
  const msgs: ImportedCliMessage[] = [];
  const toolNames = new Map<string, string>();
  const callStarts = new Map<string, number | undefined>();
  const entries: Record<string, unknown>[] = [];
  /** spawn_agent call id -> the thread it started (`SubAgentActivity` / `CollabAgentToolCall`). */
  const spawnedThreadByCall = new Map<string, string>();
  const spawnPromptByThread = new Map<string, string>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      entries.push(entry);
      const payload = (entry.payload as Record<string, unknown> | undefined) ?? {};
      if (typeof payload.id === 'string') opts.collectItemIds?.add(payload.id);
      const item = payload.item as Record<string, unknown> | undefined;
      if (
        payload.type === 'item_completed' &&
        item?.type === 'SubAgentActivity' &&
        typeof item.id === 'string' &&
        typeof item.agent_thread_id === 'string' &&
        (item.kind === 'started' || !spawnedThreadByCall.has(item.id))
      ) {
        spawnedThreadByCall.set(item.id, item.agent_thread_id);
      }
      // multi_agent_v1 records the spawn as a collaboration item naming the
      // receiver thread and the plain-text prompt it was given.
      if (
        payload.type === 'item_completed' &&
        item?.type === 'CollabAgentToolCall' &&
        item.tool === 'spawn_agent' &&
        typeof item.id === 'string' &&
        Array.isArray(item.receiver_thread_ids) &&
        typeof item.receiver_thread_ids[0] === 'string'
      ) {
        spawnedThreadByCall.set(item.id, item.receiver_thread_ids[0]);
        if (typeof item.prompt === 'string' && item.prompt.trim()) {
          spawnPromptByThread.set(item.receiver_thread_ids[0], item.prompt);
        }
      }
    } catch {
      continue;
    }
  }

  // A rollout Codex re-serialized in one go (seen on forked sub-agent threads)
  // stamps every row with the same instant: those stamps are not the rows' times.
  const distinctStamps = new Set(entries.map((entry) => entry.timestamp).filter((stamp) => stamp !== undefined));
  const stampsAreReal = entries.length <= 2 || distinctStamps.size > 1;

  let warnedRowCap = false;
  let ownItemSeen = false;
  let index = 0;
  for (const entry of entries) {
    index += 1;
    if (msgs.length >= MAX_RAW_SOURCE_ROWS) {
      if (!warnedRowCap) {
        warnedRowCap = true;
        serverLog.warn({ cap: MAX_RAW_SOURCE_ROWS, filePath }, 'CLI chat import hit the raw row safety cap');
      }
      break;
    }
    const sourceTs = stampsAreReal ? sourceTimestampMs(entry.timestamp) : undefined;
    const known = sourceTs !== undefined;
    const ts = sourceTs ?? fallbackTs;
    const unknownFlag: { timeUnknown?: true } = known ? {} : { timeUnknown: true };
    const payload = (entry.payload as Record<string, unknown> | undefined) ?? {};
    const pushAssistantEvents = (events: TurnEvent[]) => {
      msgs.push({ role: 'assistant', content: '', createdAt: ts, model, events, ...unknownFlag });
    };
    if (entry.type === 'session_meta' || entry.type === 'turn_context') {
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd;
      // The model can change between turns; each turn records the one it used.
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
      continue;
    }
    if (forImport && entry.type === 'compacted') {
      // A forked child inherits its parent's compactions with the history copy.
      if ((opts.skipItemIds?.size ?? 0) > 0 && !ownItemSeen) continue;
      const summary = typeof payload.message === 'string' ? payload.message.trim() : '';
      const replaced = Array.isArray(payload.replacement_history) ? payload.replacement_history.length : 0;
      const text =
        summary ||
        (replaced > 0
          ? `Codex replaced the conversation context with ${replaced} retained items.`
          : 'Codex compacted the conversation context.');
      const sub: SubagentTranscript = {
        name: 'Context compaction',
        task: 'Compact the conversation context',
        turns: [
          known
            ? { role: 'assistant', parts: [{ kind: 'text', text, startedAt: ts }], createdAt: ts }
            : { role: 'assistant', parts: [{ kind: 'text', text, startedAt: ts }] },
        ],
      };
      pushAssistantEvents(synthesizedSubagentEvents(sub, ts, { key: `compaction-${index}` }));
      continue;
    }
    if (forImport && entry.type === 'event_msg') {
      if ((opts.skipItemIds?.size ?? 0) > 0 && !ownItemSeen) continue;
      if (payload.type === 'turn_aborted') {
        const reason = typeof payload.reason === 'string' ? payload.reason : 'aborted';
        pushAssistantEvents(noticeEvents(`codex-${index}`, 'interrupted', `Turn ${reason}`, ts));
      } else if (payload.type === 'error' || payload.type === 'stream_error') {
        const text = typeof payload.message === 'string' ? payload.message : '';
        if (text) pushAssistantEvents(noticeEvents(`codex-${index}`, 'error', text, ts, true));
      }
      continue;
    }
    if (entry.type !== 'response_item') continue;
    // A forked sub-agent thread begins with a copy of its parent's history.
    if (typeof payload.id === 'string' && opts.skipItemIds?.has(payload.id)) continue;
    ownItemSeen = true;

    if (payload.type === 'message') {
      const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
      if (!role) continue;
      // Skip developer/system instructions injected as user context
      const text = cleanMessageText(extractTextFromContentField(payload.content));
      const attachments = forImport && role === 'user' ? codexImageAttachments(payload.content, `image-${index}`) : [];
      if (text && isCodexInjectedContext(text)) continue;
      if (role === 'user' && text && isNoiseUserPrompt(text) && attachments.length === 0) continue;
      if (!text && attachments.length === 0) continue;
      const row: ImportedCliMessage = { role, content: text, createdAt: ts, model, ...unknownFlag };
      if (attachments.length > 0) row.attachments = attachments;
      msgs.push(row);
      continue;
    }
    if (!forImport) continue;

    if (payload.type === 'reasoning') {
      const summary = Array.isArray(payload.summary)
        ? payload.summary
            .map((item) =>
              item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
                ? (item as { text: string }).text
                : '',
            )
            .filter(Boolean)
            .join('\n\n')
        : '';
      const rawContent = extractTextFromContentField(payload.content);
      const text = summary || rawContent;
      // A reasoning item records when it was written, never how long it took.
      if (text.trim()) pushAssistantEvents(reasoningEvents(text, { timestamp: ts }));
      continue;
    }
    if (
      (payload.type === 'function_call' ||
        payload.type === 'custom_tool_call' ||
        payload.type === 'local_shell_call' ||
        payload.type === 'tool_search_call') &&
      typeof payload.call_id === 'string' &&
      payload.call_id
    ) {
      const name =
        typeof payload.name === 'string' && payload.name
          ? payload.name
          : payload.type === 'local_shell_call'
            ? 'shell'
            : payload.type === 'tool_search_call'
              ? 'tool_search'
              : 'tool';
      toolNames.set(payload.call_id, name);
      callStarts.set(payload.call_id, known ? ts : undefined);
      pushAssistantEvents([
        {
          type: 'tool_call',
          callId: payload.call_id,
          name,
          input: toolInputRecord(payload.arguments ?? payload.input ?? payload.action),
          timestamp: ts,
        },
      ]);
      continue;
    }
    if (
      (payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call_output' ||
        payload.type === 'local_shell_call_output' ||
        payload.type === 'tool_search_output') &&
      typeof payload.call_id === 'string' &&
      payload.call_id
    ) {
      const output = payload.output ?? (payload.type === 'tool_search_output' ? payload.tools : undefined);
      const outputObject =
        output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>) : null;
      const outputValue = outputObject && 'content' in outputObject ? outputObject.content : output;
      const callId = payload.call_id;
      const childThreadId = spawnedThreadByCall.get(callId);
      const subagent = opts.resolveChild?.(
        callId,
        childThreadId,
        childThreadId ? spawnPromptByThread.get(childThreadId) : undefined,
      );
      pushAssistantEvents([
        toolResultEvent({
          callId,
          name: toolNames.get(callId) ?? 'tool',
          output: toolOutputText(outputValue),
          isError: outputObject?.success === false,
          timestamp: ts,
          // A call and its output stamped in the same millisecond were written
          // together, not timed: that is no measured duration.
          durationMs: (() => {
            const duration = knownDurationMs({ startedAt: callStarts.get(callId), endedAt: known ? ts : undefined });
            return duration === 0 ? undefined : duration;
          })(),
          subagent,
        }),
      ]);
    }
  }
  return { cwd, model, messages: msgs };
}

/** Images a Codex user message carries as `input_image` data URLs. */
function codexImageAttachments(content: unknown, keyPrefix: string): MessageAttachment[] {
  if (!Array.isArray(content)) return [];
  const out: MessageAttachment[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as { type?: unknown; image_url?: unknown };
    if (block.type !== 'input_image' || typeof block.image_url !== 'string') continue;
    const match = block.image_url.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) continue;
    const mimeType = match[1];
    const ext = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
    out.push({ type: 'image', data: match[2], name: `${keyPrefix}-${out.length + 1}.${ext}`, mimeType });
  }
  return out;
}

interface CodexChildThreadRow {
  id: string;
  rollout_path: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  agent_path: string | null;
  model: string | null;
  created_at_ms: number | null;
  created_at: number | null;
}

/** Thread ids Codex spawned as sub-agents (they import inside their parent, not as chats). */
function codexChildThreadIds(stateDb: Database): Set<string> {
  try {
    const rows = stateDb.query(`SELECT child_thread_id FROM thread_spawn_edges`).all() as Array<{
      child_thread_id: string;
    }>;
    return new Set(rows.map((row) => row.child_thread_id));
  } catch {
    return new Set();
  }
}

const MAX_CODEX_SUBAGENT_DEPTH = 8;

/**
 * Codex sub-agents are threads of their own: `thread_spawn_edges` links parent
 * to child, the parent's `spawn_agent` call is linked to the child thread by a
 * `SubAgentActivity` event, and the child's rollout starts with a copy of the
 * parent history (skipped by item id). Children that spawn children recurse.
 */
function createCodexChildResolver(
  stateDbPath: string,
  parentThreadId: string,
  parentItemIds: ReadonlySet<string>,
  depth: number,
) {
  const children = new Map<string, CodexChildThreadRow>();
  const claimed = new Set<string>();
  const built = new Map<string, { transcript: SubagentTranscript; startMs?: number }>();
  if (depth <= MAX_CODEX_SUBAGENT_DEPTH) {
    const stateDb = openReadonlySqlite(stateDbPath);
    try {
      const rows = (stateDb
        ?.query(
          `SELECT t.id, t.rollout_path, t.agent_nickname, t.agent_role, t.agent_path, t.model,
                  t.created_at_ms, t.created_at
           FROM thread_spawn_edges e JOIN threads t ON t.id = e.child_thread_id
           WHERE e.parent_thread_id = ?
           ORDER BY COALESCE(t.created_at_ms, t.created_at * 1000) ASC`,
        )
        .all(parentThreadId) ?? []) as CodexChildThreadRow[];
      for (const row of rows) children.set(row.id, row);
    } catch {
      // No spawn edges in this Codex version: nothing to nest.
    } finally {
      try {
        stateDb?.close();
      } catch {}
    }
  }

  const build = (row: CodexChildThreadRow, prompt?: string) => {
    const cached = built.get(row.id);
    if (cached) return cached;
    const startMs = sourceTimestampMs(row.created_at_ms ?? row.created_at);
    // The rollout's first pass adds the child's own item ids before any
    // grandchild is built, so a grandchild skips both inherited histories.
    const allIds = new Set<string>(parentItemIds);
    const grandchildren = createCodexChildResolver(stateDbPath, row.id, allIds, depth + 1);
    const rollout = codexRolloutAvailable(row.rollout_path)
      ? parseCodexRolloutJsonl(row.rollout_path ?? '', startMs ?? 0, true, {
          resolveChild: grandchildren.resolve,
          skipItemIds: parentItemIds,
          collectItemIds: allIds,
        })
      : { messages: [] as ImportedCliMessage[], model: undefined };
    grandchildren.placeLeftovers(rollout.messages);
    const transcript = buildSubagentTranscript(
      {
        agentId: row.id,
        name: row.agent_nickname || row.agent_role || 'agent',
        task: prompt || row.agent_path || undefined,
        model: row.model ?? rollout.model,
        provider: 'codex',
      },
      rollout.messages,
      startMs,
    );
    const result = { transcript, startMs };
    built.set(row.id, result);
    return result;
  };

  return {
    resolve(callId: string, threadId: string | undefined, prompt?: string): SubagentTranscript | undefined {
      void callId;
      if (!threadId || claimed.has(threadId)) return undefined;
      const row = children.get(threadId);
      if (!row) return undefined;
      claimed.add(threadId);
      return build(row, prompt).transcript;
    },
    /** Children no call claimed become synthetic parts where they started. */
    placeLeftovers(msgs: ImportedCliMessage[]): void {
      for (const row of children.values()) {
        if (claimed.has(row.id)) continue;
        claimed.add(row.id);
        const { transcript, startMs } = build(row);
        const at = startMs ?? firstKnownTime(msgs) ?? 0;
        insertRowByTime(msgs, {
          role: 'assistant',
          content: '',
          createdAt: at,
          events: synthesizedSubagentEvents(transcript, at, { key: row.id }),
          ...(startMs === undefined ? { timeUnknown: true as const } : {}),
        });
      }
    },
  };
}

function scanCodexRoot(root: string, maxChats: number): InternalDiscoveredChat[] {
  const stateDbPath = findHighestVersionedSqlite(root, 'state_');
  const historyDbPath = findHighestVersionedSqlite(root, 'thread_history_');
  const results: InternalDiscoveredChat[] = [];

  if (stateDbPath && existsSync(stateDbPath)) {
    let stateDb: Database | null = null;
    let historyDb: Database | null = null;
    try {
      stateDb = openReadonlySqlite(stateDbPath);
      if (!stateDb) return results;
      // A spawned sub-agent thread is part of its parent chat, not a chat.
      const childThreadIds = codexChildThreadIds(stateDb);
      if (historyDbPath && existsSync(historyDbPath)) {
        historyDb = openReadonlySqlite(historyDbPath);
      }

      const threads = stateDb
        .query(
          `SELECT id, rollout_path, created_at, updated_at, cwd, title, first_user_message, model, created_at_ms, updated_at_ms
           FROM threads
           WHERE COALESCE(archived, 0) = 0
           ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
           LIMIT ?`,
        )
        .all(maxChats + childThreadIds.size) as Array<{
        id: string;
        rollout_path: string | null;
        created_at: number | null;
        updated_at: number | null;
        cwd: string | null;
        title: string | null;
        first_user_message: string | null;
        model: string | null;
        created_at_ms: number | null;
        updated_at_ms: number | null;
      }>;

      // The history store is optional: when it cannot be prepared, samples come
      // from each thread's rollout file instead of aborting the scan.
      let countStmt: ReturnType<Database['query']> | null = null;
      let sampleStmt: ReturnType<Database['query']> | null = null;
      if (historyDb) {
        try {
          countStmt = historyDb.query(
            `SELECT COUNT(*) as cnt FROM thread_items
             WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage', 'message')`,
          );
          sampleStmt = historyDb.query(
            `SELECT item_type, item_json, created_at_ms FROM thread_items
             WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage', 'message')
             ORDER BY rollout_ordinal ASC
             LIMIT ?`,
          );
        } catch {
          countStmt = null;
          sampleStmt = null;
        }
      }

      for (const row of threads.filter((thread) => !childThreadIds.has(thread.id)).slice(0, maxChats)) {
        const createdAt = normalizeTimestampMs(row.created_at_ms ?? row.created_at);
        const updatedAt = normalizeTimestampMs(row.updated_at_ms ?? row.updated_at, createdAt);
        const firstUserClean = cleanMessageText(row.first_user_message ?? '');

        let msgCount = 0;
        const sampleMessages: DiscoveredCliChatMessage[] = [];

        if (countStmt && sampleStmt) {
          try {
            const cntRow = countStmt.get(row.id) as { cnt?: number } | null;
            msgCount = Number(cntRow?.cnt ?? 0);
            if (msgCount > 0) {
              const items = sampleStmt.all(row.id, MAX_SAMPLE_MESSAGES * 2) as Array<{
                item_type: string;
                item_json: string;
                created_at_ms: number | null;
              }>;
              for (const item of items) {
                const parsed = parseCodexThreadItemJson(
                  item.item_type,
                  item.item_json,
                  normalizeTimestampMs(item.created_at_ms, createdAt),
                );
                if (parsed) {
                  if (row.model) parsed.model = row.model;
                  sampleMessages.push(parsed);
                  if (sampleMessages.length >= MAX_SAMPLE_MESSAGES) break;
                }
              }
            }
          } catch {
            // Fall through to rollout or first_user_message fallback
          }
        }

        if (sampleMessages.length === 0 && row.rollout_path && !row.rollout_path.endsWith('.zst')) {
          const rollout = parseCodexRolloutJsonl(row.rollout_path, createdAt);
          if (rollout.messages.length > 0) {
            msgCount = countImportTurns(rollout.messages);
            sampleMessages.push(...toPublicSamples(rollout.messages));
          }
        }

        if (sampleMessages.length === 0 && firstUserClean) {
          sampleMessages.push({
            role: 'user',
            content: firstUserClean,
            createdAt,
            model: row.model ?? undefined,
          });
          if (msgCount === 0) msgCount = 1;
        }

        if (msgCount === 0 && !firstUserClean && !(row.title ?? '').trim()) {
          continue;
        }

        const resolvedPath = canonicalizeProjectPath(row.cwd, root);
        const title = deriveChatTitle(row.title, firstUserClean || sampleMessages[0]?.content || '');
        const preview = derivePreview(firstUserClean, sampleMessages);
        const threadId = row.id;
        const rolloutPath = row.rollout_path;
        const threadModel = row.model ?? undefined;

        results.push({
          id: `codex:${threadId}`,
          externalId: threadId,
          provider: 'codex',
          providerDisplayName: 'Codex CLI',
          projectPath: resolvedPath,
          projectName: projectNameFromPath(resolvedPath),
          title,
          preview,
          model: threadModel,
          messageCount: Math.max(msgCount, sampleMessages.length, 1),
          createdAt,
          updatedAt,
          alreadyImported: false,
          sampleMessages,
          loadMessages: () => {
            // The rollout is the complete record (reasoning summaries, tool
            // calls and outputs); the history store only has text items.
            if (codexRolloutAvailable(rolloutPath)) {
              const itemIds = new Set<string>();
              const children = createCodexChildResolver(stateDbPath, threadId, itemIds, 1);
              const rollout = parseCodexRolloutJsonl(rolloutPath ?? '', createdAt, true, {
                resolveChild: children.resolve,
                collectItemIds: itemIds,
              });
              if (rollout.messages.length > 0) {
                children.placeLeftovers(rollout.messages);
                // Per-turn models come from the rollout; the thread model only fills gaps.
                for (const m of rollout.messages) {
                  if (!m.model && threadModel) m.model = threadModel;
                }
                return rollout.messages;
              }
            }
            if (historyDbPath && existsSync(historyDbPath)) {
              const hDb = openReadonlySqlite(historyDbPath);
              try {
                const rows = (hDb
                  ?.query(
                    `SELECT item_type, item_json, created_at_ms
                     FROM thread_items
                     WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage', 'message')
                     ORDER BY rollout_ordinal ASC
                     LIMIT ?`,
                  )
                  .all(threadId, MAX_RAW_SOURCE_ROWS) ?? []) as Array<{
                  item_type: string;
                  item_json: string;
                  created_at_ms: number | null;
                }>;
                const full: ImportedCliMessage[] = [];
                for (const r of rows) {
                  const itemTs = sourceTimestampMs(r.created_at_ms);
                  const m: ImportedCliMessage | null = parseCodexThreadItemJson(
                    r.item_type,
                    r.item_json,
                    itemTs ?? createdAt,
                  );
                  if (m) {
                    if (itemTs === undefined) m.timeUnknown = true;
                    if (threadModel) m.model = threadModel;
                    full.push(m);
                  }
                }
                if (full.length > 0) return full;
              } catch {
                // Fallback below
              } finally {
                try {
                  hDb?.close();
                } catch {}
              }
            }
            return sampleMessages;
          },
        });
      }
    } catch {
      // Ignore corrupt SQLite DB
    } finally {
      try {
        historyDb?.close();
      } catch {}
      try {
        stateDb?.close();
      } catch {}
    }
  }

  return results;
}

// ─── 4. Antigravity CLI Scanner (conversation_summaries.db + brain/*.jsonl) ─

function chooseBestAntigravityWorkspace(urisRaw: string | null | undefined, fallback: string): string {
  if (!urisRaw) return fallback;
  try {
    const parsed = JSON.parse(urisRaw);
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
    const paths = parsed
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map((u) => canonicalizeProjectPath(u, fallback));
    if (paths.length === 0) return fallback;
    // Prefer user project folders over internal skill directories (.gemini/ or .agents/skills)
    const nonSkill = paths.find(
      (p) =>
        !p.includes('/.gemini/') &&
        !p.endsWith('/.gemini') &&
        !p.includes('/.agents/skills'),
    );
    return nonSkill ?? paths[0];
  } catch {
    return fallback;
  }
}

function parseAntigravityTranscript(
  transcriptPath: string,
  fallbackTs: number,
): DiscoveredCliChatMessage[] {
  if (!existsSync(transcriptPath)) return [];
  let raw: string;
  try {
    raw = readHeadAndTailText(transcriptPath);
  } catch {
    return [];
  }
  const msgs: DiscoveredCliChatMessage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const step = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof step.type === 'string' ? step.type : '';
      const ts = normalizeTimestampMs(step.created_at, fallbackTs);
      if (type === 'USER_INPUT' && typeof step.content === 'string') {
        const cleaned = cleanMessageText(step.content);
        if (cleaned) {
          msgs.push({ role: 'user', content: cleaned, createdAt: ts });
        }
      } else if (type === 'PLANNER_RESPONSE' && typeof step.content === 'string') {
        const cleaned = cleanMessageText(step.content);
        if (cleaned) {
          msgs.push({ role: 'assistant', content: cleaned, createdAt: ts });
        }
      }
    } catch {
      continue;
    }
  }
  return msgs;
}

function scanAntigravityRoot(root: string, maxChats: number): InternalDiscoveredChat[] {
  const dbPath = join(root, 'conversation_summaries.db');
  const results: InternalDiscoveredChat[] = [];
  const seenIds = new Set<string>();

  if (existsSync(dbPath)) {
    let sqlite: Database | null = null;
    try {
      sqlite = openReadonlySqlite(dbPath);
      if (!sqlite) throw new Error('conversation_summaries.db is unreadable');
      // Swarm workers are their own conversations; they import nested under the
      // coordinator's call that added them, never as top-level chats.
      const relations: AntigravityRelations = readAntigravityRelations(sqlite);
      const rows = sqlite
        .query(
          `SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, preview
           FROM conversation_summaries
           WHERE COALESCE(step_count, 0) > 0
           ORDER BY last_modified_time DESC
           LIMIT ?`,
        )
        .all(maxChats + relations.childIds.size) as Array<{
        conversation_id: string;
        title: string | null;
        step_count: number | null;
        last_modified_time: string | null;
        workspace_uris: string | null;
        preview: string | null;
      }>;

      for (const row of rows) {
        const convId = row.conversation_id;
        if (!convId || relations.childIds.has(convId)) continue;
        if (results.length >= maxChats) break;
        seenIds.add(convId);

        const textTranscriptPath = join(
          root,
          'brain',
          convId,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );
        // Some conversations keep only `transcript_full.jsonl`.
        const transcriptPath = existsSync(textTranscriptPath)
          ? textTranscriptPath
          : (antigravityTranscriptPath(root, convId) ?? textTranscriptPath);
        const updatedAt = normalizeTimestampMs(row.last_modified_time);
        const transcriptMessages = parseAntigravityTranscript(transcriptPath, updatedAt);
        const rawPreview = cleanMessageText(row.preview ?? row.title ?? '');
        if (transcriptMessages.length === 0 && !rawPreview) continue;

        const sampleMessages: DiscoveredCliChatMessage[] =
          transcriptMessages.length > 0
            ? transcriptMessages.slice(0, MAX_SAMPLE_MESSAGES)
            : [{ role: 'user', content: rawPreview, createdAt: updatedAt }];

        const projectPath = chooseBestAntigravityWorkspace(row.workspace_uris, root);
        const createdAt = transcriptMessages[0]?.createdAt ?? updatedAt;
        const title = deriveChatTitle(row.title, sampleMessages[0]?.content ?? rawPreview);
        const preview = derivePreview(rawPreview, sampleMessages);

        results.push({
          id: `antigravity:${convId}`,
          externalId: convId,
          provider: 'antigravity',
          providerDisplayName: 'Antigravity CLI',
          projectPath,
          projectName: projectNameFromPath(projectPath),
          title,
          preview,
          messageCount:
            transcriptMessages.length > 0
              ? transcriptMessages.length
              : Math.max(1, Number(row.step_count ?? 1)),
          createdAt,
          updatedAt,
          alreadyImported: false,
          sampleMessages,
          loadMessages: () => {
            // Full transcript: reasoning, tool calls with outputs and durations,
            // errors, background-task completions and swarm sub-agents.
            const structured = loadAntigravityConversation(root, convId, portingHelpers(), {
              relations,
              chatStartMs: createdAt,
            });
            if (structured.some((m) => m.role === 'user' || m.content.trim())) return structured;
            const full = parseAntigravityTranscript(transcriptPath, updatedAt);
            return full.length > 0
              ? full.slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT)
              : sampleMessages;
          },
        });
      }
    } catch {
      // Ignore SQLite read failure
    } finally {
      try {
        sqlite?.close();
      } catch {}
    }
  }

  return results;
}

// ─── 5. Devin CLI Scanner (sessions.db + transcripts/*.json) ────────────────

/**
 * Read a Devin session's message forest.
 *
 * `message_nodes` is a forest, not a list. The user's conversation is the tree
 * that holds `sessions.main_chain_id`; compaction re-roots it on a new branch
 * that repeats earlier messages by `message_id`, so each `message_id` is kept
 * once, in node order, and only real user input (`metadata.is_user_input`)
 * becomes a user message.
 *
 * Every other tree is a sub-agent or a Summarizer run. A sub-agent run starts
 * at its task message (`telemetry.source = subagent_task`: a `run_subagent`
 * task or a Sidekick `<lead_handoff>`); its copies across re-rooted trees are
 * merged by `message_id`. Each run is nested under the `run_subagent` /
 * `sidekick` call that started it (matched by the task text the call sent);
 * Summarizer runs become a "Context compaction" sub-agent at the time they
 * ran. None of it becomes a top-level message of the chat.
 */
interface DevinParsedNode {
  nodeId: number;
  parentId: number | null;
  rowCreatedAt: number | null;
  msg: Record<string, unknown>;
}

function devinMetadata(msg: Record<string, unknown>): Record<string, unknown> | null {
  return msg.metadata && typeof msg.metadata === 'object' ? (msg.metadata as Record<string, unknown>) : null;
}

function devinExtensions(msg: Record<string, unknown>): Record<string, unknown> {
  const ext = devinMetadata(msg)?.extensions;
  return ext && typeof ext === 'object' ? (ext as Record<string, unknown>) : {};
}

function devinContentText(msg: Record<string, unknown>): string {
  return typeof msg.content === 'string' ? msg.content : extractTextFromContentField(msg.content);
}

function isDevinSubagentTask(msg: Record<string, unknown>): boolean {
  if (msg.role !== 'user') return false;
  const telemetry = devinMetadata(msg)?.telemetry as { source?: unknown } | undefined;
  return telemetry?.source === 'subagent_task';
}

interface DevinRowContext {
  defaultModel?: string;
  fallbackTs: number;
  toolNames: Map<string, string>;
  callArgs: Map<string, Record<string, unknown>>;
  resolveSubagent: (
    callId: string,
    name: string,
    args: Record<string, unknown> | undefined,
    agentId: string | undefined,
  ) => SubagentTranscript | undefined;
}

/** Convert one agent's ordered Devin chat messages into import rows. */
function devinMessagesToRows(nodes: readonly DevinParsedNode[], ctx: DevinRowContext): ImportedCliMessage[] {
  const msgs: ImportedCliMessage[] = [];
  for (const node of nodes) {
    const msg = node.msg;
    const metadata = devinMetadata(msg);
    const sourceTs = sourceTimestampMs(metadata?.created_at) ?? sourceTimestampMs(node.rowCreatedAt);
    const known = sourceTs !== undefined;
    const ts = sourceTs ?? ctx.fallbackTs;
    const unknownFlag: { timeUnknown?: true } = known ? {} : { timeUnknown: true };
    const rowModel =
      typeof metadata?.generation_model === 'string' && metadata.generation_model
        ? metadata.generation_model
        : ctx.defaultModel;
    const contentText = devinContentText(msg);

    if (msg.role === 'user') {
      if (metadata && 'is_user_input' in metadata && !metadata.is_user_input) continue;
      const text = cleanMessageText(contentText);
      if (!text || isNoiseUserPrompt(text)) continue;
      msgs.push({ role: 'user', content: text, createdAt: ts, model: ctx.defaultModel, ...unknownFlag });
      continue;
    }

    if (msg.role === 'assistant') {
      const events: TurnEvent[] = [];
      const thinking =
        msg.thinking && typeof msg.thinking === 'object'
          ? (msg.thinking as { thinking?: unknown }).thinking
          : msg.thinking;
      if (typeof thinking === 'string' && thinking.trim()) {
        // Devin records when the whole message was generated, never how long
        // the thinking block itself took.
        events.push(...reasoningEvents(thinking, { timestamp: ts }));
      }
      const text = cleanMessageText(contentText);
      if (text) events.push({ type: 'text', text, timestamp: ts });
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const c = call as Record<string, unknown>;
          if (typeof c.id !== 'string' || !c.id) continue;
          const name = typeof c.name === 'string' && c.name ? c.name : 'tool';
          const input = toolInputRecord(c.arguments);
          ctx.toolNames.set(c.id, name);
          ctx.callArgs.set(c.id, input);
          events.push({ type: 'tool_call', callId: c.id, name, input, timestamp: ts });
        }
      }
      if (events.length > 0) {
        msgs.push({ role: 'assistant', content: text, createdAt: ts, model: rowModel, events, ...unknownFlag });
      }
      continue;
    }

    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string' && msg.tool_call_id) {
      const ext = devinExtensions(msg);
      const timing = (ext['chisel/tool_call_timing'] as Record<string, unknown> | undefined) ?? {};
      const resultMeta = (ext['chisel/tool_result_meta'] as Record<string, unknown> | undefined) ?? {};
      const callId = msg.tool_call_id;
      const name = ctx.toolNames.get(callId) ?? 'tool';
      const agentId = typeof ext['subagent/agent_id'] === 'string' ? (ext['subagent/agent_id'] as string) : undefined;
      msgs.push({
        role: 'assistant',
        content: '',
        createdAt: ts,
        ...unknownFlag,
        events: [
          toolResultEvent({
            callId,
            name,
            output: toolOutputText(contentText),
            isError: resultMeta.success === false,
            timestamp: ts,
            durationMs: knownDurationMs({
              durationMs: timing.duration_ms,
              startedAt: sourceTimestampMs(timing.started_at),
              endedAt: sourceTimestampMs(timing.finished_at),
            }),
            subagent: ctx.resolveSubagent(callId, name, ctx.callArgs.get(callId), agentId),
          }),
        ],
      });
    }
  }
  return msgs;
}

function readDevinMainTreeMessages(
  sqlite: Database,
  sessionId: string,
  defaultModel: string | undefined,
  fallbackTs: number,
): ImportedCliMessage[] {
  const rows = sqlite
    .query(
      `SELECT node_id, parent_node_id, chat_message, created_at
       FROM message_nodes
       WHERE session_id = ?
       ORDER BY node_id ASC
       LIMIT ?`,
    )
    .all(sessionId, MAX_RAW_SOURCE_ROWS) as Array<{
    node_id: number;
    parent_node_id: number | null;
    chat_message: string;
    created_at: number | null;
  }>;
  if (rows.length === 0) return [];
  if (rows.length >= MAX_RAW_SOURCE_ROWS) {
    serverLog.warn({ sessionId, cap: MAX_RAW_SOURCE_ROWS }, 'Devin import hit the raw row safety cap');
  }

  let mainChainId: number | null = null;
  try {
    const sessionRow = sqlite
      .query(`SELECT main_chain_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { main_chain_id?: number | null } | null;
    mainChainId = typeof sessionRow?.main_chain_id === 'number' ? sessionRow.main_chain_id : null;
  } catch {
    mainChainId = null;
  }

  const nodes: DevinParsedNode[] = [];
  const byId = new Map<number, DevinParsedNode>();
  for (const row of rows) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(row.chat_message) as Record<string, unknown>;
    } catch {
      msg = {};
    }
    const node: DevinParsedNode = {
      nodeId: row.node_id,
      parentId: row.parent_node_id,
      rowCreatedAt: row.created_at,
      msg,
    };
    nodes.push(node);
    byId.set(node.nodeId, node);
  }

  const rootCache = new Map<number, number>();
  const rootOf = (nodeId: number): number => {
    const cached = rootCache.get(nodeId);
    if (cached !== undefined) return cached;
    let current = nodeId;
    const seen = new Set<number>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = byId.get(current)?.parentId;
      if (parent === null || parent === undefined || !byId.has(parent)) break;
      current = parent;
    }
    for (const id of seen) rootCache.set(id, current);
    return current;
  };

  let mainRoot: number | null = mainChainId !== null && byId.has(mainChainId) ? rootOf(mainChainId) : null;
  if (mainRoot === null) {
    // Older sessions without a main chain pointer: the largest tree that is not
    // a sub-agent or Summarizer run is the conversation the user drove.
    const sizes = new Map<number, number>();
    for (const node of nodes) {
      const root = rootOf(node.nodeId);
      sizes.set(root, (sizes.get(root) ?? 0) + 1);
    }
    let best = -1;
    for (const [root, size] of sizes) {
      if (size > best) {
        best = size;
        mainRoot = root;
      }
    }
  }

  const summarizerRoots = new Set<number>();
  for (const node of nodes) {
    if (node.parentId !== null && byId.has(node.parentId)) continue;
    const content = devinContentText(node.msg);
    if (node.msg.role === 'system' && /You are a Summarizer/i.test(content)) summarizerRoots.add(node.nodeId);
  }

  // Sub-agent runs: every non-main node belongs to the run of its nearest task
  // ancestor; copies in re-rooted trees share the task's message_id.
  const taskAncestorCache = new Map<number, number | null>();
  const taskAncestorOf = (nodeId: number): number | null => {
    const path: number[] = [];
    let current: number | null | undefined = nodeId;
    let found: number | null = null;
    const seen = new Set<number>();
    while (current !== null && current !== undefined && byId.has(current) && !seen.has(current)) {
      seen.add(current);
      const cached = taskAncestorCache.get(current);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      path.push(current);
      const node = byId.get(current) as DevinParsedNode;
      if (isDevinSubagentTask(node.msg)) {
        found = current;
        break;
      }
      current = node.parentId;
    }
    for (const id of path) taskAncestorCache.set(id, found);
    return found;
  };

  interface DevinRun {
    key: string;
    task: string;
    nodes: DevinParsedNode[];
    startMs?: number;
    claimed?: boolean;
    building?: boolean;
    transcript?: SubagentTranscript;
  }
  // Message ids of the main tree: a re-rooted copy of the main conversation is
  // not a sub-agent.
  const mainMessageIds = new Set<string>();
  for (const node of nodes) {
    if (rootOf(node.nodeId) === mainRoot && typeof node.msg.message_id === 'string') {
      mainMessageIds.add(node.msg.message_id);
    }
  }
  // Older Devin versions do not tag task messages: such a tree's first prompt
  // that is not part of the main conversation is its task.
  const fallbackTaskByRoot = new Map<number, number | null>();
  const fallbackTaskOf = (root: number): number | null => {
    const cached = fallbackTaskByRoot.get(root);
    if (cached !== undefined) return cached;
    const first = nodes.find((candidate) => rootOf(candidate.nodeId) === root && candidate.msg.role === 'user');
    const id =
      first && !(typeof first.msg.message_id === 'string' && mainMessageIds.has(first.msg.message_id))
        ? first.nodeId
        : null;
    fallbackTaskByRoot.set(root, id);
    return id;
  };

  const runs = new Map<string, DevinRun>();
  // A message belongs to the run it was first written in. Re-rooted copies
  // (compaction, resumed Sidekicks) can sit under a later task message and
  // would otherwise repeat earlier work in that later run.
  const assignedMessageIds = new Set<string>();
  for (const node of nodes) {
    const root = rootOf(node.nodeId);
    if (root === mainRoot || summarizerRoots.has(root)) continue;
    if (typeof node.msg.message_id === 'string' && mainMessageIds.has(node.msg.message_id)) continue;
    const taskNodeId = taskAncestorOf(node.nodeId) ?? fallbackTaskOf(root);
    if (taskNodeId === null) continue;
    const taskNode = byId.get(taskNodeId) as DevinParsedNode;
    const key = typeof taskNode.msg.message_id === 'string' ? taskNode.msg.message_id : `node-${taskNodeId}`;
    let run = runs.get(key);
    if (!run) {
      const task = cleanMessageText(devinContentText(taskNode.msg));
      run = {
        key,
        task,
        nodes: [],
        startMs: sourceTimestampMs(devinMetadata(taskNode.msg)?.created_at) ?? sourceTimestampMs(taskNode.rowCreatedAt),
      };
      runs.set(key, run);
    }
    const messageId = typeof node.msg.message_id === 'string' ? node.msg.message_id : `node-${node.nodeId}`;
    if (assignedMessageIds.has(messageId)) continue;
    assignedMessageIds.add(messageId);
    run.nodes.push(node);
  }

  const handoffBody = (task: string): string =>
    task
      .replace(/^<lead_handoff>\s*/i, '')
      .replace(/\s*<\/lead_handoff>[\s\S]*$/i, '')
      .trim();

  const ctxFor = (): DevinRowContext => ({
    defaultModel,
    fallbackTs,
    toolNames: new Map(),
    callArgs: new Map(),
    resolveSubagent,
  });

  const buildRun = (run: DevinRun, name: string, agentId: string | undefined): SubagentTranscript | undefined => {
    if (run.transcript) return run.transcript;
    if (run.building) return undefined;
    run.building = true;
    const rowsForRun = devinMessagesToRows(run.nodes, ctxFor());
    const model = rowsForRun.find((m) => m.role === 'assistant' && m.model)?.model;
    run.transcript = buildSubagentTranscript(
      { agentId, name, task: handoffBody(run.task) || undefined, model, provider: 'devin' },
      rowsForRun,
      run.startMs,
    );
    run.building = false;
    return run.transcript;
  };

  function resolveSubagent(
    callId: string,
    name: string,
    args: Record<string, unknown> | undefined,
    agentId: string | undefined,
  ): SubagentTranscript | undefined {
    void callId;
    const sent = [args?.task, args?.message, args?.prompt].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (!sent || (!agentId && name !== 'run_subagent' && name !== 'sidekick')) return undefined;
    const probe = cleanMessageText(sent).trim().slice(0, 400);
    if (!probe) return undefined;
    const run = [...runs.values()].find((candidate) => !candidate.claimed && candidate.task.includes(probe));
    if (!run) return undefined;
    run.claimed = true;
    const label =
      (typeof args?.title === 'string' && args.title) || (name === 'sidekick' ? 'Sidekick' : agentId ?? 'subagent');
    return buildRun(run, label, agentId);
  }

  const mainNodes: DevinParsedNode[] = [];
  const seenMessageIds = new Set<string>();
  for (const node of nodes) {
    if (rootOf(node.nodeId) !== mainRoot) continue;
    const messageId = typeof node.msg.message_id === 'string' ? node.msg.message_id : null;
    if (messageId) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    mainNodes.push(node);
  }
  const msgs = devinMessagesToRows(mainNodes, ctxFor());

  // Summarizer (compaction) runs, once each, where they ran.
  const seenSummaries = new Set<string>();
  for (const root of summarizerRoots) {
    const treeNodes = nodes.filter((node) => rootOf(node.nodeId) === root);
    const prompt = treeNodes.find((node) => node.msg.role === 'user');
    const key = typeof prompt?.msg.message_id === 'string' ? prompt.msg.message_id : `summarizer-${root}`;
    if (seenSummaries.has(key)) continue;
    seenSummaries.add(key);
    const turns: SubagentTurn[] = [];
    let startMs: number | undefined;
    for (const node of treeNodes) {
      const at = sourceTimestampMs(devinMetadata(node.msg)?.created_at) ?? sourceTimestampMs(node.rowCreatedAt);
      const text = devinContentText(node.msg);
      if (!text.trim()) continue;
      if (node.msg.role === 'user') {
        startMs ??= at;
        turns.push(at === undefined ? { role: 'user', text } : { role: 'user', text, createdAt: at });
      } else if (node.msg.role === 'assistant') {
        const parts: TranscriptPart[] = [{ kind: 'text', text, startedAt: at ?? startMs ?? fallbackTs }];
        turns.push(at === undefined ? { role: 'assistant', parts } : { role: 'assistant', parts, createdAt: at });
      }
    }
    if (turns.length === 0) continue;
    const sub: SubagentTranscript = {
      agentId: key,
      name: 'Context compaction',
      task: 'Summarize the conversation so far',
      provider: 'devin',
      turns,
    };
    const at = startMs ?? firstKnownTime(msgs) ?? fallbackTs;
    insertRowByTime(msgs, {
      role: 'assistant',
      content: '',
      createdAt: at,
      events: synthesizedSubagentEvents(sub, at, { key: `summarizer-${key}` }),
      ...(startMs === undefined ? { timeUnknown: true as const } : {}),
    });
  }

  // Sub-agent runs no call claimed: synthetic parts where they started.
  for (const run of runs.values()) {
    if (run.claimed) continue;
    run.claimed = true;
    const transcript = buildRun(run, 'subagent', undefined);
    if (!transcript) continue;
    const at = run.startMs ?? firstKnownTime(msgs) ?? fallbackTs;
    insertRowByTime(msgs, {
      role: 'assistant',
      content: '',
      createdAt: at,
      events: synthesizedSubagentEvents(transcript, at, { key: run.key }),
      ...(run.startMs === undefined ? { timeUnknown: true as const } : {}),
    });
  }
  return msgs;
}

function loadDevinSessionMessages(
  dbPath: string,
  root: string,
  sessionId: string,
  defaultModel: string | undefined,
  fallbackTs: number,
): ImportedCliMessage[] {
  if (existsSync(dbPath)) {
    const sqlite = openReadonlySqlite(dbPath);
    try {
      const msgs = sqlite ? readDevinMainTreeMessages(sqlite, sessionId, defaultModel, fallbackTs) : [];
      if (msgs.length > 0) return msgs;
    } catch {
      // Fall through to ATIF JSON transcript
    } finally {
      try {
        sqlite?.close();
      } catch {}
    }
  }

  const transcriptPath = join(root, 'transcripts', `${sessionId}.json`);
  if (existsSync(transcriptPath)) {
    try {
      const data = JSON.parse(readFileSync(transcriptPath, 'utf8')) as {
        steps?: Array<{
          source?: string;
          message?: string;
          timestamp?: string;
          model_name?: string;
        }>;
      };
      const msgs: DiscoveredCliChatMessage[] = [];
      for (const step of data.steps ?? []) {
        const role =
          step.source === 'user' ? 'user' : step.source === 'agent' ? 'assistant' : null;
        if (!role || typeof step.message !== 'string') continue;
        const text = cleanMessageText(step.message);
        if (!text) continue;
        msgs.push({
          role,
          content: text,
          createdAt: normalizeTimestampMs(step.timestamp, fallbackTs),
          model: step.model_name ?? defaultModel,
        });
      }
      return msgs.slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT);
    } catch {
      return [];
    }
  }
  return [];
}

function scanDevinRoot(root: string, maxChats: number): InternalDiscoveredChat[] {
  const dbPath = join(root, 'sessions.db');
  const results: InternalDiscoveredChat[] = [];
  if (!existsSync(dbPath)) return results;

  let sqlite: Database | null = null;
  try {
    sqlite = openReadonlySqlite(dbPath);
    if (!sqlite) return results;
    const rows = sqlite
      .query(
        `SELECT s.id, s.working_directory, s.model, s.created_at, s.last_activity_at, s.title
         FROM sessions s
         WHERE COALESCE(s.hidden, 0) = 0
         ORDER BY s.last_activity_at DESC
         LIMIT ?`,
      )
      .all(maxChats) as Array<{
      id: string;
      working_directory: string | null;
      model: string | null;
      created_at: number | null;
      last_activity_at: number | null;
      title: string | null;
    }>;

    for (const row of rows) {
      const createdAt = normalizeTimestampMs(row.created_at);
      const updatedAt = normalizeTimestampMs(row.last_activity_at, createdAt);
      const msgs = loadDevinSessionMessages(
        dbPath,
        root,
        row.id,
        row.model ?? undefined,
        createdAt,
      );
      if (msgs.length === 0 && !(row.title ?? '').trim()) continue;

      const projectPath = canonicalizeProjectPath(row.working_directory, root);
      const firstUser = msgs.find((m) => m.role === 'user')?.content ?? msgs[0]?.content ?? '';
      const title = deriveChatTitle(row.title, firstUser);
      const preview = derivePreview(row.title, msgs);

      results.push({
        id: `devin:${row.id}`,
        externalId: row.id,
        provider: 'devin',
        providerDisplayName: 'Devin CLI',
        projectPath,
        projectName: projectNameFromPath(projectPath),
        title,
        preview,
        model: row.model ?? undefined,
        messageCount: Math.max(countImportTurns(msgs), 1),
        createdAt,
        updatedAt,
        alreadyImported: false,
        sampleMessages: toPublicSamples(msgs),
        loadMessages: () =>
          loadDevinSessionMessages(dbPath, root, row.id, row.model ?? undefined, createdAt),
      });
    }
  } catch {
    // Ignore SQLite read errors
  } finally {
    try {
      sqlite?.close();
    } catch {}
  }

  return results;
}

// ─── 6. Freebuff CLI Scanner (~/.config/manicode/projects/<slug>/chats/*) ───

function readFreebuffProjectRootFast(chatDir: string): string | null {
  const runStatePath = join(chatDir, 'run-state.json');
  if (!existsSync(runStatePath)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(runStatePath, 'r');
    const buf = Buffer.alloc(1024);
    const bytesRead = readSync(fd, buf, 0, 1024, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    const rootMatch = head.match(/"projectRoot"\s*:\s*"([^"]+)"/);
    if (rootMatch?.[1]) return rootMatch[1];
    const cwdMatch = head.match(/"cwd"\s*:\s*"([^"]+)"/);
    if (cwdMatch?.[1]) return cwdMatch[1];
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  return null;
}

/**
 * The creation time a Freebuff UI id records (`user-1793567753089`,
 * `ai-1793567753370-…`), or undefined.
 */
function freebuffItemSourceTimestamp(id: unknown): number | undefined {
  if (typeof id !== 'string') return undefined;
  const match = id.match(/-(\d{12,14})(?:-|$)/);
  return match ? sourceTimestampMs(Number(match[1])) : undefined;
}

interface FreebuffUiBlock {
  type?: string;
  content?: string;
  textType?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  status?: string;
  initialPrompt?: string;
  params?: unknown;
  questions?: unknown;
  answers?: unknown;
  blocks?: FreebuffUiBlock[];
}

/**
 * Turn events for Freebuff UI blocks. Freebuff records no time per block, so
 * reasoning and tool durations are `timeUnknown`. A spawned sub-agent block
 * becomes a tool row whose `subagent` carries the agent's own nested blocks
 * (recursively, for agents that spawn agents).
 */
function freebuffBlockEvents(blocks: FreebuffUiBlock[], ts: number): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.content === 'string' && block.content.trim()) {
      if (block.textType === 'reasoning') {
        events.push(...reasoningEvents(block.content, { timestamp: ts }));
      } else {
        const text = cleanMessageText(block.content);
        if (text) events.push({ type: 'text', text, timestamp: ts });
      }
    } else if (block.type === 'tool' && typeof block.toolCallId === 'string' && block.toolCallId) {
      const name = block.toolName || 'tool';
      events.push({
        type: 'tool_call',
        callId: block.toolCallId,
        name,
        input: toolInputRecord(block.input),
        timestamp: ts,
      });
      if (block.output !== undefined) {
        events.push(
          toolResultEvent({ callId: block.toolCallId, name, output: toolOutputText(block.output), timestamp: ts }),
        );
      }
    } else if (block.type === 'ask-user' && typeof block.toolCallId === 'string' && block.toolCallId) {
      const input = toolInputRecord({ questions: block.questions });
      events.push({ type: 'tool_call', callId: block.toolCallId, name: 'ask_user', input, timestamp: ts });
      if (block.answers !== undefined) {
        events.push(
          toolResultEvent({
            callId: block.toolCallId,
            name: 'ask_user',
            output: toolOutputText(block.answers),
            timestamp: ts,
          }),
        );
      }
    } else if (block.type === 'agent' && typeof block.agentId === 'string' && block.agentId) {
      const name = block.agentType || block.agentName || 'agent';
      const callId = `agent-${block.agentId}`;
      const prompt = typeof block.initialPrompt === 'string' ? block.initialPrompt.trim() : '';
      const params =
        block.params && typeof block.params === 'object' ? (block.params as Record<string, unknown>) : undefined;
      let task = prompt;
      if (!task && params) {
        try {
          task = JSON.stringify(params);
        } catch {
          task = '';
        }
      }
      const input: Record<string, unknown> = { agent: block.agentName ?? name };
      if (prompt) input.prompt = prompt;
      if (params) input.params = toolInputRecord(params);
      events.push({ type: 'tool_call', callId, name, input, timestamp: ts });
      const nested: ImportedCliMessage[] = [];
      if (task) nested.push({ role: 'user', content: task, createdAt: ts, timeUnknown: true });
      const nestedEvents = freebuffBlockEvents(block.blocks ?? [], ts);
      const finalText = cleanMessageText(block.content ?? '');
      if (finalText && !nestedEvents.some((event) => event.type === 'text' && event.text === finalText)) {
        nestedEvents.push({ type: 'text', text: finalText, timestamp: ts });
      }
      if (nestedEvents.length > 0) {
        nested.push({ role: 'assistant', content: '', createdAt: ts, events: nestedEvents, timeUnknown: true });
      }
      const subagent = buildSubagentTranscript(
        { agentId: block.agentId, name, task: task || undefined, provider: 'freebuff' },
        nested,
      );
      events.push(
        toolResultEvent({
          callId,
          name,
          output: toolOutputText(block.content || subagentFinalAnswer(subagent)),
          isError: block.status === 'failed' || block.status === 'error',
          timestamp: ts,
          subagent,
        }),
      );
    }
  }
  return events;
}

/** A Freebuff user item's pasted text and image attachments. */
function freebuffUserAttachments(item: {
  textAttachments?: Array<{ content?: unknown; name?: unknown; filename?: unknown }>;
  attachments?: Array<{ path?: unknown; filename?: unknown }>;
}): { extraText: string[]; attachments: MessageAttachment[] } {
  const extraText: string[] = [];
  const attachments: MessageAttachment[] = [];
  for (const pasted of item.textAttachments ?? []) {
    if (typeof pasted?.content !== 'string' || !pasted.content.trim()) continue;
    const label = typeof pasted.name === 'string' ? pasted.name : typeof pasted.filename === 'string' ? pasted.filename : 'pasted text';
    extraText.push(`[Attached text: ${label}]\n${capText(pasted.content, MAX_IMPORTED_VALUE_CHARS)}`);
  }
  for (const file of item.attachments ?? []) {
    const path = typeof file?.path === 'string' ? file.path : '';
    const name = typeof file?.filename === 'string' ? file.filename : path ? basename(path) : 'attachment';
    const ext = name.toLowerCase().split('.').pop() ?? '';
    const mimeType =
      ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : undefined;
    try {
      if (path && existsSync(path) && statSync(path).size <= MAX_IMPORTED_ATTACHMENT_BYTES) {
        attachments.push({
          type: mimeType ? 'image' : 'file',
          data: readFileSync(path).toString('base64'),
          name,
          ...(mimeType ? { mimeType } : {}),
        });
        continue;
      }
    } catch {
      // Fall through to the reference below.
    }
    extraText.push(`[Attached ${mimeType ? 'image' : 'file'}: ${name} — the file is no longer on disk]`);
  }
  return { extraText, attachments };
}

/**
 * Freebuff keeps two records of a chat. `chat-messages.json` is the UI
 * transcript: every user prompt and every agent turn with its reasoning, tool
 * and sub-agent blocks. `run-state.json` is only the agent's *current context*:
 * after a compaction it holds a summary plus the latest prompt, so reading it
 * first ported a 54-prompt chat as 2 prompts. The UI transcript is authoritative;
 * run-state is the fallback for chats that predate it.
 */
function loadFreebuffChatMessages(chatDir: string, fallbackTs: number): ImportedCliMessage[] {
  const chatMessagesPath = join(chatDir, 'chat-messages.json');
  if (existsSync(chatMessagesPath)) {
    try {
      const st = statSync(chatMessagesPath);
      if (st.size <= MAX_IMPORT_JSON_BYTES) {
        const items = JSON.parse(readFileSync(chatMessagesPath, 'utf8')) as Array<{
          id?: string;
          variant?: string;
          content?: string;
          blocks?: FreebuffUiBlock[];
          userError?: string;
          textAttachments?: Array<{ content?: unknown; name?: unknown; filename?: unknown }>;
          attachments?: Array<{ path?: unknown; filename?: unknown }>;
        }>;
        const msgs: ImportedCliMessage[] = [];
        let index = 0;
        for (const item of Array.isArray(items) ? items : []) {
          index += 1;
          const role =
            item.variant === 'user'
              ? 'user'
              : item.variant === 'ai' || item.variant === 'assistant'
                ? 'assistant'
                : null;
          if (!role) continue;
          // The id is the only date Freebuff records (`timestamp` is a clock time
          // without a day). Without it the row's time is unknown.
          const sourceTs = freebuffItemSourceTimestamp(item.id);
          const ts = sourceTs ?? fallbackTs;
          const unknownFlag: { timeUnknown?: true } = sourceTs === undefined ? { timeUnknown: true } : {};
          if (role === 'user') {
            const { extraText, attachments } = freebuffUserAttachments(item);
            const text = [cleanMessageText(item.content ?? ''), ...extraText].filter(Boolean).join('\n\n');
            if (!text && attachments.length === 0) continue;
            const row: ImportedCliMessage = { role, content: text, createdAt: ts, ...unknownFlag };
            if (attachments.length > 0) row.attachments = attachments;
            msgs.push(row);
            continue;
          }
          const events = freebuffBlockEvents(item.blocks ?? [], ts);
          const directText = cleanMessageText(item.content ?? '');
          if (directText && !events.some((event) => event.type === 'text')) {
            events.push({ type: 'text', text: directText, timestamp: ts });
          }
          if (typeof item.userError === 'string' && item.userError.trim()) {
            events.push(...noticeEvents(`${item.id ?? index}-error`, 'error', item.userError, ts, true));
          }
          if (events.length === 0) continue;
          const text = events
            .filter((event): event is Extract<TurnEvent, { type: 'text' }> => event.type === 'text')
            .map((event) => event.text)
            .join('\n\n');
          msgs.push({ role, content: text, createdAt: ts, events, ...unknownFlag });
        }
        if (msgs.length > 0) return msgs;
      }
    } catch {
      // Fall through to run-state.json
    }
  }

  const runStatePath = join(chatDir, 'run-state.json');
  if (existsSync(runStatePath)) {
    try {
      const st = statSync(runStatePath);
      if (st.size <= MAX_IMPORT_JSON_BYTES) {
        const rs = JSON.parse(readFileSync(runStatePath, 'utf8')) as {
          sessionState?: {
            mainAgentState?: {
              messageHistory?: Array<{
                role?: string;
                tags?: string[];
                sentAt?: number;
                content?: unknown;
              }>;
            };
          };
        };
        const history = rs.sessionState?.mainAgentState?.messageHistory ?? [];
        const msgs: ImportedCliMessage[] = [];
        for (const entry of history) {
          if (entry.role !== 'user' && entry.role !== 'assistant') continue;
          if (
            entry.role === 'user' &&
            Array.isArray(entry.tags) &&
            !entry.tags.includes('USER_PROMPT')
          ) {
            continue;
          }
          const text = cleanMessageText(extractTextFromContentField(entry.content));
          if (!text) continue;
          const sentAt = sourceTimestampMs(entry.sentAt);
          msgs.push({
            role: entry.role,
            content: text,
            createdAt: sentAt ?? fallbackTs,
            ...(sentAt === undefined ? { timeUnknown: true as const } : {}),
          });
        }
        if (msgs.length > 0) return msgs;
      }
    } catch {
      // Unreadable run state: nothing left to read.
    }
  }

  return [];
}

function scanFreebuffRoot(root: string, maxChats: number): InternalDiscoveredChat[] {
  const projectsDir = join(root, 'projects');
  if (!existsSync(projectsDir)) return [];

  // Map known project basenames from recent-projects.json
  const recentProjectMap = new Map<string, string>();
  const recentProjectsPath = join(root, 'recent-projects.json');
  if (existsSync(recentProjectsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(recentProjectsPath, 'utf8')) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { projects?: unknown[] })?.projects)
          ? ((parsed as { projects: unknown[] }).projects)
          : [];
      for (const item of list) {
        const p = (item as { path?: string })?.path;
        if (typeof p === 'string' && p.trim() && p !== '/') {
          recentProjectMap.set(basename(p), p);
        }
      }
    } catch {}
  }

  const results: InternalDiscoveredChat[] = [];
  let slugs: string[] = [];
  try {
    slugs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const slug of slugs) {
    const chatsDir = join(projectsDir, slug, 'chats');
    if (!existsSync(chatsDir)) continue;
    let chatFolders: string[] = [];
    try {
      chatFolders = readdirSync(chatsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const chatId of chatFolders) {
      const chatDir = join(chatsDir, chatId);
      const metaPath = join(chatDir, 'chat-meta.json');
      if (!existsSync(metaPath) && !existsSync(join(chatDir, 'run-state.json'))) {
        continue;
      }

      let firstPrompt = '';
      let messageCount = 0;
      let updatedAt = normalizeTimestampMs(chatId);
      const createdAt = updatedAt;

      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
            messageCount?: number;
            firstPrompt?: string;
            messagesMtimeMs?: number;
          };
          firstPrompt = cleanMessageText(meta.firstPrompt ?? '');
          messageCount = Number(meta.messageCount ?? 0);
          if (meta.messagesMtimeMs) {
            updatedAt = normalizeTimestampMs(meta.messagesMtimeMs, updatedAt);
          }
        } catch {}
      }

      if (messageCount <= 0 && !firstPrompt) continue;

      const rawProjectPath =
        readFreebuffProjectRootFast(chatDir) ??
        recentProjectMap.get(slug) ??
        join(homedir(), 'Documents', slug);
      const projectPath = canonicalizeProjectPath(rawProjectPath, root);
      const externalId = `${slug}/${chatId}`;

      const sampleMessages: DiscoveredCliChatMessage[] = firstPrompt
        ? [{ role: 'user', content: firstPrompt, createdAt }]
        : [];
      const title = deriveChatTitle(null, firstPrompt);
      const preview = derivePreview(firstPrompt, sampleMessages);

      results.push({
        id: `freebuff:${externalId}`,
        externalId,
        provider: 'freebuff',
        providerDisplayName: 'Freebuff CLI',
        projectPath,
        projectName: projectNameFromPath(projectPath),
        title,
        preview,
        messageCount: Math.max(messageCount, 1),
        createdAt,
        updatedAt,
        alreadyImported: false,
        sampleMessages,
        loadMessages: () => {
          const loaded = loadFreebuffChatMessages(chatDir, createdAt);
          return loaded.length > 0 ? loaded : sampleMessages;
        },
      });
    }
  }

  return results
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxChats);
}

// ─── 7. OpenCode / Kilo Code / Omnirush SQLite & JSONL Scanners ─────────────

const MAX_OPENCODE_SUBAGENT_DEPTH = 8;

interface OpenCodePartData {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  time?: { start?: unknown; end?: unknown };
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    title?: unknown;
    metadata?: Record<string, unknown>;
    time?: { start?: unknown; end?: unknown };
  };
  mime?: string;
  filename?: string;
  url?: string;
  files?: unknown;
  attempt?: unknown;
  error?: unknown;
  prompt?: string;
  description?: string;
  agent?: string;
  auto?: unknown;
}

/**
 * Read one OpenCode-style session (OpenCode, Kilo Code, Omnirush). Discovery
 * reads a bounded text sample; import reads every part with its recorded
 * timing (reasoning and tool parts carry their own start/end), user file
 * attachments, errors and retries, and nests each `task` tool's child session
 * (`session.parent_id`) under the call that created it.
 */
function loadOpenCodeSessionMessages(
  conn: Database,
  sessionId: string,
  limit: number,
  defaultTs: number,
  forImport = false,
  depth = 0,
): { model?: string; messages: ImportedCliMessage[] } {
  // Discovery reads a bounded sample; import reads every part. The part
  // LIMIT used to apply to import too, and tool/step parts outnumber text,
  // so long sessions were silently cut off.
  const rows = conn
    .query(
      `SELECT m.id, m.time_created, m.data AS msg_data, p.data AS part_data
       FROM message m
       JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ?
       ORDER BY m.time_created ASC, p.time_created ASC
       LIMIT ?`,
    )
    .all(sessionId, forImport ? MAX_RAW_SOURCE_ROWS : limit * 4) as Array<{
    id: string;
    time_created: number | null;
    msg_data: string;
    part_data: string;
  }>;
  if (forImport && rows.length >= MAX_RAW_SOURCE_ROWS) {
    serverLog.warn({ sessionId, cap: MAX_RAW_SOURCE_ROWS }, 'OpenCode import hit the raw row safety cap');
  }

  // Child sessions a `task` tool created, for nesting.
  const children = new Map<string, { id: string; title: string; createdAt?: number }>();
  const claimedChildren = new Set<string>();
  if (forImport && depth < MAX_OPENCODE_SUBAGENT_DEPTH) {
    try {
      const childRows = conn
        .query(`SELECT id, title, time_created FROM session WHERE parent_id = ? ORDER BY time_created ASC`)
        .all(sessionId) as Array<{ id: string; title: string | null; time_created: number | null }>;
      for (const child of childRows) {
        children.set(child.id, {
          id: child.id,
          title: child.title ?? '',
          createdAt: sourceTimestampMs(child.time_created),
        });
      }
    } catch {
      // No parent links in this store.
    }
  }
  const childTranscript = (childId: string, name: string, task: string | undefined): SubagentTranscript | undefined => {
    const child = children.get(childId);
    if (!child || claimedChildren.has(childId)) return undefined;
    claimedChildren.add(childId);
    const loaded = loadOpenCodeSessionMessages(conn, childId, limit, child.createdAt ?? defaultTs, true, depth + 1);
    return buildSubagentTranscript(
      { agentId: childId, name, task: task || child.title || undefined, model: loaded.model },
      loaded.messages,
      child.createdAt,
    );
  };

  let detectedModel: string | undefined;
  const byMsgId = new Map<
    string,
    {
      role: 'user' | 'assistant';
      texts: string[];
      events: TurnEvent[];
      attachments: MessageAttachment[];
      createdAt: number;
      timeUnknown?: true;
      model?: string;
    }
  >();
  let partIndex = 0;

  for (const r of rows) {
    partIndex += 1;
    try {
      const msgObj = JSON.parse(r.msg_data) as {
        role?: string;
        modelID?: string;
        model?: { modelID?: string };
        time?: { created?: unknown };
        error?: { name?: unknown; data?: { message?: unknown } };
      };
      if (msgObj.role !== 'user' && msgObj.role !== 'assistant') continue;
      const partObj = JSON.parse(r.part_data) as OpenCodePartData;
      const mId = msgObj.modelID ?? msgObj.model?.modelID;
      if (mId && !detectedModel) detectedModel = mId;
      const sourceTs = sourceTimestampMs(r.time_created) ?? sourceTimestampMs(msgObj.time?.created);
      const createdAt = sourceTs ?? defaultTs;
      let entry = byMsgId.get(r.id);
      const ensure = () => {
        if (!entry) {
          entry = {
            role: msgObj.role as 'user' | 'assistant',
            texts: [],
            events: [],
            attachments: [],
            createdAt,
            model: mId,
            ...(sourceTs === undefined ? { timeUnknown: true as const } : {}),
          };
          byMsgId.set(r.id, entry);
          // An assistant message that failed records the error on the message.
          const err = msgObj.error;
          if (forImport && msgObj.role === 'assistant' && err) {
            const message =
              typeof err.data?.message === 'string' ? err.data.message : typeof err.name === 'string' ? err.name : '';
            if (message) entry.events.push(...noticeEvents(`${r.id}-error`, 'error', message, createdAt, true));
          }
        }
        return entry;
      };

      if (partObj.type === 'text' && typeof partObj.text === 'string' && !partObj.synthetic) {
        const target = ensure();
        target.texts.push(partObj.text);
        const cleaned = cleanMessageText(partObj.text);
        if (cleaned) target.events.push({ type: 'text', text: cleaned, timestamp: createdAt });
        continue;
      }
      if (!forImport) continue;
      if (msgObj.role === 'user') {
        if (partObj.type === 'file' && typeof partObj.url === 'string') {
          const match = partObj.url.match(/^data:([^;,]+);base64,(.+)$/s);
          const name = partObj.filename || 'attachment';
          if (match) {
            const mimeType = partObj.mime || match[1];
            ensure().attachments.push({
              type: mimeType.startsWith('image/') ? 'image' : 'file',
              data: match[2],
              name,
              mimeType,
            });
          } else {
            ensure().texts.push(`[Attached file: ${name}${partObj.url.startsWith('file:') ? ` (${partObj.url})` : ''}]`);
          }
        }
        continue;
      }
      if (partObj.type === 'reasoning' && typeof partObj.text === 'string' && partObj.text.trim()) {
        ensure().events.push(
          ...reasoningEvents(partObj.text, {
            timestamp: createdAt,
            startedAt: sourceTimestampMs(partObj.time?.start),
            endedAt: sourceTimestampMs(partObj.time?.end),
          }),
        );
      } else if (partObj.type === 'tool' && typeof partObj.callID === 'string' && partObj.callID) {
        const name = partObj.tool || 'tool';
        const target = ensure();
        // OpenCode call ids are step-local (`call_0`, `call_1`, …). Merged
        // into one turn they would collide and fold distinct calls together.
        const callId = `${r.id}:${partObj.callID}`;
        const input = toolInputRecord(partObj.state?.input);
        const startedAt = sourceTimestampMs(partObj.state?.time?.start);
        target.events.push({ type: 'tool_call', callId, name, input, timestamp: startedAt ?? createdAt });
        const status = partObj.state?.status;
        if (status === 'completed' || status === 'error') {
          const metadata = partObj.state?.metadata ?? {};
          const childId = typeof metadata.sessionId === 'string' ? metadata.sessionId : undefined;
          let subagent: SubagentTranscript | undefined;
          if (childId) {
            subagent = childTranscript(
              childId,
              typeof input.subagent_type === 'string' ? input.subagent_type : name,
              typeof input.prompt === 'string' ? input.prompt : typeof input.description === 'string' ? input.description : undefined,
            );
          }
          const endedAt = sourceTimestampMs(partObj.state?.time?.end);
          target.events.push(
            toolResultEvent({
              callId,
              name,
              output: toolOutputText(
                status === 'error' ? (partObj.state?.error ?? partObj.state?.output) : partObj.state?.output,
              ),
              isError: status === 'error',
              timestamp: endedAt ?? createdAt,
              durationMs: knownDurationMs({ startedAt, endedAt }),
              subagent,
            }),
          );
        }
      } else if (partObj.type === 'patch' && Array.isArray(partObj.files) && partObj.files.length > 0) {
        const callId = `${r.id}:patch:${partIndex}`;
        const files = partObj.files.filter((file): file is string => typeof file === 'string');
        ensure().events.push(
          { type: 'tool_call', callId, name: 'patch', input: { files }, timestamp: createdAt },
          toolResultEvent({ callId, name: 'patch', output: files.join('\n'), timestamp: createdAt }),
        );
      } else if (partObj.type === 'retry') {
        const err = partObj.error as { data?: { message?: unknown }; message?: unknown } | undefined;
        const message =
          (typeof err?.data?.message === 'string' && err.data.message) ||
          (typeof err?.message === 'string' && err.message) ||
          'Request failed';
        ensure().events.push(
          ...noticeEvents(`${r.id}-retry-${partIndex}`, 'api_error', `${message} (retry ${String(partObj.attempt ?? '')})`.trim(), createdAt, true),
        );
      } else if (partObj.type === 'compaction') {
        const sub: SubagentTranscript = {
          name: 'Context compaction',
          task: partObj.auto ? 'Automatic context compaction' : 'Context compaction',
          turns: [],
        };
        ensure().events.push(...synthesizedSubagentEvents(sub, createdAt, { key: `compaction-${r.id}-${partIndex}` }));
      }
    } catch {
      continue;
    }
  }

  const combined: ImportedCliMessage[] = [];
  for (const item of byMsgId.values()) {
    const text = cleanMessageText(item.texts.join('\n\n'));
    const unknownFlag: { timeUnknown?: true } = item.timeUnknown ? { timeUnknown: true } : {};
    if (item.role === 'user') {
      if ((!text || isNoiseUserPrompt(text)) && item.attachments.length === 0) continue;
      const row: ImportedCliMessage = {
        role: 'user',
        content: text,
        createdAt: item.createdAt,
        model: item.model ?? detectedModel,
        ...unknownFlag,
      };
      if (item.attachments.length > 0) row.attachments = item.attachments;
      combined.push(row);
    } else if (forImport) {
      if (item.events.length === 0) continue;
      combined.push({
        role: 'assistant',
        content: text,
        createdAt: item.createdAt,
        model: item.model ?? detectedModel,
        events: item.events,
        ...unknownFlag,
      });
    } else {
      if (!text) continue;
      combined.push({ role: 'assistant', content: text, createdAt: item.createdAt, model: item.model ?? detectedModel });
    }
    if (!forImport && combined.length >= limit) break;
  }

  // Child sessions no task call claimed: synthetic parts where they started.
  for (const child of children.values()) {
    if (claimedChildren.has(child.id)) continue;
    const transcript = childTranscript(child.id, 'subagent', child.title);
    if (!transcript) continue;
    const at = child.createdAt ?? firstKnownTime(combined) ?? defaultTs;
    insertRowByTime(combined, {
      role: 'assistant',
      content: '',
      createdAt: at,
      events: synthesizedSubagentEvents(transcript, at, { key: child.id }),
      ...(child.createdAt === undefined ? { timeUnknown: true as const } : {}),
    });
  }
  return { model: detectedModel, messages: combined };
}

function scanOpenCodeSqliteDb(
  dbPath: string,
  provider: ProviderName,
  providerDisplayName: string,
  fallbackRoot: string,
  maxChats: number,
): InternalDiscoveredChat[] {
  if (!existsSync(dbPath)) return [];
  const results: InternalDiscoveredChat[] = [];
  const sqlite = openReadonlySqlite(dbPath);
  if (!sqlite) return results;
  try {
    const sessionRows = sqlite
      .query(
        `SELECT id, directory, title, parent_id, time_created, time_updated
         FROM session
         WHERE time_archived IS NULL AND parent_id IS NULL
         ORDER BY time_updated DESC
         LIMIT ?`,
      )
      .all(maxChats) as Array<{
      id: string;
      directory: string | null;
      title: string | null;
      parent_id: string | null;
      time_created: number | null;
      time_updated: number | null;
    }>;

    const loadSessionMsgs = loadOpenCodeSessionMessages;

    // Advertised count matches what import persists: user turns plus one
    // merged assistant turn per run of assistant steps.
    const countTurnsStmt = (() => {
      try {
        return sqlite.query(
          `SELECT json_extract(data, '$.role') AS role FROM message
           WHERE session_id = ? ORDER BY time_created ASC`,
        );
      } catch {
        return null;
      }
    })();
    const countSessionTurns = (sessionId: string): number => {
      if (!countTurnsStmt) return 0;
      try {
        const roles = countTurnsStmt.all(sessionId) as Array<{ role: string | null }>;
        let count = 0;
        let previous: string | null = null;
        for (const { role } of roles) {
          if (role !== 'user' && role !== 'assistant') continue;
          if (role === 'user' || previous !== 'assistant') count += 1;
          previous = role;
        }
        return count;
      } catch {
        return 0;
      }
    };

    for (const sRow of sessionRows) {
      const createdAt = normalizeTimestampMs(sRow.time_created);
      const updatedAt = normalizeTimestampMs(sRow.time_updated, createdAt);
      const { model, messages: sampleMessages } = loadSessionMsgs(
        sqlite,
        sRow.id,
        MAX_SAMPLE_MESSAGES,
        createdAt,
      );
      if (sampleMessages.length === 0) continue;

      const projectPath = canonicalizeProjectPath(sRow.directory, fallbackRoot);
      const firstUser = sampleMessages.find((m) => m.role === 'user')?.content ?? '';
      const title = deriveChatTitle(sRow.title, firstUser);
      const preview = derivePreview(sRow.title, sampleMessages);
      const sessionId = sRow.id;

      results.push({
        id: `${provider}:${sessionId}`,
        externalId: sessionId,
        provider,
        providerDisplayName,
        projectPath,
        projectName: projectNameFromPath(projectPath),
        title,
        preview,
        model,
        messageCount: Math.max(countSessionTurns(sessionId), sampleMessages.length),
        createdAt,
        updatedAt,
        alreadyImported: false,
        sampleMessages,
        loadMessages: () => {
          let innerDb: Database | null = null;
          try {
            innerDb = openReadonlySqlite(dbPath);
            if (!innerDb) return sampleMessages;
            const loaded = loadSessionMsgs(
              innerDb,
              sessionId,
              MAX_IMPORTED_MESSAGES_PER_CHAT,
              createdAt,
              true,
            );
            return loaded.messages.length > 0 ? loaded.messages : sampleMessages;
          } catch {
            return sampleMessages;
          } finally {
            try {
              innerDb?.close();
            } catch {}
          }
        },
      });
    }
  } catch {
    // Ignore SQLite errors
  } finally {
    try {
      sqlite?.close();
    } catch {}
  }
  return results;
}

function scanOmnirushRoot(root: string, maxChats: number): InternalDiscoveredChat[] {
  const results: InternalDiscoveredChat[] = [];

  // 1. Check OpenCode-style SQLite if root contains opencode.db
  const dbPath = join(root, 'opencode.db');
  if (existsSync(dbPath)) {
    results.push(...scanOpenCodeSqliteDb(dbPath, 'omnirush', 'Omnirush CLI', root, maxChats));
  }

  // 2. Check ~/.omnirush/agent/sessions/--<slug>--/*.jsonl
  const sessionsDir = join(root, 'agent', 'sessions');
  if (existsSync(sessionsDir)) {
    let dirEntries: string[] = [];
    try {
      dirEntries = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {}

    for (const slugDir of dirEntries) {
      const fullSlugDir = join(sessionsDir, slugDir);
      let files: string[] = [];
      try {
        files = readdirSync(fullSlugDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(fullSlugDir, file);
        let mtimeMs = Date.now();
        try {
          mtimeMs = statSync(filePath).mtimeMs;
        } catch {
          continue;
        }

        const parseOmnirushFile = (): {
          id: string;
          cwd: string | null;
          model?: string;
          createdAt: number;
          updatedAt: number;
          messages: DiscoveredCliChatMessage[];
        } | null => {
          try {
            const raw = readHeadAndTailText(filePath);
            let id = file.replace(/\.jsonl$/, '');
            let cwd: string | null = null;
            let model: string | undefined;
            let createdAt = 0;
            let updatedAt = 0;
            const msgs: DiscoveredCliChatMessage[] = [];

            for (const line of raw.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('{')) continue;
              const entry = JSON.parse(trimmed) as Record<string, unknown>;
              const ts = normalizeTimestampMs(entry.timestamp, 0);
              if (ts > 0) {
                if (createdAt === 0 || ts < createdAt) createdAt = ts;
                if (ts > updatedAt) updatedAt = ts;
              }
              if (entry.type === 'session') {
                if (typeof entry.id === 'string') id = entry.id;
                if (typeof entry.cwd === 'string') cwd = entry.cwd;
              } else if (entry.type === 'model_change' && typeof entry.modelId === 'string') {
                model = entry.modelId;
              } else if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
                const m = entry.message as Record<string, unknown>;
                if (m.role !== 'user' && m.role !== 'assistant') continue;
                const text = cleanMessageText(extractTextFromContentField(m.content));
                if (!text || (m.role === 'user' && isNoiseUserPrompt(text))) continue;
                msgs.push({
                  role: m.role,
                  content: text,
                  createdAt: ts || mtimeMs,
                  model: (typeof m.model === 'string' ? m.model : undefined) ?? model,
                });
              }
            }
            if (msgs.length === 0) return null;
            return {
              id,
              cwd,
              model,
              createdAt: createdAt || mtimeMs,
              updatedAt: updatedAt || mtimeMs,
              messages: msgs,
            };
          } catch {
            return null;
          }
        };

        const parsed = parseOmnirushFile();
        if (!parsed) continue;
        const projectPath = canonicalizeProjectPath(
          parsed.cwd ?? decodeEncodedProjectDir(slugDir.replace(/^--|--$/g, '-'), root),
          root,
        );
        const firstUser = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
        results.push({
          id: `omnirush:${parsed.id}`,
          externalId: parsed.id,
          provider: 'omnirush',
          providerDisplayName: 'Omnirush CLI',
          projectPath,
          projectName: projectNameFromPath(projectPath),
          title: deriveChatTitle(null, firstUser),
          preview: derivePreview(null, parsed.messages),
          model: parsed.model,
          messageCount: parsed.messages.length,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          alreadyImported: false,
          sampleMessages: parsed.messages.slice(0, MAX_SAMPLE_MESSAGES),
          loadMessages: () => {
            // pi-format session: the active branch of the entry tree, with
            // thinking, tool calls/results (durations when recorded), errors
            // and `subagent` tool runs nested.
            const full = parsePiSessionFile(filePath, portingHelpers());
            if (full.some((m) => m.role === 'user')) return full;
            return (parseOmnirushFile()?.messages ?? parsed.messages).slice(
              0,
              MAX_IMPORTED_MESSAGES_PER_CHAT,
            );
          },
        });
      }
    }
  }

  return results
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxChats);
}

// ─── 8. Generic Multi-Format CLI Scanner (Cursor, Grok, Kimi Code, etc.) ────

function scanGenericCliRoot(
  root: string,
  provider: ProviderName,
  providerDisplayName: string,
  maxChats: number,
): InternalDiscoveredChat[] {
  if (!existsSync(root)) return [];
  const results: InternalDiscoveredChat[] = [];

  // 1. Check Claude/CodeBuddy-style `projects/` directory
  results.push(...scanClaudeStyleProjectsDir(root, provider, providerDisplayName, maxChats));

  // 2. Check OpenCode-style SQLite databases (`sessions.db`, `${provider}.db`, `opencode.db`, `chats.db`)
  for (const dbName of ['sessions.db', `${provider}.db`, 'opencode.db', 'chats.db']) {
    const dbCandidate = join(root, dbName);
    if (existsSync(dbCandidate)) {
      results.push(
        ...scanOpenCodeSqliteDb(dbCandidate, provider, providerDisplayName, root, maxChats),
      );
    }
  }

  // 3. Check direct JSONL/JSON session files in `sessions/`, `chats/`, `transcripts/`
  for (const sub of ['sessions', 'chats', 'transcripts']) {
    const subDir = join(root, sub);
    if (!existsSync(subDir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(subDir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(subDir, file);
      let mtimeMs = Date.now();
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      const defaultId = file.replace(/\.(jsonl|json)$/, '');

      if (file.endsWith('.jsonl')) {
        const parsed = parseClaudeOrCodeBuddyJsonlFile(filePath, defaultId, mtimeMs);
        if (!parsed || parsed.messages.length === 0) continue;
        const projectPath = canonicalizeProjectPath(parsed.cwd, root);
        const firstUser = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
        results.push({
          id: `${provider}:${parsed.externalId}`,
          externalId: parsed.externalId,
          provider,
          providerDisplayName,
          projectPath,
          projectName: projectNameFromPath(projectPath),
          title: deriveChatTitle(parsed.title, firstUser),
          preview: derivePreview(parsed.title, parsed.messages),
          model: parsed.model,
          messageCount: countImportTurns(parsed.messages),
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          alreadyImported: false,
          sampleMessages: toPublicSamples(parsed.messages),
          loadMessages: () =>
            parseClaudeOrCodeBuddyJsonlFile(filePath, defaultId, mtimeMs, true)?.messages ??
            parsed.messages,
        });
      } else if (file.endsWith('.json')) {
        try {
          const data = JSON.parse(readFileSync(filePath, 'utf8')) as {
            id?: string;
            cwd?: string;
            workingDirectory?: string;
            projectPath?: string;
            title?: string;
            model?: string;
            createdAt?: number | string;
            updatedAt?: number | string;
            messages?: Array<{
              role?: string;
              content?: unknown;
              createdAt?: number | string;
              timestamp?: number | string;
            }>;
          };
          const rawMsgs = Array.isArray(data.messages) ? data.messages : [];
          const parsedMsgs: DiscoveredCliChatMessage[] = [];
          for (const m of rawMsgs) {
            if (m.role !== 'user' && m.role !== 'assistant') continue;
            const text = cleanMessageText(extractTextFromContentField(m.content));
            if (!text) continue;
            parsedMsgs.push({
              role: m.role,
              content: text,
              createdAt: normalizeTimestampMs(m.createdAt ?? m.timestamp, mtimeMs),
              model: data.model,
            });
          }
          if (parsedMsgs.length === 0) continue;
          const extId = (typeof data.id === 'string' && data.id.trim()) || defaultId;
          const projectPath = canonicalizeProjectPath(
            data.cwd ?? data.workingDirectory ?? data.projectPath,
            root,
          );
          const createdAt = normalizeTimestampMs(data.createdAt, parsedMsgs[0]?.createdAt ?? mtimeMs);
          const updatedAt = normalizeTimestampMs(
            data.updatedAt,
            parsedMsgs[parsedMsgs.length - 1]?.createdAt ?? mtimeMs,
          );
          const firstUser = parsedMsgs.find((m) => m.role === 'user')?.content ?? '';
          results.push({
            id: `${provider}:${extId}`,
            externalId: extId,
            provider,
            providerDisplayName,
            projectPath,
            projectName: projectNameFromPath(projectPath),
            title: deriveChatTitle(data.title, firstUser),
            preview: derivePreview(data.title, parsedMsgs),
            model: data.model,
            messageCount: parsedMsgs.length,
            createdAt,
            updatedAt,
            alreadyImported: false,
            sampleMessages: parsedMsgs.slice(0, MAX_SAMPLE_MESSAGES),
            loadMessages: () => {
              // OpenAI / Anthropic / AI-SDK message shapes with tool calls,
              // results and reasoning; messages without a time stay timeUnknown.
              const full = genericMessagesToRows(rawMsgs, portingHelpers(), {
                model: data.model,
                idPrefix: `${provider}:${extId}`,
                chatStartMs: sourceTimestampMs(data.createdAt),
                chatEndMs: sourceTimestampMs(data.updatedAt),
              });
              return full.length > 0 ? full : parsedMsgs.slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT);
            },
          });
        } catch {
          continue;
        }
      }
    }
  }

  return results
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxChats);
}

// ─── Dedicated parsers (cli-chat-porting-providers.ts) ──────────────────────

/** The importer's own helpers, handed to the dedicated parsers as they are. */
function portingHelpers(): PortingHelpers {
  return {
    cleanMessageText,
    isNoiseUserPrompt,
    toolOutputText,
    toolInputRecord,
    sourceTimestampMs,
    readTranscriptText,
    openReadonlySqlite,
  };
}

function internalChatFromPorted(
  provider: ProviderName,
  providerDisplayName: string,
  root: string,
  chat: PortedChat,
): InternalDiscoveredChat {
  const projectPath = canonicalizeProjectPath(chat.cwd, root);
  const firstUser = chat.sample.find((m) => m.role === 'user')?.content ?? '';
  return {
    id: `${provider}:${chat.externalId}`,
    externalId: chat.externalId,
    provider,
    providerDisplayName,
    projectPath,
    projectName: projectNameFromPath(projectPath),
    title: deriveChatTitle(chat.title, firstUser),
    preview: derivePreview(chat.title, chat.sample),
    model: chat.model,
    messageCount: countImportTurns(chat.sample),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    alreadyImported: false,
    sampleMessages: toPublicSamples(chat.sample),
    loadMessages: chat.load,
  };
}

/** A dedicated store scan plus the generic layouts, deduplicated by chat id. */
function scanDedicatedCliRoot(
  root: string,
  provider: ProviderName,
  providerDisplayName: string,
  maxChats: number,
  scan: (root: string, helpers: PortingHelpers) => PortedChat[],
): InternalDiscoveredChat[] {
  if (!existsSync(root)) return [];
  const byId = new Map<string, InternalDiscoveredChat>();
  try {
    for (const chat of scan(root, portingHelpers())) {
      const internal = internalChatFromPorted(provider, providerDisplayName, root, chat);
      byId.set(internal.id, internal);
    }
  } catch (err) {
    serverLog.debug({ err, provider, root }, 'Dedicated CLI chat scan failed; using generic layouts');
  }
  for (const chat of scanGenericCliRoot(root, provider, providerDisplayName, maxChats)) {
    if (!byId.has(chat.id)) byId.set(chat.id, chat);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxChats);
}

// ─── Canonical Catalog of ALL CLI Providers ─────────────────────────────────

export const ALL_CLI_CHAT_PROVIDERS: readonly CliProviderCatalogEntry[] = [
  {
    id: 'claude',
    provider: 'claude',
    displayName: 'Claude Code',
    resolveCandidateRoots: (home, env) => {
      const roots = expandSiblingProfiles(home, '.claude');
      if (env.CLAUDE_CONFIG_DIR) roots.unshift(env.CLAUDE_CONFIG_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) =>
      scanClaudeStyleProjectsDir(root, 'claude', 'Claude Code', maxChats),
  },
  {
    id: 'codex',
    provider: 'codex',
    displayName: 'Codex CLI',
    resolveCandidateRoots: (home, env) => {
      const roots = expandSiblingProfiles(home, '.codex');
      if (env.CODEX_HOME && !env.CODEX_HOME.includes('.koryphaios')) {
        roots.unshift(env.CODEX_HOME);
      }
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) => scanCodexRoot(root, maxChats),
  },
  {
    id: 'antigravity',
    provider: 'antigravity',
    displayName: 'Antigravity CLI',
    resolveCandidateRoots: (home, env) => {
      const roots = [
        join(home, '.gemini', 'antigravity-cli'),
        ...expandSiblingProfiles(home, '.antigravity'),
      ];
      if (env.GEMINI_DIR) roots.unshift(join(env.GEMINI_DIR, 'antigravity-cli'));
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) => scanAntigravityRoot(root, maxChats),
  },
  {
    id: 'codebuddy',
    provider: 'codebuddy',
    displayName: 'CodeBuddy',
    resolveCandidateRoots: (home, env) => {
      const roots = expandSiblingProfiles(home, '.codebuddy');
      if (env.CODEBUDDY_CONFIG_DIR) roots.unshift(env.CODEBUDDY_CONFIG_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) => scanCodeBuddyRoot(root, maxChats),
  },
  {
    id: 'workbuddy-desktop',
    provider: 'workbuddy-desktop',
    displayName: 'WorkBuddy',
    resolveCandidateRoots: (home, env) => {
      const roots = [join(home, '.workbuddy-ai'), join(home, '.workbuddy')];
      if (env.WORKBUDDY_HOME) roots.unshift(env.WORKBUDDY_HOME);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) => scanWorkBuddyRoot(root, maxChats),
  },
  {
    id: 'devin',
    provider: 'devin',
    displayName: 'Devin CLI',
    resolveCandidateRoots: (home, env) => {
      const roots = [
        join(home, '.local', 'share', 'devin', 'cli'),
        join(home, '.local', 'share', 'devin'),
      ];
      if (env.DEVIN_CONFIG_DIR) roots.unshift(env.DEVIN_CONFIG_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) => scanDevinRoot(root, maxChats),
  },
  {
    id: 'freebuff',
    provider: 'freebuff',
    displayName: 'Freebuff CLI',
    resolveCandidateRoots: (home, env) => {
      const roots = expandSiblingProfiles(join(home, '.config'), 'manicode');
      if (env.FREEBUFF_CONFIG_DIR) roots.unshift(env.FREEBUFF_CONFIG_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) => scanFreebuffRoot(root, maxChats),
  },
  {
    id: 'omnirush',
    provider: 'omnirush',
    displayName: 'Omnirush CLI',
    resolveCandidateRoots: (home, env) => {
      const roots = [
        ...expandSiblingProfiles(home, '.omnirush'),
        join(home, '.local', 'share', 'omnirush'),
      ];
      if (env.OMNIRUSH_DIR) roots.unshift(env.OMNIRUSH_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) => scanOmnirushRoot(root, maxChats),
  },
  {
    id: 'kilocode',
    provider: 'kilocode',
    displayName: 'Kilo Code CLI',
    resolveCandidateRoots: (home, env) => {
      const roots = [
        join(home, '.local', 'share', 'kilo'),
        ...expandSiblingProfiles(home, '.kilo'),
      ];
      if (env.KILO_CONFIG_DIR) roots.unshift(env.KILO_CONFIG_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) => {
      const kiloDb = join(root, 'kilo.db');
      if (existsSync(kiloDb)) {
        return scanOpenCodeSqliteDb(kiloDb, 'kilocode', 'Kilo Code CLI', root, maxChats);
      }
      return scanGenericCliRoot(root, 'kilocode', 'Kilo Code CLI', maxChats);
    },
  },
  {
    id: 'opencodezen',
    provider: 'opencodezen',
    displayName: 'OpenCode CLI',
    resolveCandidateRoots: (home, env) => {
      const roots = [
        join(home, '.local', 'share', 'opencode'),
        ...expandSiblingProfiles(home, '.opencode'),
      ];
      if (env.OPENCODE_CONFIG_DIR) roots.unshift(env.OPENCODE_CONFIG_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) => {
      const ocDb = join(root, 'opencode.db');
      if (existsSync(ocDb)) {
        return scanOpenCodeSqliteDb(ocDb, 'opencodezen', 'OpenCode CLI', root, maxChats);
      }
      return scanGenericCliRoot(root, 'opencodezen', 'OpenCode CLI', maxChats);
    },
  },
  {
    id: 'cursor',
    provider: 'cursor',
    displayName: 'Cursor CLI',
    resolveCandidateRoots: (home, env) => {
      const roots = [
        ...expandSiblingProfiles(home, '.cursor'),
        join(home, '.config', 'cursor'),
      ];
      if (env.CURSOR_CONFIG_DIR) roots.unshift(env.CURSOR_CONFIG_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) =>
      scanDedicatedCliRoot(root, 'cursor', 'Cursor CLI', maxChats, scanCursorAgentChats),
  },
  {
    id: 'grok',
    provider: 'grok',
    displayName: 'Grok Build',
    resolveCandidateRoots: (home, env) => {
      const roots = [
        ...expandSiblingProfiles(home, '.grok'),
        join(home, '.config', 'grok'),
      ];
      if (env.GROK_CONFIG_DIR) roots.unshift(env.GROK_CONFIG_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) =>
      scanDedicatedCliRoot(root, 'grok', 'Grok Build', maxChats, scanGrokSessions),
  },
  {
    id: 'kimicode',
    provider: 'kimicode',
    displayName: 'Kimi Code CLI',
    resolveCandidateRoots: (home, env) => {
      const roots = [
        ...expandSiblingProfiles(home, '.kimi'),
        join(home, '.local', 'share', 'kimi'),
      ];
      if (env.KIMI_SHARE_DIR) roots.unshift(env.KIMI_SHARE_DIR);
      return [...new Set(roots)];
    },
    scanRoot: (root, maxChats) =>
      scanDedicatedCliRoot(root, 'kimicode', 'Kimi Code CLI', maxChats, scanKimiSessions),
  },
];

// ─── Already-Imported Session Lookup ────────────────────────────────────────

function getImportedChatSessionMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const rows = db
      .select({ id: sessions.id, metadata: sessions.metadata })
      .from(sessions)
      .all();
    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const meta = JSON.parse(row.metadata) as {
          importedFrom?: { chatId?: string; provider?: string; externalId?: string };
        };
        const imp = meta.importedFrom;
        if (!imp) continue;
        if (typeof imp.chatId === 'string' && imp.chatId) {
          map.set(imp.chatId, row.id);
        } else if (imp.provider && imp.externalId) {
          map.set(`${imp.provider}:${imp.externalId}`, row.id);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Database might not be initialized in standalone unit tests
  }
  return map;
}

// ─── Discovery & Porting Entrypoints ────────────────────────────────────────

function scanAllInternal(options: CliChatPortingOptions = {}): {
  providers: CliProviderScanSummary[];
  chatsById: Map<string, InternalDiscoveredChat>;
  projects: DiscoveredCliProjectGroup[];
} {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const maxChatsPerProvider = options.maxChatsPerProvider ?? 150;
  const importedMap = getImportedChatSessionMap();

  const providers: CliProviderScanSummary[] = [];
  const chatsById = new Map<string, InternalDiscoveredChat>();

  for (const entry of ALL_CLI_CHAT_PROVIDERS) {
    const candidateRoots = entry.resolveCandidateRoots(home, env);
    let storageFound = false;
    const providerChats = new Map<string, InternalDiscoveredChat>();

    for (const root of candidateRoots) {
      if (!existsSync(root)) continue;
      storageFound = true;
      try {
        const scanned = entry.scanRoot(root, maxChatsPerProvider);
        for (const chat of scanned) {
          const existingSessionId = importedMap.get(chat.id);
          if (existingSessionId) {
            chat.alreadyImported = true;
            chat.importedSessionId = existingSessionId;
          }
          if (!providerChats.has(chat.id)) {
            providerChats.set(chat.id, chat);
            chatsById.set(chat.id, chat);
          }
        }
      } catch (err) {
        serverLog.debug({ err, provider: entry.id, root }, 'CLI chat scan failed for root');
      }
    }

    const projectSet = new Set(
      [...providerChats.values()].map((c) =>
        projectKey(c.projectPath),
      ),
    );

    providers.push({
      id: entry.id,
      provider: entry.provider,
      displayName: entry.displayName,
      checked: true,
      storageFound,
      checkedPaths: candidateRoots,
      chatCount: providerChats.size,
      projectCount: projectSet.size,
    });
  }

  // Group chats by normalized project path (case-insensitive key on macOS/Windows)
  const projectMap = new Map<
    string,
    {
      displayPath: string;
      chats: InternalDiscoveredChat[];
    }
  >();

  for (const chat of chatsById.values()) {
    const key = projectKey(chat.projectPath);
    const existing = projectMap.get(key);
    if (existing) {
      // Prefer a displayPath with uppercase characters over all-lowercase
      if (
        existing.displayPath === existing.displayPath.toLowerCase() &&
        chat.projectPath !== chat.projectPath.toLowerCase()
      ) {
        existing.displayPath = chat.projectPath;
      }
      existing.chats.push(chat);
    } else {
      projectMap.set(key, {
        displayPath: chat.projectPath,
        chats: [chat],
      });
    }
  }

  const projects: DiscoveredCliProjectGroup[] = [];
  for (const group of projectMap.values()) {
    const sortedChats = group.chats
      .map((c) => {
        c.projectPath = group.displayPath;
        c.projectName = projectNameFromPath(group.displayPath);
        return c;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const providerCounts = new Map<
      ProviderName,
      { provider: ProviderName; displayName: string; chatCount: number }
    >();
    for (const chat of sortedChats) {
      const prev = providerCounts.get(chat.provider);
      if (prev) {
        prev.chatCount += 1;
      } else {
        providerCounts.set(chat.provider, {
          provider: chat.provider,
          displayName: chat.providerDisplayName,
          chatCount: 1,
        });
      }
    }

    const latestUpdatedAt = sortedChats[0]?.updatedAt ?? 0;
    projects.push({
      projectPath: group.displayPath,
      projectName: projectNameFromPath(group.displayPath),
      chatCount: sortedChats.length,
      providers: [...providerCounts.values()].sort((a, b) => b.chatCount - a.chatCount),
      latestUpdatedAt,
      chats: sortedChats.map(({ loadMessages: _omit, ...publicChat }) => ({
        ...publicChat,
        sampleMessages: toPublicSamples(publicChat.sampleMessages),
      })),
    });
  }

  projects.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);

  return { providers, chatsById, projects };
}

export function discoverCliChats(options: CliChatPortingOptions = {}): CliChatDiscoveryResult {
  const { providers, chatsById, projects } = scanAllInternal(options);
  return {
    providers,
    projects,
    totalChats: chatsById.size,
    totalProjects: projects.length,
  };
}

export async function importCliChats(
  input: ImportCliChatsInput,
  options: CliChatPortingOptions = {},
): Promise<ImportCliChatsResult> {
  const requestedIds = [...new Set((input.chatIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (requestedIds.length === 0) {
    return { importedCount: 0, alreadyImportedCount: 0, sessions: [], items: [] };
  }

  const { chatsById } = scanAllInternal(options);
  const importedMap = getImportedChatSessionMap();

  let importedCount = 0;
  let alreadyImportedCount = 0;
  const importedSessions: SharedSession[] = [];
  const items: ImportedCliSessionSummary[] = [];

  for (const chatId of requestedIds) {
    const discovered = chatsById.get(chatId);
    if (!discovered) continue;

    const existingSessionId = importedMap.get(chatId);
    if (existingSessionId) {
      const existingRow = await db.query.sessions.findFirst({
        where: eq(sessions.id, existingSessionId),
      });
      if (existingRow) {
        alreadyImportedCount += 1;
        const shared: SharedSession = {
          id: existingRow.id,
          title: existingRow.title,
          archivedAt: existingRow.archivedAt?.getTime(),
          status: existingRow.archivedAt ? 'archived' : 'active',
          parentSessionId: existingRow.parentId ?? undefined,
          workingDirectory: existingRow.workingDirectory ?? undefined,
          interactionMode: 'act',
          messageCount: existingRow.messageCount ?? 0,
          totalTokensIn: existingRow.tokensIn ?? 0,
          totalTokensOut: existingRow.tokensOut ?? 0,
          totalCost: existingRow.totalCost ?? 0,
          version: existingRow.version ?? 1,
          createdAt: existingRow.createdAt.getTime(),
          updatedAt: existingRow.updatedAt.getTime(),
        };
        importedSessions.push(shared);
        items.push({
          chatId,
          sessionId: existingRow.id,
          provider: discovered.provider,
          projectPath: discovered.projectPath,
          title: existingRow.title,
          messageCount: existingRow.messageCount ?? 0,
          status: 'already_imported',
        });
        continue;
      }
    }

    let rawMessages: ImportedCliMessage[] = [];
    try {
      rawMessages = discovered.loadMessages();
    } catch (err) {
      serverLog.debug({ err, chatId }, 'CLI chat transcript load failed; using discovery sample');
    }
    let transcript = buildImportTurns(rawMessages, discovered.createdAt);
    if (transcript.length === 0) {
      transcript = buildImportTurns(discovered.sampleMessages, discovered.createdAt);
    }
    if (transcript.length === 0) {
      transcript = [
        {
          role: 'user',
          content: discovered.preview || discovered.title,
          createdAt: discovered.createdAt,
          model: discovered.model,
        },
      ];
    }
    if (transcript.length > MAX_IMPORTED_MESSAGES_PER_CHAT) {
      serverLog.warn(
        { chatId, turns: transcript.length, cap: MAX_IMPORTED_MESSAGES_PER_CHAT },
        'CLI chat import hit the per-chat safety cap; later turns were not imported',
      );
      transcript = transcript.slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT);
    }

    const sessionId = nanoid(ID.SESSION_ID_LENGTH);
    const createdAtDate = new Date(discovered.createdAt);
    const updatedAtDate = new Date(discovered.updatedAt);
    const metadata = JSON.stringify({
      importedFrom: {
        chatId: discovered.id,
        provider: discovered.provider,
        providerDisplayName: discovered.providerDisplayName,
        externalId: discovered.externalId,
        model: discovered.model,
        importedAt: Date.now(),
      },
    });

    db.transaction((tx) => {
      tx.insert(sessions)
        .values({
          id: sessionId,
          userId: 'local-user',
          title: discovered.title,
          parentId: null,
          workingDirectory: discovered.projectPath,
          metadata,
          messageCount: 0,
          tokensIn: 0,
          tokensOut: 0,
          totalCost: 0,
          conversationRevision: 0,
          providerConversationRevision: 0,
          activeMessageId: null,
          version: 1,
          createdAt: createdAtDate,
          updatedAt: updatedAtDate,
        })
        .run();

      let parentMessageId: string | null = null;
      // Source order is authoritative. Timestamps are made strictly increasing
      // so a display that sorts by time can never reorder the transcript (CLI
      // logs carry rows without timestamps and clock skew between resumes).
      let previousTime = 0;
      for (let i = 0; i < transcript.length; i++) {
        const msg = transcript[i];
        const msgId = nanoid(ID.SESSION_ID_LENGTH);
        const sourceTime = msg.createdAt > 0 ? msg.createdAt : discovered.createdAt + i * 1000;
        const msgTimeMs = Math.max(sourceTime, previousTime + 1);
        previousTime = msgTimeMs;
        const msgTime = new Date(msgTimeMs);
        const blocks: unknown[] = [{ type: 'text', text: msg.content }];
        // Same block layout `message-store.ts` writes: text, attachments, parts, meta.
        for (const attachment of msg.attachments ?? []) blocks.push(attachment);
        // Reasoning and tool activity are display-only parts. They are never
        // written as a `thinking` block: that is provider replay input, and a
        // foreign CLI's reasoning must not be replayed to Kory's provider.
        if (msg.parts) blocks.push({ type: TRANSCRIPT_PARTS_BLOCK, parts: msg.parts });
        // The source recorded no time for this row: `createdAt` only orders it.
        if (msg.timeUnknown) blocks.push({ type: MESSAGE_META_BLOCK, timeUnknown: true });
        tx.insert(messages)
          .values({
            id: msgId,
            sessionId,
            role: msg.role,
            content: JSON.stringify(blocks),
            model: msg.model ?? discovered.model ?? null,
            provider: discovered.provider,
            tokensIn: 0,
            tokensOut: 0,
            cost: 0,
            variantGroupId: null,
            variantIndex: 0,
            contextRevision: 0,
            parentMessageId,
            createdAt: msgTime,
          })
          .run();
        parentMessageId = msgId;
      }

      tx.update(sessions)
        .set({
          activeMessageId: parentMessageId,
          messageCount: transcript.length,
          createdAt: createdAtDate,
          updatedAt: updatedAtDate,
        })
        .where(eq(sessions.id, sessionId))
        .run();
    });

    const createdSession: SharedSession = {
      id: sessionId,
      title: discovered.title,
      status: 'active',
      workingDirectory: discovered.projectPath,
      interactionMode: 'act',
      messageCount: transcript.length,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCost: 0,
      version: 1,
      createdAt: createdAtDate.getTime(),
      updatedAt: updatedAtDate.getTime(),
    };

    importedMap.set(chatId, sessionId);
    importedCount += 1;
    importedSessions.push(createdSession);
    items.push({
      chatId,
      sessionId,
      provider: discovered.provider,
      projectPath: discovered.projectPath,
      title: discovered.title,
      messageCount: transcript.length,
      status: 'imported',
    });
  }

  return {
    importedCount,
    alreadyImportedCount,
    sessions: importedSessions,
    items,
  };
}
