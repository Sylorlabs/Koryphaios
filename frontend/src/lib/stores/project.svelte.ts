export type SessionScope = 'project' | 'all';

export interface WorkspaceProjectEntry {
  path: string;
  name: string;
  modifiedAt: number;
}

export interface WorkspaceNavigationSnapshot {
  workspaceRoot: string | null;
  selectedProject: string | null;
  projects: WorkspaceProjectEntry[];
  revision: string;
  unavailableWorkspace: string | null;
  unavailableProject: string | null;
}

export interface WorkspaceReconciliation {
  projectBecameUnavailable: string | null;
  workspaceBecameUnavailable: string | null;
  changed: boolean;
}

let currentPath = $state<string | null>(null);
let openProjects = $state<string[]>([]);
let workspaceProjects = $state<WorkspaceProjectEntry[]>([]);
let workspaceRoot = $state<string | null>(null);
let unavailablePath = $state<string | null>(null);
let revision = $state('');
let scope = $state<SessionScope>('project');

export function projectDisplayName(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function cleanPath(path: string | null | undefined): string | null {
  return path?.trim() || null;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

export const projectStore = {
  get currentPath() {
    return currentPath;
  },
  /** Path used to keep project-scoped requests fail-closed during recovery. */
  get requestPath() {
    return currentPath ?? unavailablePath;
  },
  get unavailablePath() {
    return unavailablePath;
  },
  get openProjects() {
    return openProjects;
  },
  get workspaceProjects() {
    return workspaceProjects;
  },
  get workspaceRoot() {
    return workspaceRoot;
  },
  get revision() {
    return revision;
  },
  get scope(): SessionScope {
    return currentPath ? scope : 'all';
  },
  get displayName() {
    return projectDisplayName(currentPath);
  },
  setProject(path: string | null) {
    const next = cleanPath(path);
    if (workspaceRoot && next && !openProjects.includes(next)) return false;
    currentPath = next;
    unavailablePath = null;
    if (next && !workspaceRoot) {
      openProjects = uniquePaths([next]);
      workspaceProjects = [{ path: next, name: projectDisplayName(next), modifiedAt: Date.now() }];
    }
    return true;
  },
  removeProject(path: string) {
    openProjects = openProjects.filter((item) => item !== path);
    workspaceProjects = workspaceProjects.filter((item) => item.path !== path);
    if (currentPath === path) currentPath = null;
  },
  reconcile(snapshot: WorkspaceNavigationSnapshot): WorkspaceReconciliation {
    const previousRoot = workspaceRoot;
    const previousProject = currentPath;
    const previousUnavailablePath = unavailablePath;
    const previousRevision = revision;
    const nextProjects = snapshot.projects.map((project) => project.path);

    workspaceRoot = snapshot.workspaceRoot;
    workspaceProjects = snapshot.projects;
    openProjects = uniquePaths(nextProjects);
    currentPath = snapshot.selectedProject;
    unavailablePath = snapshot.selectedProject
      ? null
      : (snapshot.unavailableProject ?? snapshot.unavailableWorkspace);
    revision = snapshot.revision;

    return {
      projectBecameUnavailable:
        snapshot.unavailableProject && snapshot.unavailableProject !== previousUnavailablePath
          ? snapshot.unavailableProject
          : null,
      workspaceBecameUnavailable:
        snapshot.unavailableWorkspace && snapshot.unavailableWorkspace !== previousUnavailablePath
          ? snapshot.unavailableWorkspace
          : null,
      changed:
        previousRoot !== workspaceRoot ||
        previousProject !== currentPath ||
        snapshot.revision !== previousRevision,
    };
  },
  markUnavailable(path: string) {
    if (currentPath !== path && unavailablePath !== path) return false;
    currentPath = null;
    unavailablePath = path;
    openProjects = openProjects.filter((item) => item !== path);
    workspaceProjects = workspaceProjects.filter((item) => item.path !== path);
    return true;
  },
  clearUnavailable() {
    unavailablePath = null;
  },
  clearWorkspace() {
    currentPath = null;
    openProjects = [];
    workspaceProjects = [];
    workspaceRoot = null;
    unavailablePath = null;
    revision = '';
  },
  setScope(next: SessionScope) {
    scope = next;
  },
};
