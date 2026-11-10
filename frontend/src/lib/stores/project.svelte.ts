import { resolveProjectIcon, type ProjectIdentity, type ProjectIconSpec } from '@koryphaios/shared';
import { loadSessionScope, saveSessionScope } from './navigation-preferences';

export type SessionScope = 'project' | 'all';

export interface WorkspaceProjectEntry {
  path: string;
  name: string;
  modifiedAt: number;
  identity?: ProjectIdentity;
}

export type ResolvedProjectIcon = Exclude<ProjectIconSpec, { mode: 'automatic' }>;

export interface WorkspaceProjectIdentityProjection {
  identity: ProjectIdentity;
  icon: ResolvedProjectIcon;
}

export interface WorkspaceNavigationSnapshot {
  workspaceRoot: string | null;
  selectedProject: string | null;
  projects: WorkspaceProjectEntry[];
  revision: string;
  unavailableWorkspace: string | null;
  unavailableProject: string | null;
  /** Monotonic write sequence from the backend — stale snapshots are discarded. */
  seq?: number;
  projectIdentities?: Record<string, ProjectIdentity>;
}

export interface WorkspaceReconciliation {
  projectBecameUnavailable: string | null;
  workspaceBecameUnavailable: string | null;
  changed: boolean;
}

/**
 * Project listings currently carry a checkout path rather than a durable
 * project id. Keep that limitation explicit in the temporary identity while
 * still giving every frontend consumer the shared identity/icon contract.
 */
export function projectIdentityFor(entry: WorkspaceProjectEntry): ProjectIdentity {
  if (entry.identity) return entry.identity;
  const path = entry.path.trim();
  const name = entry.name.trim() || projectDisplayName(path);
  return {
    id: `path:${path}`,
    name,
    icon: { mode: 'automatic' },
  };
}

/** Resolve the shared automatic icon fallback for a workspace project. */
export function projectIconFor(entry: WorkspaceProjectEntry): ResolvedProjectIcon {
  const identity = projectIdentityFor(entry);
  return resolveProjectIcon(identity, identity.icon);
}

/** Stable identity plus its concrete, render-ready icon projection. */
export function projectIdentityProjection(
  entry: WorkspaceProjectEntry,
): WorkspaceProjectIdentityProjection {
  const identity = projectIdentityFor(entry);
  return { identity, icon: resolveProjectIcon(identity, identity.icon) };
}

export function currentProjectIdentity(): ProjectIdentity | null {
  if (!currentPath) return null;
  const entry = workspaceProjects.find((project) => project.path === currentPath);
  if (entry) return projectIdentityFor(entry);
  return {
    id: `path:${currentPath}`,
    name: projectDisplayName(currentPath),
    icon: { mode: 'automatic' },
  };
}

let currentPath = $state<string | null>(null);
let openProjects = $state<string[]>([]);
let workspaceProjects = $state<WorkspaceProjectEntry[]>([]);
let workspaceRoot = $state<string | null>(null);
let unavailablePath = $state<string | null>(null);
let revision = $state('');
// This is a preference only, not workspace navigation. The selected project
// still comes exclusively from an authenticated backend snapshot.
let scope = $state<SessionScope>(loadSessionScope());
let lastAppliedSeq = 0;

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
    // Discard stale snapshots: a slow HTTP response must never regress state
    // that a newer WebSocket broadcast already applied.
    if (typeof snapshot.seq === 'number' && snapshot.seq < lastAppliedSeq) {
      return {
        projectBecameUnavailable: null,
        workspaceBecameUnavailable: null,
        changed: false,
      };
    }
    if (typeof snapshot.seq === 'number') lastAppliedSeq = snapshot.seq;
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
    lastAppliedSeq = 0;
  },
  setScope(next: SessionScope) {
    scope = next;
    saveSessionScope(next);
  },
};
