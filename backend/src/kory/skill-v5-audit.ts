import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { SkillDefinition } from './skills';
import type { SkillPromotionGate } from './skill-evaluations';
import {
  sourceFreshness,
  type V5CompiledSkillPackage,
  type V5SkillSourceRecord,
} from './skill-packages';

export const V5_AUDIT_STATUSES = [
  'unreviewed',
  'researching',
  'candidate',
  'evaluating',
  'qualified',
  'blocked',
  'retired',
] as const;

export type V5AuditStatus = (typeof V5_AUDIT_STATUSES)[number];
export type V5AuditFreshness = 'unmeasured' | 'fresh' | 'stale';

export interface V5SkillAuditRecord {
  skill: string;
  cohort: 'base' | 'professional' | 'specialist-v4';
  v5Status: V5AuditStatus;
  steward: string;
  adjacentSkills: string[];
  sources: V5SkillSourceRecord[];
  routing: {
    positive: number;
    negative: number;
    ambiguous: number;
    adversarial: number;
  };
  taskMaturity: {
    individual: number;
    scaffold: number;
  };
  fullTaskEvals: number;
  openRegressions: number;
  uplift: {
    passRateDelta: number | null;
    qualityDelta: number | null;
    verificationDelta: number | null;
  } | null;
  freshness: V5AuditFreshness;
  packageVersion: string | null;
  packageFingerprint: string | null;
  nextAction: string;
  updatedAt: string;
}

export interface V5SkillAuditLedger {
  schemaVersion: 1;
  librarySize: number;
  generatedAt: string;
  records: V5SkillAuditRecord[];
}

const sourceRecordSchema = z
  .object({
    url: z.string(),
    sourceType: z.enum(['official-docs', 'spec', 'reference-implementation', 'community-pattern']),
    versionScope: z.string(),
    revision: z.string().optional(),
    verifiedAt: z.string(),
    staleAfterDays: z.number().int().positive(),
    license: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

const auditRecordSchema = z
  .object({
    skill: z.string().min(1),
    cohort: z.enum(['base', 'professional', 'specialist-v4']),
    v5Status: z.enum(V5_AUDIT_STATUSES),
    steward: z.string().min(1),
    adjacentSkills: z.array(z.string()),
    sources: z.array(sourceRecordSchema),
    routing: z
      .object({
        positive: z.number().int().nonnegative(),
        negative: z.number().int().nonnegative(),
        ambiguous: z.number().int().nonnegative(),
        adversarial: z.number().int().nonnegative(),
      })
      .strict(),
    taskMaturity: z
      .object({
        individual: z.number().int().nonnegative(),
        scaffold: z.number().int().nonnegative(),
      })
      .strict()
      .default({ individual: 0, scaffold: 0 }),
    fullTaskEvals: z.number().int().nonnegative(),
    openRegressions: z.number().int().nonnegative(),
    uplift: z
      .object({
        passRateDelta: z.number().nullable(),
        qualityDelta: z.number().nullable(),
        verificationDelta: z.number().nullable(),
      })
      .strict()
      .nullable(),
    freshness: z.enum(['unmeasured', 'fresh', 'stale']),
    packageVersion: z.string().nullable(),
    packageFingerprint: z.string().nullable().default(null),
    nextAction: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

const auditLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    librarySize: z.number().int().nonnegative(),
    generatedAt: z.string().min(1),
    records: z.array(auditRecordSchema),
  })
  .strict();

export function getV5AuditLedgerPath(projectRoot: string): string {
  return join(resolve(projectRoot), 'skills-v5', 'audit-ledger.json');
}

export function loadV5AuditLedger(projectRoot: string): V5SkillAuditLedger | null {
  const path = getV5AuditLedgerPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    return auditLedgerSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error: unknown) {
    throw new Error(
      `V5 skill audit ledger is invalid and was preserved at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function saveV5AuditLedger(projectRoot: string, ledger: V5SkillAuditLedger): V5SkillAuditLedger {
  auditLedgerSchema.parse(ledger);
  const path = getV5AuditLedgerPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return ledger;
}

function cohortForIndex(index: number, baseCount: number, professionalCount: number) {
  if (index < baseCount) return 'base' as const;
  if (index < baseCount + professionalCount) return 'professional' as const;
  return 'specialist-v4' as const;
}

function adjacentSkills(
  definition: SkillDefinition,
  definitions: readonly SkillDefinition[],
): string[] {
  const direct = new Set([
    ...(definition.broader ?? []),
    ...(definition.facets ?? []),
    ...(definition.requires ?? []),
    ...(definition.conflicts ?? []),
  ]);
  for (const candidate of definitions) {
    if (candidate.name === definition.name) continue;
    const candidateRelations = [
      ...(candidate.broader ?? []),
      ...(candidate.facets ?? []),
      ...(candidate.requires ?? []),
      ...(candidate.conflicts ?? []),
    ];
    if (candidateRelations.includes(definition.name)) direct.add(candidate.name);
    if (
      (definition.broader ?? []).some((parent) => (candidate.broader ?? []).includes(parent)) &&
      definition.broader?.length
    ) {
      direct.add(candidate.name);
    }
  }
  direct.delete(definition.name);
  return [...direct].sort();
}

function freshnessForPackage(
  skillPackage: V5CompiledSkillPackage | undefined,
  now: Date,
): V5AuditFreshness {
  if (!skillPackage) return 'unmeasured';
  return skillPackage.sidecar.sources.every((source) => sourceFreshness(source, now) === 'fresh')
    ? 'fresh'
    : 'stale';
}

const STATUS_PROGRESS: Record<V5AuditStatus, number> = {
  unreviewed: 0,
  researching: 1,
  candidate: 2,
  evaluating: 3,
  blocked: 4,
  qualified: 5,
  retired: 6,
};

function preserveProgress(
  previous: V5SkillAuditRecord | undefined,
  baselineStatus: V5AuditStatus,
): V5AuditStatus {
  if (!previous) return baselineStatus;
  return STATUS_PROGRESS[previous.v5Status] >= STATUS_PROGRESS[baselineStatus]
    ? previous.v5Status
    : baselineStatus;
}

function comparableAuditRecord(record: V5SkillAuditRecord): Omit<V5SkillAuditRecord, 'updatedAt'> {
  const { updatedAt: _updatedAt, ...comparable } = record;
  return comparable;
}

function fingerprintDirectory(directory: string): string {
  const hash = createHash('sha256');
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        hash.update(path.replace(directory, ''));
        hash.update(readFileSync(path));
      }
    }
  };
  visit(directory);
  return hash.digest('hex');
}

function fingerprintPackage(skillPackage: V5CompiledSkillPackage | undefined): string | null {
  if (!skillPackage) return null;
  const hash = createHash('sha256');
  hash.update(skillPackage.sourceContent);
  hash.update(skillPackage.instructions);
  hash.update(JSON.stringify(skillPackage.sidecar));
  hash.update(JSON.stringify(skillPackage.evaluation));
  hash.update(JSON.stringify(skillPackage.supportingResources));
  if (existsSync(skillPackage.sidecarPath)) hash.update(readFileSync(skillPackage.sidecarPath));
  const directory = skillPackage.directory;
  if (existsSync(directory) && lstatSync(directory).isDirectory()) {
    hash.update(fingerprintDirectory(directory));
  }
  return hash.digest('hex');
}

export function syncV5AuditLedger(
  projectRoot: string,
  definitions: readonly SkillDefinition[],
  packages: readonly V5CompiledSkillPackage[],
  options: {
    baseCount: number;
    professionalCount: number;
    now?: Date;
  },
): V5SkillAuditLedger {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const previous = loadV5AuditLedger(projectRoot);
  const previousBySkill = new Map(previous?.records.map((record) => [record.skill, record]) ?? []);
  const packagesByName = new Map(
    packages.map((skillPackage) => [skillPackage.sidecar.name, skillPackage]),
  );

  const records = definitions.map((definition, index): V5SkillAuditRecord => {
    const skillPackage = packagesByName.get(definition.name);
    const prior = previousBySkill.get(definition.name);
    const packageFingerprint = fingerprintPackage(skillPackage);
    const fingerprintChanged = Boolean(
      prior?.packageFingerprint &&
      packageFingerprint &&
      prior.packageFingerprint !== packageFingerprint,
    );
    const legacyUnboundQualified = Boolean(
      prior?.v5Status === 'qualified' && !prior.packageFingerprint,
    );
    const baselineStatus: V5AuditStatus = skillPackage ? 'candidate' : 'unreviewed';
    const routing = skillPackage
      ? {
          positive: skillPackage.sidecar.routing.positive.length,
          negative: skillPackage.sidecar.routing.negative.length,
          ambiguous: skillPackage.sidecar.routing.ambiguous.length,
          adversarial: skillPackage.sidecar.routing.adversarial.length,
        }
      : {
          positive: definition.should.length,
          negative: definition.shouldNot.length,
          ambiguous: 0,
          adversarial: 0,
        };
    const taskMaturity = skillPackage
      ? {
          individual: skillPackage.evaluation.tasks.filter((task) => task.maturity === 'individual')
            .length,
          scaffold: skillPackage.evaluation.tasks.filter((task) => task.maturity === 'scaffold')
            .length,
        }
      : (prior?.taskMaturity ?? { individual: 0, scaffold: 0 });
    const candidate: V5SkillAuditRecord = {
      skill: definition.name,
      cohort: cohortForIndex(index, options.baseCount, options.professionalCount),
      v5Status: preserveProgress(prior, baselineStatus),
      steward: `ChatGPT web — ${definition.name}`,
      adjacentSkills: adjacentSkills(definition, definitions),
      sources: skillPackage ? [...skillPackage.sidecar.sources] : (prior?.sources ?? []),
      routing,
      taskMaturity,
      fullTaskEvals: prior?.fullTaskEvals ?? 0,
      openRegressions: prior?.openRegressions ?? 0,
      uplift: prior?.uplift ?? null,
      freshness: freshnessForPackage(skillPackage, now),
      packageVersion: skillPackage?.sidecar.version ?? null,
      packageFingerprint,
      nextAction:
        prior?.nextAction && prior.v5Status !== 'unreviewed'
          ? prior.nextAction
          : skillPackage
            ? taskMaturity.scaffold > 0
              ? 'replace scaffold full-task fixtures with individually authored concrete scenarios'
              : 'run held-out routing and paired full-task V5 evaluation suite'
            : 'research authoritative sources and build an individually-qualified V5 package',
      updatedAt: timestamp,
    };

    if (fingerprintChanged || legacyUnboundQualified) {
      candidate.v5Status = candidate.v5Status === 'retired' ? 'retired' : 'blocked';
      candidate.fullTaskEvals = 0;
      candidate.uplift = null;
      candidate.nextAction = 'rerun qualification evidence against the revised skill package';
    }

    if (!skillPackage && prior?.v5Status === 'qualified') {
      candidate.v5Status = 'unreviewed';
      candidate.fullTaskEvals = 0;
      candidate.uplift = null;
      candidate.nextAction = 'restore the package and rebuild qualification evidence';
    }
    if (
      prior &&
      JSON.stringify(comparableAuditRecord(prior)) ===
        JSON.stringify(comparableAuditRecord(candidate))
    ) {
      candidate.updatedAt = prior.updatedAt;
    }
    return candidate;
  });

  const unchanged =
    previous?.librarySize === definitions.length &&
    previous.records.length === records.length &&
    previous.records.every(
      (record, index) => JSON.stringify(record) === JSON.stringify(records[index]),
    );

  return saveV5AuditLedger(projectRoot, {
    schemaVersion: 1,
    librarySize: definitions.length,
    generatedAt: unchanged && previous ? previous.generatedAt : timestamp,
    records,
  });
}

export function updateV5AuditRecord(
  projectRoot: string,
  skill: string,
  patch: Partial<
    Pick<
      V5SkillAuditRecord,
      | 'v5Status'
      | 'sources'
      | 'routing'
      | 'fullTaskEvals'
      | 'openRegressions'
      | 'uplift'
      | 'freshness'
      | 'nextAction'
    >
  >,
  now = new Date(),
): V5SkillAuditRecord {
  const ledger = loadV5AuditLedger(projectRoot);
  if (!ledger) throw new Error('V5 audit ledger must be initialized before updating a skill');
  const index = ledger.records.findIndex((record) => record.skill === skill);
  if (index < 0) throw new Error(`V5 audit record not found for ${skill}`);
  const next = {
    ...ledger.records[index],
    ...patch,
    updatedAt: now.toISOString(),
  } satisfies V5SkillAuditRecord;
  auditRecordSchema.parse(next);
  const records = [...ledger.records];
  records[index] = next;
  saveV5AuditLedger(projectRoot, {
    ...ledger,
    generatedAt: now.toISOString(),
    records,
  });
  return next;
}

function evaluationAuditPatch(
  current: V5SkillAuditRecord,
  gate: SkillPromotionGate,
): Pick<
  V5SkillAuditRecord,
  'v5Status' | 'fullTaskEvals' | 'openRegressions' | 'uplift' | 'nextAction'
> {
  let v5Status: V5AuditStatus;
  let nextAction: string;
  if (gate.status === 'ready' && current.freshness === 'fresh' && current.packageVersion) {
    v5Status = 'qualified';
    nextAction = 'monitor regressions, usage signals, and source freshness';
  } else if (gate.status === 'blocked') {
    v5Status = 'blocked';
    nextAction = gate.reasons[0] ?? 'resolve blocked evaluation evidence';
  } else if (gate.status === 'ready' && current.freshness !== 'fresh') {
    v5Status = 'evaluating';
    nextAction = 'refresh authoritative sources before qualification';
  } else if (gate.status === 'unmeasured') {
    v5Status = current.packageVersion ? 'candidate' : current.v5Status;
    nextAction = current.packageVersion
      ? 'run held-out routing and paired full-task V5 evaluation suite'
      : current.nextAction;
  } else {
    v5Status = 'evaluating';
    nextAction = gate.reasons[0] ?? 'complete missing evaluation evidence';
  }

  return {
    v5Status,
    fullTaskEvals: gate.categoryCoverage['full-task'],
    openRegressions: gate.openRegressions,
    uplift:
      gate.skillBaselinePassRateDelta === null &&
      gate.skillBaselineQualityDelta === null &&
      gate.skillBaselineVerificationDelta === null
        ? null
        : {
            passRateDelta: gate.skillBaselinePassRateDelta,
            qualityDelta: gate.skillBaselineQualityDelta,
            verificationDelta: gate.skillBaselineVerificationDelta,
          },
    nextAction,
  };
}

/**
 * Reconcile a whole audit ledger against current promotion gates in one atomic
 * write. This prevents stale per-skill status from surviving merely because a
 * caller refreshed package metadata without replaying evaluation evidence.
 */
export function reconcileV5AuditLedgerFromEvaluations(
  projectRoot: string,
  gates: ReadonlyMap<string, SkillPromotionGate>,
  now = new Date(),
): V5SkillAuditLedger {
  const ledger = loadV5AuditLedger(projectRoot);
  if (!ledger)
    throw new Error('V5 audit ledger must be initialized before applying evaluation evidence');
  const timestamp = now.toISOString();
  const records = ledger.records.map((current) => {
    const gate = gates.get(current.skill);
    if (!gate || current.v5Status === 'retired') return current;
    const next = {
      ...current,
      ...evaluationAuditPatch(current, gate),
      updatedAt: timestamp,
    } satisfies V5SkillAuditRecord;
    auditRecordSchema.parse(next);
    if (
      JSON.stringify(comparableAuditRecord(current)) === JSON.stringify(comparableAuditRecord(next))
    ) {
      next.updatedAt = current.updatedAt;
    }
    return next;
  });
  const unchanged = records.every(
    (record, index) => JSON.stringify(record) === JSON.stringify(ledger.records[index]),
  );
  return saveV5AuditLedger(projectRoot, {
    ...ledger,
    generatedAt: unchanged ? ledger.generatedAt : timestamp,
    records,
  });
}

export function updateV5AuditFromEvaluation(
  projectRoot: string,
  skill: string,
  gate: SkillPromotionGate,
  now = new Date(),
): V5SkillAuditRecord {
  const ledger = loadV5AuditLedger(projectRoot);
  if (!ledger)
    throw new Error('V5 audit ledger must be initialized before applying evaluation evidence');
  const current = ledger.records.find((record) => record.skill === skill);
  if (!current) throw new Error(`V5 audit record not found for ${skill}`);

  return updateV5AuditRecord(projectRoot, skill, evaluationAuditPatch(current, gate), now);
}
