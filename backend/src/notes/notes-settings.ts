/**
 * Notes agent permission settings — persisted in koryphaios.json
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_NOTES_AGENT_PERMISSIONS,
  NOTE_TOOL_DEFINITIONS,
  NOTE_TOOL_NAMES,
  isNoteToolName,
  normalizeNotesAgentPermissions,
  type NotePermissionLevel,
  type NoteToolName,
  type NotesAgentPermissions,
} from '@koryphaios/shared';

export interface NoteToolPermissionCheck {
  allowed: boolean
  level: NotePermissionLevel
  requiresApproval: boolean
  reason: string
}

function loadKoryphaiosConfig(projectRoot: string): Record<string, unknown> {
  const configPath = join(projectRoot, 'koryphaios.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
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
  permissions: NotesAgentPermissions,
): NotesAgentPermissions {
  const config = loadKoryphaiosConfig(projectRoot);
  const normalized = normalizeNotesAgentPermissions(permissions);
  config.notesAgentPermissions = normalized;
  saveKoryphaiosConfig(projectRoot, config);
  return normalized;
}

export function resetNotesAgentPermissions(projectRoot: string): NotesAgentPermissions {
  return saveNotesAgentPermissions(projectRoot, { ...DEFAULT_NOTES_AGENT_PERMISSIONS });
}

export function isNoteToolBlocked(toolName: string, projectRoot: string): boolean {
  if (!isNoteToolName(toolName)) return false;
  const { tools } = loadNotesAgentPermissions(projectRoot);
  return tools[toolName] === 'block';
}

export function getVisibleNoteToolNames(projectRoot: string): NoteToolName[] {
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

  return (
    '• KNOWLEDGE NETWORK: You have access to an Obsidian-style note vault. ' +
    `Available note tools: ${visible.join(', ')}. ` +
    'The Notes Catalog below lists notes you can load with recall_notes or read_note. ' +
    '[[wikilinks]] in note content create graph edges when using write tools.'
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
  if (typeof input.fromTitle === 'string' && input.fromTitle) parts.push(`from "${input.fromTitle}"`);
  if (typeof input.toTitle === 'string' && input.toTitle) parts.push(`to "${input.toTitle}"`);
  if (typeof input.query === 'string' && input.query) parts.push(`query "${input.query}"`);
  if (typeof input.id === 'string' && input.id) parts.push(`id ${input.id.slice(0, 8)}…`);

  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  return `${def?.label ?? toolName}${detail}`;
}