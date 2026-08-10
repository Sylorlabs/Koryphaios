/**
 * Time Travel Service - Undo/Redo via Ghost Commits
 *
 * This service provides a high-level API for the "Time Travel" UI feature,
 * allowing users to see a history of AI-generated states and instantly
 * revert to any previous state.
 *
 * Built on top of CheckpointStore (git-based checkpoint system).
 */

import {
  CheckpointStore,
  type TimelineEntry,
  type GhostCommit,
  type CheckpointFileChange,
  type GhostCommitMetadata,
  type RecoveryOperation,
} from '../kory/checkpoint-store';
import { GitManager } from '../kory/git-manager';
import { serverLog } from '../logger';
import type { IMessageStore } from '../stores/message-store';
import { resolve } from 'node:path';

export interface TimeTravelState {
  /** Current position in the timeline (HEAD) */
  currentHash: string;
  /** Available states to travel to */
  timeline: TimelineEntry[];
  /** Can we undo? */
  canUndo: boolean;
  /** Can we redo? */
  canRedo: boolean;
  /** Statistics */
  stats: {
    totalStates: number;
    totalCost: number;
    modelsUsed: string[];
  };
}

export interface TimeTravelOptions {
  /** Maximum timeline entries to show */
  timelineLimit?: number;
  /** Auto-create ghost commit on significant changes */
  autoCheckpoint?: boolean;
  /** Cost threshold for auto-checkpoint (USD) */
  costThreshold?: number;
}

export class TimeTravelService {
  private shadowLogger: CheckpointStore;
  private gitManager: GitManager;
  private messageStore: IMessageStore;
  private options: Required<TimeTravelOptions>;
  private readonly workingDirectory: string;
  private readonly projectServices = new Map<string, TimeTravelService>();
  private readonly recoveryReconciliations = new Map<string, Promise<void>>();

  constructor(
    workingDirectory: string,
    messageStore: IMessageStore,
    options: TimeTravelOptions = {},
  ) {
    this.workingDirectory = resolve(workingDirectory);
    this.shadowLogger = new CheckpointStore(this.workingDirectory);
    this.gitManager = new GitManager(this.workingDirectory);
    this.messageStore = messageStore;
    this.options = {
      timelineLimit: options.timelineLimit ?? 50,
      autoCheckpoint: options.autoCheckpoint ?? true,
      costThreshold: options.costThreshold ?? 0.01, // 1 cent
    };
  }

  /** Resolve one checkpoint namespace per project. Session routes and turn-end
   * producers must call this before reading or mutating Time Travel state. */
  forWorkingDirectory(workingDirectory: string): TimeTravelService {
    const project = resolve(workingDirectory);
    if (project === this.workingDirectory) return this;
    const existing = this.projectServices.get(project);
    if (existing) return existing;
    const service = new TimeTravelService(project, this.messageStore, this.options);
    this.projectServices.set(project, service);
    return service;
  }

  /**
   * Get the current time travel state for UI display
   */
  async getState(sessionId?: string): Promise<TimeTravelState> {
    if (sessionId) await this.ensureRecoveryReconciled(sessionId);
    const currentHash = sessionId ? ((await this.shadowLogger.getCursor(sessionId)) ?? '') : '';
    const timeline = await this.shadowLogger.getTimeline(this.options.timelineLimit, sessionId);

    // Determine if we can undo/redo
    const currentIndex = timeline.findIndex((t) => t.hash === currentHash);
    const canUndo = currentIndex >= 0 && currentIndex < timeline.length - 1;
    const canRedo = currentIndex > 0;

    return {
      currentHash,
      timeline,
      canUndo,
      canRedo,
      stats: {
        totalStates: timeline.length,
        totalCost: timeline.reduce((total, entry) => total + (entry.cost ?? 0), 0),
        modelsUsed: [...new Set(timeline.map((entry) => entry.model).filter(Boolean) as string[])],
      },
    };
  }

  /**
   * Create a checkpoint (ghost commit) after AI changes
   *
   * Call this after an AI agent makes changes to save the state.
   */
  async checkpoint(
    description: string,
    metadata: Omit<GhostCommitMetadata, 'id' | 'timestamp' | 'sequence'>,
  ): Promise<{ success: boolean; hash?: string; message: string }> {
    if (metadata.agentId) await this.ensureRecoveryReconciled(metadata.agentId);
    // Only checkpoint if there are actual changes OR it's a final response point
    const statusResult = await this.gitManager.runGit(['status', '--porcelain']);
    const status = statusResult.output.trim();

    const isFinalResponse = metadata.checkpointType === 'turn_end';

    if (!status && !isFinalResponse) {
      return { success: false, message: 'No changes or final response to checkpoint' };
    }

    // Check cost threshold for auto-checkpoints (not for final responses)
    if (!isFinalResponse && metadata.cost && metadata.cost < this.options.costThreshold) {
      return {
        success: false,
        message: `Cost ${metadata.cost} below threshold ${this.options.costThreshold}`,
      };
    }

    const hash = await this.shadowLogger.createGhostCommit(description, metadata);

    if (hash) {
      serverLog.info(
        { hash, description, model: metadata.model, type: metadata.checkpointType },
        'Time travel checkpoint created',
      );
      return { success: true, hash, message: 'Checkpoint created' };
    }

    return { success: false, message: 'Failed to create checkpoint' };
  }

  /**
   * Undo - Go back to the previous state
   *
   * This finds the next ghost commit in the timeline and recovers to it.
   */
  async undo(sessionId: string): Promise<{ success: boolean; message: string; newHash?: string }> {
    await this.ensureRecoveryReconciled(sessionId);
    const currentHash = await this.shadowLogger.getCursor(sessionId);
    if (!currentHash) {
      return { success: false, message: 'Cannot determine current state' };
    }

    const timeline = await this.shadowLogger.getTimeline(this.options.timelineLimit, sessionId);
    const currentIndex = timeline.findIndex((t) => t.hash === currentHash);

    if (currentIndex === -1 || currentIndex >= timeline.length - 1) {
      return { success: false, message: 'No previous state to undo to' };
    }

    // Get the next state (older in timeline)
    const targetState = timeline[currentIndex + 1];
    return this.travelTo(targetState.hash, sessionId, currentHash);
  }

  /**
   * Redo - Go forward to a newer state
   *
   * This finds the previous ghost commit in the timeline and recovers to it.
   */
  async redo(sessionId: string): Promise<{ success: boolean; message: string; newHash?: string }> {
    await this.ensureRecoveryReconciled(sessionId);
    const currentHash = await this.shadowLogger.getCursor(sessionId);
    if (!currentHash) {
      return { success: false, message: 'Cannot determine current state' };
    }

    const timeline = await this.shadowLogger.getTimeline(this.options.timelineLimit, sessionId);
    const currentIndex = timeline.findIndex((t) => t.hash === currentHash);

    if (currentIndex <= 0) {
      return { success: false, message: 'No newer state to redo to' };
    }

    // Get the previous state (newer in timeline)
    const targetState = timeline[currentIndex - 1];
    return this.travelTo(targetState.hash, sessionId, currentHash);
  }

  /**
   * Travel to a specific ghost commit state
   *
   * @param ghostHash The ghost commit hash to recover to
   * @param sessionId Optional session ID to truncate history for
   */
  async travelTo(
    ghostHash: string,
    sessionId: string,
    expectedCurrentHash?: string | null,
  ): Promise<{ success: boolean; message: string; newHash?: string }> {
    try {
      await this.ensureRecoveryReconciled(sessionId);
    } catch (error) {
      return {
        success: false,
        message: `Interrupted recovery requires attention: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const ghost = await this.shadowLogger.getGhostCommit(ghostHash);
    if (!ghost || !(await this.shadowLogger.isOwnedCheckpoint(ghostHash, sessionId))) {
      return { success: false, message: 'Invalid or unknown state' };
    }
    const plan = await this.buildTravelPlan(ghostHash, sessionId);
    if (!plan.success) return { success: false, message: plan.message };
    if (expectedCurrentHash && expectedCurrentHash !== plan.currentHash) {
      return { success: false, message: 'The session changed after the preview. Review it again.' };
    }

    serverLog.info(
      {
        targetHash: ghostHash,
        description: ghost.message,
        metadata: ghost.metadata,
      },
      'Time travel initiated',
    );

    const conversationBefore = await this.messageStore.getActiveBoundary(sessionId);
    const targetMessageId = ghost.metadata?.messageId ?? conversationBefore.messageId;
    const prepared = await this.shadowLogger.prepareRecoveryOperation({
      agentId: sessionId,
      targetHash: ghostHash,
      expectedCurrentHash: expectedCurrentHash ?? plan.currentHash,
      previousMessageId: conversationBefore.messageId,
      targetMessageId,
      changedFiles: plan.changedFiles,
    });
    if (!prepared.success || !prepared.operation) {
      return { success: false, message: prepared.message };
    }
    const result = await this.shadowLogger.recover(ghostHash, {
      agentId: sessionId,
      changedFiles: plan.changedFiles,
      expectedCurrentHash: expectedCurrentHash ?? plan.currentHash,
      operationId: prepared.operation.id,
    });

    if (result.success) {
      // Older/tool-only checkpoints may not name a real persisted boundary.
      // Those remain truthful code-only recoveries instead of claiming that a
      // conversation was rewound when no durable message can be selected.
      if (ghost.metadata?.messageId) {
        try {
          await this.messageStore.setActiveBoundary(sessionId, ghost.metadata.messageId, {
            expectedActiveMessageId: conversationBefore.messageId,
          });
        } catch (err) {
          serverLog.error({ err, sessionId }, 'Failed to move retained conversation boundary');
          const workspaceRollback = result.receipt
            ? await this.shadowLogger.rollbackRecovery(result.receipt)
            : { success: false, message: 'Recovery receipt was unavailable' };
          if (workspaceRollback.success) {
            const cleaned = await this.shadowLogger.completeRecoveryOperation(
              sessionId,
              prepared.operation.id,
            );
            if (!cleaned.success) {
              serverLog.warn(
                { sessionId, operationId: prepared.operation.id, message: cleaned.message },
                'Compensated recovery journal cleanup will be retried',
              );
            }
          }
          return {
            success: false,
            message: workspaceRollback.success
              ? 'Conversation rewind failed; the workspace and cursor were restored.'
              : `Conversation rewind failed and automatic workspace compensation was not safe: ${workspaceRollback.message}`,
          };
        }
        serverLog.info(
          { sessionId, messageId: ghost.metadata.messageId },
          'Retained conversation boundary moved after rewind',
        );
      }

      const completed = await this.shadowLogger.completeRecoveryOperation(
        sessionId,
        prepared.operation.id,
      );
      if (!completed.success) {
        serverLog.warn(
          { sessionId, operationId: prepared.operation.id, message: completed.message },
          'Recovery completed but durable journal cleanup will be retried',
        );
      }

      return {
        success: true,
        message: ghost.metadata?.messageId
          ? `Traveled to: ${ghost.message.slice(0, 50)}`
          : `Workspace traveled to: ${ghost.message.slice(0, 50)} (conversation unchanged)`,
        newHash: ghostHash,
      };
    }
    try {
      await this.ensureRecoveryReconciled(sessionId);
    } catch (reconcileError) {
      return {
        success: false,
        message: `${result.message}. Recovery journal retained: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
      };
    }
    return result;
  }

  /**
   * Preview what would change if we traveled to a state
   *
   * Returns a diff showing the changes that would be applied.
   */
  async previewTravel(
    ghostHash: string,
    sessionId: string,
  ): Promise<{
    canTravel: boolean;
    currentHash: string;
    targetHash: string;
    description: string;
    evidence: {
      model?: string;
      cost?: number;
      tokensIn?: number;
      tokensOut?: number;
      promptHash?: string;
      timestamp: number;
    };
    diff: string;
    filesChanged: CheckpointFileChange[];
    conversationEffect: 'rewind' | 'code-only';
    message: string;
  }> {
    try {
      await this.ensureRecoveryReconciled(sessionId);
    } catch (error) {
      return {
        canTravel: false,
        currentHash: '',
        targetHash: ghostHash,
        description: '',
        evidence: { timestamp: 0 },
        diff: '',
        filesChanged: [],
        conversationEffect: 'code-only',
        message: `Interrupted recovery requires attention: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const ghost = await this.shadowLogger.getGhostCommit(ghostHash);
    const plan = await this.buildTravelPlan(ghostHash, sessionId);
    if (!ghost || !plan.success) {
      return {
        canTravel: false,
        currentHash: plan.currentHash,
        targetHash: ghostHash,
        description: '',
        evidence: { timestamp: 0 },
        diff: '',
        filesChanged: [],
        conversationEffect: 'code-only',
        message: plan.message,
      };
    }
    const paths = plan.changedFiles.map((change) => change.path);
    const diff = paths.length
      ? await this.shadowLogger.compareCheckpoints(plan.currentHash, ghostHash, paths)
      : '';

    return {
      canTravel: true,
      currentHash: plan.currentHash,
      targetHash: ghostHash,
      description: ghost.message.replace(/^\[GHOST\]\s*/, ''),
      evidence: {
        model: ghost.metadata?.model,
        cost: ghost.metadata?.cost,
        tokensIn: ghost.metadata?.tokensIn,
        tokensOut: ghost.metadata?.tokensOut,
        promptHash: ghost.metadata?.promptHash,
        timestamp: ghost.metadata?.timestamp ?? ghost.date.getTime(),
      },
      diff,
      filesChanged: plan.changedFiles,
      conversationEffect: ghost.metadata?.messageId ? 'rewind' : 'code-only',
      message: paths.length
        ? `${paths.length} session-owned file${paths.length === 1 ? '' : 's'} will be restored${ghost.metadata?.messageId ? ' with the retained conversation boundary' : '; the conversation is unchanged'}.`
        : ghost.metadata?.messageId
          ? 'Only the retained conversation boundary will be moved.'
          : 'This code-only checkpoint has no workspace or conversation changes to apply.',
    };
  }

  /** Reconcile a crash between the Git workspace participant and the SQLite
   * conversation participant before exposing or mutating Time Travel again. */
  private async ensureRecoveryReconciled(sessionId: string): Promise<void> {
    const existing = this.recoveryReconciliations.get(sessionId);
    if (existing) return existing;
    const reconciliation = this.reconcilePendingRecoveries(sessionId).finally(() => {
      if (this.recoveryReconciliations.get(sessionId) === reconciliation) {
        this.recoveryReconciliations.delete(sessionId);
      }
    });
    this.recoveryReconciliations.set(sessionId, reconciliation);
    return reconciliation;
  }

  private async reconcilePendingRecoveries(sessionId: string): Promise<void> {
    const operations = await this.shadowLogger.getPendingRecoveryOperations(sessionId);
    for (const operation of operations) {
      await this.reconcileRecoveryOperation(sessionId, operation);
    }
  }

  private async reconcileRecoveryOperation(
    sessionId: string,
    operation: RecoveryOperation,
  ): Promise<void> {
    const [cursor, boundary] = await Promise.all([
      this.shadowLogger.getCursor(sessionId),
      this.messageStore.getActiveBoundary(sessionId),
    ]);
    if (!cursor) throw new Error(`Recovery ${operation.id} has no session cursor`);

    // Both participants reached the intended target before the process died.
    // Verify the owned workspace paths before acknowledging completion; a
    // newer external edit is never silently normalized.
    if (cursor === operation.targetHash && boundary.messageId === operation.targetMessageId) {
      for (const change of operation.changedFiles) {
        if (!(await this.shadowLogger.worktreePathMatches(operation.targetHash, change.path))) {
          throw new Error(
            `Recovery ${operation.id} reached its target but ${change.path} changed afterward`,
          );
        }
      }
      const completed = await this.shadowLogger.completeRecoveryOperation(sessionId, operation.id);
      if (!completed.success) throw new Error(completed.message);
      return;
    }

    // A crash after intent publication but before any workspace mutation is a
    // safe cancellation. Preserve edits made after the prepared preview.
    if (
      operation.phase === 'prepared' &&
      cursor === operation.previousCursor &&
      boundary.messageId === operation.previousMessageId
    ) {
      const abandoned = await this.shadowLogger.completeRecoveryOperation(sessionId, operation.id);
      if (!abandoned.success) throw new Error(abandoned.message);
      return;
    }

    if (
      boundary.messageId !== operation.previousMessageId &&
      boundary.messageId !== operation.targetMessageId
    ) {
      throw new Error(`Recovery ${operation.id} conflicts with a newer conversation boundary`);
    }

    const repaired = await this.shadowLogger.repairInterruptedRecovery(sessionId, operation.id);
    if (!repaired.success) throw new Error(repaired.message);

    if (
      boundary.messageId === operation.targetMessageId &&
      operation.targetMessageId !== operation.previousMessageId
    ) {
      await this.messageStore.setActiveBoundary(sessionId, operation.previousMessageId, {
        expectedActiveMessageId: operation.targetMessageId,
      });
    }

    const completed = await this.shadowLogger.completeRecoveryOperation(sessionId, operation.id);
    if (!completed.success) throw new Error(completed.message);
    serverLog.warn(
      { sessionId, operationId: operation.id, phase: operation.phase },
      'Interrupted Time Travel operation was compensated during recovery',
    );
  }

  private async buildTravelPlan(
    targetHash: string,
    sessionId: string,
  ): Promise<
    | { success: true; currentHash: string; changedFiles: CheckpointFileChange[]; message: string }
    | { success: false; currentHash: string; message: string }
  > {
    if (!(await this.shadowLogger.isOwnedCheckpoint(targetHash, sessionId))) {
      return {
        success: false,
        currentHash: '',
        message: 'Checkpoint does not belong to this session',
      };
    }
    const timeline = await this.shadowLogger.getTimeline(1000, sessionId);
    const currentHash = (await this.shadowLogger.getCursor(sessionId)) ?? timeline[0]?.hash ?? '';
    const currentIndex = timeline.findIndex((entry) => entry.hash === currentHash);
    const targetIndex = timeline.findIndex((entry) => entry.hash === targetHash);
    if (currentIndex < 0 || targetIndex < 0) {
      return {
        success: false,
        currentHash,
        message: 'Checkpoint is outside this session timeline',
      };
    }
    const changes = new Map<string, CheckpointFileChange['operation']>();
    const start = Math.min(currentIndex, targetIndex);
    const end = Math.max(currentIndex, targetIndex);
    for (const entry of timeline.slice(start, end)) {
      const metadata = await this.shadowLogger.getMetadata(entry.hash);
      for (const change of metadata?.changedFiles ?? []) changes.set(change.path, change.operation);
    }
    const changedFiles = Array.from(changes, ([path, operation]) => ({ path, operation }));
    const workspaceConflicts: string[] = [];
    for (const change of changedFiles) {
      const matchesCursor = await this.shadowLogger.worktreePathMatches(currentHash, change.path);
      if (!matchesCursor) workspaceConflicts.push(change.path);
    }
    if (workspaceConflicts.length > 0) {
      return {
        success: false,
        currentHash,
        message: `Workspace changed after the latest session checkpoint: ${workspaceConflicts.join(', ')}. Finish or checkpoint those edits before rewinding.`,
      };
    }
    if (currentHash !== targetHash && changedFiles.length === 0) {
      const noCodeDifference = await this.shadowLogger.checkpointsEqual(currentHash, targetHash);
      if (!noCodeDifference) {
        return {
          success: false,
          currentHash,
          message:
            'This legacy checkpoint lacks a session-owned file manifest and cannot be safely restored.',
        };
      }
    }
    return { success: true, currentHash, changedFiles, message: 'Ready' };
  }

  /**
   * Get detailed information about a specific state
   */
  async getStateDetails(ghostHash: string): Promise<GhostCommit | null> {
    return this.shadowLogger.getGhostCommit(ghostHash);
  }

  /**
   * Create a branch from a ghost state instead of resetting
   *
   * This is safer than reset - creates a new branch without modifying HEAD.
   */
  async createBranchFromState(
    ghostHash: string,
    branchName: string,
  ): Promise<{ success: boolean; message: string }> {
    const ghost = await this.shadowLogger.getGhostCommit(ghostHash);
    if (!ghost) {
      return { success: false, message: 'Invalid ghost state' };
    }

    const result = await this.shadowLogger.createBranchFromCheckpoint(ghostHash, branchName);
    return result.success
      ? {
          success: true,
          message: `Created branch '${branchName}' from state: ${ghost.message.slice(0, 50)}`,
        }
      : result;
  }

  /**
   * Clean up old ghost states
   */
  async prune(olderThanDays = 30): Promise<{ success: boolean; message: string }> {
    const result = await this.shadowLogger.prune(olderThanDays);
    return {
      success: true,
      message: result.message,
    };
  }

  /**
   * Export the timeline as a JSON file (for backup/analysis)
   */
  async exportTimeline(): Promise<{
    exportedAt: string;
    timeline: TimelineEntry[];
    stats: Awaited<ReturnType<CheckpointStore['getStats']>>;
  }> {
    return {
      exportedAt: new Date().toISOString(),
      timeline: await this.shadowLogger.getTimeline(100),
      stats: await this.shadowLogger.getStats(),
    };
  }
}
