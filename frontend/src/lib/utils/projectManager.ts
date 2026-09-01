import { sessionStore } from '$lib/stores/sessions.svelte';
import { wsStore } from '$lib/stores/websocket.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { invoke } from '@tauri-apps/api/core';
import { loadRecentProjectBriefs, saveRecentProjectBriefs } from './recent-projects-storage';

export type RecentProject = {
  id: string;
  title: string;
  content: string;
  source: 'new' | 'file' | 'template';
  fileName?: string;
  path?: string;
  updatedAt: number;
};

export type PromptTemplate = {
  id: 'prd' | 'bugfix' | 'refactor' | 'ship';
  label: string;
  content: string;
};

const MAX_RECENT_PROJECTS = 12;

export const promptTemplates: PromptTemplate[] = [
  {
    id: 'prd',
    label: 'Insert PRD Template',
    content: `Build Spec
- Problem:
- Target user:
- Success metrics:

Requirements
- Must have:
- Nice to have:
- Out of scope:

Execution plan
- Milestone 1:
- Milestone 2:
- Milestone 3:

Open questions
- `,
  },
  {
    id: 'bugfix',
    label: 'Insert Bugfix Template',
    content: `Bug Report
- Expected:
- Actual:
- Repro steps:
- Environment:

Debug plan
- Suspected root cause:
- Verification steps:
- Regression risks:

Definition of done
- `,
  },
  {
    id: 'refactor',
    label: 'Insert Refactor Template',
    content: `Refactor Goal
- Why now:
- Scope:
- Constraints:

Current pain points
- 

Refactor approach
- Architecture changes:
- Migration steps:
- Test strategy:

Acceptance criteria
- `,
  },
  {
    id: 'ship',
    label: 'Insert Ship Checklist',
    content: `Ship Checklist
- Feature complete
- Tests passing
- Edge cases reviewed
- Docs updated
- Monitoring/alerts defined
- Rollback plan prepared

Release notes
- `,
  },
];

export function formatRecentDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function buildNewProjectTemplate(): string {
  return 'Set up a new project plan with milestones, risks, and first tasks.';
}

export function parseRecentProjects(): RecentProject[] {
  return loadRecentProjectBriefs();
}

export function persistRecentProjects(projects: RecentProject[]): void {
  // Only portable text briefs are restored. Never persist a folder path as
  // navigation authority; opening a filesystem project remains an explicit,
  // current-path validation step.
  saveRecentProjectBriefs(projects);
}

/** Check whether a filesystem path exists via the Tauri `path_exists` command.
 *  Returns true when not in a Tauri context (browser mode never stores
 *  absolute paths, so there's nothing to validate). */
export async function pathExists(path: string): Promise<boolean> {
  if (!('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return true;
  try {
    return await invoke<boolean>('path_exists', { path });
  } catch {
    return false;
  }
}

/** Remove recent-project entries whose `path` no longer exists on disk.
 *  Only entries with an absolute path are checked; text-only briefs and
 *  web folder picks (bare names) are kept.  Persists the pruned list and
 *  returns it. */
export async function pruneRecentProjects(projects: RecentProject[]): Promise<RecentProject[]> {
  const withPaths = projects.filter(
    (p) => p.path && (/^\//.test(p.path) || /^[A-Za-z]:[/\\]/.test(p.path)),
  );
  if (withPaths.length === 0) return projects;

  const checks = await Promise.all(
    withPaths.map(async (p) => ({ id: p.id, exists: await pathExists(p.path!) })),
  );
  const dead = new Set(checks.filter((c) => !c.exists).map((c) => c.id));
  if (dead.size === 0) return projects;

  const pruned = projects.filter((p) => !dead.has(p.id));
  persistRecentProjects(pruned);
  return pruned;
}

export function addRecentProject(
  projects: RecentProject[],
  entry: Omit<RecentProject, 'id' | 'updatedAt'>,
): RecentProject[] {
  const normalizedTitle = entry.title.trim().toLowerCase();
  const normalizedContent = entry.content.trim();
  const existing = projects.find(
    (p) =>
      p.title.trim().toLowerCase() === normalizedTitle && p.content.trim() === normalizedContent,
  );

  const now = Date.now();
  let updated: RecentProject[];
  if (existing) {
    updated = [
      { ...existing, ...entry, updatedAt: now },
      ...projects.filter((p) => p.id !== existing.id),
    ].slice(0, MAX_RECENT_PROJECTS);
  } else {
    updated = [
      {
        id: `recent-${now}-${Math.random().toString(36).slice(2, 8)}`,
        ...entry,
        updatedAt: now,
      },
      ...projects,
    ].slice(0, MAX_RECENT_PROJECTS);
  }

  persistRecentProjects(updated);
  return updated;
}

/** Creates a blank project session. Opening a folder must never trigger an
 * unsolicited model run; the project remains available through its working directory. */
export async function createProjectSession(title: string, text: string): Promise<string | null> {
  const sessionId = await sessionStore.createSession();
  if (!sessionId) {
    toastStore.error('Could not create project session');
    return null;
  }

  await sessionStore.renameSession(sessionId, title);

  return sessionId;
}

/** Reads and parses a single project file. Returns parsed data or null on error. */
export async function readProjectFile(
  file: File,
): Promise<{ title: string; text: string; fileName: string; truncated: boolean } | null> {
  try {
    const raw = await file.text();
    const maxChars = 12000;
    const trimmed = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    const baseTitle = file.name.replace(/\.[^/.]+$/, '').trim();
    const title = (baseTitle ? `Project: ${baseTitle}` : 'Imported Project').slice(0, 64);

    return { title, text: trimmed, fileName: file.name, truncated: raw.length > maxChars };
  } catch (err: unknown) {
    console.warn('Failed to read project file:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Reads and parses a project folder. Returns parsed data or null on error. */
export async function readProjectFolder(
  files: FileList,
): Promise<{ title: string; text: string; folderName: string; fileCount: number } | null> {
  try {
    const MAX_TOTAL_CHARS = 16000;
    const KEY_FILES =
      /^(README|readme|Readme)(\.(md|txt|rst))?$|^package\.json$|^package-lock\.json$|^Cargo\.toml$|^pyproject\.toml$|^go\.mod$|^\.env\.example$/i;
    const entries: { path: string; file: File }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      entries.push({ path, file });
    }
    const keyEntries = entries.filter((e) => KEY_FILES.test(e.path.split('/').pop() || ''));
    const otherEntries = entries.filter((e) => !KEY_FILES.test(e.path.split('/').pop() || ''));

    let total = 0;
    const parts: string[] = [];

    for (const { path, file } of keyEntries) {
      if (total >= MAX_TOTAL_CHARS) break;
      try {
        const text = await file.text();
        const slice =
          text.length + total > MAX_TOTAL_CHARS ? text.slice(0, MAX_TOTAL_CHARS - total) : text;
        total += slice.length;
        parts.push(`--- ${path} ---\n${slice}`);
      } catch (err: unknown) {
        console.debug(
          `Failed to read file ${path} during folder import:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const maxList = 200;
    const otherPaths = otherEntries.slice(0, maxList).map((e) => e.path);
    if (otherEntries.length > maxList) {
      otherPaths.push(`... and ${otherEntries.length - maxList} more files`);
    }
    if (otherPaths.length > 0) {
      parts.push(
        `--- Project structure (${otherEntries.length} files) ---\n${otherPaths.join('\n')}`,
      );
    }

    const folderName = entries[0]?.path.split('/')[0] || 'Folder';
    const title = `Project: ${folderName}`.slice(0, 64);
    const content = parts.join('\n\n');

    return {
      title,
      text: content || `Project folder: ${folderName} (${entries.length} files)`,
      folderName,
      fileCount: entries.length,
    };
  } catch (err) {
    console.error('Folder import failed', err);
    return null;
  }
}

export function insertPromptTemplate(
  templateId: PromptTemplate['id'],
  inputRef: HTMLTextAreaElement | undefined,
): void {
  const template = promptTemplates.find((t) => t.id === templateId);
  if (!template || !inputRef) {
    toastStore.error('Prompt template unavailable');
    return;
  }

  const current = inputRef.value.trim();
  inputRef.value = current ? `${current}\n\n${template.content}` : template.content;
  inputRef.dispatchEvent(new Event('input', { bubbles: true }));
  inputRef.focus();
  inputRef.setSelectionRange(inputRef.value.length, inputRef.value.length);
  toastStore.success(`${template.label.replace('Insert ', '')} added`);
}
