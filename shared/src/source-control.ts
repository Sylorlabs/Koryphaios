/**
 * Source-control-neutral contracts. Git remains the first implementation, but
 * callers should address roots and repositories rather than assuming that a
 * project is one Git checkout.
 */

export type SourceControlKind =
  'git' | 'mercurial' | 'perforce' | 'filesystem' | 'archive' | 'none';

export type RootAccess =
  'read-write' | 'read-only' | 'excluded' | 'generated' | 'dependent' | 'publishable';

export interface ProjectRootRef {
  id: string;
  projectId: string;
  path: string;
  label: string;
  access: RootAccess;
  sourceControl: SourceControlKind;
  repositoryId?: string;
}

export interface RepositoryRef {
  id: string;
  kind: SourceControlKind;
  canonicalPath: string;
  identityKey: string;
  remote?: string;
}

export interface TaskRootAllocation {
  taskId?: string;
  roots: ProjectRootRef[];
  workspaceRoot: string;
  revision: number;
}

export interface SourceControlStatusEntry {
  path: string;
  state: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged?: boolean;
}

export interface SourceControlSnapshot {
  id: string;
  rootId: string;
  revision: string;
  createdAt: number;
}

export interface SourceControlInspection {
  kind: SourceControlKind;
  repository?: RepositoryRef;
  branch?: string | null;
  head?: string | null;
  dirty: boolean;
  available: boolean;
  reason?: string;
}

export interface SourceControlAdapter {
  readonly kind: SourceControlKind;
  detect(root: ProjectRootRef): Promise<boolean>;
  inspect(root: ProjectRootRef): Promise<SourceControlInspection>;
  status(root: ProjectRootRef): Promise<SourceControlStatusEntry[]>;
  diff(root: ProjectRootRef, path?: string): Promise<string>;
  createWorkspace(root: ProjectRootRef, taskId: string): Promise<string>;
  snapshot(root: ProjectRootRef): Promise<SourceControlSnapshot>;
  restore(root: ProjectRootRef, snapshot: SourceControlSnapshot): Promise<void>;
  reconcile(root: ProjectRootRef): Promise<void>;
  fetch(root: ProjectRootRef): Promise<void>;
  update(root: ProjectRootRef): Promise<void>;
  publish(root: ProjectRootRef): Promise<void>;
}

export interface ChangeRequest {
  id: string;
  repositoryId: string;
  title: string;
  description?: string;
  sourceRef: string;
  targetRef?: string;
  status: 'open' | 'closed' | 'merged' | 'draft' | 'unknown';
}

export interface Review {
  id: string;
  changeRequestId: string;
  status: 'pending' | 'approved' | 'changes-requested' | 'commented' | 'unknown';
  body?: string;
}

export interface Publication {
  id: string;
  rootId: string;
  status: 'queued' | 'published' | 'partial' | 'failed';
  message?: string;
}

export type RootId = string;
export type RepositoryId = string;
export type TaskWorkspaceId = string;
export type RevisionId = string;
export type SnapshotId = string;
export type ChangeId = string;

export interface ForgeAdapter {
  readonly name: string;
  listChangeRequests(repository: RepositoryRef): Promise<ChangeRequest[]>;
  review(changeRequest: ChangeRequest, review: Review): Promise<Review>;
  publish(root: ProjectRootRef, changeRequest: ChangeRequest): Promise<Publication>;
}

export function isMutableRoot(root: ProjectRootRef): boolean {
  return root.access === 'read-write' || root.access === 'publishable';
}
