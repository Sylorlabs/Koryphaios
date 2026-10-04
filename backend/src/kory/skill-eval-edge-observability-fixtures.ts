import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const EDGE_PRIVACY = 'edge-cdn-full-task-1-individual';
const EDGE_TIERED = 'edge-cdn-full-task-2-individual';
const OBS_CHECKOUT = 'observability-sre-full-task-1';
const OBS_SAMPLING = 'observability-sre-full-task-2';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

const EDGE_SIM = `export interface PrivacyPolicy {
  revision:string;
  accountMode:'bypass'|'bounded-key';
  boundedIdentityDimension?:'session-class'|'account-id';
  cacheSetCookie:boolean;
  keyDimensions:string[];
  purgeDimensions:string[];
  unrelatedAssetCacheable:boolean;
}

export interface Request { path:string; user?:string; query?:string; rewrite?:string; logout?:boolean }
export function representation(req:Request):string {
  if(req.path==='/account') return req.logout||!req.user?'anon-account':'account:'+req.user;
  return 'asset:'+req.path;
}
export function keyFor(policy:PrivacyPolicy,req:Request):string|null {
  if(req.path==='/account'&&req.user&&policy.accountMode==='bypass')return null;
  const parts=[req.path];
  for(const dim of policy.keyDimensions){if(dim==='user'&&req.user)parts.push('u='+req.user);if(dim==='query')parts.push('q='+(req.query??''));if(dim==='rewrite')parts.push('r='+(req.rewrite??''));}
  return parts.join('|');
}
export function privacySafe(policy:PrivacyPolicy):boolean {
  if(policy.cacheSetCookie)return false;
  if(policy.accountMode==='bypass')return policy.unrelatedAssetCacheable;
  return policy.boundedIdentityDimension==='account-id'&&policy.keyDimensions.includes('user')&&policy.unrelatedAssetCacheable;
}

export interface TieredPolicy {
  revision:string;
  keyDimensions:string[];
  purgeDimensions:string[];
  ttlSeconds:number;
  staleWhileRevalidateSeconds:number;
  validators:boolean;
  tiered:boolean;
  originTlsHostnameVerified:boolean;
  originTlsTrustVerified:boolean;
  rollbackRevision:string;
}
export function tieredOriginFetches(policy:TieredPolicy,pops:number):number {
  if(!policy.tiered)return pops;
  return 1;
}
export function staleBehavior(policy:TieredPolicy,ageSeconds:number,originHealthy:boolean):'fresh'|'stale-updating'|'error'|'expired' {
  if(ageSeconds<=policy.ttlSeconds)return'fresh';
  if(ageSeconds<=policy.ttlSeconds+policy.staleWhileRevalidateSeconds)return originHealthy?'stale-updating':'stale-updating';
  return originHealthy?'expired':'error';
}
`;

const edgePrivacyMaterializer: SkillEvalFixtureMaterializer = {
  id: 'edge-cdn/account-cache-privacy@1',
  matches: (s) => s.id === EDGE_PRIVACY,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-edge-privacy'));
    writeFixtureFile(d, 'src/edge-sim.ts', EDGE_SIM);
    writeFixtureFile(
      d,
      'evidence/traces.json',
      `${JSON.stringify(
        {
          provider: 'synthetic-cdn',
          zone: 'zone-7',
          revision: 'rev-bad-42',
          accountRule: { cacheable: true, key: ['path'], override: 'public,max-age=120' },
          traces: [
            { pop: 'SFO', user: 'alice', status: 'MISS', body: 'account:alice' },
            { pop: 'SFO', user: 'bob', status: 'HIT', body: 'account:alice' },
            { pop: 'IAD', user: 'anonymous', status: 'MISS', body: 'anon-account' },
          ],
          purge: { dimensions: ['path'] },
          unrelatedAsset: { path: '/assets/app.js', hitRate: 0.96 },
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Shared-CDN authenticated-cache privacy fixture

Preserve the trace evidence/simulator. Write \`.kory-eval/edge-privacy-policy.json\` as \`PrivacyPolicy\`. The safest valid correction is authenticated account-page bypass/private behavior; a bounded auditable account-id key is accepted only when every personalized representation dimension is actually keyed. Never use an unbounded raw Authorization/Cookie string as the cache key. \`Set-Cookie\` responses are not shared-cacheable.

The old contaminated path-only variants and any new bounded-key variants must be targeted for purge with dimensions matching actual old/new key semantics. Unrelated static assets remain cacheable. Write \`.kory-eval/edge-privacy-evidence.json\` reconstructing current route cacheability/key, exact missing dimension, cold/warm POP verification for anonymous/alice/bob/logout/login/query/rewrite, cache-status/Age/body identity, targeted purge, origin-load impact, deployed revision and rollback safety. Synthetic provider evidence must stay labeled synthetic.
`,
    );
  },
};
const edgePrivacyScorer: SkillEvalDeterministicScorer = {
  id: 'edge-cdn/account-cache-privacy-scorer@1',
  scenarioIds: [EDGE_PRIVACY],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{keyFor,privacySafe,representation,type PrivacyPolicy}from'../src/edge-sim';const p=JSON.parse(readFileSync('.kory-eval/edge-privacy-policy.json','utf8')) as PrivacyPolicy;
test('hidden: authenticated representations cannot cross cache identity',()=>{expect(privacySafe(p)).toBe(true);const a={path:'/account',user:'alice'},b={path:'/account',user:'bob'};const ka=keyFor(p,a),kb=keyFor(p,b);if(ka!==null&&kb!==null)expect(ka).not.toBe(kb);expect(representation(a)).not.toBe(representation(b));expect(p.cacheSetCookie).toBe(false);});
test('hidden: unrelated cache efficiency survives and purge covers key dimensions',()=>{expect(p.unrelatedAssetCacheable).toBe(true);for(const dim of p.keyDimensions)if(['query','rewrite','user'].includes(dim))expect(p.purgeDimensions).toContain(dim);});
`,
    );
    const fixed = readFileSync(join(workingDirectory, 'src/edge-sim.ts'), 'utf8') === EDGE_SIM;
    const trace = readFileSync(join(workingDirectory, 'evidence/traces.json'), 'utf8');
    const preserved = /rev-bad-42/.test(trace) && /account:alice/.test(trace);
    const ev = artifactText(workingDirectory, '.kory-eval/edge-privacy-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /cold/u.test(ev.text) &&
      /warm/u.test(ev.text) &&
      /alice/u.test(ev.text) &&
      /bob/u.test(ev.text) &&
      /logout|login/u.test(ev.text) &&
      /purge/u.test(ev.text) &&
      /age|cache-status|hit|miss/u.test(ev.text) &&
      /rollback/u.test(ev.text) &&
      /synthetic/u.test(ev.text);
    const passed = hidden.passed && fixed && preserved && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && fixed ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !preserved,
      evidence: [
        `cache isolation simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `contamination evidence preserved: ${preserved ? 'yes' : 'no'}`,
        `POP/purge/rollback evidence: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const edgeTieredMaterializer: SkillEvalFixtureMaterializer = {
  id: 'edge-cdn/tiered-swr-delivery@1',
  matches: (s) => s.id === EDGE_TIERED,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-edge-tiered'));
    writeFixtureFile(d, 'src/edge-sim.ts', EDGE_SIM);
    writeFixtureFile(
      d,
      'evidence/tiered-traces.json',
      `${JSON.stringify({ revision: 'rev-old', pops: ['SFO', 'IAD', 'FRA'], oldKey: ['path', 'locale'], newKey: ['path', 'locale', 'build'], badPurge: ['path', 'locale'], origin: { etag: 'v1', cacheControl: 'public, max-age=60, stale-while-revalidate=120' }, faults: ['timeout', '503'], tls: { hostname: 'origin.example', sni: 'origin.example' } }, null, 2)}\n`,
    );
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Tiered cache + stale-while-revalidate fixture

Write \`.kory-eval/edge-tiered-policy.json\` as \`TieredPolicy\`. Enable explicit tiering, TTL/freshness, validators and bounded asynchronous stale-while-revalidate. Cache retention is not freshness. Lower-tier MISS may be an upper-tier HIT and therefore not an origin request. The new deployment key includes the supplied \`build\` dimension; targeted purge must include every key dimension so stale deployment artifacts cannot survive a mismatched purge.

Origin timeout/5xx behavior and edge→origin TLS hostname/trust are independent checks. Write \`.kory-eval/edge-tiered-evidence.json\` for cold/warm/expired-updating/origin-failed/recovered POP states, lower/upper/origin observations, origin request reduction, validator/Age/cache status, corrected purge across tiers, TLS evidence, pinned revision and rollback without incompatible cached variants.
`,
    );
  },
};
const edgeTieredScorer: SkillEvalDeterministicScorer = {
  id: 'edge-cdn/tiered-swr-delivery-scorer@1',
  scenarioIds: [EDGE_TIERED],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{staleBehavior,tieredOriginFetches,type TieredPolicy}from'../src/edge-sim';const p=JSON.parse(readFileSync('.kory-eval/edge-tiered-policy.json','utf8')) as TieredPolicy;
test('hidden: tiering reduces fanout and stale policy is bounded',()=>{expect(p.tiered).toBe(true);expect(tieredOriginFetches(p,3)).toBeLessThan(3);expect(p.validators).toBe(true);expect(staleBehavior(p,p.ttlSeconds+1,true)).toBe('stale-updating');expect(staleBehavior(p,p.ttlSeconds+p.staleWhileRevalidateSeconds+1,false)).toBe('error');});
test('hidden: key/purge/TLS/rollback contract complete',()=>{expect(p.keyDimensions).toContain('build');for(const d of p.keyDimensions)expect(p.purgeDimensions).toContain(d);expect(p.originTlsHostnameVerified).toBe(true);expect(p.originTlsTrustVerified).toBe(true);expect(p.rollbackRevision).toBeTruthy();});
`,
    );
    const fixed = readFileSync(join(workingDirectory, 'src/edge-sim.ts'), 'utf8') === EDGE_SIM;
    const ev = artifactText(workingDirectory, '.kory-eval/edge-tiered-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /lower/u.test(ev.text) &&
      /upper/u.test(ev.text) &&
      /origin/u.test(ev.text) &&
      /expired|updating/u.test(ev.text) &&
      /timeout|503/u.test(ev.text) &&
      /tls/u.test(ev.text) &&
      /rollback/u.test(ev.text);
    const passed = hidden.passed && fixed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && fixed ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `tier/SWR/purge simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `tier/origin/TLS evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const OBS_SIM = `export interface CheckoutEvent{id:string;route:string;status:number;latencyMs:number;eligible:boolean;dependency?:string;tenantId?:string}
export interface CheckoutSpec{availabilityObjective:number;latencyObjective:number;latencyThresholdMs:number;windowDays:number;metricLabels:string[];page:{errorRateThreshold:number;latencyRateThreshold:number;windowMinutes:number;singlePage:boolean};collectorMetaMonitoring:boolean;blackBoxIndependent:boolean}
export function sli(spec:CheckoutSpec,events:CheckoutEvent[]){const eligible=events.filter(e=>e.eligible);const available=eligible.filter(e=>e.status<500).length/eligible.length;const fast=eligible.filter(e=>e.latencyMs<=spec.latencyThresholdMs).length/eligible.length;return{eligible:eligible.length,available,fast}}
export function metricSeries(spec:CheckoutSpec,events:CheckoutEvent[]):Set<string>{return new Set(events.map(e=>spec.metricLabels.map(k=>k==='operation'?e.route:k==='status'?String(Math.floor(e.status/100)+'xx'):k).join('|')))}

export interface SamplingSpec{metricLabels:string[];allowedTraceFields:string[];retainErrors:boolean;retainLatencyOverMs:number;normalSampleRate:number;collectorCapacityPerSecond:number;collectorQueueBounded:boolean;collectorDropMetric:boolean;exportFailureMetric:boolean;dashboardsUseUnsampledMetrics:boolean}
export function retainedTraceIds(spec:SamplingSpec,events:CheckoutEvent[]):string[]{return events.filter(e=>e.status>=500&&spec.retainErrors||e.latencyMs>spec.retainLatencyOverMs||(!spec.retainErrors&&spec.normalSampleRate>=1)).map(e=>e.id)}
`;
const checkoutCorpus = `${JSON.stringify(
  [
    { id: 'ok1', route: 'checkout', status: 200, latencyMs: 250, eligible: true, tenantId: 't1' },
    { id: 'ok2', route: 'checkout', status: 200, latencyMs: 400, eligible: true, tenantId: 't2' },
    {
      id: 'timeout1',
      route: 'checkout',
      status: 504,
      latencyMs: 2600,
      eligible: true,
      dependency: 'payments',
      tenantId: 't3',
    },
    { id: 'health', route: 'health', status: 200, latencyMs: 3, eligible: false },
  ],
  null,
  2,
)}\n`;
const obsCheckoutMaterializer: SkillEvalFixtureMaterializer = {
  id: 'observability-sre/checkout-sli-alert@1',
  matches: (s) => s.id === OBS_CHECKOUT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-observability-checkout'));
    writeFixtureFile(d, 'src/observability-sim.ts', OBS_SIM);
    writeFixtureFile(d, 'evidence/events.json', checkoutCorpus);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Checkout SLI/SLO + actionable paging fixture

Write \`.kory-eval/checkout-observability.json\` as \`CheckoutSpec\`. Availability and latency share an explicit eligible checkout denominator; health/admin/synthetic exclusions are explicit. Objective window is 28 days. Metric labels are bounded to service/operation/status-like dimensions—never request/customer/tenant id or raw unbounded path/error text. Correlation belongs in logs/traces.

The supplied payment timeout corpus must cross the declared sustained page rule only after its configured threshold/window and produce one actionable user-impact page with dashboard/runbook/dependency context; fresh good events after dependency recovery clear the alert according to rule. Collector/export interruption must be independently detectable so absent telemetry is not interpreted as healthy zero errors.

Write \`.kory-eval/checkout-observability-evidence.json\` with raw-event denominator calculation matching SLI, OTel semantic identity, injected timeout alert/clear timeline, bounded series inventory, dashboard/runbook target and collector-failure metamonitor result.
`,
    );
  },
};
const obsCheckoutScorer: SkillEvalDeterministicScorer = {
  id: 'observability-sre/checkout-sli-alert-scorer@1',
  scenarioIds: [OBS_CHECKOUT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{sli,metricSeries,type CheckoutEvent,type CheckoutSpec}from'../src/observability-sim';const spec=JSON.parse(readFileSync('.kory-eval/checkout-observability.json','utf8')) as CheckoutSpec;const events=JSON.parse(readFileSync('evidence/events.json','utf8')) as CheckoutEvent[];
test('hidden: SLI denominator/good rules operate on raw eligible events',()=>{expect(spec.windowDays).toBe(28);const r=sli(spec,events);expect(r.eligible).toBe(3);expect(r.available).toBeCloseTo(2/3);expect(r.fast).toBeCloseTo(2/3);expect(spec.availabilityObjective).toBeGreaterThan(0.9);expect(spec.latencyObjective).toBeGreaterThan(0.9);});
test('hidden: metric cardinality/privacy and telemetry failure policy bounded',()=>{const labels=spec.metricLabels.map(x=>x.toLowerCase());for(const bad of ['tenant','request','customer','raw_path','error_text'])expect(labels.some(x=>x.includes(bad))).toBe(false);expect(metricSeries(spec,events).size).toBeLessThanOrEqual(6);expect(spec.collectorMetaMonitoring||spec.blackBoxIndependent).toBe(true);expect(spec.page.singlePage).toBe(true);expect(spec.page.windowMinutes).toBeGreaterThan(0);});
`,
    );
    const fixed =
      readFileSync(join(workingDirectory, 'src/observability-sim.ts'), 'utf8') === OBS_SIM;
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/events.json'), 'utf8') === checkoutCorpus;
    const ev = artifactText(workingDirectory, '.kory-eval/checkout-observability-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /denominator|eligible/u.test(ev.text) &&
      /payment/u.test(ev.text) &&
      /page|alert/u.test(ev.text) &&
      /clear|recover/u.test(ev.text) &&
      /collector|export/u.test(ev.text) &&
      /runbook/u.test(ev.text);
    const passed = hidden.passed && fixed && corpus && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && fixed ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `SLI/cardinality simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `raw corpus preserved: ${corpus ? 'yes' : 'no'}`,
        `alert/recovery/metamonitor evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const samplingCorpus = `${JSON.stringify(
  [
    { id: 'n1', route: 'ingest', status: 200, latencyMs: 100, eligible: true, tenantId: 'a' },
    { id: 'n2', route: 'ingest', status: 200, latencyMs: 120, eligible: true, tenantId: 'b' },
    { id: 'slow', route: 'ingest', status: 200, latencyMs: 2501, eligible: true, tenantId: 'c' },
    { id: 'err', route: 'ingest', status: 503, latencyMs: 300, eligible: true, tenantId: 'd' },
  ],
  null,
  2,
)}\n`;
const obsSamplingMaterializer: SkillEvalFixtureMaterializer = {
  id: 'observability-sre/tail-sampling-cardinality@2',
  matches: (s) => s.id === OBS_SAMPLING,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-observability-sampling'));
    writeFixtureFile(d, 'src/observability-sim.ts', OBS_SIM);
    writeFixtureFile(d, 'evidence/replay.json', samplingCorpus);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# OTel sampling/cardinality fixture

Treat \`src/observability-sim.ts\` and \`evidence/replay.json\` as fixed evaluator-owned inputs. Do not edit, replace, or regenerate them; implement the policy and evidence in the requested output artifacts and add separate tests if useful.

Write \`.kory-eval/sampling-policy.json\` as \`SamplingSpec\`. Metric labels are bounded service/operation/status dimensions only; tenant/request correlation may remain only in privacy-approved trace/log fields. The required incident policy retains every error trace and every trace exceeding 2000 ms, which requires completed-trace/tail-capable logic rather than assuming 1% head sampling can inspect outcomes. Normal traffic may be sampled at a documented rate.

Collector/tail sampler has explicit capacity, bounded queue, drop metric and export-failure metric. Dashboards use unsampled metrics/event counters for full traffic/error denominators; retained trace counts are never presented as request population. Write \`.kory-eval/sampling-evidence.json\` with deterministic corpus retained IDs, bounded metric series count, privacy-field map, sampler capacity/backpressure/drop/export health and dashboard signal provenance.
`,
    );
  },
};
const obsSamplingScorer: SkillEvalDeterministicScorer = {
  id: 'observability-sre/tail-sampling-cardinality-scorer@1',
  scenarioIds: [OBS_SAMPLING],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{retainedTraceIds,type CheckoutEvent,type SamplingSpec}from'../src/observability-sim';const spec=JSON.parse(readFileSync('.kory-eval/sampling-policy.json','utf8')) as SamplingSpec;const events=JSON.parse(readFileSync('evidence/replay.json','utf8')) as CheckoutEvent[];
test('hidden: incident classes retained by outcome-aware policy',()=>{expect(spec.retainErrors).toBe(true);expect(spec.retainLatencyOverMs).toBeLessThanOrEqual(2000);const ids=retainedTraceIds(spec,events);expect(ids).toContain('slow');expect(ids).toContain('err');});
test('hidden: bounded metrics/privacy and sampler health',()=>{const labels=spec.metricLabels.map(x=>x.toLowerCase());expect(labels.some(x=>/tenant|request|raw/.test(x))).toBe(false);expect(spec.collectorCapacityPerSecond).toBeGreaterThan(0);expect(spec.collectorQueueBounded).toBe(true);expect(spec.collectorDropMetric).toBe(true);expect(spec.exportFailureMetric).toBe(true);expect(spec.dashboardsUseUnsampledMetrics).toBe(true);});
`,
    );
    const fixed =
      readFileSync(join(workingDirectory, 'src/observability-sim.ts'), 'utf8') === OBS_SIM;
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/replay.json'), 'utf8') === samplingCorpus;
    const ev = artifactText(workingDirectory, '.kory-eval/sampling-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /slow/u.test(ev.text) &&
      /err/u.test(ev.text) &&
      /series/u.test(ev.text) &&
      /privacy/u.test(ev.text) &&
      /drop|backpressure/u.test(ev.text) &&
      /unsampled/u.test(ev.text);
    const passed = hidden.passed && fixed && corpus && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && fixed ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `sampling/cardinality behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `replay corpus preserved: ${corpus ? 'yes' : 'no'}`,
        `sampler health/provenance evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const EDGE_OBSERVABILITY_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    edgePrivacyMaterializer,
    edgeTieredMaterializer,
    obsCheckoutMaterializer,
    obsSamplingMaterializer,
  ];
export const EDGE_OBSERVABILITY_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  edgePrivacyScorer,
  edgeTieredScorer,
  obsCheckoutScorer,
  obsSamplingScorer,
];
