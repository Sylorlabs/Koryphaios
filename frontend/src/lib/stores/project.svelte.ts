const PROJECT_KEY = 'koryphaios-current-project';
const PROJECTS_KEY = 'koryphaios-open-projects';
const WORKSPACE_KEY = 'koryphaios-workspace-root';
const SCOPE_KEY = 'koryphaios-session-scope';

export type SessionScope = 'project' | 'all';

function readString(key: string): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
}
function readList(key: string): string[] {
  try { return JSON.parse(readString(key) || '[]') as string[]; } catch { return []; }
}
function persist(key: string, value: string | string[] | null) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, Array.isArray(value) ? JSON.stringify(value) : value);
  } catch { /* private mode */ }
}

const initialCurrentPath = readString(PROJECT_KEY);
const initialOpenProjects = readList(PROJECTS_KEY);
let currentPath = $state<string | null>(initialCurrentPath);
let openProjects = $state<string[]>(initialCurrentPath && !initialOpenProjects.includes(initialCurrentPath) ? [initialCurrentPath, ...initialOpenProjects] : initialOpenProjects);
let workspaceRoot = $state<string | null>(readString(WORKSPACE_KEY));
let scope = $state<SessionScope>(readString(SCOPE_KEY) === 'all' ? 'all' : 'project');

export function projectDisplayName(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export const projectStore = {
  get currentPath() { return currentPath; },
  get openProjects() { return openProjects; },
  get workspaceRoot() { return workspaceRoot; },
  get scope(): SessionScope { return currentPath ? scope : 'all'; },
  get displayName() { return projectDisplayName(currentPath); },
  setProject(path: string | null) {
    currentPath = path?.trim() || null;
    persist(PROJECT_KEY, currentPath);
    if (currentPath) {
      this.addProject(currentPath);
      this.setScope('project');
    }
  },
  addProject(path: string) {
    const clean = path.trim();
    if (!clean) return;
    openProjects = [clean, ...openProjects.filter((item) => item !== clean)];
    persist(PROJECTS_KEY, openProjects);
  },
  removeProject(path: string) {
    openProjects = openProjects.filter((item) => item !== path);
    persist(PROJECTS_KEY, openProjects);
    if (currentPath === path) this.setProject(null);
  },
  setWorkspace(root: string | null, projects: string[] = []) {
    workspaceRoot = root?.trim() || null;
    persist(WORKSPACE_KEY, workspaceRoot);
    for (const project of projects) this.addProject(project);
    // Workspaces restore without silently choosing an agent working directory.
    this.setProject(null);
  },
  setScope(next: SessionScope) { scope = next; persist(SCOPE_KEY, next); },
};
