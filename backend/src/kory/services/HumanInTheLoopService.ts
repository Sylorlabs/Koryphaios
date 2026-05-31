/**
 * HumanInTheLoopService - Approval Gates for High-Risk Operations
 *
 * Provides configurable human approval checkpoints for operations that require
 * oversight: file deletions, destructive changes, security-sensitive operations,
 * and high-cost actions.
 *
 * Features:
 * - Risk-based approval requirements
 * - Configurable approval policies per operation type
 * - Timeout handling with automatic rejection
 * - Audit trail of all approval decisions
 * - Batch approval for multiple operations
 */

import { koryLog } from '../../logger';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type OperationType =
  | 'file-delete'
  | 'file-overwrite'
  | 'bash-execution'
  | 'git-push'
  | 'dependency-install'
  | 'api-key-modify'
  | 'config-change'
  | 'bulk-operation'
  | 'cost-threshold'
  | 'security-sensitive';

export interface Operation {
  id: string;
  type: OperationType;
  description: string;
  details: Record<string, unknown>;
  riskLevel: RiskLevel;
  estimatedCost?: number;
  sessionId: string;
  agentId: string;
  requestedAt: number;
}

export interface ApprovalRequest {
  operation: Operation;
  timeoutMs: number;
  expiresAt: number;
}

export interface ApprovalDecision {
  operationId: string;
  approved: boolean;
  reason?: string;
  decidedBy: 'human' | 'system' | 'auto';
  decidedAt: number;
  timeoutOccurred?: boolean;
}

export interface ApprovalPolicy {
  operationType: OperationType;
  requireApproval: boolean;
  minRiskLevel: RiskLevel;
  costThreshold?: number;
  timeoutMs: number;
  autoRejectOnTimeout: boolean;
  allowBatchApproval: boolean;
}

export interface HITLConfig {
  defaultTimeoutMs: number;
  policies: ApprovalPolicy[];
  emergencyContacts?: string[];
}

const DEFAULT_POLICIES: ApprovalPolicy[] = [
  {
    operationType: 'file-delete',
    requireApproval: true,
    minRiskLevel: 'medium',
    timeoutMs: 300000, // 5 minutes
    autoRejectOnTimeout: true,
    allowBatchApproval: true,
  },
  {
    operationType: 'bash-execution',
    requireApproval: true,
    minRiskLevel: 'high',
    timeoutMs: 600000, // 10 minutes
    autoRejectOnTimeout: true,
    allowBatchApproval: false,
  },
  {
    operationType: 'git-push',
    requireApproval: true,
    minRiskLevel: 'medium',
    timeoutMs: 300000,
    autoRejectOnTimeout: true,
    allowBatchApproval: true,
  },
  {
    operationType: 'api-key-modify',
    requireApproval: true,
    minRiskLevel: 'critical',
    timeoutMs: 600000,
    autoRejectOnTimeout: true,
    allowBatchApproval: false,
  },
  {
    operationType: 'cost-threshold',
    requireApproval: true,
    minRiskLevel: 'medium',
    costThreshold: 1.0, // $1.00
    timeoutMs: 300000,
    autoRejectOnTimeout: true,
    allowBatchApproval: true,
  },
  {
    operationType: 'security-sensitive',
    requireApproval: true,
    minRiskLevel: 'high',
    timeoutMs: 600000,
    autoRejectOnTimeout: true,
    allowBatchApproval: false,
  },
];

const DEFAULT_CONFIG: HITLConfig = {
  defaultTimeoutMs: 300000,
  policies: DEFAULT_POLICIES,
};

export class HumanInTheLoopService {
  private pendingApprovals = new Map<string, ApprovalRequest>();
  private decisions = new Map<string, ApprovalDecision>();
  private config: HITLConfig;
  private cleanupInterval?: Timer;

  constructor(config?: Partial<HITLConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupInterval();
  }

  /**
   * Check if an operation requires human approval
   */
  requiresApproval(operation: Omit<Operation, 'id' | 'requestedAt'>): boolean {
    const policy = this.getPolicy(operation.type);
    if (!policy || !policy.requireApproval) return false;

    // Check risk level
    const riskLevels = { low: 1, medium: 2, high: 3, critical: 4 };
    if (riskLevels[operation.riskLevel] >= riskLevels[policy.minRiskLevel]) {
      return true;
    }

    // Check cost threshold
    if (
      policy.costThreshold &&
      operation.estimatedCost &&
      operation.estimatedCost >= policy.costThreshold
    ) {
      return true;
    }

    return false;
  }

  /**
   * Request approval for an operation
   */
  async requestApproval(
    operation: Omit<Operation, 'id' | 'requestedAt'>,
  ): Promise<ApprovalDecision> {
    const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const policy = this.getPolicy(operation.type)!;

    const fullOperation: Operation = {
      ...operation,
      id,
      requestedAt: Date.now(),
    };

    const request: ApprovalRequest = {
      operation: fullOperation,
      timeoutMs: policy.timeoutMs,
      expiresAt: Date.now() + policy.timeoutMs,
    };

    this.pendingApprovals.set(id, request);

    // Emit event to notify frontend (via WebSocket broker if available)
    this.emitApprovalRequest(request);

    koryLog.info(
      {
        operationId: id,
        type: operation.type,
        riskLevel: operation.riskLevel,
        timeoutMs: policy.timeoutMs,
      },
      'Approval requested',
    );

    // Wait for decision or timeout
    return this.waitForDecision(id, policy);
  }

  /**
   * Submit a human decision for an approval request
   */
  submitDecision(operationId: string, approved: boolean, reason?: string): boolean {
    const request = this.pendingApprovals.get(operationId);
    if (!request) {
      koryLog.warn({ operationId }, 'Approval request not found or expired');
      return false;
    }

    const decision: ApprovalDecision = {
      operationId,
      approved,
      reason,
      decidedBy: 'human',
      decidedAt: Date.now(),
    };

    this.decisions.set(operationId, decision);
    this.pendingApprovals.delete(operationId);

    this.emitDecisionUpdate(decision);

    koryLog.info(
      {
        operationId,
        approved,
        decidedBy: 'human',
      },
      'Approval decision submitted',
    );

    return true;
  }

  /**
   * Batch request approval for multiple operations
   */
  async requestBatchApproval(
    operations: Omit<Operation, 'id' | 'requestedAt'>[],
    batchDescription: string,
  ): Promise<Map<string, ApprovalDecision>> {
    const batchId = `batch-${Date.now()}`;
    const results = new Map<string, ApprovalDecision>();

    // Check if all operations allow batch approval
    const canBatch = operations.every((op) => {
      const policy = this.getPolicy(op.type);
      return policy?.allowBatchApproval ?? false;
    });

    if (!canBatch) {
      // Request individually
      for (const op of operations) {
        const decision = await this.requestApproval(op);
        results.set(op.type, decision);
        if (!decision.approved) break; // Stop on first rejection
      }
      return results;
    }

    // Create batch approval request
    const batchOperation: Operation = {
      id: batchId,
      type: 'bulk-operation',
      description: batchDescription,
      details: { operations: operations.map((o) => o.description) },
      riskLevel: this.getBatchRiskLevel(operations),
      sessionId: operations[0]?.sessionId || '',
      agentId: operations[0]?.agentId || '',
      requestedAt: Date.now(),
    };

    const batchDecision = await this.requestApproval(batchOperation);

    // Apply batch decision to all operations
    for (const op of operations) {
      const individualDecision: ApprovalDecision = {
        operationId: op.type,
        approved: batchDecision.approved,
        reason: batchDecision.reason,
        decidedBy: batchDecision.decidedBy,
        decidedAt: batchDecision.decidedAt,
      };
      results.set(op.type, individualDecision);
    }

    return results;
  }

  /**
   * Get pending approval requests
   */
  getPendingApprovals(sessionId?: string): ApprovalRequest[] {
    const requests = Array.from(this.pendingApprovals.values());
    if (sessionId) {
      return requests.filter((r) => r.operation.sessionId === sessionId);
    }
    return requests;
  }

  /**
   * Get approval history
   */
  getApprovalHistory(sessionId?: string, limit = 100): ApprovalDecision[] {
    const decisions = Array.from(this.decisions.values())
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .slice(0, limit);

    if (sessionId) {
      // Note: We'd need to store sessionId in decisions for this to work
      // This is a simplified implementation
      return decisions;
    }
    return decisions;
  }

  /**
   * Cancel a pending approval request
   */
  cancelRequest(operationId: string): boolean {
    const request = this.pendingApprovals.get(operationId);
    if (!request) return false;

    this.pendingApprovals.delete(operationId);

    const decision: ApprovalDecision = {
      operationId,
      approved: false,
      reason: 'Cancelled by system',
      decidedBy: 'system',
      decidedAt: Date.now(),
    };

    this.decisions.set(operationId, decision);
    this.emitDecisionUpdate(decision);

    koryLog.info({ operationId }, 'Approval request cancelled');
    return true;
  }

  /**
   * Update approval policy for an operation type
   */
  updatePolicy(policy: ApprovalPolicy): void {
    const existingIndex = this.config.policies.findIndex(
      (p) => p.operationType === policy.operationType,
    );

    if (existingIndex >= 0) {
      this.config.policies[existingIndex] = policy;
    } else {
      this.config.policies.push(policy);
    }

    koryLog.info({ operationType: policy.operationType }, 'Approval policy updated');
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.pendingApprovals.clear();
    this.decisions.clear();
  }

  // ─── Private Methods ───────────────────────────────────────────────────────────

  private getPolicy(type: OperationType): ApprovalPolicy | undefined {
    return this.config.policies.find((p) => p.operationType === type);
  }

  private async waitForDecision(
    operationId: string,
    policy: ApprovalPolicy,
  ): Promise<ApprovalDecision> {
    const startTime = Date.now();
    const checkInterval = 100; // ms

    while (Date.now() - startTime < policy.timeoutMs) {
      // Check if decision was made
      const decision = this.decisions.get(operationId);
      if (decision) {
        return decision;
      }

      // Check if still pending
      if (!this.pendingApprovals.has(operationId)) {
        return {
          operationId,
          approved: false,
          reason: 'Request was cancelled',
          decidedBy: 'system',
          decidedAt: Date.now(),
        };
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    // Timeout occurred
    this.pendingApprovals.delete(operationId);

    const timeoutDecision: ApprovalDecision = {
      operationId,
      approved: !policy.autoRejectOnTimeout, // Approve if not auto-reject
      reason: `Timeout after ${policy.timeoutMs}ms`,
      decidedBy: 'system',
      decidedAt: Date.now(),
      timeoutOccurred: true,
    };

    this.decisions.set(operationId, timeoutDecision);

    koryLog.warn({ operationId }, 'Approval request timed out');

    return timeoutDecision;
  }

  private getBatchRiskLevel(operations: Array<{ riskLevel: RiskLevel }>): RiskLevel {
    const levels = { low: 1, medium: 2, high: 3, critical: 4 };
    let maxLevel = 1;

    for (const op of operations) {
      maxLevel = Math.max(maxLevel, levels[op.riskLevel]);
    }

    const levelNames: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    return levelNames[maxLevel - 1] || 'medium';
  }

  private emitApprovalRequest(request: ApprovalRequest): void {
    // This would integrate with WebSocket broker to notify frontend
    // For now, just log
    koryLog.debug(
      {
        operationId: request.operation.id,
        type: request.operation.type,
        sessionId: request.operation.sessionId,
      },
      'Emitting approval request event',
    );

    // TODO: Integrate with wsBroker when types are properly aligned
    // wsBroker.publish(request.operation.sessionId, message);
  }

  private emitDecisionUpdate(decision: ApprovalDecision): void {
    // This would integrate with WebSocket broker to notify frontend
    koryLog.debug(
      {
        operationId: decision.operationId,
        approved: decision.approved,
      },
      'Emitting approval decision event',
    );

    // TODO: Integrate with wsBroker when types are properly aligned
    // wsBroker.publish("broadcast", message);
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, request] of this.pendingApprovals) {
        if (request.expiresAt < now) {
          this.pendingApprovals.delete(id);

          const policy = this.getPolicy(request.operation.type);
          const decision: ApprovalDecision = {
            operationId: id,
            approved: !(policy?.autoRejectOnTimeout ?? true),
            reason: 'Expired - cleanup',
            decidedBy: 'system',
            decidedAt: now,
            timeoutOccurred: true,
          };

          this.decisions.set(id, decision);
          koryLog.info({ operationId: id }, 'Expired approval request cleaned up');
        }
      }
    }, 60000); // Check every minute
  }
}

export { DEFAULT_CONFIG as DEFAULT_HITL_CONFIG, DEFAULT_POLICIES };
