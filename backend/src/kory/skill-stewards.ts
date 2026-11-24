import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { listSkills, type SkillRevision } from './skills';

export const SKILL_STEWARD_DISPLAY_PREFIX = 'ChatGPT web — ';
export const SKILL_STEWARD_PROVIDER = 'chatgpt-web' as const;
export const DEFAULT_SKILL_STEWARD_MODEL = 'chatgpt-web/pro';
export const DEFAULT_SKILL_STEWARD_LEASE_MS = 15 * 60_000;

const REGISTRY_SCHEMA_VERSION = 1 as const;
const REGISTRY_LOCK_STALE_MS = 5 * 60_000;
const MAX_SKILL_STEWARD_LEASE_MS = 4 * 60 * 60_000;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CHATGPT_WEB_MODEL_PATTERN = /^chatgpt-web\/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type SkillStewardStatus = 'active' | 'paused' | 'orphaned';
export type SkillStewardOutcome = 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface SkillStewardObservedRevision {
  source: SkillRevision['source'];
  state: SkillRevision['state'];
  hash: string;
}

/**
 * Persistent logical ownership for one skill. The record is durable, while an
 * actual worker exists only while a lease is active.
 */
export interface SkillStewardRecord {
  skill: string;
  agentId: string;
  displayLabel: string;
  provider: typeof SKILL_STEWARD_PROVIDER;
  model: string;
  status: SkillStewardStatus;
  observedRevisions: SkillStewardObservedRevision[];
  assignedAt: string;
  updatedAt: string;
  lastLeaseAt?: string;
  lastCompletedAt?: string;
  lastOutcome?: SkillStewardOutcome;
  lastEvidence?: string[];
}

/** A crash-safe, self-expiring claim to instantiate a steward worker. */
export interface SkillStewardLease {
  id: string;
  skill: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface SkillStewardRegistrySnapshot {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  stewards: SkillStewardRecord[];
  leases: SkillStewardLease[];
}

export interface SkillStewardRuntimeCandidate {
  provider: string;
  model: string;
  available?: boolean;
}

export type SkillStewardLaunchDecision =
  | {
      mode: 'delegated';
      displayLabel: string;
      provider: typeof SKILL_STEWARD_PROVIDER;
      model: string;
    }
  | {
      mode: 'self';
      displayLabel: string;
      reason: string;
    };

export class SkillStewardRegistryConflictError extends Error {
  constructor() {
    super('Skill Steward registry is being updated by another process; retry with fresh state');
    this.name = 'SkillStewardRegistryConflictError';
  }
}

export class SkillStewardLeaseConflictError extends Error {
  constructor(skill: string) {
    super(`Skill ${skill} already has an active steward lease`);
    this.name = 'SkillStewardLeaseConflictError';
  }
}

export function getSkillStewardRegistryPath(projectRoot: string): string {
  return join(resolve(projectRoot), '.koryphaios', 'skills', 'stewards.json');
}

export function buildSkillStewardDisplayLabel(skill: string): string {
  assertSkillName(skill);
  return `${SKILL_STEWARD_DISPLAY_PREFIX}${skill}`;
}

export function isChatGptWebSkillStewardIdentity(provider: string, model: string): boolean {
  return (
    provider === SKILL_STEWARD_PROVIDER &&
    CHATGPT_WEB_MODEL_PATTERN.test(model) &&
    !/gpt[-_.]?5[.-]?6|(?:^|[/._-])sol(?:$|[/._-])/i.test(model)
  );
}

/**
 * Decide whether a blind review's recorded provenance is eligible for promotion
 * credit, without privileging any provider, model or vendor.
 *
 * The only identity a blind review has to prove is independence: a named reviewer
 * agent, an assignment that was blind to the skill variant and to the expected
 * outcome, and some evidence that the assignment existed. Which model produced
 * the judgement is recorded metadata, so a new reviewer can be added without a
 * gate change and an ineligible one cannot be smuggled in by self-declaring a
 * favoured name.
 *
 * When the record carries a display label, it must still name this skill, so a
 * label copied from another skill is a provenance defect rather than a credit.
 * The label is never required to match a vendor prefix, and no label is ever
 * rewritten to one.
 */
export function isEligibleBlindReviewerProvenance(
  skill: string,
  provenance:
    | {
        agentId?: string;
        displayLabel?: string;
        blindTo?: readonly string[];
        evidence?: readonly string[];
      }
    | undefined,
  steward?: { agentId?: string },
): boolean {
  if (!provenance?.agentId) return false;
  if (steward?.agentId && provenance.agentId === steward.agentId) return false;
  if (!provenance.blindTo?.includes('skill-variant')) return false;
  if (!provenance.evidence?.length) return false;
  const label = provenance.displayLabel?.trim();
  if (label && !label.includes(skill)) return false;
  return true;
}

export function assertChatGptWebSkillStewardIdentity(provider: string, model: string): void {
  if (!isChatGptWebSkillStewardIdentity(provider, model)) {
    throw new Error(
      'Skill stewards require a ChatGPT Web model identity; GPT-5.6 Sol and non-ChatGPT-Web providers are not valid fallbacks',
    );
  }
}

/**
 * Select an available ChatGPT Web runtime. If none exists, the caller keeps
 * the work in the current agent rather than silently substituting another
 * model family.
 */
export function resolveSkillStewardLaunch(
  steward: SkillStewardRecord,
  candidates: SkillStewardRuntimeCandidate[],
): SkillStewardLaunchDecision {
  if (steward.status !== 'active') {
    return {
      mode: 'self',
      displayLabel: steward.displayLabel,
      reason: `Skill steward is ${steward.status}`,
    };
  }
  const eligible = candidates.filter(
    (candidate) =>
      candidate.available !== false &&
      isChatGptWebSkillStewardIdentity(candidate.provider, candidate.model),
  );
  const exact = eligible.find(
    (candidate) => candidate.provider === steward.provider && candidate.model === steward.model,
  );
  const preferences = [
    steward.model,
    DEFAULT_SKILL_STEWARD_MODEL,
    'chatgpt-web/extra-high',
    'chatgpt-web/high',
    'chatgpt-web/medium',
    'chatgpt-web/instant',
  ];
  const selected =
    exact ??
    eligible
      .map((candidate, index) => ({
        candidate,
        index,
        preference: preferences.indexOf(candidate.model),
      }))
      .sort(
        (left, right) =>
          (left.preference < 0 ? Number.MAX_SAFE_INTEGER : left.preference) -
            (right.preference < 0 ? Number.MAX_SAFE_INTEGER : right.preference) ||
          left.index - right.index,
      )[0]?.candidate;
  if (!selected) {
    return {
      mode: 'self',
      displayLabel: steward.displayLabel,
      reason:
        'No ChatGPT Web runtime is available; keep this stewardship task in the current agent',
    };
  }
  return {
    mode: 'delegated',
    displayLabel: steward.displayLabel,
    provider: SKILL_STEWARD_PROVIDER,
    model: selected.model,
  };
}

export function loadSkillStewardRegistry(projectRoot: string): SkillStewardRegistrySnapshot {
  return readRegistry(getSkillStewardRegistryPath(projectRoot));
}

export function listSkillStewards(projectRoot: string): SkillStewardRecord[] {
  return loadSkillStewardRegistry(projectRoot).stewards;
}

export function getSkillSteward(
  projectRoot: string,
  skill: string,
): SkillStewardRecord | undefined {
  assertSkillName(skill);
  return listSkillStewards(projectRoot).find((steward) => steward.skill === skill);
}

/** Ensure every currently installed logical skill has exactly one steward. */
export function syncSkillStewardRegistry(
  projectRoot: string,
  options: { now?: Date | string; defaultModel?: string } = {},
): SkillStewardRegistrySnapshot {
  const now = toIso(options.now);
  const defaultModel = options.defaultModel ?? DEFAULT_SKILL_STEWARD_MODEL;
  assertChatGptWebSkillStewardIdentity(SKILL_STEWARD_PROVIDER, defaultModel);
  const observed = groupObservedRevisions(listSkills(projectRoot));
  return updateRegistry(projectRoot, now, (draft) => {
    const bySkill = new Map(draft.stewards.map((steward) => [steward.skill, steward]));
    for (const [skill, revisions] of observed) {
      const current = bySkill.get(skill);
      if (!current) {
        const created = createStewardRecord(skill, revisions, defaultModel, now);
        draft.stewards.push(created);
        bySkill.set(skill, created);
        continue;
      }
      const status = current.status === 'orphaned' ? 'active' : current.status;
      if (
        status !== current.status ||
        !sameObservedRevisions(current.observedRevisions, revisions)
      ) {
        current.status = status;
        current.observedRevisions = revisions;
        current.updatedAt = now;
      }
    }
    for (const steward of draft.stewards) {
      if (!observed.has(steward.skill) && steward.status !== 'orphaned') {
        steward.status = 'orphaned';
        steward.observedRevisions = [];
        steward.updatedAt = now;
      }
    }
    draft.stewards.sort((left, right) => left.skill.localeCompare(right.skill));
  }).snapshot;
}

export function ensureSkillSteward(
  projectRoot: string,
  skill: string,
  options: { now?: Date | string; model?: string } = {},
): SkillStewardRecord {
  assertSkillName(skill);
  const now = toIso(options.now);
  const model = options.model ?? DEFAULT_SKILL_STEWARD_MODEL;
  assertChatGptWebSkillStewardIdentity(SKILL_STEWARD_PROVIDER, model);
  const observed = groupObservedRevisions(listSkills(projectRoot)).get(skill);
  if (!observed) throw new Error(`Cannot assign a steward to unknown skill ${skill}`);
  const result = updateRegistry(projectRoot, now, (draft) => {
    const current = draft.stewards.find((steward) => steward.skill === skill);
    if (!current) {
      const created = createStewardRecord(skill, observed, model, now);
      draft.stewards.push(created);
      return created;
    }
    const status = current.status === 'orphaned' ? 'active' : current.status;
    if (
      current.model !== model ||
      current.status !== status ||
      !sameObservedRevisions(current.observedRevisions, observed)
    ) {
      current.model = model;
      current.status = status;
      current.observedRevisions = observed;
      current.updatedAt = now;
    }
    return current;
  });
  return result.snapshot.stewards.find((steward) => steward.skill === skill)!;
}

export function configureSkillSteward(
  projectRoot: string,
  skill: string,
  input: { model?: string; status?: Exclude<SkillStewardStatus, 'orphaned'>; now?: Date | string },
): SkillStewardRecord {
  const current = ensureSkillSteward(projectRoot, skill, {
    model: input.model ?? getSkillSteward(projectRoot, skill)?.model,
    now: input.now,
  });
  const now = toIso(input.now);
  const result = updateRegistry(projectRoot, now, (draft) => {
    const steward = draft.stewards.find((item) => item.skill === skill);
    if (!steward) throw new Error(`Skill steward ${skill} disappeared during update`);
    const model = input.model ?? steward.model;
    assertChatGptWebSkillStewardIdentity(SKILL_STEWARD_PROVIDER, model);
    const status = input.status ?? steward.status;
    if (model !== steward.model || status !== steward.status) {
      steward.model = model;
      steward.status = status;
      steward.updatedAt = now;
    }
  });
  return result.snapshot.stewards.find((steward) => steward.skill === current.skill)!;
}

export function acquireSkillStewardLease(
  projectRoot: string,
  skill: string,
  ownerId: string,
  options: { now?: Date | string; leaseMs?: number; model?: string } = {},
): SkillStewardLease {
  const now = toIso(options.now);
  const owner = cleanStoredString(ownerId, 'ownerId', 200);
  const leaseMs = validateLeaseDuration(options.leaseMs ?? DEFAULT_SKILL_STEWARD_LEASE_MS);
  ensureSkillSteward(projectRoot, skill, { now, model: options.model });
  const result = updateRegistry(projectRoot, now, (draft) => {
    const steward = draft.stewards.find((item) => item.skill === skill);
    if (!steward || steward.status !== 'active') {
      throw new Error(`Skill steward ${skill} is not active`);
    }
    if (draft.leases.some((lease) => lease.skill === skill)) {
      throw new SkillStewardLeaseConflictError(skill);
    }
    const lease: SkillStewardLease = {
      id: randomUUID(),
      skill,
      ownerId: owner,
      acquiredAt: now,
      expiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
    };
    draft.leases.push(lease);
    steward.lastLeaseAt = now;
    steward.updatedAt = now;
    return lease;
  });
  return result.value!;
}

export function renewSkillStewardLease(
  projectRoot: string,
  leaseId: string,
  options: { now?: Date | string; leaseMs?: number } = {},
): SkillStewardLease {
  const now = toIso(options.now);
  const leaseMs = validateLeaseDuration(options.leaseMs ?? DEFAULT_SKILL_STEWARD_LEASE_MS);
  const result = updateRegistry(projectRoot, now, (draft) => {
    const lease = draft.leases.find((item) => item.id === leaseId);
    if (!lease) throw new Error('Skill steward lease not found or expired');
    lease.expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    return lease;
  });
  return result.value!;
}

export function releaseSkillStewardLease(
  projectRoot: string,
  leaseId: string,
  outcome: Exclude<SkillStewardOutcome, 'expired'>,
  options: { now?: Date | string; evidence?: string[] } = {},
): SkillStewardRecord {
  const now = toIso(options.now);
  const evidence = cleanEvidence(options.evidence ?? []);
  const result = updateRegistry(projectRoot, now, (draft) => {
    const index = draft.leases.findIndex((lease) => lease.id === leaseId);
    if (index < 0) throw new Error('Skill steward lease not found or expired');
    const [lease] = draft.leases.splice(index, 1);
    const steward = draft.stewards.find((item) => item.skill === lease.skill);
    if (!steward) throw new Error(`Skill steward ${lease.skill} is missing`);
    steward.lastCompletedAt = now;
    steward.lastOutcome = outcome;
    steward.lastEvidence = evidence;
    steward.updatedAt = now;
    return steward;
  });
  return result.snapshot.stewards.find((steward) => steward.skill === result.value!.skill)!;
}

export function reconcileExpiredSkillStewardLeases(
  projectRoot: string,
  now?: Date | string,
): SkillStewardRegistrySnapshot {
  return updateRegistry(projectRoot, toIso(now), () => undefined).snapshot;
}

export function listActiveSkillStewardLeases(
  projectRoot: string,
  now?: Date | string,
): SkillStewardLease[] {
  const timestamp = Date.parse(toIso(now));
  return loadSkillStewardRegistry(projectRoot).leases.filter(
    (lease) => Date.parse(lease.expiresAt) > timestamp,
  );
}

function createStewardRecord(
  skill: string,
  observedRevisions: SkillStewardObservedRevision[],
  model: string,
  now: string,
): SkillStewardRecord {
  return {
    skill,
    agentId: `skill-steward:${skill}`,
    displayLabel: buildSkillStewardDisplayLabel(skill),
    provider: SKILL_STEWARD_PROVIDER,
    model,
    status: 'active',
    observedRevisions,
    assignedAt: now,
    updatedAt: now,
  };
}

function groupObservedRevisions(
  revisions: SkillRevision[],
): Map<string, SkillStewardObservedRevision[]> {
  const grouped = new Map<string, SkillStewardObservedRevision[]>();
  for (const revision of revisions) {
    const values = grouped.get(revision.name) ?? [];
    values.push({ source: revision.source, state: revision.state, hash: revision.hash });
    grouped.set(revision.name, values);
  }
  for (const values of grouped.values()) {
    values.sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.state.localeCompare(right.state) ||
        left.hash.localeCompare(right.hash),
    );
  }
  return grouped;
}

function sameObservedRevisions(
  left: SkillStewardObservedRevision[],
  right: SkillStewardObservedRevision[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateRegistry<T>(
  projectRoot: string,
  now: string,
  operation: (draft: SkillStewardRegistrySnapshot) => T,
): { snapshot: SkillStewardRegistrySnapshot; value: T } {
  const path = getSkillStewardRegistryPath(projectRoot);
  return withRegistryLock(path, () => {
    const existed = existsSync(path);
    const current = readRegistry(path);
    const draft = cloneRegistry(current);
    pruneExpiredLeases(draft, now);
    const value = operation(draft);
    draft.stewards.sort((left, right) => left.skill.localeCompare(right.skill));
    draft.leases.sort(
      (left, right) => left.skill.localeCompare(right.skill) || left.id.localeCompare(right.id),
    );
    const changed =
      !existed ||
      JSON.stringify(current.stewards) !== JSON.stringify(draft.stewards) ||
      JSON.stringify(current.leases) !== JSON.stringify(draft.leases);
    if (!changed) return { snapshot: current, value };
    const next: SkillStewardRegistrySnapshot = {
      ...draft,
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      revision: current.revision + 1,
      updatedAt: now,
    };
    writeRegistry(path, next);
    return { snapshot: next, value };
  });
}

function pruneExpiredLeases(snapshot: SkillStewardRegistrySnapshot, now: string): void {
  const timestamp = Date.parse(now);
  const retained: SkillStewardLease[] = [];
  for (const lease of snapshot.leases) {
    if (Date.parse(lease.expiresAt) > timestamp) {
      retained.push(lease);
      continue;
    }
    const steward = snapshot.stewards.find((item) => item.skill === lease.skill);
    if (steward) {
      steward.lastCompletedAt = lease.expiresAt;
      steward.lastOutcome = 'expired';
      steward.lastEvidence = [];
      steward.updatedAt = now;
    }
  }
  snapshot.leases = retained;
}

function cloneRegistry(snapshot: SkillStewardRegistrySnapshot): SkillStewardRegistrySnapshot {
  return {
    ...snapshot,
    stewards: snapshot.stewards.map((steward) => ({
      ...steward,
      observedRevisions: steward.observedRevisions.map((revision) => ({ ...revision })),
      lastEvidence: steward.lastEvidence ? [...steward.lastEvidence] : undefined,
    })),
    leases: snapshot.leases.map((lease) => ({ ...lease })),
  };
}

function emptyRegistry(): SkillStewardRegistrySnapshot {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    stewards: [],
    leases: [],
  };
}

function readRegistry(path: string): SkillStewardRegistrySnapshot {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return emptyRegistry();
    throw new Error(
      `Could not read Skill Steward registry at ${path}; the existing file was preserved`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new Error(
      `Invalid Skill Steward registry JSON at ${path}; the existing file was preserved`,
      { cause: error },
    );
  }
  if (!isValidRegistry(parsed)) {
    throw new Error(`Invalid Skill Steward registry at ${path}; the existing file was preserved`);
  }
  return parsed;
}

function writeRegistry(path: string, snapshot: SkillStewardRegistrySnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error: unknown) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function withRegistryLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    const stat = lstatSync(lockPath);
    if (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      Date.now() - stat.mtimeMs > REGISTRY_LOCK_STALE_MS
    ) {
      unlinkSync(lockPath);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    fsyncSync(descriptor);
    return operation();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
      throw new SkillStewardRegistryConflictError();
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the operation result or error.
      }
      try {
        unlinkSync(lockPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function isValidRegistry(value: unknown): value is SkillStewardRegistrySnapshot {
  const registry = value as SkillStewardRegistrySnapshot;
  if (
    !registry ||
    registry.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
    !Number.isInteger(registry.revision) ||
    registry.revision < 0 ||
    !isIsoDate(registry.updatedAt) ||
    !Array.isArray(registry.stewards) ||
    !registry.stewards.every(isValidSteward) ||
    !Array.isArray(registry.leases) ||
    !registry.leases.every(isValidLease)
  ) {
    return false;
  }
  const stewardNames = registry.stewards.map((steward) => steward.skill);
  const leaseIds = registry.leases.map((lease) => lease.id);
  const leasedSkills = registry.leases.map((lease) => lease.skill);
  return (
    new Set(stewardNames).size === stewardNames.length &&
    new Set(leaseIds).size === leaseIds.length &&
    new Set(leasedSkills).size === leasedSkills.length &&
    registry.leases.every((lease) => stewardNames.includes(lease.skill))
  );
}

function isValidSteward(value: unknown): value is SkillStewardRecord {
  const steward = value as SkillStewardRecord;
  return Boolean(
    steward &&
    SKILL_NAME_PATTERN.test(steward.skill) &&
    steward.agentId === `skill-steward:${steward.skill}` &&
    steward.displayLabel === `${SKILL_STEWARD_DISPLAY_PREFIX}${steward.skill}` &&
    isChatGptWebSkillStewardIdentity(steward.provider, steward.model) &&
    ['active', 'paused', 'orphaned'].includes(steward.status) &&
    Array.isArray(steward.observedRevisions) &&
    steward.observedRevisions.every(isValidObservedRevision) &&
    isIsoDate(steward.assignedAt) &&
    isIsoDate(steward.updatedAt) &&
    (steward.lastLeaseAt === undefined || isIsoDate(steward.lastLeaseAt)) &&
    (steward.lastCompletedAt === undefined || isIsoDate(steward.lastCompletedAt)) &&
    (steward.lastOutcome === undefined ||
      ['succeeded', 'failed', 'cancelled', 'expired'].includes(steward.lastOutcome)) &&
    (steward.lastEvidence === undefined ||
      (Array.isArray(steward.lastEvidence) &&
        steward.lastEvidence.length <= 12 &&
        steward.lastEvidence.every(
          (item) => typeof item === 'string' && item.length > 0 && item.length <= 1_000,
        ))),
  );
}

function isValidObservedRevision(value: unknown): value is SkillStewardObservedRevision {
  const revision = value as SkillStewardObservedRevision;
  return Boolean(
    revision &&
    (revision.source === 'personal' || revision.source === 'project') &&
    (revision.state === 'active' || revision.state === 'draft') &&
    SHA256_PATTERN.test(revision.hash),
  );
}

function isValidLease(value: unknown): value is SkillStewardLease {
  const lease = value as SkillStewardLease;
  return Boolean(
    lease &&
    typeof lease.id === 'string' &&
    lease.id.length > 0 &&
    lease.id.length <= 200 &&
    SKILL_NAME_PATTERN.test(lease.skill) &&
    typeof lease.ownerId === 'string' &&
    lease.ownerId.length > 0 &&
    lease.ownerId.length <= 200 &&
    isIsoDate(lease.acquiredAt) &&
    isIsoDate(lease.expiresAt) &&
    Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt),
  );
}

function assertSkillName(skill: string): void {
  if (!SKILL_NAME_PATTERN.test(skill)) throw new Error('Invalid skill name');
}

function validateLeaseDuration(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > MAX_SKILL_STEWARD_LEASE_MS) {
    throw new Error('Skill steward lease must be an integer from 1000ms to 4 hours');
  }
  return value;
}

function cleanStoredString(value: string, label: string, maxLength: number): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength || /[\r\n]/.test(cleaned)) {
    throw new Error(`${label} must be a single-line value of at most ${maxLength} characters`);
  }
  return cleaned;
}

function cleanEvidence(values: string[]): string[] {
  const result = [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 12);
  if (result.some((value) => value.length > 1_000 || /[\r\n]/.test(value))) {
    throw new Error('Skill steward evidence must be single-line values of at most 1000 characters');
  }
  return result;
}

function toIso(value?: Date | string): string {
  const date = value instanceof Date ? value : value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  return date.toISOString();
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
