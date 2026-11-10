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
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import type { ProviderName, Session as SharedSession } from '@koryphaios/shared';
import { ID, MESSAGE, SESSION } from '../constants';
import { db, messages, sessions } from '../db';
import { eq } from 'drizzle-orm';
import { serverLog } from '../logger';

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

interface InternalDiscoveredChat extends DiscoveredCliChat {
  loadMessages: () => DiscoveredCliChatMessage[];
}

interface CliProviderCatalogEntry {
  id: string;
  provider: ProviderName;
  displayName: string;
  resolveCandidateRoots: (home: string, env: NodeJS.ProcessEnv) => string[];
  scanRoot: (root: string, maxChats: number) => InternalDiscoveredChat[];
}

const MAX_DISCOVERY_JSONL_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SAMPLE_MESSAGES = 4;
const MAX_IMPORTED_MESSAGES_PER_CHAT = 500;
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

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

  if (text.length > MESSAGE.MAX_CONTENT_LENGTH) {
    text = text.slice(0, MESSAGE.MAX_CONTENT_LENGTH);
  }
  return text;
}

function isNoiseUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<local-command-stdout>') ||
    trimmed.startsWith('<local-command-stderr>') ||
    trimmed.startsWith('<system-reminder')
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
  messages: DiscoveredCliChatMessage[];
}

function parseClaudeOrCodeBuddyJsonlFile(
  filePath: string,
  defaultExternalId: string,
  fallbackMtimeMs: number,
): ParsedJsonlTranscript | null {
  let raw: string;
  try {
    raw = readHeadAndTailText(filePath);
  } catch {
    return null;
  }

  let externalId = defaultExternalId;
  let cwd: string | null = null;
  let explicitTitle: string | null = null;
  let model: string | undefined;
  let createdAt = 0;
  let updatedAt = 0;
  const parsedMessages: DiscoveredCliChatMessage[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof entry.sessionId === 'string' && entry.sessionId.trim()) {
      externalId = entry.sessionId.trim();
    }
    if (!cwd && typeof entry.cwd === 'string' && entry.cwd.trim()) {
      cwd = entry.cwd.trim();
    }

    const ts = normalizeTimestampMs(entry.timestamp ?? entry.createdAt, 0);
    if (ts > 0) {
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
      if (!cwd && typeof payload.cwd === 'string' && payload.cwd.trim()) {
        cwd = payload.cwd.trim();
      }
      if (!model && typeof payload.model === 'string' && payload.model.trim()) {
        model = payload.model.trim();
      }
      continue;
    }

    // Claude Code format: type === 'user' | 'assistant' with entry.message
    if ((type === 'user' || type === 'assistant') && entry.message && typeof entry.message === 'object') {
      if (entry.isMeta === true || entry.isSidechain === true) continue;
      const msgObj = entry.message as Record<string, unknown>;
      const role = msgObj.role === 'assistant' || type === 'assistant' ? 'assistant' : 'user';
      if (!model && typeof msgObj.model === 'string' && msgObj.model.trim()) {
        model = msgObj.model.trim();
      }
      const text = cleanMessageText(extractTextFromContentField(msgObj.content));
      if (!text || (role === 'user' && isNoiseUserPrompt(text))) continue;
      parsedMessages.push({
        role,
        content: text,
        createdAt: ts || fallbackMtimeMs,
        model: typeof msgObj.model === 'string' ? msgObj.model : model,
      });
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
      parsedMessages.push({
        role,
        content: text,
        createdAt: ts || fallbackMtimeMs,
        model: msgModel ?? model,
      });
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
      parsedMessages.push({
        role,
        content: text,
        createdAt: ts || fallbackMtimeMs,
        model: msgModel ?? model,
      });
    }
  }

  if (parsedMessages.length === 0) return null;

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
        messageCount: parsed.messages.length,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        alreadyImported: false,
        sampleMessages: parsed.messages.slice(0, MAX_SAMPLE_MESSAGES),
        loadMessages: () =>
          (parseClaudeOrCodeBuddyJsonlFile(filePath, defaultId, mtimeMs)?.messages ??
            parsed.messages).slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT),
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
      sqlite = new Database(dbPath, { readonly: true });
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

  return [...byExternalId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxChats);
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

function parseCodexRolloutJsonl(filePath: string, fallbackTs: number): {
  cwd: string | null;
  model?: string;
  messages: DiscoveredCliChatMessage[];
} {
  if (!filePath || !existsSync(filePath) || filePath.endsWith('.zst')) {
    return { cwd: null, messages: [] };
  }
  let raw: string;
  try {
    raw = readHeadAndTailText(filePath);
  } catch {
    return { cwd: null, messages: [] };
  }
  let cwd: string | null = null;
  let model: string | undefined;
  const msgs: DiscoveredCliChatMessage[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const ts = normalizeTimestampMs(entry.timestamp, fallbackTs);
      const payload = (entry.payload as Record<string, unknown> | undefined) ?? {};
      if (entry.type === 'session_meta') {
        if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd;
        if (!model && typeof payload.model === 'string') model = payload.model;
      } else if (entry.type === 'turn_context') {
        if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd;
        if (!model && typeof payload.model === 'string') model = payload.model;
      } else if (entry.type === 'response_item' && payload.type === 'message') {
        const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
        if (!role) continue;
        // Skip developer/system instructions injected as user context
        const text = cleanMessageText(extractTextFromContentField(payload.content));
        if (
          !text ||
          text.startsWith('<environment_context>') ||
          text.startsWith('<permissions instructions>') ||
          text.startsWith('# AGENTS.md instructions')
        ) {
          continue;
        }
        msgs.push({ role, content: text, createdAt: ts, model });
      }
    } catch {
      continue;
    }
  }
  return { cwd, model, messages: msgs };
}

function scanCodexRoot(root: string, maxChats: number): InternalDiscoveredChat[] {
  const stateDbPath = findHighestVersionedSqlite(root, 'state_');
  const historyDbPath = findHighestVersionedSqlite(root, 'thread_history_');
  const results: InternalDiscoveredChat[] = [];

  if (stateDbPath && existsSync(stateDbPath)) {
    let stateDb: Database | null = null;
    let historyDb: Database | null = null;
    try {
      stateDb = new Database(stateDbPath, { readonly: true });
      if (historyDbPath && existsSync(historyDbPath)) {
        try {
          historyDb = new Database(historyDbPath, { readonly: true });
        } catch {
          historyDb = null;
        }
      }

      const threads = stateDb
        .query(
          `SELECT id, rollout_path, created_at, updated_at, cwd, title, first_user_message, model, created_at_ms, updated_at_ms
           FROM threads
           WHERE COALESCE(archived, 0) = 0
           ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
           LIMIT ?`,
        )
        .all(maxChats) as Array<{
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

      const countStmt = historyDb
        ? historyDb.query(
            `SELECT COUNT(*) as cnt FROM thread_items
             WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage', 'message')`,
          )
        : null;
      const sampleStmt = historyDb
        ? historyDb.query(
            `SELECT item_type, item_json, created_at_ms FROM thread_items
             WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage', 'message')
             ORDER BY rollout_ordinal ASC
             LIMIT ?`,
          )
        : null;

      for (const row of threads) {
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
            msgCount = rollout.messages.length;
            sampleMessages.push(...rollout.messages.slice(0, MAX_SAMPLE_MESSAGES));
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
            if (historyDbPath && existsSync(historyDbPath)) {
              let hDb: Database | null = null;
              try {
                hDb = new Database(historyDbPath, { readonly: true });
                const rows = hDb
                  .query(
                    `SELECT item_type, item_json, created_at_ms
                     FROM thread_items
                     WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage', 'message')
                     ORDER BY rollout_ordinal ASC
                     LIMIT ?`,
                  )
                  .all(threadId, MAX_IMPORTED_MESSAGES_PER_CHAT * 2) as Array<{
                  item_type: string;
                  item_json: string;
                  created_at_ms: number | null;
                }>;
                const full: DiscoveredCliChatMessage[] = [];
                for (const r of rows) {
                  const m = parseCodexThreadItemJson(
                    r.item_type,
                    r.item_json,
                    normalizeTimestampMs(r.created_at_ms, createdAt),
                  );
                  if (m) {
                    if (threadModel) m.model = threadModel;
                    full.push(m);
                    if (full.length >= MAX_IMPORTED_MESSAGES_PER_CHAT) break;
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
            if (rolloutPath && !rolloutPath.endsWith('.zst')) {
              const rollout = parseCodexRolloutJsonl(rolloutPath, createdAt);
              if (rollout.messages.length > 0) {
                return rollout.messages.slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT);
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
      sqlite = new Database(dbPath, { readonly: true });
      const rows = sqlite
        .query(
          `SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, preview
           FROM conversation_summaries
           WHERE COALESCE(step_count, 0) > 0
           ORDER BY last_modified_time DESC
           LIMIT ?`,
        )
        .all(maxChats) as Array<{
        conversation_id: string;
        title: string | null;
        step_count: number | null;
        last_modified_time: string | null;
        workspace_uris: string | null;
        preview: string | null;
      }>;

      for (const row of rows) {
        const convId = row.conversation_id;
        if (!convId) continue;
        seenIds.add(convId);

        const transcriptPath = join(
          root,
          'brain',
          convId,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );
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

function loadDevinSessionMessages(
  dbPath: string,
  root: string,
  sessionId: string,
  defaultModel: string | undefined,
  fallbackTs: number,
): DiscoveredCliChatMessage[] {
  if (existsSync(dbPath)) {
    let sqlite: Database | null = null;
    try {
      sqlite = new Database(dbPath, { readonly: true });
      const rows = sqlite
        .query(
          `SELECT chat_message, created_at
           FROM message_nodes
           WHERE session_id = ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(sessionId, MAX_IMPORTED_MESSAGES_PER_CHAT * 2) as Array<{
        chat_message: string;
        created_at: number | null;
      }>;
      const msgs: DiscoveredCliChatMessage[] = [];
      for (const row of rows) {
        try {
          const msg = JSON.parse(row.chat_message) as Record<string, unknown>;
          if (msg.role !== 'user' && msg.role !== 'assistant') continue;
          const text = cleanMessageText(
            typeof msg.content === 'string'
              ? msg.content
              : extractTextFromContentField(msg.content),
          );
          if (!text || (msg.role === 'user' && isNoiseUserPrompt(text))) continue;
          msgs.push({
            role: msg.role,
            content: text,
            createdAt: normalizeTimestampMs(row.created_at, fallbackTs),
            model: defaultModel,
          });
        } catch {
          continue;
        }
      }
      if (msgs.length > 0) return msgs.slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT);
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
    sqlite = new Database(dbPath, { readonly: true });
    const rows = sqlite
      .query(
        `SELECT s.id, s.working_directory, s.model, s.created_at, s.last_activity_at, s.title,
                (SELECT COUNT(*) FROM message_nodes m WHERE m.session_id = s.id) AS node_count
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
      node_count: number | null;
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
      const title = deriveChatTitle(row.title, msgs[0]?.content ?? '');
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
        messageCount: Math.max(msgs.length, Number(row.node_count ?? 0), 1),
        createdAt,
        updatedAt,
        alreadyImported: false,
        sampleMessages: msgs.slice(0, MAX_SAMPLE_MESSAGES),
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

function loadFreebuffChatMessages(chatDir: string, fallbackTs: number): DiscoveredCliChatMessage[] {
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
        const msgs: DiscoveredCliChatMessage[] = [];
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
          msgs.push({
            role: entry.role,
            content: text,
            createdAt: normalizeTimestampMs(entry.sentAt, fallbackTs),
          });
        }
        if (msgs.length > 0) return msgs.slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT);
      }
    } catch {
      // Fall through to chat-messages.json
    }
  }

  const chatMessagesPath = join(chatDir, 'chat-messages.json');
  if (existsSync(chatMessagesPath)) {
    try {
      const st = statSync(chatMessagesPath);
      if (st.size <= MAX_IMPORT_JSON_BYTES) {
        const items = JSON.parse(readFileSync(chatMessagesPath, 'utf8')) as Array<{
          variant?: string;
          content?: string;
          blocks?: Array<{ type?: string; content?: string; textType?: string }>;
        }>;
        const msgs: DiscoveredCliChatMessage[] = [];
        for (const item of items) {
          const role =
            item.variant === 'user'
              ? 'user'
              : item.variant === 'ai' || item.variant === 'assistant'
                ? 'assistant'
                : null;
          if (!role) continue;
          const blockTexts = (item.blocks ?? [])
            .filter((b) => b.type === 'text' && b.textType !== 'reasoning' && typeof b.content === 'string')
            .map((b) => b.content ?? '')
            .join('\n\n');
          const text = cleanMessageText(item.content || blockTexts);
          if (!text) continue;
          msgs.push({ role, content: text, createdAt: fallbackTs });
        }
        if (msgs.length > 0) return msgs.slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT);
      }
    } catch {
      // Ignore oversized or invalid JSON
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

function scanOpenCodeSqliteDb(
  dbPath: string,
  provider: ProviderName,
  providerDisplayName: string,
  fallbackRoot: string,
  maxChats: number,
): InternalDiscoveredChat[] {
  if (!existsSync(dbPath)) return [];
  const results: InternalDiscoveredChat[] = [];
  let sqlite: Database | null = null;
  try {
    sqlite = new Database(dbPath, { readonly: true });
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

    const loadSessionMsgs = (
      conn: Database,
      sessionId: string,
      limit: number,
      defaultTs: number,
    ): { model?: string; messages: DiscoveredCliChatMessage[] } => {
      const rows = conn
        .query(
          `SELECT m.id, m.time_created, m.data AS msg_data, p.data AS part_data
           FROM message m
           JOIN part p ON p.message_id = m.id
           WHERE m.session_id = ?
           ORDER BY m.time_created ASC, p.time_created ASC
           LIMIT ?`,
        )
        .all(sessionId, limit * 4) as Array<{
        id: string;
        time_created: number | null;
        msg_data: string;
        part_data: string;
      }>;

      let detectedModel: string | undefined;
      const byMsgId = new Map<
        string,
        { role: 'user' | 'assistant'; texts: string[]; createdAt: number; model?: string }
      >();

      for (const r of rows) {
        try {
          const msgObj = JSON.parse(r.msg_data) as {
            role?: string;
            modelID?: string;
            model?: { modelID?: string };
          };
          const partObj = JSON.parse(r.part_data) as {
            type?: string;
            text?: string;
            synthetic?: boolean;
          };
          if (msgObj.role !== 'user' && msgObj.role !== 'assistant') continue;
          if (partObj.type !== 'text' || typeof partObj.text !== 'string' || partObj.synthetic) {
            continue;
          }
          const mId = msgObj.modelID ?? msgObj.model?.modelID;
          if (mId && !detectedModel) detectedModel = mId;

          const existing = byMsgId.get(r.id);
          if (existing) {
            existing.texts.push(partObj.text);
          } else {
            byMsgId.set(r.id, {
              role: msgObj.role,
              texts: [partObj.text],
              createdAt: normalizeTimestampMs(r.time_created, defaultTs),
              model: mId,
            });
          }
        } catch {
          continue;
        }
      }

      const combined: DiscoveredCliChatMessage[] = [];
      for (const item of byMsgId.values()) {
        const text = cleanMessageText(item.texts.join('\n\n'));
        if (!text || (item.role === 'user' && isNoiseUserPrompt(text))) continue;
        combined.push({
          role: item.role,
          content: text,
          createdAt: item.createdAt,
          model: item.model ?? detectedModel,
        });
        if (combined.length >= limit) break;
      }
      return { model: detectedModel, messages: combined };
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
        messageCount: sampleMessages.length,
        createdAt,
        updatedAt,
        alreadyImported: false,
        sampleMessages,
        loadMessages: () => {
          let innerDb: Database | null = null;
          try {
            innerDb = new Database(dbPath, { readonly: true });
            const loaded = loadSessionMsgs(
              innerDb,
              sessionId,
              MAX_IMPORTED_MESSAGES_PER_CHAT,
              createdAt,
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
          loadMessages: () =>
            (parseOmnirushFile()?.messages ?? parsed.messages).slice(
              0,
              MAX_IMPORTED_MESSAGES_PER_CHAT,
            ),
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
          messageCount: parsed.messages.length,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          alreadyImported: false,
          sampleMessages: parsed.messages.slice(0, MAX_SAMPLE_MESSAGES),
          loadMessages: () =>
            (parseClaudeOrCodeBuddyJsonlFile(filePath, defaultId, mtimeMs)?.messages ??
              parsed.messages).slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT),
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
            loadMessages: () => parsedMsgs.slice(0, MAX_IMPORTED_MESSAGES_PER_CHAT),
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
    scanRoot: (root, maxChats) =>
      scanClaudeStyleProjectsDir(root, 'codebuddy', 'CodeBuddy', maxChats),
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
      scanGenericCliRoot(root, 'cursor', 'Cursor CLI', maxChats),
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
      scanGenericCliRoot(root, 'grok', 'Grok Build', maxChats),
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
      scanGenericCliRoot(root, 'kimicode', 'Kimi Code CLI', maxChats),
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
        CASE_INSENSITIVE_FS ? c.projectPath.toLowerCase() : c.projectPath,
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
    const key = CASE_INSENSITIVE_FS ? chat.projectPath.toLowerCase() : chat.projectPath;
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
      chats: sortedChats.map(({ loadMessages: _omit, ...publicChat }) => publicChat),
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

    const rawMessages = discovered.loadMessages();
    const transcript =
      rawMessages.length > 0
        ? rawMessages
        : discovered.sampleMessages.length > 0
          ? discovered.sampleMessages
          : [
              {
                role: 'user' as const,
                content: discovered.preview || discovered.title,
                createdAt: discovered.createdAt,
                model: discovered.model,
              },
            ];

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
      for (let i = 0; i < transcript.length; i++) {
        const msg = transcript[i];
        const msgId = nanoid(ID.SESSION_ID_LENGTH);
        const msgTime = new Date(
          msg.createdAt > 0 ? msg.createdAt : discovered.createdAt + i * 1000,
        );
        tx.insert(messages)
          .values({
            id: msgId,
            sessionId,
            role: msg.role,
            content: JSON.stringify([{ type: 'text', text: msg.content }]),
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
