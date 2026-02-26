import { sessionStore } from '$lib/stores/sessions.svelte';
import { wsStore } from '$lib/stores/websocket.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

export type RecentProject = {
  id: string;
  title: string;
  content: string;
  source: 'new' | 'file' | 'template';
  fileName?: string;
  updatedAt: number;
};

export type PromptTemplate = {
  id: 'prd' | 'bugfix' | 'refactor' | 'ship';
  label: string;
  content: string;
};

const RECENT_PROJECTS_KEY = 'koryphaios-recent-projects';
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

export function sanitizeFileName(raw: string): string {
  return raw.replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project';
}

export function parseRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is RecentProject =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RecentProject).id === 'string' &&
        typeof (entry as RecentProject).title === 'string' &&
        typeof (entry as RecentProject).content === 'string' &&
        typeof (entry as RecentProject).source === 'string' &&
        typeof (entry as RecentProject).updatedAt === 'number'
      )
      .slice(0, MAX_RECENT_PROJECTS);
  } catch {
    return [];
  }
}

export function persistRecentProjects(projects: RecentProject[]): void {
  localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
}

export function addRecentProject(
  projects: RecentProject[],
  entry: Omit<RecentProject, 'id' | 'updatedAt'>
): RecentProject[] {
  const normalizedTitle = entry.title.trim().toLowerCase();
  const normalizedContent = entry.content.trim();
  const existing = projects.find((p) =>
    p.title.trim().toLowerCase() === normalizedTitle && p.content.trim() === normalizedContent
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

/** Creates a new session from project text. Returns sessionId on success, null on failure. */
export async function createProjectSession(
  title: string,
  text: string,
): Promise<string | null> {
  const sessionId = await sessionStore.createSession();
  if (!sessionId) {
    toastStore.error('Could not create project session');
    return null;
  }

  await sessionStore.renameSession(sessionId, title);

  if (text.trim()) {
    wsStore.sendMessage(sessionId, `Project brief loaded from file:\n\n${text}`);
  }

  return sessionId;
}

/** Reads and parses a single project file. Returns parsed data or null on error. */
export async function readProjectFile(
  file: File
): Promise<{ title: string; text: string; fileName: string; truncated: boolean } | null> {
  try {
    const raw = await file.text();
    const maxChars = 12000;
    const trimmed = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    const baseTitle = file.name.replace(/\.[^/.]+$/, '').trim();
    const title = (baseTitle ? `Project: ${baseTitle}` : 'Imported Project').slice(0, 64);

    return { title, text: trimmed, fileName: file.name, truncated: raw.length > maxChars };
  } catch {
    return null;
  }
}

/** Reads and parses a project folder. Returns parsed data or null on error. */
export async function readProjectFolder(
  files: FileList
): Promise<{ title: string; text: string; folderName: string; fileCount: number } | null> {
  try {
    const MAX_TOTAL_CHARS = 16000;
    const KEY_FILES = /^(README|readme|Readme)(\.(md|txt|rst))?$|^package\.json$|^package-lock\.json$|^Cargo\.toml$|^pyproject\.toml$|^go\.mod$|^\.env\.example$/i;
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
        const slice = text.length + total > MAX_TOTAL_CHARS ? text.slice(0, MAX_TOTAL_CHARS - total) : text;
        total += slice.length;
        parts.push(`--- ${path} ---\n${slice}`);
      } catch (_) {}
    }

    const maxList = 200;
    const otherPaths = otherEntries.slice(0, maxList).map((e) => e.path);
    if (otherEntries.length > maxList) {
      otherPaths.push(`... and ${otherEntries.length - maxList} more files`);
    }
    if (otherPaths.length > 0) {
      parts.push(`--- Project structure (${otherEntries.length} files) ---\n${otherPaths.join('\n')}`);
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

export function exportCurrentProjectSnapshot(): void {
  const sessionId = sessionStore.activeSessionId;
  const activeSession = sessionStore.sessions.find((s) => s.id === sessionId);

  if (!activeSession) {
    toastStore.error('No active project session to export');
    return;
  }

  const snapshot = {
    format: 'koryphaios.project.snapshot.v1',
    exportedAt: new Date().toISOString(),
    project: {
      id: activeSession.id,
      title: activeSession.title,
      updatedAt: activeSession.updatedAt,
    },
    feed: wsStore.feed
      .filter((entry) => entry.metadata?.sessionId === sessionId || !entry.metadata?.sessionId)
      .map((entry) => ({
        type: entry.type,
        agent: entry.agentName,
        text: entry.text ?? '',
        timestamp: entry.timestamp,
        model: entry.metadata?.model ?? null,
      })),
  };

  const payload = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const safeTitle = sanitizeFileName(activeSession.title.toLowerCase());
  const datePart = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = href;
  a.download = `${safeTitle}-${datePart}.kory.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
  toastStore.success('Project snapshot exported');
}

export function insertPromptTemplate(
  templateId: PromptTemplate['id'],
  inputRef: HTMLTextAreaElement | undefined
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
