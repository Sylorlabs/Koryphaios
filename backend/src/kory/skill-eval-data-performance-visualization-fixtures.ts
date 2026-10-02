import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const DB_SKEW = 'database-performance-full-task-1-individual';
const DB_MIGRATION = 'database-performance-full-task-2-individual';
const VIS_CAPACITY = 'data-visualization-full-task-1-individual';
const VIS_CONVERSION = 'data-visualization-full-task-2-individual';

function normalized(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
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
  id: 'database-performance/skewed-orders-plan-regression-scorer@2',
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
    const hierarchy =
      /performance-debugging/u.test(body) &&
      /gpu-compute/u.test(body) &&
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
  id: 'database-performance/migration-lock-amplification-scorer@1',
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
      /performance-debugging/u.test(body) &&
      /mongodb-engineering/u.test(body) &&
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
  id: 'data-visualization/capacity-trend-uncertainty-chart@1',
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

The decision task is when to consider adding capacity, not why latency changed. Redesign the representation from \`data/capacity.json\` without changing/inventing telemetry. Produce \`.kory-eval/visualization-capacity.json\` as a structured visualization specification + accessible table/description.

Required semantics: 5-minute time grain; latency in milliseconds; throughput in requests/sec; median and p95 remain distinguishable (not a smoothed average); the two missing intervals at 10:10/10:15 are explicit gaps and must not be interpolated; deployment annotation is visible at 10:15; throughput cannot silently share a misleading latency scale; non-color distinctions and a text/table fallback expose every observed point/gap. Do not claim the deployment caused the p95 spike.

Record hierarchy boundary: broader \`data-analysis\` + \`visual-interface-design\`; \`analytics-engineering\` is not being used to redefine telemetry/model semantics.
`,
    );
  },
};

const visCapacityScorer: SkillEvalDeterministicScorer = {
  id: 'data-visualization/capacity-trend-uncertainty-chart-scorer@1',
  scenarioIds: [VIS_CAPACITY],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/visualization-capacity.json',
    );
    const body = normalized(artifact);
    const encodings =
      /median/u.test(body) &&
      /p95/u.test(body) &&
      /throughput/u.test(body) &&
      /requests\/sec|rps/u.test(body) &&
      /millisecond|\bms\b/u.test(body) &&
      /5-minute|5 minute/u.test(body) &&
      /deployment|deploy-2026\.09\.06\.1/u.test(body);
    const gaps =
      /10:10/u.test(body) &&
      /10:15/u.test(body) &&
      /gap|missing|unavailable/u.test(body) &&
      /no interpolation|not interpolat|break.*line|line.*break/u.test(body);
    const access =
      /table/u.test(body) &&
      /description|text alternative|accessible/u.test(body) &&
      /dash|marker|shape|pattern|line style|non-color/u.test(body);
    const scales = /separate.*axis|separate.*panel|secondary.*axis|distinct.*scale/u.test(body);
    const bounded =
      /data-analysis/u.test(body) &&
      /visual-interface-design/u.test(body) &&
      /analytics-engineering/u.test(body) &&
      /not selected|boundary|out of scope/u.test(body) &&
      !/deployment[^.]{0,40}(?:caused|cause of)/u.test(body);
    const passed = Boolean(artifact) && encodings && gaps && access && scales && bounded;
    return {
      passed,
      quality: passed ? 1 : encodings && gaps && access ? 0.75 : encodings && gaps ? 0.5 : 0,
      verification: encodings && gaps && access && scales ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `median/p95/throughput/deploy encoding: ${encodings ? 'complete' : 'incomplete'}`,
        `missing intervals explicitly non-interpolated: ${gaps ? 'yes' : 'no'}`,
        `non-color + table/text fallback: ${access ? 'present' : 'missing'}`,
        `latency/throughput scales remain legible: ${scales ? 'yes' : 'no'}`,
        `hierarchy + no causal invention: ${bounded ? 'bounded' : 'incorrect/incomplete'}`,
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
  id: 'data-visualization/regional-conversion-denominator@1',
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

Build a rate comparison, not a raw-count pie or geographic map. Produce \`.kory-eval/visualization-conversion.json\` containing an ordered chart specification plus the accessible/narrow-screen table rows.

For every row retain the exact eligible-session denominator + conversions and calculate \`rate = conversions / eligibleSessions\`. Include an uncertainty interval around each rate (a 95% binomial/Wilson-style interval is appropriate), sample size, and a visible low-sample flag for regions with fewer than 50 eligible sessions (Northeast=40, Southwest=25). The missing label for \`regionCode=R8\` must be exposed as an unknown/unresolved label rather than silently dropped or invented. Meaningful ordering should compare rates; low-sample regions remain visible.

Use a position/interval encoding suitable for rate comparison, not area or geography. Include text alternative/table and narrow-screen behavior. Product-strategy recommendations are out of scope. Record hierarchy boundary: broader \`data-analysis\` + \`visual-interface-design\`; \`data-pipeline-engineering\` is not being changed.
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

const visConversionScorer: SkillEvalDeterministicScorer = {
  id: 'data-visualization/regional-conversion-denominator-scorer@1',
  scenarioIds: [VIS_CONVERSION],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/visualization-conversion.json',
    );
    const body = normalized(artifact);
    const rows = extractRows(artifact);
    const numericRows = conversionData.every((expected) => {
      const label = expected.region ?? 'r8';
      const row = rows.find((candidate) => {
        const candidateText = JSON.stringify(candidate).toLowerCase();
        return (
          candidateText.includes(label.toLowerCase()) ||
          (expected.region === null && candidateText.includes('r8'))
        );
      });
      if (!row) return false;
      const sessions = numberFrom(row, ['eligibleSessions', 'eligible_sessions', 'sessions', 'n']);
      const conversions = numberFrom(row, ['conversions', 'converted']);
      let rate = numberFrom(row, ['rate', 'conversionRate', 'conversion_rate', 'value']);
      if (rate !== null && rate > 1) rate /= 100;
      const lower = numberFrom(row, ['lower', 'lowerBound', 'lower_bound', 'ciLow', 'ci_low']);
      const upper = numberFrom(row, ['upper', 'upperBound', 'upper_bound', 'ciHigh', 'ci_high']);
      const expectedRate = expected.conversions / expected.eligibleSessions;
      return (
        sessions === expected.eligibleSessions &&
        conversions === expected.conversions &&
        rate !== null &&
        Math.abs(rate - expectedRate) <= 0.001 &&
        lower !== null &&
        upper !== null &&
        lower <= expectedRate &&
        upper >= expectedRate &&
        lower < upper
      );
    });
    const lowSamples =
      /northeast/u.test(body) &&
      /southwest/u.test(body) &&
      /40/u.test(body) &&
      /25/u.test(body) &&
      /low.?sample|small.?sample|n<50|fewer than 50/u.test(body);
    const missingLabel =
      /r8/u.test(body) && /unknown|unresolved|missing.*label|label.*missing/u.test(body);
    const encoding =
      /dot|point|bar|interval|error bar|confidence/u.test(body) &&
      /order|sort|rank/u.test(body) &&
      !/pie chart|map encoding|geographic map/u.test(body);
    const access =
      /table/u.test(body) &&
      /text|accessible|alternative/u.test(body) &&
      /narrow|mobile|small screen/u.test(body);
    const boundary =
      /data-analysis/u.test(body) &&
      /visual-interface-design/u.test(body) &&
      /data-pipeline-engineering/u.test(body) &&
      /not selected|out of scope|boundary/u.test(body) &&
      !/product strategy|recommend.*strategy/u.test(body);
    const passed =
      Boolean(artifact) &&
      numericRows &&
      lowSamples &&
      missingLabel &&
      encoding &&
      access &&
      boundary;
    return {
      passed,
      quality: passed ? 1 : numericRows && lowSamples && encoding ? 0.75 : numericRows ? 0.5 : 0,
      verification: numericRows && lowSamples && missingLabel ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `all 8 denominators/rates/intervals numerically correct: ${numericRows ? 'yes' : 'no'}`,
        `two <50 samples visibly flagged: ${lowSamples ? 'yes' : 'no'}`,
        `missing R8 label preserved as unknown: ${missingLabel ? 'yes' : 'no'}`,
        `rate-comparison encoding/order: ${encoding ? 'appropriate' : 'incorrect/incomplete'}`,
        `accessible narrow-screen fallback: ${access ? 'present' : 'missing'}`,
        `visualization/pipeline/product-strategy boundary: ${boundary ? 'bounded' : 'missing'}`,
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
