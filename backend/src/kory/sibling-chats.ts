// Sibling-chats awareness for the manager prompt. Worktree Auto asks the
// manager to notice other chats working in (or under, or above) the same
// folder so it can decide whether to keep working in place, isolate via
// isolate_chat, or ask the user.
//
// The prompt section is only built for in-place chats with a folder; isolated
// chats get the "runs in its own copy" reminder instead (built in manager.ts).

import { resolve } from 'node:path';
import type { Session } from '@koryphaios/shared';
import { canonicalizePath, isContainedBy } from '../runtime/platform';
import type { ContextArchiveService } from './context-archive';
import type { ISessionStore } from '../stores/session-store';

const RECENT_FILES_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_FILES = 10;

export interface SiblingChat {
  id: string;
  title: string;
  busy: boolean;
  updatedAt: number;
  isolation: 'in place' | 'own copy, will merge back';
  recentFiles: string[];
}

function canonicalDir(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    return canonicalizePath(dir);
  } catch {
    return resolve(dir);
  }
}

/** `file_edit` archive labels are '<operation> <path>'; keep the path. */
function editLabelPath(label: string): string {
  const trimmed = label.trim();
  const space = trimmed.indexOf(' ');
  return space === -1 ? trimmed : trimmed.slice(space + 1).trim();
}

async function recentEditedFiles(
  archive: ContextArchiveService | undefined | null,
  sessionId: string,
  now: number,
): Promise<string[]> {
  if (!archive) return [];
  try {
    const entries = await archive.listRecent(sessionId, 500);
    const files: string[] = [];
    const seen = new Set<string>();
    for (let i = entries.length - 1; i >= 0 && files.length < MAX_RECENT_FILES; i--) {
      const entry = entries[i];
      if (entry.kind !== 'file_edit' || entry.ts < now - RECENT_FILES_WINDOW_MS) continue;
      const path = editLabelPath(entry.label);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

/** Other non-archived chats sharing the same folder (same canonical path, or
 *  one containing the other), excluding the session itself and revision-picker
 *  isolated chats (those already run far away in their own repository). */
export async function findSiblingChats(args: {
  session: Session;
  sessions: ISessionStore;
  isRunning: (sessionId: string) => boolean;
  archive?: ContextArchiveService | null;
  now?: number;
}): Promise<SiblingChat[]> {
  const { session, sessions, isRunning, archive } = args;
  const now = args.now ?? Date.now();
  const selfDir = canonicalDir(session.workingDirectory);
  if (!selfDir || session.gitWorkspace) return [];

  const active = await sessions.listActive();
  const siblings: SiblingChat[] = [];
  for (const other of active) {
    if (other.id === session.id || !other.workingDirectory) continue;
    // Revision-picker isolated chats run in their own repository and never
    // share the folder; only auto-isolated copies still merge back here.
    if (other.gitWorkspace && !other.gitWorkspace.autoIsolated) continue;
    const otherDir = canonicalDir(other.workingDirectory);
    if (!otherDir) continue;
    if (!isContainedBy(selfDir, otherDir) && !isContainedBy(otherDir, selfDir)) continue;
    siblings.push({
      id: other.id,
      title: other.title,
      busy: isRunning(other.id),
      updatedAt: other.updatedAt,
      isolation: other.gitWorkspace?.autoIsolated ? 'own copy, will merge back' : 'in place',
      recentFiles: await recentEditedFiles(archive, other.id, now),
    });
  }
  return siblings;
}

export function formatRelativeAge(ts: number, now: number): string {
  const ageMs = Math.max(0, now - ts);
  if (ageMs < 60_000) return 'just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const AUTO_GUIDANCE =
  'Before you edit files, decide whether your work can collide with theirs. If they are idle and nothing they recently edited overlaps what you will touch, keep working in place. If one is busy in, or recently edited, files you will touch, call isolate_chat before editing: this chat moves into its own copy that starts from the last commit and cannot see uncommitted changes in the folder. If your task depends on uncommitted work in the folder, or you cannot tell whether you will collide, ask the user with ask_user. Never isolate for read-only work. Use read_session or send_agent_message with a chat id to coordinate.';

const NEVER_GUIDANCE =
  'Worktree is Off for this chat: keep working in place. If your edits may collide with theirs, coordinate with send_agent_message or ask the user.';

/** Every-turn reminder for a chat that isolated itself: the recorded source
 *  and reason so the manager knows the work must return via merge_chat_back. */
export function buildAutoIsolatedPromptSection(auto: {
  sourceDirectory: string;
  reason: string;
}): string {
  return `## This chat runs in its own copy\nThis chat was moved out of ${auto.sourceDirectory} into its own copy (${auto.reason}). When the task is complete and verified, call merge_chat_back to bring the work back into the folder.`;
}

/** The '## Other chats in this folder' section appended to the manager system
 *  prompt. Empty when the chat is isolated, folder-less, or has no siblings. */
export function buildSiblingChatsPromptSection(args: {
  siblings: SiblingChat[];
  worktreeMode: 'auto' | 'always' | 'never';
  now?: number;
}): string {
  const { siblings, worktreeMode } = args;
  if (siblings.length === 0) return '';
  const now = args.now ?? Date.now();
  const lines = siblings.map((sibling) => {
    const files = sibling.recentFiles.length ? sibling.recentFiles.join(', ') : 'nothing recorded';
    return `- ${sibling.title} (id ${sibling.id}) — ${sibling.busy ? 'busy' : 'idle'}, updated ${formatRelativeAge(sibling.updatedAt, now)}; ${sibling.isolation}; recently edited: ${files}`;
  });
  const guidance = worktreeMode === 'never' ? NEVER_GUIDANCE : AUTO_GUIDANCE;
  return `## Other chats in this folder\n${lines.join('\n')}\n${guidance}`;
}
