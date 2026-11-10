import { createHash } from 'node:crypto';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const DB_SKEW = 'database-performance-full-task-1-individual';
const DB_MIGRATION = 'database-performance-full-task-2-individual';
const VIS_CAPACITY = 'data-visualization-full-task-1-individual';
const VIS_CONVERSION = 'data-visualization-full-task-2-individual';

function normalized(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValuesForKeys(value: unknown, keys: ReadonlySet<string>): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => textValuesForKeys(item, keys));
  const record = asRecord(value);
  if (!record) return [];
  const values: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    if (keys.has(key.toLowerCase()) && typeof child === 'string') values.push(child.toLowerCase());
    values.push(...textValuesForKeys(child, keys));
  }
  return values;
}

function readerIsEvidenceBound(value: unknown): boolean {
  const claims = textValuesForKeys(value, new Set(['reader', 'audience', 'persona']));
  return claims.every((claim) => /unspecified|not supplied|not provided|unknown/u.test(claim));
}

type LinePathNode = {
  node: Record<string, unknown>;
  transforms: unknown[];
};

function collectLinePathNodes(
  value: unknown,
  inheritedTransforms: unknown[] = [],
  result: LinePathNode[] = [],
): LinePathNode[] {
  const record = asRecord(value);
  if (!record) return result;
  const localTransforms = Array.isArray(record.transform) ? record.transform : [];
  const transforms = [...inheritedTransforms, ...localTransforms];
  const mark = record.mark;
  const markType = typeof mark === 'string' ? mark : asRecord(mark)?.type;
  if (markType === 'line') result.push({ node: record, transforms });
  for (const key of ['layer', 'vconcat', 'hconcat', 'concat']) {
    const children = record[key];
    if (Array.isArray(children)) {
      for (const child of children) collectLinePathNodes(child, transforms, result);
    }
  }
  for (const key of ['spec', 'chart']) {
    if (record[key]) collectLinePathNodes(record[key], transforms, result);
  }
  return result;
}

const capacityValueFields = new Set(['medianms', 'p95ms', 'throughputrps']);
const capacityDatumField = String.raw`datum(?:\.(?:medianMs|p95Ms|throughputRps)|\[\s*['"](?:medianMs|p95Ms|throughputRps)['"]\s*\])`;

function combineGapPredicates(results: Array<boolean | null>, operator: 'and' | 'or'): boolean | null {
  const decisive = operator === 'or';
  if (results.includes(decisive)) return decisive;
  return results.every((result) => result === !decisive) ? !decisive : null;
}

function splitGapPredicate(expression: string, operator: '&&' | '||'): string[] | null {
  let depth = 0;
  let start = 0;
  const clauses: string[] = [];
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === '(') depth += 1;
    else if (expression[index] === ')') depth -= 1;
    else if (depth === 0 && expression.startsWith(operator, index)) {
      clauses.push(expression.slice(start, index));
      start = index + operator.length;
      index += 1;
    }
  }
  return clauses.length ? [...clauses, expression.slice(start)] : null;
}

// Evaluate only statically understood predicates at the fixture's null-valued
// telemetry rows. Unknown predicates are not execution evidence. In particular,
// testing timestamp validity does not drop a telemetry gap, and an OR with an
// explicit null branch must not be confused with a null-dropping AND.
function predicateAtCapacityGap(value: unknown): boolean | null {
  if (typeof value === 'string') {
    const expression = value.trim();
    if (expression === 'true') return true;
    if (expression === 'false') return false;
    for (const [symbol, operator] of [['||', 'or'], ['&&', 'and']] as const) {
      const clauses = splitGapPredicate(expression, symbol);
      if (clauses) return combineGapPredicates(clauses.map(predicateAtCapacityGap), operator);
    }
    if (expression.startsWith('(') && expression.endsWith(')')) {
      let depth = 0;
      let wrapsExpression = true;
      for (let index = 0; index < expression.length - 1; index += 1) {
        if (expression[index] === '(') depth += 1;
        if (expression[index] === ')') depth -= 1;
        if (depth === 0) { wrapsExpression = false; break; }
      }
      if (wrapsExpression) return predicateAtCapacityGap(expression.slice(1, -1));
    }
    if (expression.startsWith('!')) {
      const result = predicateAtCapacityGap(expression.slice(1));
      return result === null ? null : !result;
    }
    const validity = new RegExp(`^(!\\s*)?(?:isvalid|isfinite)\\s*\\(\\s*${capacityDatumField}\\s*\\)$`, 'iu').exec(expression);
    if (validity) return Boolean(validity[1]);
    const comparison = new RegExp(`^(?:${capacityDatumField}\\s*(===|==|!==|!=)\\s*null|null\\s*(===|==|!==|!=)\\s*${capacityDatumField})$`, 'iu').exec(expression);
    if (comparison) return ['===', '=='].includes(comparison[1] ?? comparison[2]!);
    if (new RegExp(`^${capacityDatumField}$`, 'iu').test(expression)) return false;
    return null;
  }
  const predicate = asRecord(value);
  if (!predicate) return null;
  if (predicate.not !== undefined) {
    const result = predicateAtCapacityGap(predicate.not);
    return result === null ? null : !result;
  }
  for (const operator of ['and', 'or'] as const) {
    const clauses = predicate[operator];
    if (!Array.isArray(clauses)) continue;
    return combineGapPredicates(clauses.map(predicateAtCapacityGap), operator);
  }
  if (typeof predicate.field !== 'string' || !capacityValueFields.has(predicate.field.toLowerCase())) {
    return null;
  }
  if (typeof predicate.valid === 'boolean') return !predicate.valid;
  if ('equal' in predicate) return predicate.equal === null;
  if (Array.isArray(predicate.oneOf)) return predicate.oneOf.includes(null);
  return null;
}

function transformDropsMissingRows(transforms: unknown[]): boolean {
  return transforms.some((transform) => {
    const record = asRecord(transform);
    const imputesTelemetry = typeof record?.impute === 'string' &&
      capacityValueFields.has(record.impute.toLowerCase());
    return imputesTelemetry || predicateAtCapacityGap(record?.filter) === false;
  });
}

function linePathBreaksOnMissing(node: Record<string, unknown>): boolean {
  const mark = asRecord(node.mark);
  // Vega-Lite breaks paths at null-valued quantitative points by default.
  // `break-path` and `defined` are not supported Vega-Lite mark properties.
  const invalidMode = mark?.invalid;
  if (invalidMode === undefined || [
    'break-paths-filter-domains',
    'break-paths-show-domains',
    'break-paths-show-path-domains',
  ].includes(invalidMode as string)) return true;
  return false;
}

function inspectExecutableGapSemantics(value: unknown): {
  executable: boolean;
  preservesGaps: boolean;
} {
  const relevant = collectLinePathNodes(value).filter(({ node, transforms }) =>
    /median|p95|latency|throughput/u.test(normalized({ node, transforms })),
  );
  if (!relevant.length) return { executable: false, preservesGaps: true };
  // A scale invalid-value replacement makes a null point drawable even with
  // the ordinary path-breaking default. Unmodelled overrides fail closed.
  const configScale = asRecord(asRecord(asRecord(value)?.config)?.scale);
  const hasInvalidOutput = configScale?.invalid !== undefined;
  return {
    executable: true,
    preservesGaps: relevant.every(
      ({ node, transforms }) =>
        !hasInvalidOutput && !transformDropsMissingRows(transforms) &&
        asRecord(asRecord(node.config)?.scale)?.invalid === undefined &&
        linePathBreaksOnMissing(node),
    ),
  };
}

const dbSkewMaterializer: SkillEvalFixtureMaterializer = {
  id: 'database-performance/skewed-orders-plan-regression@1',
  matches: (scenario) => scenario.id === DB_SKEW,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'evidence/query-analysis.json',
      `${JSON.stringify(
        {
          engine: 'PostgreSQL-compatible 17 fixture',
          query:
            'SELECT id,total_cents FROM orders WHERE tenant_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT 100',
          distribution: {
            smallTenantRows: 1800,
            enterpriseTenantRows: 8_400_000,
            enterpriseOpenPct: 61,
          },
          indexes: [
            'orders_pkey(id)',
            'orders_tenant_created_idx(tenant_id, created_at DESC)',
            'orders_tenant_status_created_idx(tenant_id, status, created_at DESC)',
          ],
          temptingProposal: 'orders_tenant_idx(tenant_id)',
          before: {
            medianMs: 62,
            p99Ms: 4010,
            smallTenantPlan: 'Index Scan orders_tenant_status_created_idx; actual 14ms',
            enterprisePlan:
              'generic plan misestimates tenant/status cardinality; reads 5.1M index tuples; actual 3980ms',
            concurrentWritesPerSecond: 850,
          },
          candidateExperiments: [
            {
              id: 'redundant-prefix-index',
              change: 'CREATE INDEX orders_tenant_idx ON orders(tenant_id)',
              enterpriseP99Ms: 3995,
              writeCpuDeltaPct: 6.8,
              storageGiBDelta: 6.2,
              neighborQueryP99DeltaPct: 0,
              evidence:
                'planner does not select new index; existing indexes already lead on tenant_id',
            },
            {
              id: 'extended-statistics',
              change:
                'CREATE STATISTICS orders_tenant_status_mcv (mcv, dependencies) ON tenant_id,status FROM orders; ANALYZE orders',
              enterpriseP99Ms: 168,
              smallTenantP99Ms: 76,
              writeCpuDeltaPct: 0.2,
              storageGiBDelta: 0.01,
              lockObservation:
                'statistics creation/ANALYZE completed under representative writes without blocking writers',
              neighborQueryP99DeltaPct: 1.1,
              actualPlan:
                'enterprise parameter estimate reflects tenant/status skew; bounded index scan; actual 151ms',
            },
            {
              id: 'force-custom-plan',
              change: 'SET plan_cache_mode=force_custom_plan for all application connections',
              enterpriseP99Ms: 149,
              smallTenantP99Ms: 71,
              writeCpuDeltaPct: 0,
              planningCpuDeltaPct: 19,
              neighborQueryP99DeltaPct: 14,
              evidence: 'broad session-level setting regresses unrelated prepared-query workload',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Database performance — skewed orders tail

Diagnose and choose the narrowest tuning change from the supplied representative plans/statistics/experiments. The median is not the target; enterprise p99 is. Reject changes whose measured write/storage/neighbor-query cost is not justified. The proposed tenant-only index duplicates an existing leading prefix and has measured no tail benefit. GPU compute is outside the relational query boundary.

Write \`.kory-eval/database-skew.json\` with exact query/parameters, schema/index/statistics/distribution/concurrency identity, small-vs-enterprise before plans, hypothesis and evidence, selected experiment + rejected alternatives, before/after p99 and plan evidence, write/storage/lock/neighbor-query effects, and hierarchy boundary: broader \`performance-debugging\`; \`gpu-compute\` is not selected.
`,
    );
  },
};

const dbSkewScorer: SkillEvalDeterministicScorer = {
  id: 'database-performance/skewed-orders-plan-regression-scorer@3',
  scenarioIds: [DB_SKEW],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/database-skew.json');
    const body = normalized(artifact);
    const captured =
      /tenant_id/u.test(body) &&
      /status/u.test(body) &&
      /8,?400,?000|8400000/u.test(body) &&
      /61/u.test(body) &&
      /4,?010|4010|3,?980|3980/u.test(body) &&
      /generic plan|misestimat/u.test(body) &&
      /850/u.test(body);
    const decision =
      /extended-statistics|extended statistics|mcv|dependencies/u.test(body) &&
      /168/u.test(body) &&
      /151/u.test(body) &&
      /redundant-prefix-index|tenant-only|tenant index/u.test(body) &&
      /reject|not selected|no benefit|redundant/u.test(body) &&
      /force[-_ ]custom[-_ ]plan|plan_cache_mode[^\n]{0,80}force_custom_plan/u.test(body) &&
      /14|19/u.test(body) &&
      /regress|broad/u.test(body);
    const sideEffects =
      /write/u.test(body) && /storage/u.test(body) && /lock/u.test(body) && /neighbor/u.test(body);
    // Candidates write the adjacent skill name with either separator ("gpu-compute"
    // or "GPU compute"). Requiring one spelling refused correct boundaries, so the
    // separator is optional here; naming both neighbours and the boundary verb is
    // still required.
    const hierarchy =
      /performance[\s_-]?debugging/u.test(body) &&
      /gpu[\s_-]?compute/u.test(body) &&
      /not selected|out of scope|boundary/u.test(body);
    const passed = Boolean(artifact) && captured && decision && sideEffects && hierarchy;
    return {
      passed,
      quality: passed
        ? 1
        : captured && decision && sideEffects
          ? 0.75
          : captured && decision
            ? 0.5
            : 0,
      verification: decision && sideEffects ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `representative query/distribution/concurrency captured: ${captured ? 'yes' : 'no'}`,
        `narrow plan/statistics change justified against alternatives: ${decision ? 'yes' : 'no'}`,
        `write/storage/lock/neighbor effects checked: ${sideEffects ? 'yes' : 'no'}`,
        `performance-debugging/GPU boundary: ${hierarchy ? 'explicit' : 'missing'}`,
      ],
    };
  },
};

const dbMigrationMaterializer: SkillEvalFixtureMaterializer = {
  id: 'database-performance/migration-lock-amplification@1',
  matches: (scenario) => scenario.id === DB_MIGRATION,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'evidence/migration.json',
      `${JSON.stringify(
        {
          engine: 'PostgreSQL 17.5',
          table: 'events',
          stagingRows: 1_000_000,
          productionRows: 400_000_000,
          productionWritesPerSecond: 1400,
          longTransactionP95Seconds: 92,
          requestedColumn: 'normalized_key TEXT derived from payload and ultimately NOT NULL',
          naiveAttempt: {
            ddl: 'ALTER TABLE events ADD COLUMN normalized_key TEXT NOT NULL DEFAULT derive(payload)',
            result:
              'blocked behind long-running transaction; write queue grew; aborted at 30s lock timeout',
          },
          validatedPhases: [
            '1 add normalized_key nullable with no volatile default (metadata-only)',
            '2 backfill primary-key ranges in 25k-row committed batches; resume from durable high-water mark',
            '3 create supporting index CONCURRENTLY if needed; abort/retry invalid concurrent index safely',
            '4 add CHECK (normalized_key IS NOT NULL) NOT VALID',
            '5 VALIDATE CONSTRAINT under representative writes',
            '6 short lock window: SET lock_timeout=2s; ALTER COLUMN normalized_key SET NOT NULL only after validation',
          ],
          experiment: {
            batchRows: 25000,
            batchP95Ms: 340,
            maxObservedWriterBlockMs: 81,
            abortedAtBatch: 37,
            resumedFromHighWaterMark: true,
            duplicateOrSkippedRowsAfterResume: 0,
            validateConstraintCompleted: true,
            finalSetNotNullLockMs: 44,
            postMigrationPlanRegressionPct: 1.3,
          },
          abortRule:
            'If lock_timeout or statement_timeout fires, stop the phase, leave prior committed batches intact, inspect blockers, and resume; do not disable isolation or constraints.',
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Database performance — low-lock migration

Use the supplied PostgreSQL 17.5 production-scale evidence; do not extrapolate from the 400x-smaller staging table. Produce a phased, bounded, resumable migration strategy consistent with the validated experiment. Preserve correctness/isolation. Include lock + statement timeout policy, batch resume evidence, concurrent-index failure handling if applicable, NOT VALID→VALIDATE constraint strategy, short final NOT NULL lock, abort/recovery, and post-migration plan/regression checks.

Write \`.kory-eval/database-migration.json\` with version/scale/concurrency identity, why the naive attempt fails, ordered phases, batch/lock measurements, abort/resume behavior, correctness/isolation guarantees, index/constraint validation, final lock evidence, post-plan checks, and hierarchy boundary: broader \`performance-debugging\`; \`mongodb-engineering\` is not applicable.
`,
    );
  },
};

const dbMigrationScorer: SkillEvalDeterministicScorer = {
  id: 'database-performance/migration-lock-amplification-scorer@2',
  scenarioIds: [DB_MIGRATION],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/database-migration.json',
    );
    const body = normalized(artifact);
    const context =
      /17\.5/u.test(body) &&
      /400,?000,?000|400 million/u.test(body) &&
      /1,?400|1400/u.test(body) &&
      /92/u.test(body) &&
      /400x|400.*larg/u.test(body) &&
      /naive|blocked|long.*transaction/u.test(body);
    const phases =
      /nullable/u.test(body) &&
      /25,?000|25000/u.test(body) &&
      /high.?water|resume/u.test(body) &&
      /concurrent/u.test(body) &&
      /not valid/u.test(body) &&
      /validate constraint|validate/u.test(body) &&
      /set not null/u.test(body) &&
      /lock_timeout|lock timeout/u.test(body) &&
      /2s|2 second/u.test(body);
    const recovery =
      /37/u.test(body) &&
      /zero|0.*duplicate|no.*duplicate/u.test(body) &&
      /81/u.test(body) &&
      /44/u.test(body) &&
      /abort/u.test(body) &&
      /resume/u.test(body) &&
      /isolation/u.test(body) &&
      /post.*plan|plan.*regression/u.test(body);
    const hierarchy =
      /performance[\s_-]?debugging/u.test(body) &&
      /mongo(?:db)?[\s_-]?engineering/u.test(body) &&
      /not applicable|not selected|boundary/u.test(body) &&
      !/disable isolation|weaken isolation/u.test(body);
    const passed = Boolean(artifact) && context && phases && recovery && hierarchy;
    return {
      passed,
      quality: passed ? 1 : phases && recovery && context ? 0.75 : phases ? 0.5 : 0,
      verification: phases && recovery ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `actual version/production scale/lock context: ${context ? 'captured' : 'missing'}`,
        `bounded low-lock phased strategy: ${phases ? 'complete' : 'incomplete'}`,
        `abort/resume + lock/post-plan evidence: ${recovery ? 'complete' : 'incomplete'}`,
        `performance-debugging/Mongo boundary + isolation: ${hierarchy ? 'preserved' : 'missing'}`,
      ],
    };
  },
};

const capacityData = [
  { time: '10:00', medianMs: 55, p95Ms: 122, throughputRps: 310, deployment: null },
  { time: '10:05', medianMs: 58, p95Ms: 130, throughputRps: 320, deployment: null },
  { time: '10:10', medianMs: null, p95Ms: null, throughputRps: null, deployment: null },
  {
    time: '10:15',
    medianMs: null,
    p95Ms: null,
    throughputRps: null,
    deployment: 'deploy-2026.09.06.1',
  },
  { time: '10:20', medianMs: 66, p95Ms: 290, throughputRps: 390, deployment: null },
  { time: '10:25', medianMs: 70, p95Ms: 338, throughputRps: 405, deployment: null },
  { time: '10:30', medianMs: 62, p95Ms: 180, throughputRps: 360, deployment: null },
];

const visCapacityMaterializer: SkillEvalFixtureMaterializer = {
  id: 'data-visualization/capacity-trend-uncertainty-chart@4',
  matches: (scenario) => scenario.id === VIS_CAPACITY,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'data/capacity.json',
      `${JSON.stringify(capacityData, null, 2)}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Data visualization — capacity trend/missingness

The decision task is when to consider adding capacity, not why latency changed. No reader persona is supplied; keep the reader unspecified. Redesign the representation from \`data/capacity.json\` without changing/inventing telemetry. The supplied rows contain no duplicate timestamps; do not invent duplicate evidence. Produce \`.kory-eval/visualization-capacity.json\` as a structured visualization specification + accessible table/description.

Required semantics: 5-minute time grain; latency in milliseconds; throughput in requests/sec; median and p95 remain distinguishable (not a smoothed average); the two missing intervals at 10:10/10:15 are explicit gaps and must not be interpolated; deployment annotation is visible at 10:15; throughput cannot silently share a misleading latency scale; non-color distinctions and a text/table fallback expose every observed point/gap. Do not claim the deployment caused the p95 spike.

The host scorer performs static checks against the final visualization and source files, rejects an in-memory gap reconnection/interpolation corruption, then rereads the unchanged final files and confirms their hashes. This checks the structured specification; browser rendering and reader usability are unobserved. Candidate-authored execution records do not count as host verification. In text-patch mode, label candidate checks unobserved or unavailable and do not fabricate commands, hashes, or executed success/negative/recovery claims. No candidate-authored verification file is required.

Record hierarchy boundary: broader \`data-analysis\` + \`visual-interface-design\`; \`analytics-engineering\` is not being used to redefine telemetry/model semantics.
`,
    );
  },
};

// A structured specification may declare interpolation:false instead of using
// one preferred phrase. Inspect individual values so unrelated JSON fields do
// not accidentally form a line-break claim, and reject contradictory enablement.
function inspectDeclaredGapPolicy(value: unknown): {
  prohibitsInterpolation: boolean;
  enablesInterpolation: boolean;
} {
  if (typeof value === 'string') {
    const clauses = value.split(/[.;\n]+|\b(?:but|however)\b/iu).map((clause) => {
      const forbidsLineBreak =
        /\b(?:do not|must not|never)\s+(?:break\b[^.;]*line|(?:draw|insert|show)\b[^.;]*line[^.;]*break)|\bno\s+line\s+break/iu.test(clause);
      const prohibition =
        /no interpolation|not interpolat|(?:do not|must not|never) (?:interpolat|(?:draw|connect|reconnect)[^.;]*across[^.;]*(?:gap|missing|null))/iu.test(clause) ||
        // A refusal to drop or impute nulls preserves the gap just as directly as
        // a refusal to interpolate, and candidates write it that way ("never
        // filter nulls before connecting lines").
        /\b(?:never|do not|must not|no)\s+(?:filter|filtering|drop|dropping|remove|removing|discard|discarding|impute|imputing)[^.;]*(?:null|missing|nan)/iu.test(clause) ||
        // "No smoothing, interpolation, aggregation, or derived metrics" is one list,
        // not the contiguous phrase the first alternative needs.
        /\bno\s+(?:smoothing,?\s*)?interpolation/iu.test(clause) ||
        // "do not filter, interpolate, or connect across them" is the same prohibition
        // written as a verb list whose object is the pronoun "them". The negation and
        // the interpolation verb are both in the clause, so the gap is preserved.
        /\b(?:do not|does not|must not|never|no)\b[^.;]*\b(?:interpolat\w*|reconnect\w*|connect(?:s|ed|ing)?\s+across|draw\w*[^.;]*\bacross)\b/iu.test(
          clause,
        ) ||
        /\b(?:no|without)\s+(?:line|path|points?)\s+(?:is\s+|are\s+)?(?:drawn|connected|interpolated)\s+across\s+(?:the\s+)?(?:gap|missing|null)/iu.test(clause);
      return {
        prohibitsInterpolation: prohibition ||
          (!forbidsLineBreak && /break[^.;]*line|line[^.;]*break/iu.test(clause)),
        enablesInterpolation: forbidsLineBreak || (!prohibition &&
          /(?:interpolat[^.;]*(?:gap|missing|null)|(?:draw|connect|reconnect)[^.;]*across[^.;]*(?:gap|missing|null))/iu.test(clause)),
      };
    });
    return {
      prohibitsInterpolation: clauses.some((clause) => clause.prohibitsInterpolation),
      enablesInterpolation: clauses.some((clause) => clause.enablesInterpolation),
    };
  }
  const record = asRecord(value);
  const children = Array.isArray(value) ? value : Object.values(record ?? {});
  const policies = children.map(inspectDeclaredGapPolicy);
  const interpolation = record?.interpolation;
  const disabled = interpolation === false || (typeof interpolation === 'string' &&
    // "None. Null metrics remain explicit gaps; no smoothing." is a prohibition in
    // prose. Only the leading verdict matters here; the clause scan above already
    // decides whether the rest of the sentence enables anything.
    (/^(?:none|disabled)\b|^(?:no interpolation)/iu.test(interpolation.trim()) ||
      /^(?:none|disabled|none[- ]across[- ](?:null|missing)[- ]values)$/iu.test(interpolation.trim()) ||
      inspectDeclaredGapPolicy(interpolation).prohibitsInterpolation));
  return {
    prohibitsInterpolation: disabled || policies.some((policy) => policy.prohibitsInterpolation),
    enablesInterpolation: interpolation === true ||
      (typeof interpolation === 'string' && !disabled) ||
      policies.some((policy) => policy.enablesInterpolation),
  };
}

function inspectCapacityArtifact(artifact: unknown) {
  const body = normalized(artifact);
  const encodings =
    /median/u.test(body) &&
    /p95/u.test(body) &&
    /throughput/u.test(body) &&
    /requests\/sec|rps/u.test(body) &&
    /millisecond|\bms\b/u.test(body) &&
    /5-minute|5 minute|five-minute|five minute|"(?:time)?grainminutes":5/u.test(body) &&
    /deployment|deploy-2026\.09\.06\.1/u.test(body);
  const gapPolicy = inspectDeclaredGapPolicy(artifact);
  const gapDeclaration =
    /10:10/u.test(body) &&
    /10:15/u.test(body) &&
    /gap|missing|unavailable/u.test(body) &&
    gapPolicy.prohibitsInterpolation &&
    !gapPolicy.enablesInterpolation;
  const pathSemantics = inspectExecutableGapSemantics(artifact);
  const gaps = gapDeclaration && pathSemantics.preservesGaps;
  // The task asks for "non-color distinctions and a text/table fallback". JSON keys
  // reach this body as camelCase without separators, so `textAlternative` and
  // `nonColorDistinctions` are the same declarations as "text alternative" and
  // "non-color"; and the task's slash offers text or table, not both.
  const hasFallback =
    /\btable\b/u.test(body) ||
    /description|text[ _-]?alternative|textalternative|accessib/u.test(body);
  const access =
    hasFallback &&
    /dash|marker|shape|pattern|line[ _-]?style|line style|non-?colou?r|noncolou?r|stroke|hatch/u.test(body);
  const scales =
    hasIndependentYScale(artifact) ||
    /separate.*axis|separate.*panel|secondary.*axis|distinct.*scale|independent.*scale|scale.*independent/u.test(
      body,
    );
  const causalClaimBody = body
    .replace(/\bno causal\b/gu, 'does not establish causal')
    .replace(/\bnot presented as a cause\b/gu, 'does not establish a cause');
  const bounded =
    readerIsEvidenceBound(artifact) &&
    !hasAffirmativeClaim(causalClaimBody, [/deployment/u, /caus(?:e|ed|es|al driver)/u], true) &&
    !hasAffirmativeClaim(body, [
      /\b(?:redefine|change|rewrite|modify)\b/u,
      /\b(?:telemetry|metric semantics|analytics model)\b/u,
    ]);
  const substantive = Boolean(artifact) && encodings && gaps && access && scales && bounded;
  return { substantive, encodings, gaps, access, scales, bounded, pathSemantics };
}

function readCapacityArtifact(root: string) {
  try {
    const text = readFixtureText(root, '.kory-eval/visualization-capacity.json');
    return {
      artifact: JSON.parse(text) as unknown,
      sha256: createHash('sha256').update(text).digest('hex'),
    };
  } catch {
    return null;
  }
}

function corruptCapacityGapSemantics(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const children = Array.isArray(record.vconcat) ? record.vconcat : [];
  record.vconcat = [
    ...children,
    {
      mark: { type: 'line', invalid: 'break-paths-show-path-domains' },
      transform: [{ filter: 'isValid(datum.medianMs)' }],
      encoding: { y: { field: 'medianMs', type: 'quantitative' } },
    },
  ];
  return true;
}

const visCapacityScorer: SkillEvalDeterministicScorer = {
  id: 'data-visualization/capacity-trend-uncertainty-chart-scorer@13',
  scenarioIds: [VIS_CAPACITY],
  score: ({ workingDirectory }) => {
    const input = readCapacityArtifact(workingDirectory);
    const checks = inspectCapacityArtifact(input?.artifact);
    const { substantive, encodings, gaps, access, scales, bounded, pathSemantics } = checks;
    let sourceText: string | null = null;
    try {
      sourceText = readFixtureText(workingDirectory, 'data/capacity.json');
    } catch {
      /* Missing or unsafe source fails integrity below. */
    }
    const sourceIntegrity = sourceText === `${JSON.stringify(capacityData, null, 2)}\n`;
    const sourceSha256 =
      sourceText === null ? null : createHash('sha256').update(sourceText).digest('hex');
    const hostSuccess = sourceIntegrity && substantive;
    let declaredGapCorruptionRejected = false;
    let linePathCorruptionRejected = false;
    if (hostSuccess) {
      const declaredCorruption = asRecord(structuredClone(input!.artifact));
      if (declaredCorruption) {
        declaredCorruption.interpolation = true;
        declaredGapCorruptionRejected = !inspectCapacityArtifact(declaredCorruption).gaps;
      }
      const pathCorruption = structuredClone(input!.artifact);
      if (corruptCapacityGapSemantics(pathCorruption)) {
        linePathCorruptionRejected = !inspectCapacityArtifact(pathCorruption).gaps;
      }
    }
    const negativeRejected = declaredGapCorruptionRejected && linePathCorruptionRejected;
    const recovery = readCapacityArtifact(workingDirectory);
    let recoveryPassed = false;
    try {
      recoveryPassed =
        hostSuccess &&
        recovery?.sha256 === input?.sha256 &&
        readFixtureText(workingDirectory, 'data/capacity.json') === sourceText &&
        inspectCapacityArtifact(recovery?.artifact).substantive;
    } catch {
      /* Recovery must revalidate the real final files. */
    }
    const hostVerification = hostSuccess && negativeRejected && recoveryPassed;
    const passed = hostVerification;
    return {
      passed,
      quality: passed
        ? 1
        : substantive
          ? 0.75
          : encodings && gaps && access
            ? 0.75
            : encodings && gaps
              ? 0.5
              : 0,
      verification: passed ? 1 : 0,
      integrityFailure: !sourceIntegrity,
      evidence: [
        `median/p95/throughput/deploy encoding: ${encodings ? 'complete' : 'incomplete'}`,
        `missing intervals explicitly non-interpolated: ${gaps ? 'yes' : 'no'}`,
        `executable line-path topology: ${pathSemantics.executable ? (pathSemantics.preservesGaps ? 'gap-preserving' : 'reconnect-risk') : 'no executable line path declared'}`,
        `non-color + table/text fallback: ${access ? 'present' : 'missing'}`,
        `latency/throughput scales remain legible: ${scales ? 'yes' : 'no'}`,
        `reader/causal/analytical ownership remains evidence-bound: ${bounded ? 'bounded' : 'incorrect'}`,
        `fixed capacity source integrity: ${sourceIntegrity ? 'preserved' : 'changed or missing'}`,
        `host-owned negative gap probes: interpolation enablement=${hostSuccess ? (declaredGapCorruptionRejected ? 'rejected' : 'accepted') : 'not run'}; null-dropping break-path=${hostSuccess ? (linePathCorruptionRejected ? 'rejected' : 'accepted') : 'not run'}`,
        `host-owned static specification verification: success=${hostSuccess ? 'passed' : 'failed'}; negative gap corruption=${hostSuccess ? (negativeRejected ? 'rejected' : 'accepted') : 'not run'}; recovery reread=${hostSuccess ? (recoveryPassed ? 'passed' : 'failed') : 'not run'}; artifactSha256=${input?.sha256 ?? 'unavailable'}; sourceSha256=${sourceSha256 ?? 'unavailable'}`,
        'Verification scope: structured specification checks with an in-memory gap corruption probe and final-file reread; browser rendering and reader usability are unobserved. Candidate execution claims are not verification evidence.',
      ],
    };
  },
};

const conversionData = [
  { region: 'West', eligibleSessions: 4000, conversions: 320 },
  { region: 'East', eligibleSessions: 100, conversions: 12 },
  { region: 'North', eligibleSessions: 2000, conversions: 180 },
  { region: 'South', eligibleSessions: 50, conversions: 6 },
  { region: 'Central', eligibleSessions: 800, conversions: 64 },
  { region: 'Northeast', eligibleSessions: 40, conversions: 6 },
  { region: 'Southwest', eligibleSessions: 25, conversions: 2 },
  { region: null, regionCode: 'R8', eligibleSessions: 1000, conversions: 70 },
];

const visConversionMaterializer: SkillEvalFixtureMaterializer = {
  id: 'data-visualization/regional-conversion-denominator@5',
  matches: (scenario) => scenario.id === VIS_CONVERSION,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'data/conversion.json',
      `${JSON.stringify(conversionData, null, 2)}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Data visualization — regional conversion comparison

Build a rate comparison, not a raw-count pie or geographic map. No reader persona or downstream product decision is supplied; keep both unspecified. Produce \`.kory-eval/visualization-conversion.json\` containing an ordered chart specification plus the accessible/narrow-screen table rows.

For every row retain the exact eligible-session denominator + conversions and calculate \`rate = conversions / eligibleSessions\`. Calculate a 95% Wilson binomial interval using z=1.96 for every region (bounds checked independently by the host, tolerance 0.002 for rounding), sample size, and a visible per-row low-sample flag for regions with fewer than 50 eligible sessions (Northeast=40, Southwest=25). Interval bounds must be finite numeric probabilities in [0, 1], with lower < upper and the rate inside the interval. Bounds may use \`lower95\`/\`upper95\`, \`lower\`/\`upper\`, or an \`interval95\` array/object. The missing label for \`regionCode=R8\` must be exposed on that row as unknown/unresolved rather than silently dropped or invented. Keep exactly one row per source region, ordered by ascending or descending rate consistently with the declared direction; ties may appear in any order. The accessible/narrow-screen rows must follow that order, and low-sample regions remain visible. Keep \`data/conversion.json\` unchanged.

Use a structured \`chart\` or \`encoding\` object specifying the dot/point-and-interval chart type, quantitative rate axis (\`x.field=rate\` or \`point.field=rate\`), interval lower/upper field mappings, and rate ordering. Do not use area or geography. Include text alternative/table and narrow-screen behavior. Product-strategy recommendations are out of scope. Record hierarchy boundary: broader \`data-analysis\` + \`visual-interface-design\`; \`data-pipeline-engineering\` is not being changed.

The host scorer runs static specification checks after applying your patch: it validates the final rows and source integrity, rejects an in-memory copy with a corrupted denominator, then rereads and revalidates the unchanged final artifact/source for recovery. Its persisted score evidence binds those results to \`artifactSha256\` and \`sourceSha256\`. This checks the structured specification, not browser rendering or reader usability. Candidate-authored execution records do not count as host verification. In text-patch mode, label your own checks unobserved/unavailable; do not fabricate commands, hashes, or executed success/negative/recovery claims. No candidate-authored \`.kory-eval/visualization-conversion-verification.json\` is required.
`,
    );
  },
};

function extractRows(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  for (const key of ['rows', 'table', 'data', 'regions']) {
    const candidate = obj[key];
    if (Array.isArray(candidate) && candidate.every((item) => item && typeof item === 'object')) {
      return candidate as Array<Record<string, unknown>>;
    }
    if (candidate && typeof candidate === 'object') {
      const nested = extractRows(candidate);
      if (nested.length) return nested;
    }
  }
  for (const candidate of Object.values(obj)) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const nested = extractRows(candidate);
      if (nested.length) return nested;
    }
  }
  return [];
}

function numberFrom(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function hasIndependentYScale(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  const resolveValue = root.resolve;
  if (!resolveValue || typeof resolveValue !== 'object' || Array.isArray(resolveValue))
    return false;
  const scaleValue = (resolveValue as Record<string, unknown>).scale;
  if (!scaleValue || typeof scaleValue !== 'object' || Array.isArray(scaleValue)) return false;
  return (scaleValue as Record<string, unknown>).y === 'independent';
}

function exactTextFrom(row: Record<string, unknown>, keys: string[]): string[] {
  return keys.flatMap((key) => {
    const value = row[key];
    return typeof value === 'string' ? [value.trim().toLowerCase()] : [];
  });
}

function matchesConversionRow(
  row: Record<string, unknown>,
  expected: (typeof conversionData)[number],
): boolean {
  if (expected.region !== null) {
    return exactTextFrom(row, [
      'region',
      'label',
      'displayLabel',
      'display_label',
      'regionLabel',
      'region_label',
      'regionName',
      'region_name',
      'name',
    ]).includes(expected.region.toLowerCase());
  }
  if (exactTextFrom(row, ['regionCode', 'region_code', 'code']).includes('r8')) return true;
  return exactTextFrom(row, [
    'label',
    'displayLabel',
    'display_label',
    'regionLabel',
    'region_label',
    'name',
  ]).some((value) => /(?:^|[^a-z0-9])r8(?:$|[^a-z0-9])/u.test(value));
}

function hasAffirmativeClaim(
  body: string,
  concepts: RegExp[],
  ignoreQuestionFraming = false,
): boolean {
  const negated =
    /\b(?:do not|does not|did not|must not|should not|cannot|never|without|unchanged|preserv(?:e|es|ed|ing)|out of scope|temporal only|not\s+(?:used|intended|meant|presented|selected|applicable))\b/u;
  const questionFraming = /\b(?:determine|assess|test|evaluate|check)\s+whether\b/u;
  return body
    .split(/[.!?;\n]+/u)
    .some(
      (clause) =>
        concepts.every((concept) => concept.test(clause)) &&
        !negated.test(clause) &&
        !(ignoreQuestionFraming && questionFraming.test(clause)),
    );
}

function intervalFrom(row: Record<string, unknown>): [number, number] | null {
  const intervals: Array<[number, number]> = [];
  const pairFrom = (record: Record<string, unknown>, lowerKeys: string[], upperKeys: string[]) => {
    const lows = lowerKeys.filter((key) => key in record).map((key) => record[key]);
    const highs = upperKeys.filter((key) => key in record).map((key) => record[key]);
    if (!lows.length && !highs.length) return true;
    if (
      !lows.length ||
      !highs.length ||
      ![...lows, ...highs].every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      !lows.every((value) => value === lows[0]) ||
      !highs.every((value) => value === highs[0])
    )
      return false;
    intervals.push([lows[0] as number, highs[0] as number]);
    return true;
  };
  if (
    !pairFrom(
      row,
      ['lower', 'lowerBound', 'lower_bound', 'ciLow', 'ci_low', 'lower95'],
      ['upper', 'upperBound', 'upper_bound', 'ciHigh', 'ci_high', 'upper95'],
    )
  )
    return null;
  for (const key of [
    'interval95',
    'interval_95',
    'confidenceInterval',
    'confidence_interval',
    'ci95',
    'interval',
  ]) {
    if (!(key in row)) continue;
    const value = row[key];
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'number' &&
      Number.isFinite(value[0]) &&
      typeof value[1] === 'number' &&
      Number.isFinite(value[1])
    ) {
      intervals.push([value[0], value[1]]);
    } else {
      const nested = asRecord(value);
      const before = intervals.length;
      if (
        !nested ||
        !pairFrom(
          nested,
          ['lower', 'lowerBound', 'lower_bound', 'low', 'min', 'lower95'],
          ['upper', 'upperBound', 'upper_bound', 'high', 'max', 'upper95'],
        ) ||
        intervals.length === before
      )
        return null;
    }
  }
  const first = intervals[0];
  return first && intervals.every(([lower, upper]) => lower === first[0] && upper === first[1])
    ? first
    : null;
}

function conversionRateFrom(row: Record<string, unknown>): number | null {
  const rate = numberFrom(row, ['rate', 'conversionRate', 'conversion_rate', 'value']);
  return rate !== null && rate > 1 ? rate / 100 : rate;
}

function wilson95(conversions: number, eligibleSessions: number): [number, number] {
  const rate = conversions / eligibleSessions;
  const z = 1.96;
  const z2 = z * z;
  const scale = 1 + z2 / eligibleSessions;
  const center = (rate + z2 / (2 * eligibleSessions)) / scale;
  const halfWidth =
    (z * Math.sqrt((rate * (1 - rate) + z2 / (4 * eligibleSessions)) / eligibleSessions)) /
    scale;
  return [center - halfWidth, center + halfWidth];
}

function conversionChartIsEncoded(
  artifact: unknown,
  rows: Array<Record<string, unknown>>,
): boolean {
  const root = asRecord(artifact);
  const chart = asRecord(root?.chart) ?? asRecord(root?.encoding);
  if (!chart) return false;
  const type = typeof chart.type === 'string' ? chart.type.toLowerCase() : '';
  const encoding = asRecord(chart.encoding) ?? chart;
  const axis = asRecord(encoding.x) ?? asRecord(encoding.point);
  const interval = asRecord(encoding.interval);
  const lowerField = interval?.lowerField ?? interval?.lower ?? interval?.low;
  const upperField = interval?.upperField ?? interval?.upper ?? interval?.high;
  const fieldValue = (row: Record<string, unknown>, field: string): unknown =>
    field.split('.').reduce<unknown>((current, key) => asRecord(current)?.[key], row);
  const encodedBounds = rows.every((row) => {
    const canonical = intervalFrom(row);
    if (!canonical || typeof axis?.field !== 'string' ||
        typeof fieldValue(row, axis.field) !== 'number') return false;
    if (interval?.field === 'interval95') {
      const value = fieldValue(row, 'interval95');
      if (Array.isArray(value)) return value.length === 2 &&
        value[0] === canonical[0] && value[1] === canonical[1];
      const nested = asRecord(value);
      return nested?.lower === canonical[0] && nested?.upper === canonical[1];
    }
    if (typeof lowerField !== 'string' || typeof upperField !== 'string') return false;
    return fieldValue(row, lowerField) === canonical[0] &&
      fieldValue(row, upperField) === canonical[1];
  });
  return (
    /dot|point/u.test(type) &&
    /interval|error.bar/u.test(type) &&
    axis?.field === 'rate' &&
    (axis.type === undefined || axis.type === 'quantitative') &&
    encodedBounds
  );
}

function conversionRowsAreOrdered(
  artifact: unknown,
  rows: Array<Record<string, unknown>>,
): boolean {
  const rates = rows.map(conversionRateFrom);
  if (!rates.length || rates.some((rate) => rate === null)) return false;
  const directions = textValuesForKeys(
    artifact,
    new Set(['order', 'ordering', 'sort', 'direction']),
  ).join(' ');
  const ascending = /\basc(?:ending)?\b/u.test(directions);
  const descending = /\bdesc(?:ending)?\b/u.test(directions);
  if (ascending && descending) return false;
  const isAscending = rates.every((rate, index) => index === 0 || rate! >= rates[index - 1]!);
  const isDescending = rates.every((rate, index) => index === 0 || rate! <= rates[index - 1]!);
  return ascending ? isAscending : descending ? isDescending : isAscending || isDescending;
}

function inspectConversionArtifact(artifact: unknown) {
  const body = normalized(artifact);
  const rows = extractRows(artifact);
  const numericRows =
    rows.length === conversionData.length &&
    rows.every(
      (row) =>
        conversionData.filter((expected) => matchesConversionRow(row, expected)).length === 1,
    ) &&
    conversionData.every((expected) => {
      const matching = rows.filter((candidate) => matchesConversionRow(candidate, expected));
      if (matching.length !== 1) return false;
      const row = matching[0];
      if (!row) return false;
      const sessions = numberFrom(row, ['eligibleSessions', 'eligible_sessions', 'sessions', 'n']);
      const conversions = numberFrom(row, ['conversions', 'converted']);
      const rate = conversionRateFrom(row);
      const interval = intervalFrom(row);
      const lower = interval?.[0] ?? null;
      const upper = interval?.[1] ?? null;
      const expectedRate = expected.conversions / expected.eligibleSessions;
      const [expectedLower, expectedUpper] = wilson95(expected.conversions, expected.eligibleSessions);
      return (
        sessions === expected.eligibleSessions &&
        conversions === expected.conversions &&
        rate !== null &&
        Math.abs(rate - expectedRate) <= 0.001 &&
        lower !== null &&
        upper !== null &&
        lower >= 0 &&
        upper <= 1 &&
        lower <= expectedRate &&
        upper >= expectedRate &&
        lower < upper &&
        Math.abs(lower - expectedLower) <= 0.002 &&
        Math.abs(upper - expectedUpper) <= 0.002
      );
    });
  const ordered = conversionRowsAreOrdered(artifact, rows);
  const lowSamples = conversionData.every((expected) => {
    const row = rows.find((candidate) => matchesConversionRow(candidate, expected));
    if (!row) return false;
    const flag = row.lowSample ?? row.low_sample;
    const detail = exactTextFrom(row, [
      'status', 'lowSampleFlag', 'low_sample_flag', 'lowSampleLabel', 'low_sample_label',
    ]).join(' ');
    // The task asks for "a visible per-row low-sample flag". A per-row boolean is
    // that flag, so a row that sets it and a row that carries a matching label both
    // count. An unmarked small row still fails, and a large row must not be marked.
    const labelled = /low.?sample|small.?sample|fewer than 50/u.test(detail);
    return expected.eligibleSessions < 50
      ? flag === true || (flag !== false && labelled)
      : flag !== true;
  });
  const unknownRow = rows.find((row) => matchesConversionRow(row, conversionData[7]!));
  const missingLabel = Boolean(unknownRow) && exactTextFrom(unknownRow!, [
    'region', 'label', 'displayLabel', 'display_label', 'displayRegion', 'regionLabel', 'region_label', 'name',
  ]).some((label) => /unknown|unresolved/u.test(label));
  const encoding = conversionChartIsEncoded(artifact, rows) &&
    !/pie chart|map encoding|geographic map/u.test(body);
  const access =
    /table/u.test(body) &&
    /text|accessible|alternative/u.test(body) &&
    /narrow|mobile|small screen/u.test(body);
  const boundary =
    readerIsEvidenceBound(artifact) &&
    !hasAffirmativeClaim(body, [/product strategy|recommend[^.]{0,60}strategy/u]) &&
    !hasAffirmativeClaim(body, [
      /\b(?:modify|change|rewrite)\b/u,
      /\b(?:pipeline|source data|metric definition)\b/u,
    ]);
  const substantive =
    Boolean(artifact) &&
    numericRows &&
    ordered &&
    lowSamples &&
    missingLabel &&
    encoding &&
    access &&
    boundary;
  return {
    substantive,
    numericRows,
    ordered,
    lowSamples,
    missingLabel,
    encoding,
    access,
    boundary,
  };
}

function readConversionArtifact(root: string) {
  try {
    const text = readFixtureText(root, '.kory-eval/visualization-conversion.json');
    return {
      artifact: JSON.parse(text) as unknown,
      sha256: createHash('sha256').update(text).digest('hex'),
    };
  } catch {
    return null;
  }
}

const visConversionScorer: SkillEvalDeterministicScorer = {
  id: 'data-visualization/regional-conversion-denominator-scorer@10',
  scenarioIds: [VIS_CONVERSION],
  score: ({ workingDirectory }) => {
    const input = readConversionArtifact(workingDirectory);
    let sourceText: string | null = null;
    try {
      sourceText = readFixtureText(workingDirectory, 'data/conversion.json');
    } catch {
      /* Missing or unsafe source fails integrity below. */
    }
    const sourceIntegrity = sourceText === `${JSON.stringify(conversionData, null, 2)}\n`;
    const sourceSha256 =
      sourceText === null ? null : createHash('sha256').update(sourceText).digest('hex');
    const checks = inspectConversionArtifact(input?.artifact);
    const {
      substantive,
      numericRows,
      ordered,
      lowSamples,
      missingLabel,
      encoding,
      access,
      boundary,
    } = checks;
    const success = sourceIntegrity && substantive;
    // This is an executed host-owned mutation probe, not a candidate's execution claim.
    // Keep it in memory so verification never overwrites candidate-owned files.
    let negativeRejected = false;
    if (success) {
      const corrupted = structuredClone(input!.artifact);
      const row = extractRows(corrupted)[0]!;
      for (const key of ['eligibleSessions', 'eligible_sessions', 'sessions', 'n']) row[key] = -1;
      negativeRejected = !inspectConversionArtifact(corrupted).numericRows;
    }
    const recovery = readConversionArtifact(workingDirectory);
    let recoveryPassed = false;
    try {
      recoveryPassed =
        success &&
        recovery?.sha256 === input?.sha256 &&
        readFixtureText(workingDirectory, 'data/conversion.json') === sourceText &&
        inspectConversionArtifact(recovery?.artifact).substantive;
    } catch {
      /* Recovery must revalidate the real final files. */
    }
    const passed = success && negativeRejected && recoveryPassed;
    return {
      passed,
      quality: passed
        ? 1
        : substantive
          ? 0.75
          : numericRows && lowSamples && encoding
            ? 0.75
            : numericRows
              ? 0.5
              : 0,
      verification: passed ? 1 : 0,
      integrityFailure: !sourceIntegrity,
      evidence: [
        `fixed conversion source integrity: ${sourceIntegrity ? 'preserved' : 'changed or missing'}`,
        `all 8 denominators/rates/intervals numerically correct: ${numericRows ? 'yes' : 'no'}`,
        `rows follow the declared rate ordering: ${ordered ? 'yes' : 'no'}`,
        `two <50 samples visibly flagged: ${lowSamples ? 'yes' : 'no'}`,
        `missing R8 label preserved as unknown: ${missingLabel ? 'yes' : 'no'}`,
        `rate-comparison encoding/order: ${encoding ? 'appropriate' : 'incorrect/incomplete'}`,
        `accessible narrow-screen fallback: ${access ? 'present' : 'missing'}`,
        `reader/pipeline/metric/product-strategy ownership remains evidence-bound: ${boundary ? 'bounded' : 'incorrect'}`,
        `host-owned static specification verification: success=${success ? 'passed' : 'failed'}; negative denominator corruption=${success ? (negativeRejected ? 'rejected' : 'accepted') : 'not run'}; recovery reread=${success ? (recoveryPassed ? 'passed' : 'failed') : 'not run'}; artifactSha256=${input?.sha256 ?? 'unavailable'}; sourceSha256=${sourceSha256 ?? 'unavailable'}`,
        'Verification scope: structured specification checks with an in-memory negative probe and final-file reread; browser rendering and reader usability are unobserved. Candidate execution claims are not verification evidence.',
      ],
    };
  },
};

export const DATA_PERFORMANCE_VISUALIZATION_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [dbSkewMaterializer, dbMigrationMaterializer, visCapacityMaterializer, visConversionMaterializer];

export const DATA_PERFORMANCE_VISUALIZATION_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  dbSkewScorer,
  dbMigrationScorer,
  visCapacityScorer,
  visConversionScorer,
];
