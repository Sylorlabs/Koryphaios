/**
 * Kory Module - Core orchestration and workspace management
 * 
 * This module provides:
 * - Manager: Main agent orchestration and task delegation
 * - TaskManager: Sub-task lifecycle management
 * - GitManager: Git operations and shadow commits
 * - WorkspaceManager: Git worktree-based parallel agent isolation
 * - SnapshotManager: State snapshots for rollback
 * - CriticUtil: Code review and quality gate utilities
 */

export { KoryManager as Manager } from "./manager";
export { TaskManager } from "./task-manager";
export { GitManager } from "./git-manager";
export { WorkspaceManager, WorkspaceError } from "./workspace-manager";
export { SnapshotManager } from "./snapshot-manager";
export * as CriticUtil from "./critic-util";
export { UserInputHandler } from "./user-input-handler";
export { ShadowLogger, ShadowLoggerError } from "./shadow-logger";

export type { WorktreeInfo, WorktreeStatus } from "./workspace-manager";
export type { GhostCommit, GhostCommitMetadata, TimelineEntry } from "./shadow-logger";
