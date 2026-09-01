import type { RecentProject } from './projectManager';

const STORAGE_KEY = 'koryphaios-recent-project-briefs-v1';
const MAX_RECENT_PROJECTS = 12;
const MAX_TITLE_CHARS = 160;
const MAX_CONTENT_CHARS = 16_000;

type StoredBrief = Omit<RecentProject, 'path'>;

function storage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function isSource(value: unknown): value is RecentProject['source'] {
  return value === 'new' || value === 'file' || value === 'template';
}

function parseBrief(value: unknown): StoredBrief | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.content !== 'string' ||
    !isSource(record.source) ||
    typeof record.updatedAt !== 'number'
  )
    return null;
  return {
    id: record.id.slice(0, 160),
    title: record.title.slice(0, MAX_TITLE_CHARS),
    content: record.content.slice(0, MAX_CONTENT_CHARS),
    source: record.source,
    ...(typeof record.fileName === 'string' ? { fileName: record.fileName.slice(0, 240) } : {}),
    updatedAt: record.updatedAt,
  };
}

/**
 * Restores text briefs only. Filesystem paths are intentionally never restored
 * from browser storage: reopening a folder must remain an explicit, validated
 * user action through the backend/Tauri picker.
 */
export function loadRecentProjectBriefs(): RecentProject[] {
  const local = storage();
  if (!local) return [];
  try {
    const raw = JSON.parse(local.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map(parseBrief)
      .filter((brief): brief is StoredBrief => brief !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECENT_PROJECTS);
  } catch {
    return [];
  }
}

export function saveRecentProjectBriefs(projects: RecentProject[]): void {
  const local = storage();
  if (!local) return;
  const briefs = projects
    .map((project): StoredBrief => ({
      id: project.id.slice(0, 160),
      title: project.title.slice(0, MAX_TITLE_CHARS),
      content: project.content.slice(0, MAX_CONTENT_CHARS),
      source: project.source,
      ...(project.fileName ? { fileName: project.fileName.slice(0, 240) } : {}),
      updatedAt: project.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECENT_PROJECTS);
  try {
    local.setItem(STORAGE_KEY, JSON.stringify(briefs));
  } catch {
    // Recent briefs are recoverable convenience data; a full local store must
    // never block importing or opening a project.
  }
}
