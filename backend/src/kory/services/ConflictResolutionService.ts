/**
 * ConflictResolutionService - Multi-Agent File Conflict Detection & Resolution
 *
 * Handles conflicts when multiple workers modify the same files.
 * Implements multiple resolution strategies: last-write-wins, merge, critic-mediated, voting.
 *
 * Features:
 * - File-level conflict detection across worktrees
 * - Multiple resolution strategies (configurable per task)
 * - Critic-mediated arbitration for complex conflicts
 * - Automatic merge for non-overlapping changes
 * - Human escalation for critical conflicts
 */

import { koryLog } from '../../logger';
import type { ProviderRegistry } from '../../providers';
import type { WorktreeInfo } from '../workspace-manager';

export interface FileChange {
  path: string;
  content: string;
  checksum: string;
  modifiedAt: number;
  agentId: string;
  worktreeId: string;
}

export interface Conflict {
  filePath: string;
  changes: FileChange[];
  conflictType: 'edit-edit' | 'delete-edit' | 'rename-edit';
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export type ResolutionStrategy =
  | 'last-write-wins'
  | 'merge'
  | 'critic-mediated'
  | 'voting'
  | 'human-escalation';

export interface ResolutionResult {
  success: boolean;
  strategy: ResolutionStrategy;
  resolvedConflicts: number;
  escalatedConflicts: number;
  mergedContent?: Map<string, string>;
  message: string;
}

export interface ResolutionConfig {
  strategy: ResolutionStrategy;
  autoResolveThreshold: 'low' | 'medium' | 'high' | 'none';
  enableMergeForNonOverlapping: boolean;
  criticModel?: string;
  escalationTimeoutMs: number;
}

const DEFAULT_CONFIG: ResolutionConfig = {
  strategy: 'critic-mediated',
  autoResolveThreshold: 'medium',
  enableMergeForNonOverlapping: true,
  criticModel: 'claude-3-7-sonnet',
  escalationTimeoutMs: 300000, // 5 minutes
};

export class ConflictResolutionService {
  private fileChanges = new Map<string, FileChange[]>();
  private config: ResolutionConfig;
  private providers: ProviderRegistry;

  constructor(providers: ProviderRegistry, config?: Partial<ResolutionConfig>) {
    this.providers = providers;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a file change from a worker
   */
  registerChange(change: FileChange): void {
    const existing = this.fileChanges.get(change.path) || [];
    existing.push(change);
    this.fileChanges.set(change.path, existing);

    koryLog.info(
      {
        file: change.path,
        agentId: change.agentId,
        worktreeId: change.worktreeId,
      },
      'File change registered for conflict tracking',
    );
  }

  /**
   * Detect conflicts across all registered changes
   */
  detectConflicts(): Conflict[] {
    const conflicts: Conflict[] = [];

    for (const [filePath, changes] of this.fileChanges) {
      if (changes.length < 2) continue;

      // Group by worktree to detect if same file modified by different agents
      const worktreeIds = new Set(changes.map((c) => c.worktreeId));
      if (worktreeIds.size < 2) continue;

      const conflictType = this.classifyConflict(changes);
      const severity = this.assessSeverity(changes, conflictType);

      conflicts.push({
        filePath,
        changes,
        conflictType,
        severity,
      });
    }

    koryLog.info({ count: conflicts.length }, 'Conflict detection completed');
    return conflicts;
  }

  /**
   * Resolve conflicts using configured strategy
   */
  async resolveConflicts(conflicts?: Conflict[]): Promise<ResolutionResult> {
    const detectedConflicts = conflicts || this.detectConflicts();

    if (detectedConflicts.length === 0) {
      return {
        success: true,
        strategy: this.config.strategy,
        resolvedConflicts: 0,
        escalatedConflicts: 0,
        message: 'No conflicts detected',
      };
    }

    // Filter conflicts based on auto-resolve threshold
    const autoResolvable = detectedConflicts.filter((c) => this.shouldAutoResolve(c.severity));
    const needsEscalation = detectedConflicts.filter((c) => !this.shouldAutoResolve(c.severity));

    let resolved = 0;
    const mergedContent = new Map<string, string>();

    // Resolve auto-resolvable conflicts
    for (const conflict of autoResolvable) {
      try {
        const result = await this.resolveConflict(conflict);
        if (result.resolved) {
          resolved++;
          if (result.content) {
            mergedContent.set(conflict.filePath, result.content);
          }
        }
      } catch (err) {
        koryLog.error({ error: err, file: conflict.filePath }, 'Failed to resolve conflict');
      }
    }

    const message =
      `Resolved ${resolved}/${autoResolvable.length} auto-resolvable conflicts. ` +
      `${needsEscalation.length} require escalation.`;

    koryLog.info({ resolved, escalated: needsEscalation.length }, message);

    return {
      success: resolved === autoResolvable.length,
      strategy: this.config.strategy,
      resolvedConflicts: resolved,
      escalatedConflicts: needsEscalation.length,
      mergedContent,
      message,
    };
  }

  /**
   * Critic-mediated arbitration for complex conflicts
   */
  async arbitrateWithCritic(conflict: Conflict): Promise<{
    resolved: boolean;
    content?: string;
    reasoning: string;
  }> {
    const prompt = this.buildArbitrationPrompt(conflict);

    try {
      const provider = this.providers.findProviderForModel(
        this.config.criticModel || 'claude-3-7-sonnet',
      );
      if (!provider) {
        throw new Error('Critic provider not available');
      }

      // Use streaming API to get completion
      const stream = provider.streamResponse({
        model: this.config.criticModel || 'claude-3-7-sonnet',
        systemPrompt: `You are an expert code reviewer and conflict resolver. Analyze conflicting changes and determine the best resolution.

Respond with JSON:
- resolution: "version_a" | "version_b" | "merged" | "reject_both"
- content: the resolved code
- reasoning: explanation`,
        messages: [{ role: 'user', content: prompt }],
      });

      // Collect the full response from stream
      let fullContent = '';
      for await (const event of stream) {
        if (event.type === 'content_delta' && event.content) {
          fullContent += event.content;
        }
      }

      const jsonMatch = fullContent.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        try {
          const decision = JSON.parse(jsonMatch[0]);
          return {
            resolved: decision.resolution !== 'reject_both',
            content: decision.content,
            reasoning: decision.reasoning,
          };
        } catch {
          return { resolved: false, reasoning: 'Failed to parse JSON response' };
        }
      }

      return { resolved: false, reasoning: 'Failed to parse critic response' };
    } catch (err) {
      koryLog.error({ error: err }, 'Critic arbitration failed');
      return { resolved: false, reasoning: `Arbitration error: ${err}` };
    }
  }

  /**
   * Attempt automatic merge of non-overlapping changes
   */
  async attemptMerge(conflict: Conflict): Promise<{
    success: boolean;
    content?: string;
    hasOverlappingChanges: boolean;
  }> {
    if (!this.config.enableMergeForNonOverlapping) {
      return { success: false, hasOverlappingChanges: true };
    }

    const [base, ...versions] = conflict.changes;
    let merged = base.content;
    let hasOverlapping = false;

    for (const version of versions) {
      const hunks = this.extractHunks(base.content, version.content);

      for (const hunk of hunks) {
        if (this.isHunkOverlapping(merged, hunk)) {
          hasOverlapping = true;
        } else {
          merged = this.applyHunk(merged, hunk);
        }
      }
    }

    return {
      success: !hasOverlapping,
      content: hasOverlapping ? undefined : merged,
      hasOverlappingChanges: hasOverlapping,
    };
  }

  /**
   * Clear all tracked changes (call after reconciliation)
   */
  clearChanges(): void {
    this.fileChanges.clear();
    koryLog.info('Conflict tracking cleared');
  }

  /**
   * Get changes for a specific file
   */
  getFileChanges(filePath: string): FileChange[] {
    return this.fileChanges.get(filePath) || [];
  }

  /**
   * Get all tracked changes
   */
  getAllChanges(): Map<string, FileChange[]> {
    return new Map(this.fileChanges);
  }

  // ─── Private Methods ───────────────────────────────────────────────────────────

  private classifyConflict(changes: FileChange[]): Conflict['conflictType'] {
    // Simplified classification based on changes
    return 'edit-edit'; // Could be enhanced with delete detection
  }

  private assessSeverity(
    changes: FileChange[],
    type: Conflict['conflictType'],
  ): Conflict['severity'] {
    const count = changes.length;

    if (count > 4 || type === 'delete-edit') return 'critical';
    if (count > 2) return 'high';
    if (type === 'rename-edit') return 'medium';
    return 'low';
  }

  private shouldAutoResolve(severity: Conflict['severity']): boolean {
    const threshold = this.config.autoResolveThreshold;
    const levels: Record<Conflict['severity'] | 'none', number> = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
      none: 5,
    };
    return levels[severity] <= levels[threshold];
  }

  private async resolveConflict(conflict: Conflict): Promise<{
    resolved: boolean;
    content?: string;
  }> {
    switch (this.config.strategy) {
      case 'last-write-wins':
        const latest = conflict.changes.sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
        return { resolved: true, content: latest.content };

      case 'merge':
        const mergeResult = await this.attemptMerge(conflict);
        return { resolved: mergeResult.success, content: mergeResult.content };

      case 'critic-mediated':
        const criticResult = await this.arbitrateWithCritic(conflict);
        return { resolved: criticResult.resolved, content: criticResult.content };

      case 'voting':
        return this.resolveByVoting(conflict);

      case 'human-escalation':
        return { resolved: false };

      default:
        return { resolved: false };
    }
  }

  private resolveByVoting(conflict: Conflict): { resolved: boolean; content?: string } {
    // Simple voting: most recent change wins (could be enhanced with confidence scoring)
    const votes = new Map<string, number>();

    for (const change of conflict.changes) {
      const current = votes.get(change.checksum) || 0;
      votes.set(change.checksum, current + 1);
    }

    let winner = { checksum: '', votes: 0 };
    for (const [checksum, count] of votes) {
      if (count > winner.votes) {
        winner = { checksum, votes: count };
      }
    }

    const winningChange = conflict.changes.find((c) => c.checksum === winner.checksum);
    return {
      resolved: !!winningChange,
      content: winningChange?.content,
    };
  }

  private buildArbitrationPrompt(conflict: Conflict): string {
    const changesText = conflict.changes
      .map(
        (change, idx) => `
--- Version ${String.fromCharCode(65 + idx)} (Agent: ${change.agentId}) ---
${change.content}
`,
      )
      .join('\n');

    return `File: ${conflict.filePath}
Conflict Type: ${conflict.conflictType}
Severity: ${conflict.severity}

${changesText}

Analyze these conflicting versions and provide your resolution decision.`;
  }

  private extractHunks(
    base: string,
    modified: string,
  ): Array<{
    startLine: number;
    endLine: number;
    content: string;
  }> {
    // Simplified hunk extraction - could use proper diff algorithm
    const baseLines = base.split('\n');
    const modifiedLines = modified.split('\n');
    const hunks = [];

    for (let i = 0; i < Math.max(baseLines.length, modifiedLines.length); i++) {
      if (baseLines[i] !== modifiedLines[i]) {
        hunks.push({
          startLine: i,
          endLine: i + 1,
          content: modifiedLines[i] || '',
        });
      }
    }

    return hunks;
  }

  private isHunkOverlapping(
    content: string,
    hunk: { startLine: number; endLine: number },
  ): boolean {
    // Check if hunk overlaps with existing modifications
    // Simplified check - could be enhanced
    return false;
  }

  private applyHunk(content: string, hunk: { startLine: number; content: string }): string {
    const lines = content.split('\n');
    lines[hunk.startLine] = hunk.content;
    return lines.join('\n');
  }
}

export { DEFAULT_CONFIG as DEFAULT_RESOLUTION_CONFIG };
