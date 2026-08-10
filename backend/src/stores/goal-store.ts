import { nanoid } from 'nanoid';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db, goals } from '../db';
import { serverLog } from '../logger';
import { redactSecretsInText } from '../security';
import type {
  Goal,
  GoalActivity,
  GoalChecklistItem,
  GoalEvidence,
  GoalExecutionConfig,
  GoalScope,
  GoalStatus,
} from '@koryphaios/shared';

export interface GoalEvidenceReview {
  producer: {
    kind: 'check' | 'artifact' | 'note';
    value: string;
    provider: string;
    model: string;
  };
  verifier: {
    passed: boolean;
    skipped?: boolean;
    feedback?: string;
    model?: string;
    provider?: string;
  };
}

const MAX_GOAL_ACTIVITY = 1_000;
const MAX_ITEM_EVIDENCE = 256;
const MAX_GOAL_ITEMS = 512;
const GOAL_STATUSES = new Set<GoalStatus>([
  'queued',
  'planning',
  'running',
  'paused',
  'blocked',
  'completed',
  'cancelled',
]);
const ITEM_STATUSES = new Set<GoalChecklistItem['status']>([
  'pending',
  'running',
  'completed',
  'blocked',
  'skipped',
]);
const GOAL_SCOPES = new Set<GoalScope>(['workspace', 'project', 'session']);
const ACTIVE_GOAL_STATUSES = ['queued', 'planning', 'running'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const finiteNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const finiteOptional = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const sanitizeGoalEvidence = (value: string, maxLength = 8_000): string => {
  const redacted = redactSecretsInText(value, maxLength).trim();
  if (!redacted) throw new Error('Completion evidence cannot be empty');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
};

export const hasIndependentGoalEvidence = (item: GoalChecklistItem): boolean => {
  const producers = new Map(
    item.evidence
      .filter((proof) => proof.source === 'producer')
      .map((proof) => [proof.id, proof] as const),
  );
  return item.evidence.some((proof) => {
    const producer = proof.producerEvidenceId ? producers.get(proof.producerEvidenceId) : undefined;
    return (
      proof.verified === true &&
      proof.source === 'verifier' &&
      proof.verificationStatus === 'verified' &&
      !!producer?.producerProvider &&
      !!producer.producerModel &&
      !!proof.verifierProvider &&
      !!proof.verifierModel &&
      !(
        producer.producerProvider === proof.verifierProvider &&
        producer.producerModel === proof.verifierModel
      )
    );
  });
};

const sanitizeEvidenceLabel = (
  value: string | undefined,
  maxLength: number,
): string | undefined => {
  if (value === undefined) return undefined;
  const sanitized = String(value)
    .trim()
    .replace(/[\0-\x1f\x7f]/g, ' ')
    .slice(0, maxLength);
  return sanitized || undefined;
};

const sanitizeActivity = (activity: GoalActivity): GoalActivity => {
  const type =
    String(activity.type ?? '')
      .trim()
      .replace(/[\0-\x1f\x7f]/g, ' ')
      .slice(0, 120) || 'activity';
  const maxLength = type === 'evidence_candidate' || type === 'blocker_candidate' ? 8_000 : 4_000;
  return {
    id: sanitizeEvidenceLabel(activity.id, 200) ?? nanoid(),
    type,
    message: redactSecretsInText(String(activity.message ?? ''), maxLength)
      .trim()
      .slice(0, maxLength),
    createdAt: finiteNumber(activity.createdAt, Date.now()),
    sessionId: sanitizeEvidenceLabel(activity.sessionId, 200),
  };
};

const sanitizeExecution = (execution: GoalExecutionConfig): GoalExecutionConfig => ({
  sessionId: sanitizeEvidenceLabel(execution.sessionId, 200) ?? '',
  provider: sanitizeEvidenceLabel(execution.provider, 120) ?? '',
  model: sanitizeEvidenceLabel(execution.model, 240) ?? '',
  attemptId: sanitizeEvidenceLabel(execution.attemptId, 200),
  attemptStartedAt: finiteOptional(execution.attemptStartedAt),
  reasoningLevel: sanitizeEvidenceLabel(execution.reasoningLevel, 120),
  instructions: execution.instructions
    ? redactSecretsInText(execution.instructions, 4_000).trim()
    : undefined,
  remotePlanApproved: execution.remotePlanApproved === true,
});

/**
 * Evidence written before independent verification existed was producer-submitted
 * even though its old boolean was named `verified`. Preserve it for history, but
 * never silently upgrade it into a verifier verdict.
 */
const normalizeEvidence = (value: unknown): GoalEvidence | undefined => {
  if (!isRecord(value)) return undefined;
  const id = sanitizeEvidenceLabel(typeof value.id === 'string' ? value.id : undefined, 200);
  if (!id) return undefined;
  const kind = value.kind;
  if (kind !== 'check' && kind !== 'artifact' && kind !== 'note') return undefined;
  const proof: GoalEvidence = {
    id,
    kind,
    value: redactSecretsInText(String(value.value ?? ''), 8_000),
    source:
      value.source === 'producer' || value.source === 'verifier' || value.source === 'legacy'
        ? value.source
        : undefined,
    verificationStatus:
      value.verificationStatus === 'submitted' ||
      value.verificationStatus === 'verified' ||
      value.verificationStatus === 'rejected' ||
      value.verificationStatus === 'unverified' ||
      value.verificationStatus === 'legacy-unverified'
        ? value.verificationStatus
        : undefined,
    producerEvidenceId: sanitizeEvidenceLabel(
      typeof value.producerEvidenceId === 'string' ? value.producerEvidenceId : undefined,
      200,
    ),
    producerModel: sanitizeEvidenceLabel(
      typeof value.producerModel === 'string' ? value.producerModel : undefined,
      160,
    ),
    producerProvider: sanitizeEvidenceLabel(
      typeof value.producerProvider === 'string' ? value.producerProvider : undefined,
      120,
    ),
    verifierModel: sanitizeEvidenceLabel(
      typeof value.verifierModel === 'string' ? value.verifierModel : undefined,
      160,
    ),
    verifierProvider: sanitizeEvidenceLabel(
      typeof value.verifierProvider === 'string' ? value.verifierProvider : undefined,
      120,
    ),
    verified: value.verified === true,
    createdAt: finiteNumber(value.createdAt),
  };
  if (!proof.source) {
    return {
      ...proof,
      source: 'legacy',
      verificationStatus: 'legacy-unverified',
      verified: false,
    };
  }
  if (proof.source === 'producer') {
    return {
      ...proof,
      verificationStatus: 'submitted',
      verified: false,
    };
  }
  if (proof.source === 'legacy') {
    return {
      ...proof,
      verificationStatus: 'legacy-unverified',
      verified: false,
    };
  }
  const verified = proof.verified === true && proof.verificationStatus === 'verified';
  return {
    ...proof,
    verificationStatus: verified
      ? 'verified'
      : proof.verificationStatus === 'rejected'
        ? 'rejected'
        : 'unverified',
    verifierModel: sanitizeEvidenceLabel(proof.verifierModel, 160),
    verifierProvider: sanitizeEvidenceLabel(proof.verifierProvider, 120),
    verified,
  };
};

interface NormalizedChecklist {
  items: GoalChecklistItem[];
  damaged: boolean;
}

const normalizeChecklistWithHealth = (value: unknown): NormalizedChecklist => {
  if (!Array.isArray(value)) return { items: [], damaged: true };
  let damaged = value.length === 0 || value.length > MAX_GOAL_ITEMS;
  const seen = new Set<string>();
  const items: GoalChecklistItem[] = [];
  for (const [index, candidate] of value.slice(0, MAX_GOAL_ITEMS).entries()) {
    if (!isRecord(candidate)) {
      damaged = true;
      continue;
    }
    const id = sanitizeEvidenceLabel(
      typeof candidate.id === 'string' ? candidate.id : undefined,
      200,
    );
    const title = String(candidate.title ?? '')
      .trim()
      .slice(0, 1_000);
    if (!id || !title || seen.has(id)) {
      damaged = true;
      continue;
    }
    seen.add(id);
    const rawDependencies = candidate.dependsOn;
    if (!Array.isArray(rawDependencies)) damaged = true;
    const dependsOn = Array.isArray(rawDependencies)
      ? [...new Set(rawDependencies.filter((entry): entry is string => typeof entry === 'string'))]
          .map((entry) => entry.trim().slice(0, 200))
          .filter(Boolean)
      : [];
    if (!ITEM_STATUSES.has(candidate.status as GoalChecklistItem['status'])) damaged = true;
    const evidenceValues = Array.isArray(candidate.evidence)
      ? candidate.evidence.slice(-MAX_ITEM_EVIDENCE)
      : [];
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length > MAX_ITEM_EVIDENCE) {
      damaged = true;
    }
    const evidence = evidenceValues
      .map(normalizeEvidence)
      .filter((proof): proof is GoalEvidence => proof !== undefined);
    if (evidence.length !== evidenceValues.length) damaged = true;
    items.push({
      id,
      title,
      status: ITEM_STATUSES.has(candidate.status as GoalChecklistItem['status'])
        ? (candidate.status as GoalChecklistItem['status'])
        : 'pending',
      order: finiteNumber(candidate.order, index),
      dependsOn,
      evidence,
      startedAt: candidate.startedAt === undefined ? undefined : finiteNumber(candidate.startedAt),
      completedAt:
        candidate.completedAt === undefined ? undefined : finiteNumber(candidate.completedAt),
    });
  }
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    if (item.dependsOn.some((dependency) => dependency === item.id || !ids.has(dependency))) {
      damaged = true;
    }
  }
  try {
    validateChecklist(items);
  } catch {
    damaged = true;
  }
  return { items, damaged };
};

const normalizeChecklist = (value: unknown): GoalChecklistItem[] =>
  normalizeChecklistWithHealth(value).items;

/**
 * Checklist planning is deliberately separate from runtime state transitions.
 * A caller may supply titles, ordering, and dependencies, but never completion
 * state or evidence. Only the guarded producer/verifier transaction below can
 * create verified evidence.
 */
const normalizePlanningChecklist = (value: unknown): GoalChecklistItem[] => {
  validateChecklist(value);
  const planningOnly = value.map((item) => ({
    ...item,
    status: 'pending' as const,
    evidence: [],
    startedAt: undefined,
    completedAt: undefined,
  }));
  validateChecklist(planningOnly);
  return normalizeChecklist(planningOnly);
};

const normalizeActivity = (value: unknown): GoalActivity[] =>
  Array.isArray(value)
    ? value
        .filter(
          (entry): entry is GoalActivity =>
            isRecord(entry) && typeof entry.id === 'string' && typeof entry.type === 'string',
        )
        .slice(-MAX_GOAL_ACTIVITY)
        .map(sanitizeActivity)
    : [];

const parseJson = (value: string | null | undefined): { value: unknown; valid: boolean } => {
  if (!value) return { value: undefined, valid: false };
  try {
    return { value: JSON.parse(value), valid: true };
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'goal JSON parse failed — using fallback',
    );
    return { value: undefined, valid: false };
  }
};
const active = (status: GoalStatus) => status === 'running';

/** Reject malformed checklist records and dependency graphs at the persistence boundary. */
function validateChecklist(checklist: unknown): asserts checklist is GoalChecklistItem[] {
  if (!Array.isArray(checklist) || checklist.length === 0) {
    throw new Error('Goals require at least one checklist item');
  }
  if (checklist.length > MAX_GOAL_ITEMS) {
    throw new Error(`Goals cannot exceed ${MAX_GOAL_ITEMS} checklist items`);
  }
  const ids = new Set<string>();
  for (const candidate of checklist) {
    if (!isRecord(candidate)) throw new Error('Checklist items must be objects');
    const item = candidate as unknown as GoalChecklistItem;
    if (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) {
      throw new Error('Checklist item IDs must be unique non-empty strings');
    }
    if (typeof item.title !== 'string' || !item.title.trim()) {
      throw new Error('Checklist items require a title');
    }
    if (!ITEM_STATUSES.has(item.status)) throw new Error('Checklist item status is invalid');
    if (!Number.isFinite(item.order)) throw new Error('Checklist item order must be finite');
    if (!Array.isArray(item.dependsOn) || !Array.isArray(item.evidence)) {
      throw new Error('Checklist dependencies and evidence must be arrays');
    }
    ids.add(item.id);
  }
  const checked = checklist as GoalChecklistItem[];
  for (const item of checked) {
    if (item.dependsOn.some((dependency) => dependency === item.id || !ids.has(dependency))) {
      throw new Error(`Checklist item "${item.title}" has an invalid dependency`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(checked.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Checklist dependencies cannot contain a cycle');
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of checked) visit(item.id);
}
function model(row: typeof goals.$inferSelect): Goal {
  const checklistJson = parseJson(row.checklist);
  const linkedSessionsJson = parseJson(row.linkedSessionIds);
  const activityJson = parseJson(row.activity);
  const executionJson = row.execution
    ? parseJson(row.execution)
    : { value: undefined, valid: true };
  const checklist = normalizeChecklistWithHealth(checklistJson.value);
  const linkedSessionIds = Array.isArray(linkedSessionsJson.value)
    ? [
        ...new Set(
          linkedSessionsJson.value
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim().slice(0, 200))
            .filter(Boolean),
        ),
      ]
    : [];
  const linkedSessionsDamaged =
    !linkedSessionsJson.valid ||
    !Array.isArray(linkedSessionsJson.value) ||
    linkedSessionIds.length !== linkedSessionsJson.value.length;
  const execution = isRecord(executionJson.value)
    ? sanitizeExecution({
        sessionId:
          typeof executionJson.value.sessionId === 'string' ? executionJson.value.sessionId : '',
        provider:
          typeof executionJson.value.provider === 'string' ? executionJson.value.provider : '',
        model: typeof executionJson.value.model === 'string' ? executionJson.value.model : '',
        attemptId:
          typeof executionJson.value.attemptId === 'string'
            ? executionJson.value.attemptId
            : undefined,
        attemptStartedAt: finiteOptional(executionJson.value.attemptStartedAt),
        reasoningLevel:
          typeof executionJson.value.reasoningLevel === 'string'
            ? executionJson.value.reasoningLevel
            : undefined,
        instructions:
          typeof executionJson.value.instructions === 'string'
            ? executionJson.value.instructions
            : undefined,
        remotePlanApproved: executionJson.value.remotePlanApproved === true,
      })
    : undefined;
  const scope = GOAL_SCOPES.has(row.scope as GoalScope)
    ? (row.scope as GoalScope)
    : ('workspace' as const);
  const storedStatus = GOAL_STATUSES.has(row.status as GoalStatus)
    ? (row.status as GoalStatus)
    : ('blocked' as const);
  const objective = String(row.objective ?? '')
    .trim()
    .slice(0, 2_000);
  const activity = normalizeActivity(activityJson.value);
  const executionDamaged =
    !executionJson.valid ||
    (executionJson.value !== undefined && !isRecord(executionJson.value)) ||
    (!!execution && (!execution.sessionId || !execution.provider || !execution.model));
  const damaged =
    !checklistJson.valid ||
    checklist.damaged ||
    linkedSessionsDamaged ||
    !activityJson.valid ||
    !GOAL_SCOPES.has(row.scope as GoalScope) ||
    !GOAL_STATUSES.has(row.status as GoalStatus) ||
    !objective ||
    (scope === 'project' && !row.projectPath) ||
    (scope === 'session' && !row.sessionId) ||
    executionDamaged;
  const status = damaged && storedStatus !== 'cancelled' ? 'blocked' : storedStatus;
  if (damaged) {
    activity.push({
      id: `persistence-recovery-${row.id}`,
      type: 'persistence_recovery_required',
      message:
        'Goal persistence is damaged or incompatible. Execution is blocked until the stored record is repaired.',
      createdAt: row.updatedAt.getTime(),
    });
  }
  return {
    id: row.id,
    objective: objective || 'Damaged goal record',
    scope,
    projectPath: row.projectPath ?? undefined,
    sessionId: row.sessionId ?? undefined,
    priority: row.priority,
    sortOrder: row.sortOrder,
    status,
    checklist: checklist.items,
    linkedSessionIds,
    activity: activity.slice(-MAX_GOAL_ACTIVITY),
    blocker: damaged
      ? 'Goal persistence is damaged or incompatible. Review and repair the stored goal before resuming.'
      : (row.blocker ?? undefined),
    execution,
    activeDurationMs: row.activeDurationMs,
    activeStartedAt: status === 'running' ? row.activeStartedAt?.getTime() : undefined,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}
export class GoalStore {
  async list(): Promise<Goal[]> {
    return (await db.select().from(goals).orderBy(desc(goals.priority), asc(goals.sortOrder))).map(
      model,
    );
  }
  async get(id: string) {
    const row = await db.query.goals.findFirst({ where: eq(goals.id, id) });
    return row ? model(row) : undefined;
  }
  async create(
    input: Pick<Goal, 'objective' | 'scope'> &
      Partial<Goal> & { planningDepth?: 'minimal' | 'adaptive' | 'structured' },
  ): Promise<Goal> {
    const objective = input.objective.trim();
    if (!objective) throw new Error('Goals require an objective');
    if (objective.length > 2_000) throw new Error('Goal objectives cannot exceed 2000 characters');
    if (input.status === 'completed') {
      throw new Error('New goals must pass independent verification before completion');
    }
    if (input.scope === 'project' && !input.projectPath)
      throw new Error('Project goals require projectPath');
    if (input.scope === 'session' && !input.sessionId)
      throw new Error('Session goals require sessionId');
    const now = new Date();
    const id = nanoid();
    const first = nanoid();
    const second = nanoid();
    const third = nanoid();
    const fourth = nanoid();
    const planningDepth = input.planningDepth ?? 'adaptive';
    const checklist = input.checklist?.length
      ? input.checklist
      : planningDepth === 'minimal'
        ? [
            {
              id: first,
              title: 'Perform the objective',
              status: 'pending' as const,
              order: 0,
              dependsOn: [],
              evidence: [],
            },
            {
              id: second,
              title: 'Verify the success criteria',
              status: 'pending' as const,
              order: 1,
              dependsOn: [first],
              evidence: [],
            },
          ]
        : planningDepth === 'structured'
          ? [
              {
                id: first,
                title: 'Discover the relevant workspace context',
                status: 'pending' as const,
                order: 0,
                dependsOn: [],
                evidence: [],
              },
              {
                id: second,
                title: 'Create and validate the execution plan',
                status: 'pending' as const,
                order: 1,
                dependsOn: [first],
                evidence: [],
              },
              {
                id: third,
                title: 'Implement or perform the objective',
                status: 'pending' as const,
                order: 2,
                dependsOn: [second],
                evidence: [],
              },
              {
                id: fourth,
                title: 'Verify the success criteria',
                status: 'pending' as const,
                order: 3,
                dependsOn: [third],
                evidence: [],
              },
            ]
          : [
              {
                id: first,
                title: 'Discover the relevant workspace context',
                status: 'pending' as const,
                order: 0,
                dependsOn: [],
                evidence: [],
              },
              {
                id: second,
                title: 'Implement or perform the objective',
                status: 'pending' as const,
                order: 1,
                dependsOn: [first],
                evidence: [],
              },
              {
                id: third,
                title: 'Verify the success criteria',
                status: 'pending' as const,
                order: 2,
                dependsOn: [second],
                evidence: [],
              },
            ];
    const normalizedChecklist = normalizePlanningChecklist(checklist);
    const [row] = await db
      .insert(goals)
      .values({
        id,
        objective,
        scope: input.scope,
        projectPath: input.projectPath ?? null,
        sessionId: input.sessionId ?? null,
        priority: input.priority ?? 0,
        sortOrder: input.sortOrder ?? now.getTime(),
        status: input.status ?? 'queued',
        checklist: JSON.stringify(normalizedChecklist),
        linkedSessionIds: JSON.stringify(
          input.linkedSessionIds ?? (input.sessionId ? [input.sessionId] : []),
        ),
        activity: JSON.stringify([
          { id: nanoid(), type: 'created', message: 'Goal created', createdAt: now.getTime() },
        ]),
        activeDurationMs: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return model(row);
  }
  async update(id: string, patch: Partial<Goal>): Promise<Goal | undefined> {
    const prior = await this.get(id);
    if (!prior) return undefined;
    if (Object.prototype.hasOwnProperty.call(patch, 'checklist')) {
      throw new Error(
        'Checklist lifecycle state cannot be changed through GoalStore.update(); use the guarded checklist methods',
      );
    }
    const now = Date.now();
    const status = patch.status ?? prior.status;
    if (status === 'completed' && prior.status !== 'completed') {
      throw new Error('Use GoalStore.finalize() to complete a goal');
    }
    const wasActive = active(prior.status);
    const isActive = active(status);
    const duration =
      prior.activeDurationMs +
      (wasActive && prior.activeStartedAt ? now - prior.activeStartedAt : 0);
    const clearsBlocker = Object.prototype.hasOwnProperty.call(patch, 'blocker');
    const activity = patch.activity
      ? [
          ...prior.activity,
          ...patch.activity.filter(
            (candidate) => !prior.activity.some((entry) => entry.id === candidate.id),
          ),
        ]
          .slice(-MAX_GOAL_ACTIVITY)
          .map(sanitizeActivity)
      : undefined;
    const objective = patch.objective?.trim();
    if (objective !== undefined && !objective) throw new Error('Goals require an objective');
    if (objective && objective.length > 2_000)
      throw new Error('Goal objectives cannot exceed 2000 characters');
    if (patch.linkedSessionIds) {
      if (
        !Array.isArray(patch.linkedSessionIds) ||
        patch.linkedSessionIds.some(
          (sessionId) => typeof sessionId !== 'string' || !sessionId.trim(),
        )
      ) {
        throw new Error('Linked session IDs must be an array of non-empty strings');
      }
    }
    const [row] = await db
      .update(goals)
      .set({
        objective,
        priority: patch.priority,
        sortOrder: patch.sortOrder,
        status,
        linkedSessionIds: patch.linkedSessionIds
          ? JSON.stringify(patch.linkedSessionIds)
          : undefined,
        activity: activity ? JSON.stringify(activity) : undefined,
        blocker: clearsBlocker
          ? patch.blocker
            ? redactSecretsInText(patch.blocker, 4_000).trim()
            : null
          : (prior.blocker ?? null),
        execution: patch.execution ? JSON.stringify(sanitizeExecution(patch.execution)) : undefined,
        activeDurationMs: duration,
        activeStartedAt: isActive ? new Date(now) : null,
        updatedAt: new Date(now),
      })
      .where(eq(goals.id, id))
      .returning();
    return row ? model(row) : undefined;
  }

  /**
   * Apply an asynchronous Goal-driver decision only if the exact execution
   * attempt that requested it is still active.
   *
   * Critic/verifier calls can take long enough for a human to pause or stop a
   * goal. A normal read-then-update would let that stale result resurrect the
   * goal as blocked/paused after cancellation, or mutate a newly resumed
   * attempt. The status and serialized execution record are both part of the
   * update predicate so the guard remains atomic at the persistence boundary.
   */
  async transitionActiveAttempt(
    id: string,
    expectedAttemptId: string,
    patch: Pick<Partial<Goal>, 'status' | 'blocker' | 'activity'>,
  ): Promise<Goal | undefined> {
    if (!expectedAttemptId.trim()) return undefined;
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(goals).where(eq(goals.id, id)).limit(1);
      if (!row?.execution) return undefined;
      const prior = model(row);
      if (
        !ACTIVE_GOAL_STATUSES.includes(prior.status as (typeof ACTIVE_GOAL_STATUSES)[number]) ||
        prior.execution?.attemptId !== expectedAttemptId
      ) {
        return undefined;
      }

      const now = Date.now();
      const status = patch.status ?? prior.status;
      if (status === 'completed') {
        throw new Error('Use GoalStore.finalize() to complete a goal');
      }
      const duration =
        prior.activeDurationMs +
        (prior.status === 'running' && prior.activeStartedAt ? now - prior.activeStartedAt : 0);
      const activity = patch.activity
        ? [
            ...prior.activity,
            ...patch.activity.filter(
              (candidate) => !prior.activity.some((entry) => entry.id === candidate.id),
            ),
          ]
            .slice(-MAX_GOAL_ACTIVITY)
            .map(sanitizeActivity)
        : undefined;
      const clearsBlocker = Object.prototype.hasOwnProperty.call(patch, 'blocker');
      const [updated] = await tx
        .update(goals)
        .set({
          status,
          activity: activity ? JSON.stringify(activity) : undefined,
          blocker: clearsBlocker
            ? patch.blocker
              ? redactSecretsInText(patch.blocker, 4_000).trim()
              : null
            : (prior.blocker ?? null),
          activeDurationMs: duration,
          activeStartedAt: status === 'running' ? new Date(now) : null,
          updatedAt: new Date(now),
        })
        .where(
          and(
            eq(goals.id, id),
            inArray(goals.status, [...ACTIVE_GOAL_STATUSES]),
            eq(goals.execution, row.execution),
          ),
        )
        .returning();
      return updated ? model(updated) : undefined;
    });
  }

  async addActivityForActiveAttempt(
    id: string,
    expectedAttemptId: string,
    type: string,
    message: string,
    sessionId?: string,
  ): Promise<Goal | undefined> {
    const event = sanitizeActivity({
      id: nanoid(),
      type,
      message,
      sessionId,
      createdAt: Date.now(),
    });
    return this.transitionActiveAttempt(id, expectedAttemptId, { activity: [event] });
  }
  async delete(id: string) {
    await db.delete(goals).where(eq(goals.id, id));
  }
  async addActivity(id: string, type: string, message: string, sessionId?: string) {
    const event = sanitizeActivity({
      id: nanoid(),
      type,
      message,
      sessionId,
      createdAt: Date.now(),
    });
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(goals).where(eq(goals.id, id)).limit(1);
      if (!row) return undefined;
      const goal = model(row);
      const [updated] = await tx
        .update(goals)
        .set({
          activity: JSON.stringify([...goal.activity, event].slice(-MAX_GOAL_ACTIVITY)),
          updatedAt: new Date(),
        })
        .where(eq(goals.id, id))
        .returning();
      return updated ? model(updated) : undefined;
    });
  }
  async setChecklist(id: string, checklist: GoalChecklistItem[]) {
    const planningOnly = normalizePlanningChecklist(checklist);
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(goals).where(eq(goals.id, id)).limit(1);
      if (!row) return undefined;
      const goal = model(row);
      if (goal.status !== 'queued' && goal.status !== 'planning') {
        throw new Error('Checklist planning is only allowed before Goal execution starts');
      }
      const [updated] = await tx
        .update(goals)
        .set({ checklist: JSON.stringify(planningOnly), updatedAt: new Date() })
        .where(and(eq(goals.id, id), inArray(goals.status, ['queued', 'planning'])))
        .returning();
      return updated ? model(updated) : undefined;
    });
  }

  /** Start exactly one ready item without exposing arbitrary checklist writes. */
  async startItem(id: string, itemId: string): Promise<Goal | undefined> {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(goals).where(eq(goals.id, id)).limit(1);
      if (!row) return undefined;
      const goal = model(row);
      if (!['queued', 'planning', 'running'].includes(goal.status)) {
        throw new Error(`Goal is ${goal.status}`);
      }
      const item = goal.checklist.find((entry) => entry.id === itemId);
      if (!item || item.status !== 'pending') {
        throw new Error('Checklist item is not ready to start');
      }
      if (goal.checklist.some((entry) => entry.status === 'running')) {
        throw new Error('Another checklist item is already running');
      }
      if (
        item.dependsOn.some(
          (dependency) =>
            goal.checklist.find((entry) => entry.id === dependency)?.status !== 'completed',
        )
      ) {
        throw new Error('Complete dependencies before starting this checklist item');
      }
      const now = Date.now();
      const checklist = goal.checklist.map((entry) =>
        entry.id === itemId
          ? { ...entry, status: 'running' as const, startedAt: now, completedAt: undefined }
          : entry,
      );
      const [updated] = await tx
        .update(goals)
        .set({
          status: 'running',
          checklist: JSON.stringify(checklist),
          blocker: null,
          activeStartedAt:
            goal.status === 'running' && goal.activeStartedAt
              ? new Date(goal.activeStartedAt)
              : new Date(now),
          updatedAt: new Date(now),
        })
        .where(and(eq(goals.id, id), eq(goals.status, row.status)))
        .returning();
      return updated ? model(updated) : undefined;
    });
  }
  async completeItem(
    id: string,
    itemId: string,
    review: GoalEvidenceReview,
    expectedAttemptId?: string,
  ): Promise<Goal | undefined> {
    const now = Date.now();
    const producerId = nanoid();
    const producerValue = sanitizeGoalEvidence(review.producer.value);
    const producerProvider = sanitizeEvidenceLabel(review.producer.provider, 120);
    const producerModel = sanitizeEvidenceLabel(review.producer.model, 160);
    if (!producerProvider || !producerModel) {
      throw new Error('Producer provider and model provenance are required');
    }
    const verifierProvider = sanitizeEvidenceLabel(review.verifier.provider, 120);
    const verifierModel = sanitizeEvidenceLabel(review.verifier.model, 160);
    const provenanceFailure = review.verifier.skipped
      ? 'Independent verification was skipped.'
      : !verifierProvider || !verifierModel
        ? 'Verifier provider and model provenance are unavailable.'
        : producerProvider === verifierProvider && producerModel === verifierModel
          ? 'Verifier identity matches the producer; independent verification is unavailable.'
          : undefined;
    const feedback = sanitizeGoalEvidence(
      provenanceFailure ??
        review.verifier.feedback ??
        (review.verifier.passed
          ? 'Independent verification passed.'
          : 'Independent verification rejected this evidence.'),
    );
    const verified = review.verifier.passed && provenanceFailure === undefined;

    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(goals).where(eq(goals.id, id)).limit(1);
      if (!row) return undefined;
      const goal = model(row);
      const item = goal.checklist.find((entry) => entry.id === itemId);
      if (!item) return undefined;
      if (expectedAttemptId && goal.execution?.attemptId !== expectedAttemptId) {
        return undefined;
      }
      if (goal.status !== 'running') {
        if (expectedAttemptId) return undefined;
        throw new Error('Goal must be running before attaching completion evidence');
      }
      if (item.status !== 'running') {
        if (expectedAttemptId) return undefined;
        throw new Error('Start the checklist item before attaching completion evidence');
      }
      if (
        item.dependsOn.some(
          (dependency) =>
            goal.checklist.find((entry) => entry.id === dependency)?.status !== 'completed',
        )
      ) {
        throw new Error('Complete dependencies before this checklist item');
      }

      const evidence = [
        ...item.evidence,
        {
          id: producerId,
          kind: review.producer.kind,
          value: producerValue,
          source: 'producer' as const,
          verificationStatus: 'submitted' as const,
          producerProvider,
          producerModel,
          verified: false,
          createdAt: now,
        },
        {
          id: nanoid(),
          kind: 'check' as const,
          value: feedback,
          source: 'verifier' as const,
          verificationStatus: verified
            ? ('verified' as const)
            : provenanceFailure
              ? ('unverified' as const)
              : ('rejected' as const),
          producerEvidenceId: producerId,
          verifierModel,
          verifierProvider,
          verified,
          createdAt: now,
        },
      ].slice(-MAX_ITEM_EVIDENCE);
      const checklist = goal.checklist.map((entry) =>
        entry.id === itemId
          ? {
              ...entry,
              status: verified ? ('completed' as const) : entry.status,
              completedAt: verified ? now : undefined,
              evidence,
            }
          : entry,
      );
      const activity = [
        ...goal.activity,
        {
          id: nanoid(),
          type: verified
            ? 'item_completed'
            : provenanceFailure
              ? 'evidence_unverified'
              : 'evidence_rejected',
          message: verified
            ? `Independently verified: ${item.title}`
            : provenanceFailure
              ? `Independent verification unavailable: ${item.title}`
              : `Independent verification rejected: ${item.title}`,
          createdAt: now,
        },
      ].slice(-MAX_GOAL_ACTIVITY);
      const [updated] = await tx
        .update(goals)
        .set({
          checklist: JSON.stringify(checklist),
          activity: JSON.stringify(activity.map(sanitizeActivity)),
          updatedAt: new Date(now),
        })
        .where(
          expectedAttemptId && row.execution
            ? and(eq(goals.id, id), eq(goals.status, 'running'), eq(goals.execution, row.execution))
            : eq(goals.id, id),
        )
        .returning();
      return updated ? model(updated) : undefined;
    });
  }
  async resetItem(
    id: string,
    itemId: string,
    reason: string,
    expectedAttemptId?: string,
  ): Promise<Goal | undefined> {
    return db.transaction(async (tx) => {
      const [selected] = await tx.select().from(goals).where(eq(goals.id, id)).limit(1);
      if (!selected) return undefined;
      const goal = model(selected);
      const item = goal.checklist.find((entry) => entry.id === itemId);
      if (!item) return undefined;
      if (expectedAttemptId && goal.execution?.attemptId !== expectedAttemptId) return undefined;
      if (!['queued', 'planning', 'running'].includes(goal.status)) {
        return expectedAttemptId ? undefined : goal;
      }
      const checklist = goal.checklist.map((entry) =>
        entry.id === itemId
          ? { ...entry, status: 'pending' as const, startedAt: undefined }
          : entry,
      );
      const now = Date.now();
      const duration =
        goal.activeDurationMs +
        (goal.status === 'running' && goal.activeStartedAt ? now - goal.activeStartedAt : 0);
      const activity = [
        ...goal.activity,
        sanitizeActivity({
          id: nanoid(),
          type: 'item_retry',
          message: reason,
          createdAt: now,
        }),
      ].slice(-MAX_GOAL_ACTIVITY);
      const [updated] = await tx
        .update(goals)
        .set({
          status: 'queued',
          checklist: JSON.stringify(normalizeChecklist(checklist)),
          blocker: null,
          activity: JSON.stringify(activity),
          activeDurationMs: duration,
          activeStartedAt: null,
          updatedAt: new Date(now),
        })
        .where(
          and(
            eq(goals.id, id),
            inArray(goals.status, ['queued', 'planning', 'running']),
            ...(expectedAttemptId && selected.execution
              ? [eq(goals.execution, selected.execution)]
              : []),
          ),
        )
        .returning();
      return updated ? model(updated) : expectedAttemptId ? undefined : goal;
    });
  }
  /** Reopen pre-split or otherwise unverified completed work before a resume. */
  async reopenUnverifiedItems(id: string): Promise<Goal | undefined> {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(goals).where(eq(goals.id, id)).limit(1);
      if (!row) return undefined;
      const goal = model(row);
      if (goal.status === 'completed' || goal.status === 'cancelled') return goal;
      const completed = new Set<string>();
      let changed = false;
      const checklist = [...goal.checklist]
        .sort((left, right) => left.order - right.order)
        .map((item) => {
          const dependenciesRemainComplete = item.dependsOn.every((dependency) =>
            completed.has(dependency),
          );
          if (
            item.status === 'completed' &&
            hasIndependentGoalEvidence(item) &&
            dependenciesRemainComplete
          ) {
            completed.add(item.id);
            return item;
          }
          if (item.status === 'completed') {
            changed = true;
            return {
              ...item,
              status: 'pending' as const,
              completedAt: undefined,
              startedAt: undefined,
            };
          }
          return item;
        })
        .sort((left, right) => left.order - right.order);
      if (!changed) return goal;
      const now = Date.now();
      const duration =
        goal.activeDurationMs +
        (goal.status === 'running' && goal.activeStartedAt ? now - goal.activeStartedAt : 0);
      const activity = [
        ...goal.activity,
        sanitizeActivity({
          id: nanoid(),
          type: 'legacy_evidence_reopened',
          message:
            'Previously completed producer-only evidence was reopened for independent verification.',
          createdAt: now,
        }),
      ].slice(-MAX_GOAL_ACTIVITY);
      const [updated] = await tx
        .update(goals)
        .set({
          status: 'queued',
          blocker: null,
          checklist: JSON.stringify(checklist),
          activity: JSON.stringify(activity),
          activeDurationMs: duration,
          activeStartedAt: null,
          updatedAt: new Date(now),
        })
        .where(and(eq(goals.id, id), eq(goals.status, row.status)))
        .returning();
      return updated ? model(updated) : goal;
    });
  }
  async finalize(id: string): Promise<Goal | undefined> {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(goals).where(eq(goals.id, id)).limit(1);
      if (!row) return undefined;
      const goal = model(row);
      if (goal.status === 'completed') return goal;
      if (goal.status === 'cancelled') {
        throw new Error('Cancelled goals cannot be finalized');
      }
      if (goal.checklist.length === 0) {
        throw new Error('Goal cannot complete: checklist is empty or unreadable');
      }
      const incomplete = goal.checklist.find((item) => {
        if (item.status !== 'completed') return true;
        return !hasIndependentGoalEvidence(item);
      });
      if (incomplete) {
        throw new Error(
          `Goal cannot complete: "${incomplete.title}" lacks verified completion evidence`,
        );
      }
      const now = Date.now();
      const duration =
        goal.activeDurationMs +
        (goal.status === 'running' && goal.activeStartedAt ? now - goal.activeStartedAt : 0);
      const activity = [
        ...goal.activity,
        sanitizeActivity({
          id: nanoid(),
          type: 'completed',
          message: 'All checklist evidence and final success criteria verified.',
          createdAt: now,
        }),
      ].slice(-MAX_GOAL_ACTIVITY);
      const [updated] = await tx
        .update(goals)
        .set({
          status: 'completed',
          blocker: null,
          activity: JSON.stringify(activity),
          activeDurationMs: duration,
          activeStartedAt: null,
          updatedAt: new Date(now),
        })
        .where(eq(goals.id, id))
        .returning();
      return updated ? model(updated) : undefined;
    });
  }
}
