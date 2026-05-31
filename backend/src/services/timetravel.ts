/**
 * Time Travel Service - Undo/Redo via Ghost Commits
 *
 * This service provides a high-level API for the "Time Travel" UI feature,
 * allowing users to see a history of AI-generated states and instantly
 * revert to any previous state.
 *
 * Built on top of ShadowLogger (git reflog recorder).
 */

import { ShadowLogger, type TimelineEntry, type GhostCommit } from '../kory/shadow-logger';
import { GitManager } from '../kory/git-manager';
import { serverLog } from '../logger';
import type { IMessageStore } from '../stores/message-store';

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
  private shadowLogger: ShadowLogger;
  private gitManager: GitManager;
  private messageStore: IMessageStore;
  private options: Required<TimeTravelOptions>;

  constructor(workingDirectory: string, messageStore: IMessageStore, options: TimeTravelOptions = {}) {
    this.shadowLogger = new ShadowLogger(workingDirectory);
    this.gitManager = new GitManager(workingDirectory);
    this.messageStore = messageStore;
    this.options = {
      timelineLimit: options.timelineLimit ?? 50,
      autoCheckpoint: options.autoCheckpoint ?? true,
      costThreshold: options.costThreshold ?? 0.01, // 1 cent
    };
  }

  /**
   * Get the current time travel state for UI display
   */
  async getState(sessionId?: string): Promise<TimeTravelState> {
    const currentHash = await this.gitManager.getCurrentHash() || '';
    const timeline = await this.shadowLogger.getTimeline(this.options.timelineLimit, sessionId);
    const stats = await this.shadowLogger.getStats();

    // Determine if we can undo/redo
    const currentIndex = timeline.findIndex((t) => t.hash === currentHash);
    const canUndo = timeline.length > 1 && currentIndex < timeline.length - 1;
    const canRedo = currentIndex > 0;

    return {
      currentHash,
      timeline,
      canUndo,
      canRedo,
      stats: {
        totalStates: stats.totalGhosts,
        totalCost: stats.totalCost,
        modelsUsed: stats.modelsUsed,
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
    metadata: {
      model?: string;
      prompt?: string;
      cost?: number;
      tokensIn?: number;
      tokensOut?: number;
      agentId?: string;
      messageId?: string;
      checkpointType?: 'turn_end' | 'user_manual' | 'auto_save';
    },
  ): Promise<{ success: boolean; hash?: string; message: string }> {
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
  async undo(sessionId?: string): Promise<{ success: boolean; message: string; newHash?: string }> {
    const currentHash = await this.gitManager.getCurrentHash();
    if (!currentHash) {
      return { success: false, message: 'Cannot determine current state' };
    }

    const timeline = await this.shadowLogger.getTimeline(this.options.timelineLimit);
    const currentIndex = timeline.findIndex((t) => t.hash === currentHash);

    if (currentIndex === -1 || currentIndex >= timeline.length - 1) {
      return { success: false, message: 'No previous state to undo to' };
    }

    // Get the next state (older in timeline)
    const targetState = timeline[currentIndex + 1];
    return this.travelTo(targetState.hash, sessionId);
  }

  /**
   * Redo - Go forward to a newer state
   *
   * This finds the previous ghost commit in the timeline and recovers to it.
   */
  async redo(sessionId?: string): Promise<{ success: boolean; message: string; newHash?: string }> {
    const currentHash = await this.gitManager.getCurrentHash();
    if (!currentHash) {
      return { success: false, message: 'Cannot determine current state' };
    }

    const timeline = await this.shadowLogger.getTimeline(this.options.timelineLimit);
    const currentIndex = timeline.findIndex((t) => t.hash === currentHash);

    if (currentIndex <= 0) {
      return { success: false, message: 'No newer state to redo to' };
    }

    // Get the previous state (newer in timeline)
    const targetState = timeline[currentIndex - 1];
    return this.travelTo(targetState.hash, sessionId);
  }

  /**
   * Travel to a specific ghost commit state
   *
   * @param ghostHash The ghost commit hash to recover to
   * @param sessionId Optional session ID to truncate history for
   */
  async travelTo(
    ghostHash: string,
    sessionId?: string,
  ): Promise<{ success: boolean; message: string; newHash?: string }> {
    // Verify this is a valid ghost commit
    const ghost = await this.shadowLogger.getGhostCommit(ghostHash);
    if (!ghost) {
      return { success: false, message: 'Invalid or unknown state' };
    }

    serverLog.info(
      {
        targetHash: ghostHash,
        description: ghost.message,
        metadata: ghost.metadata,
      },
      'Time travel initiated',
    );

    const result = await this.shadowLogger.recover(ghostHash);

    if (result.success) {
      // If we have a sessionId and the ghost commit has a messageId, truncate history
      if (sessionId && ghost.metadata?.messageId) {
        try {
          await this.messageStore.truncateAfter(sessionId, ghost.metadata.messageId);
          serverLog.info({ sessionId, messageId: ghost.metadata.messageId }, 'Session history truncated after rewind');
        } catch (err) {
          serverLog.error({ err, sessionId }, 'Failed to truncate session history during rewind');
        }
      }

      return {
        success: true,
        message: `Traveled to: ${ghost.message.slice(0, 50)}`,
        newHash: ghostHash,
      };
    }

    return result;
  }

  /**
   * Preview what would change if we traveled to a state
   *
   * Returns a diff showing the changes that would be applied.
   */
  async previewTravel(ghostHash: string): Promise<{
    canTravel: boolean;
    diff: string;
    filesChanged: Array<{ path: string; status: string }>;
    message: string;
  }> {
    const ghost = await this.shadowLogger.getGhostCommit(ghostHash);
    if (!ghost) {
      return {
        canTravel: false,
        diff: '',
        filesChanged: [],
        message: 'Invalid state',
      };
    }

    const diff = await this.shadowLogger.compareWithGhost(ghostHash);

    return {
      canTravel: true,
      diff,
      filesChanged: ghost.filesChanged || [],
      message: ghost.message,
    };
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

    // Create branch from the ghost commit
    const result = await this.gitManager.runGit(['branch', branchName, ghostHash]);

    if (result.success) {
      return {
        success: true,
        message: `Created branch '${branchName}' from state: ${ghost.message.slice(0, 50)}`,
      };
    }

    return { success: false, message: 'Failed to create branch: ' + result.output };
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
    stats: Awaited<ReturnType<ShadowLogger['getStats']>>;
  }> {
    return {
      exportedAt: new Date().toISOString(),
      timeline: await this.shadowLogger.getTimeline(100),
      stats: await this.shadowLogger.getStats(),
    };
  }
}
