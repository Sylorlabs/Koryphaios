import { createHash } from 'node:crypto';
import { existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { WORKSPACE_MARKER } from '../memory/unified-memory';

const NAVIGATION_ID = 'local-desktop';
const MAX_WORKSPACE_PROJECTS = 2_000;

type NavigationRow = {
  workspace_root: string | null;
  selected_project: string | null;
  unavailable_workspace: string | null;
  unavailable_project: string | null;
  updated_at: number;
};

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
  /** Monotonic write sequence — clients discard snapshots older than the last applied one. */
  seq: number;
}

function isBroadDirectory(path: string): boolean {
  const normalized = resolve(path);
  return (
    normalized === parse(normalized).root ||
    normalized === resolve(homedir()) ||
    normalized === resolve(dirname(homedir())) ||
    normalized === resolve(tmpdir())
  );
}

function canonicalDirectory(path: string, label: string): string {
  const trimmed = path.trim();
  if (!trimmed || !isAbsolute(trimmed)) throw new Error(`${label} must be an absolute path`);
  const resolved = resolve(trimmed);
  if (isBroadDirectory(resolved)) throw new Error(`${label} is too broad`);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${label} is unavailable`);
  }
  return realpathSync(resolved);
}

export function validateWorkspaceRoot(path: string): string {
  return canonicalDirectory(path, 'Workspace root');
}

function listImmediateProjects(root: string): WorkspaceProjectEntry[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const path = join(root, entry.name);
      try {
        if (!entry.isDirectory() || !statSync(path).isDirectory()) return [];
        const canonical = realpathSync(path);
        const stat = statSync(canonical);
        return [{ path: canonical, name: basename(canonical), modifiedAt: stat.mtimeMs }];
      } catch {
        // A folder can disappear between readdir and stat. The next snapshot
        // will observe the new state; never retain the stale entry.
        return [];
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
    .slice(0, MAX_WORKSPACE_PROJECTS);
}

function findRegisteredWorkspaceRoot(project: string): string | null {
  let current = dirname(project);
  for (let hops = 0; hops < 16; hops++) {
    if (!current || current === dirname(current)) return null;
    if (existsSync(join(current, WORKSPACE_MARKER))) return current;
    current = dirname(current);
  }
  return null;
}

function snapshotRevision(
  workspaceRoot: string | null,
  selectedProject: string | null,
  projects: WorkspaceProjectEntry[],
  unavailableWorkspace: string | null,
  unavailableProject: string | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        workspaceRoot,
        selectedProject,
        projects,
        unavailableWorkspace,
        unavailableProject,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

export class WorkspaceNavigationStore {
  constructor(private readonly database: Database) {}

  private readRow(): NavigationRow {
    return (
      this.database
        .query<NavigationRow, [string]>(
          `SELECT workspace_root, selected_project, unavailable_workspace, unavailable_project, updated_at
           FROM workspace_navigation WHERE id = ?`,
        )
        .get(NAVIGATION_ID) ?? {
        workspace_root: null,
        selected_project: null,
        unavailable_workspace: null,
        unavailable_project: null,
        updated_at: 0,
      }
    );
  }

  private write(
    workspaceRoot: string | null,
    selectedProject: string | null,
    unavailableWorkspace: string | null = null,
    unavailableProject: string | null = null,
  ): void {
    // Monotonic sequence: equal-millisecond writes still advance, so clients
    // can discard stale snapshots that arrive after newer ones.
    const seq = Math.max(Date.now(), this.readRow().updated_at + 1);
    this.database.run(
      `INSERT INTO workspace_navigation (
         id, workspace_root, selected_project, unavailable_workspace, unavailable_project, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_root = excluded.workspace_root,
         selected_project = excluded.selected_project,
         unavailable_workspace = excluded.unavailable_workspace,
         unavailable_project = excluded.unavailable_project,
         updated_at = excluded.updated_at`,
      [
        NAVIGATION_ID,
        workspaceRoot,
        selectedProject,
        unavailableWorkspace,
        unavailableProject,
        seq,
      ],
    );
  }

  openWorkspace(path: string): WorkspaceNavigationSnapshot {
    const root = validateWorkspaceRoot(path);
    this.write(root, null);
    return this.snapshot();
  }

  selectProject(path: string): WorkspaceNavigationSnapshot {
    const project = canonicalDirectory(path, 'Project directory');
    const current = this.readRow();
    let workspaceRoot: string | null = null;

    if (current.workspace_root) {
      try {
        const currentRoot = validateWorkspaceRoot(current.workspace_root);
        // The workspace root itself is a valid working project — working in
        // the root workspace must not detach the workspace context.
        if (project === currentRoot || dirname(project) === currentRoot)
          workspaceRoot = currentRoot;
      } catch {
        // A stale workspace must not prevent selecting a current project.
      }
    }

    if (!workspaceRoot) {
      const registeredRoot = findRegisteredWorkspaceRoot(project);
      if (registeredRoot && dirname(project) === registeredRoot) workspaceRoot = registeredRoot;
    }

    this.write(workspaceRoot, project);
    return this.snapshot();
  }

  deselectProject(): WorkspaceNavigationSnapshot {
    const current = this.readRow();
    this.write(current.workspace_root, null, current.unavailable_workspace, null);
    return this.snapshot();
  }

  acknowledgeUnavailable(): WorkspaceNavigationSnapshot {
    const current = this.readRow();
    this.write(current.workspace_root, current.selected_project);
    return this.snapshot();
  }

  clear(): WorkspaceNavigationSnapshot {
    this.write(null, null);
    return this.snapshot();
  }

  snapshot(): WorkspaceNavigationSnapshot {
    const row = this.readRow();
    let workspaceRoot = row.workspace_root;
    let selectedProject = row.selected_project;
    let unavailableWorkspace = row.unavailable_workspace;
    let unavailableProject = row.unavailable_project;
    let projects: WorkspaceProjectEntry[] = [];

    if (workspaceRoot) {
      try {
        workspaceRoot = canonicalDirectory(workspaceRoot, 'Workspace root');
        projects = listImmediateProjects(workspaceRoot);
      } catch {
        unavailableWorkspace = workspaceRoot;
        if (selectedProject) unavailableProject = selectedProject;
        workspaceRoot = null;
        selectedProject = null;
      }
    }

    if (selectedProject) {
      try {
        selectedProject = canonicalDirectory(selectedProject, 'Project directory');
        // The workspace root is a valid selection even though it is not part
        // of the immediate-children project list.
        const isWorkspaceRootSelection = workspaceRoot === selectedProject;
        if (
          workspaceRoot &&
          !isWorkspaceRootSelection &&
          !projects.some((project) => project.path === selectedProject)
        ) {
          unavailableProject = selectedProject;
          selectedProject = null;
        }
      } catch {
        unavailableProject = selectedProject;
        selectedProject = null;
      }
    }

    if (!workspaceRoot && selectedProject) {
      projects = [
        {
          path: selectedProject,
          name: basename(selectedProject),
          modifiedAt: statSync(selectedProject).mtimeMs,
        },
      ];
    }

    if (
      workspaceRoot !== row.workspace_root ||
      selectedProject !== row.selected_project ||
      unavailableWorkspace !== row.unavailable_workspace ||
      unavailableProject !== row.unavailable_project
    ) {
      this.write(workspaceRoot, selectedProject, unavailableWorkspace, unavailableProject);
    }

    const healed =
      workspaceRoot !== row.workspace_root ||
      selectedProject !== row.selected_project ||
      unavailableWorkspace !== row.unavailable_workspace ||
      unavailableProject !== row.unavailable_project;

    return {
      workspaceRoot,
      selectedProject,
      projects,
      revision: snapshotRevision(
        workspaceRoot,
        selectedProject,
        projects,
        unavailableWorkspace,
        unavailableProject,
      ),
      unavailableWorkspace,
      unavailableProject,
      seq: this.readRow().updated_at,
    };
  }

  /** Snapshot plus whether the filesystem self-heal wrote a new state —
   *  callers (GET /state) broadcast when true so other windows learn. */
  snapshotWithStatus(): { snapshot: WorkspaceNavigationSnapshot; healed: boolean } {
    const before = this.readRow().updated_at;
    const snapshot = this.snapshot();
    return { snapshot, healed: snapshot.seq !== before };
  }
}
