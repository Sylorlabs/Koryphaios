/**
 * Notes agent permission settings — persisted in koryphaios.json
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { serverLog } from '../logger';
import {
  DEFAULT_NOTES_AGENT_PERMISSIONS,
  DEFAULT_NOTES_SETTINGS,
  CONTEXT_BUDGET_MAX_TOKENS,
  CONTEXT_BUDGET_MIN_TOKENS,
  NOTE_TOOL_DEFINITIONS,
  NOTE_TOOL_NAMES,
  isNoteToolName,
  normalizeNotesAgentPermissions,
  type NotePermissionLevel,
  type NoteToolName,
  type NotesAgentPermissions,
  type NotesSettings,
} from '@koryphaios/shared';

export interface NoteToolPermissionCheck {
  allowed: boolean;
  level: NotePermissionLevel;
  requiresApproval: boolean;
  reason: string;
}

export const NOTES_HARD_MAX_BYTES = 5_000_000;
export const NOTES_HARD_MAX_ATTACHMENT_BYTES = 100_000_000;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeNotesSettings(input?: Partial<NotesSettings> | null): NotesSettings {
  const graph = input?.graphPhysics;
  const defaultFolder =
    typeof input?.defaultFolderPath === 'string' && input.defaultFolderPath.trim()
      ? input.defaultFolderPath.trim()
      : DEFAULT_NOTES_SETTINGS.defaultFolderPath;
  return {
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : DEFAULT_NOTES_SETTINGS.enabled,
    autoIncludeInContext:
      typeof input?.autoIncludeInContext === 'boolean'
        ? input.autoIncludeInContext
        : DEFAULT_NOTES_SETTINGS.autoIncludeInContext,
    maxContextTokensEnabled:
      typeof input?.maxContextTokensEnabled === 'boolean'
        ? input.maxContextTokensEnabled
        : DEFAULT_NOTES_SETTINGS.maxContextTokensEnabled,
    maxContextTokens: Math.round(
      Math.min(
        CONTEXT_BUDGET_MAX_TOKENS,
        Math.max(
          CONTEXT_BUDGET_MIN_TOKENS,
          finiteNumber(input?.maxContextTokens, DEFAULT_NOTES_SETTINGS.maxContextTokens),
        ),
      ),
    ),
    autosaveEnabled:
      typeof input?.autosaveEnabled === 'boolean'
        ? input.autosaveEnabled
        : DEFAULT_NOTES_SETTINGS.autosaveEnabled,
    autosaveDelayMs: Math.round(
      Math.min(
        10_000,
        Math.max(250, finiteNumber(input?.autosaveDelayMs, DEFAULT_NOTES_SETTINGS.autosaveDelayMs)),
      ),
    ),
    noteSizeLimitEnabled:
      typeof input?.noteSizeLimitEnabled === 'boolean'
        ? input.noteSizeLimitEnabled
        : DEFAULT_NOTES_SETTINGS.noteSizeLimitEnabled,
    maxNoteBytes: Math.round(
      Math.min(
        NOTES_HARD_MAX_BYTES,
        Math.max(16_384, finiteNumber(input?.maxNoteBytes, DEFAULT_NOTES_SETTINGS.maxNoteBytes)),
      ),
    ),
    attachmentSizeLimitEnabled:
      typeof input?.attachmentSizeLimitEnabled === 'boolean'
        ? input.attachmentSizeLimitEnabled
        : DEFAULT_NOTES_SETTINGS.attachmentSizeLimitEnabled,
    maxAttachmentBytes: Math.round(
      Math.min(
        NOTES_HARD_MAX_ATTACHMENT_BYTES,
        Math.max(
          64_000,
          finiteNumber(input?.maxAttachmentBytes, DEFAULT_NOTES_SETTINGS.maxAttachmentBytes),
        ),
      ),
    ),
    maxAttachmentsPerNote: Math.round(
      Math.min(
        250,
        Math.max(
          1,
          finiteNumber(input?.maxAttachmentsPerNote, DEFAULT_NOTES_SETTINGS.maxAttachmentsPerNote),
        ),
      ),
    ),
    graphPhysics: {
      gravity: Math.min(
        0,
        Math.max(-500, finiteNumber(graph?.gravity, DEFAULT_NOTES_SETTINGS.graphPhysics.gravity)),
      ),
      linkDistance: Math.min(
        500,
        Math.max(
          20,
          finiteNumber(graph?.linkDistance, DEFAULT_NOTES_SETTINGS.graphPhysics.linkDistance),
        ),
      ),
      chargeStrength: Math.min(
        -10,
        Math.max(
          -1000,
          finiteNumber(graph?.chargeStrength, DEFAULT_NOTES_SETTINGS.graphPhysics.chargeStrength),
        ),
      ),
    },
    defaultFolderPath: defaultFolder.startsWith('/') ? defaultFolder : `/${defaultFolder}`,
  };
}

function loadKoryphaiosConfig(projectRoot: string): Record<string, unknown> {
  const configPath = join(projectRoot, 'koryphaios.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'koryphaios.json parse failed — returning empty config',
    );
    return {};
  }
}

function saveKoryphaiosConfig(projectRoot: string, config: Record<string, unknown>): void {
  const configPath = join(projectRoot, 'koryphaios.json');
  const tempPath = `${configPath}.${process.pid}.tmp`;
  config.updatedAt = Date.now();
  writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tempPath, configPath);
}

export function loadNotesAgentPermissions(projectRoot: string): NotesAgentPermissions {
  const config = loadKoryphaiosConfig(projectRoot);
  const raw = config.notesAgentPermissions as Partial<NotesAgentPermissions> | undefined;
  return normalizeNotesAgentPermissions(raw);
}

export function saveNotesAgentPermissions(
  projectRoot: string,
  permissions: Partial<NotesAgentPermissions>,
): NotesAgentPermissions {
  const config = loadKoryphaiosConfig(projectRoot);
  const normalized = normalizeNotesAgentPermissions(permissions);
  config.notesAgentPermissions = normalized;
  saveKoryphaiosConfig(projectRoot, config);
  return normalized;
}

// ── General notes settings (enabled / context injection / folder) ───────────
// Persisted in koryphaios.json so the BACKEND honors them when building agent
// context. Previously these lived only in the frontend's localStorage — the
// toggles were decorative and the server always used its own defaults.

export function loadNotesSettings(projectRoot: string): NotesSettings {
  const config = loadKoryphaiosConfig(projectRoot);
  const raw = (config.notesSettings ?? {}) as Partial<NotesSettings>;
  return normalizeNotesSettings(raw);
}

export function saveNotesSettings(
  projectRoot: string,
  partial: Partial<NotesSettings>,
): NotesSettings {
  const config = loadKoryphaiosConfig(projectRoot);
  const current = loadNotesSettings(projectRoot);
  const merged = normalizeNotesSettings({
    ...current,
    ...partial,
    graphPhysics: {
      ...current.graphPhysics,
      ...(partial.graphPhysics ?? {}),
    },
  });
  config.notesSettings = merged;
  saveKoryphaiosConfig(projectRoot, config);
  return merged;
}

export function resetNotesAgentPermissions(projectRoot: string): NotesAgentPermissions {
  return saveNotesAgentPermissions(projectRoot, { ...DEFAULT_NOTES_AGENT_PERMISSIONS });
}

export function isNoteToolBlocked(toolName: string, projectRoot: string): boolean {
  if (!isNoteToolName(toolName)) return false;
  // "Enable Notes" is a product-wide boundary, not just a panel preference.
  // Disabled notes must not remain available to agents through stale tool
  // definitions or an existing session.
  if (!loadNotesSettings(projectRoot).enabled) return true;
  const { tools } = loadNotesAgentPermissions(projectRoot);
  return tools[toolName] === 'block';
}

export function getVisibleNoteToolNames(projectRoot: string): NoteToolName[] {
  if (!loadNotesSettings(projectRoot).enabled) return [];
  const { tools } = loadNotesAgentPermissions(projectRoot);
  return NOTE_TOOL_NAMES.filter((name) => tools[name] !== 'block');
}

export function hasAnyVisibleNoteTools(projectRoot: string): boolean {
  return getVisibleNoteToolNames(projectRoot).length > 0;
}

export function filterToolDefsForNotesPermissions<T extends { name: string }>(
  toolDefs: T[],
  projectRoot: string,
): T[] {
  return toolDefs.filter((t) => !isNoteToolBlocked(t.name, projectRoot));
}

export function buildNotesNetworkSystemHint(projectRoot: string): string {
  const visible = getVisibleNoteToolNames(projectRoot);
  if (!visible.length) return '';
  const enabled = new Set<string>(visible);
  const usage = [
    ['list_notes', 'list_notes({folderPath?}) -> discover titles and IDs; never loads bodies'],
    ['search_notes', 'search_notes({query}) -> locate relevant notes and short matches'],
    [
      'render_note',
      'render_note({id|title, mode:"excerpt", query?|heading?, maxChars?}) -> pull only the relevant bounded context; mode:"document" -> render the whole note in chat without copying it',
    ],
    [
      'read_note',
      'read_note({id|title}) -> full body plus the current revision required for optimistic writes; use only when the complete document is genuinely required',
    ],
    [
      'recall_notes',
      'recall_notes({query?|ids?|titles?, limit?}) -> full bodies for a small selected set; keep limit low',
    ],
    [
      'get_note_backlinks',
      'get_note_backlinks({id|title}) -> find documents that reference one note',
    ],
    [
      'get_note_graph_summary',
      'get_note_graph_summary({}) -> graph overview without loading note bodies',
    ],
    [
      'get_note_properties',
      'get_note_properties({noteId}) -> read the current revision and bounded typed YAML properties; malformed frontmatter fails closed',
    ],
    [
      'query_note_base',
      'query_note_base({baseId|baseName, limit?, offset?}) -> run an existing saved Base with deterministic bounded results; agents cannot supply a query AST',
    ],
    [
      'record_work_note',
      'record_work_note({title, summary, status, objective?, decisions?, changedFiles?, commands?, tests?, evidence?, risks?, followUps?, relatedNotes?, includeInContext?}) -> save a structured evidence note with the authenticated session and all provider, model, agent, and goal provenance available to Koryphaios',
    ],
    [
      'create_note',
      'create_note({title, content?, folderPath?, tags?, includeInContext?}) -> create Markdown note',
    ],
    [
      'set_note_property',
      'set_note_property({noteId, expectedRevision, key, type, value}) -> optimistically update one typed YAML property without overwriting a newer note revision',
    ],
    [
      'update_note',
      'update_note({id|title, expectedRevision, content?|newTitle?|folderPath?|tags?|pinned?|includeInContext?}) -> edit only the revision returned by read_note; stale writes fail instead of overwriting newer work',
    ],
    ['delete_note', 'delete_note({id|title}) -> move a note to recoverable trash'],
    [
      'link_notes',
      'link_notes({fromId|fromTitle, toId|toTitle, syncContent?}) -> connect notes and optionally add [[wikilink]]',
    ],
    [
      'unlink_notes',
      'unlink_notes({fromId|fromTitle, toId|toTitle, syncContent?}) -> remove connection',
    ],
  ]
    .filter(([name]) => enabled.has(name))
    .map(([, help]) => `  - ${help}`)
    .join('\n');

  return (
    `• KNOWLEDGE NETWORK: Project Markdown, HTML, memories, and rules are indexed as a connected note vault.\n${usage}\n` +
    '  Retrieval rule: start with catalog/search/graph metadata. Prefer render_note excerpt with a heading or query. Do not load, quote, or recommend an entire note when a focused excerpt answers the task. Use document rendering only when the user asks to see the artifact. Write tools may require approval according to Notes settings.'
  );
}

export function checkNoteToolPermission(
  toolName: string,
  projectRoot: string,
  options?: { yoloMode?: boolean },
): NoteToolPermissionCheck {
  if (!isNoteToolName(toolName)) {
    return {
      allowed: true,
      level: 'auto',
      requiresApproval: false,
      reason: 'Not a note tool',
    };
  }

  if (!loadNotesSettings(projectRoot).enabled) {
    return {
      allowed: false,
      level: 'block',
      requiresApproval: false,
      reason: 'Notes are disabled for this project',
    };
  }

  const { tools } = loadNotesAgentPermissions(projectRoot);
  let level = tools[toolName];
  let reason = `Notes permission for ${toolName}`;

  if (options?.yoloMode && level === 'ask') {
    level = 'auto';
    reason = 'YOLO mode — auto-approving note tool';
  }

  return {
    allowed: level !== 'block',
    level,
    requiresApproval: level === 'ask',
    reason,
  };
}

export function formatNoteToolApprovalSummary(
  toolName: NoteToolName,
  input: Record<string, unknown>,
): string {
  const def = NOTE_TOOL_DEFINITIONS.find((d) => d.name === toolName);
  const parts: string[] = [];

  if (typeof input.title === 'string' && input.title) parts.push(`"${input.title}"`);
  if (typeof input.fromTitle === 'string' && input.fromTitle)
    parts.push(`from "${input.fromTitle}"`);
  if (typeof input.toTitle === 'string' && input.toTitle) parts.push(`to "${input.toTitle}"`);
  if (typeof input.query === 'string' && input.query) parts.push(`query "${input.query}"`);
  if (typeof input.id === 'string' && input.id) parts.push(`id ${input.id.slice(0, 8)}…`);

  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  return `${def?.label ?? toolName}${detail}`;
}
