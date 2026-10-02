import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const SECURITY_TENANT = 'security-verification-full-task-1';
const SECURITY_CACHE = 'security-verification-full-task-2';
const RELIABILITY_REPLAY = 'reliability-verification-full-task-1';
const RELIABILITY_BLACKHOLE = 'reliability-verification-full-task-2';

function run(root: string, code: string): { status: number | null; output: string } {
  const result = spawnSync('bun', ['-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });
  return { status: result.status, output: (result.stdout ?? '').trim() };
}

function normalized(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}

const DOCUMENT_API = `export type Role = 'editor' | 'viewer';
export interface Identity { id: string; tenant: 'A' | 'B'; role: Role; token: string; revoked?: boolean }
export interface DocumentRecord { id: string; tenant: 'A' | 'B'; title: string; content: string; deleted: boolean }

export class DocumentApiFixture {
  readonly identities: Record<string, Identity> = {
    'a-editor': { id: 'a-editor', tenant: 'A', role: 'editor', token: 'secret-token-a-editor' },
    'a-viewer': { id: 'a-viewer', tenant: 'A', role: 'viewer', token: 'secret-token-a-viewer' },
    'b-editor': { id: 'b-editor', tenant: 'B', role: 'editor', token: 'secret-token-b-editor' },
  };
  private docs = new Map<string, DocumentRecord>([
    ['doc-A', { id: 'doc-A', tenant: 'A', title: 'Tenant A title', content: 'A protected content', deleted: false }],
    ['doc-B', { id: 'doc-B', tenant: 'B', title: 'Tenant B title', content: 'B protected content', deleted: false }],
  ]);
  private effects: Array<{ kind: string; documentId: string }> = [];
  private audits: Array<Record<string, unknown>> = [];

  revoke(id: string): void { if (this.identities[id]) this.identities[id]!.revoked = true; }

  private deny(identity: Identity | null, action: string, documentId: string | null, reason: string): never {
    this.audits.push({ event: 'authorization_denied', actor: identity?.id ?? 'anonymous', action, documentId, reason });
    throw Object.assign(new Error('forbidden'), { status: identity ? 403 : 401 });
  }

  private actor(id: string | null): Identity {
    if (!id) return this.deny(null, 'authenticate', null, 'unauthenticated');
    const identity = this.identities[id];
    if (!identity) return this.deny(null, 'authenticate', null, 'unknown_identity');
    if (identity.revoked) return this.deny(identity, 'authenticate', null, 'revoked_session');
    return identity;
  }

  list(identityId: string | null): Array<{ id: string; title: string }> {
    const identity = this.actor(identityId);
    return [...this.docs.values()]
      .filter((doc) => doc.tenant === identity.tenant && !doc.deleted)
      .map((doc) => ({ id: doc.id, title: doc.title }));
  }

  read(identityId: string | null, documentId: string): { id: string; title: string; content: string } {
    const identity = this.actor(identityId);
    const doc = this.docs.get(documentId);
    if (!doc || doc.deleted || doc.tenant !== identity.tenant) this.deny(identity, 'read', documentId, 'tenant_or_object_denied');
    return { id: doc!.id, title: doc!.title, content: doc!.content };
  }

  rename(identityId: string | null, documentId: string, title: string): void {
    const identity = this.actor(identityId);
    const doc = this.docs.get(documentId);
    if (!doc || doc.deleted || doc.tenant !== identity.tenant) this.deny(identity, 'rename', documentId, 'tenant_or_object_denied');
    if (identity.role !== 'editor') this.deny(identity, 'rename', documentId, 'role_denied');
    doc!.title = title;
    this.effects.push({ kind: 'search-reindex', documentId });
  }

  delete(identityId: string | null, documentId: string): void {
    const identity = this.actor(identityId);
    const doc = this.docs.get(documentId);
    if (!doc || doc.deleted || doc.tenant !== identity.tenant) this.deny(identity, 'delete', documentId, 'tenant_or_object_denied');
    if (identity.role !== 'editor') this.deny(identity, 'delete', documentId, 'role_denied');
    doc!.deleted = true;
    this.effects.push({ kind: 'delete-index', documentId });
  }

  adminSnapshot() {
    return {
      documents: [...this.docs.values()].map((doc) => ({ ...doc })),
      sideEffects: this.effects.map((effect) => ({ ...effect })),
      audit: this.audits.map((event) => ({ ...event })),
    };
  }
}
`;

const securityTenantMaterializer: SkillEvalFixtureMaterializer = {
  id: 'security-verification/multitenant-documents@1',
  matches: (scenario) => scenario.id === SECURITY_TENANT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-security-tenant'));
    writeFixtureFile(destination, 'src/document-api.ts', DOCUMENT_API);
    writeFixtureFile(
      destination,
      'contract.md',
      `# Authorization contract

- Editors: list/read/rename/delete inside their own tenant.
- Viewers: list/read inside their own tenant; rename/delete denied.
- Cross-tenant object access is denied regardless of same role or knowledge of object id.
- Unauthenticated and revoked sessions are denied.
- Denied mutations must have zero durable document or queued-side-effect change.
- Denial audit events are required but must not contain document content, bearer/session tokens, or another tenant's protected fields.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Security verification — tenant isolation

Do not edit the completed API implementation. Exercise allowed controls and denied unauthenticated, revoked-session, wrong-role, and same-role cross-tenant cases for list/read/rename/delete. After each denied mutation compare independent \`adminSnapshot()\` document and side-effect state. Review denial response/audit content for secret/object-data leakage; UI visibility is not evidence.

Write \`.kory-eval/security-tenant.json\` with the allow/deny matrix, API boundary evidence, independent non-effect checks, sanitized-audit/leakage review, and a bounded synthetic-fixture verdict.
`,
    );
  },
};

const securityTenantScorer: SkillEvalDeterministicScorer = {
  id: 'security-verification/multitenant-documents-scorer@1',
  scenarioIds: [SECURITY_TENANT],
  score: ({ workingDirectory }) => {
    const sourcePreserved =
      readFileSync(join(workingDirectory, 'src/document-api.ts'), 'utf8') === DOCUMENT_API;
    const observation = run(
      workingDirectory,
      `import { DocumentApiFixture } from './src/document-api.ts';
const api = new DocumentApiFixture();
const result:any = { allowed:{}, denied:{}, nonEffects:[], audit:[] };
result.allowed.aEditorList = api.list('a-editor');
result.allowed.aViewerRead = api.read('a-viewer','doc-A');
api.rename('a-editor','doc-A','A renamed');
const denied = [
  ['viewer-delete', () => api.delete('a-viewer','doc-A')],
  ['cross-read', () => api.read('a-editor','doc-B')],
  ['cross-rename', () => api.rename('a-editor','doc-B','pwned')],
  ['cross-delete', () => api.delete('a-editor','doc-B')],
  ['unauth-read', () => api.read(null,'doc-A')],
] as const;
for (const [name, action] of denied) {
  const before = JSON.stringify(api.adminSnapshot());
  try { action(); result.denied[name] = 'unexpected-allow'; } catch (error:any) { result.denied[name] = { status:error.status, message:error.message }; }
  const after = api.adminSnapshot();
  if (name.includes('rename') || name.includes('delete')) result.nonEffects.push({ name, before, after: JSON.stringify(after) });
}
api.revoke('a-editor');
const beforeRevoked = JSON.stringify(api.adminSnapshot());
try { api.delete('a-editor','doc-A'); result.denied.revoked = 'unexpected-allow'; } catch (error:any) { result.denied.revoked = { status:error.status, message:error.message }; }
result.nonEffects.push({ name:'revoked-delete', before:beforeRevoked, after:JSON.stringify(api.adminSnapshot()) });
result.audit = api.adminSnapshot().audit;
console.log(JSON.stringify(result));`,
    );
    let result: any = null;
    try {
      result = JSON.parse(observation.output);
    } catch {
      result = null;
    }
    const deniedCorrect =
      result &&
      Object.values(result.denied).every(
        (value: any) => value?.status === 401 || value?.status === 403,
      ) &&
      result.denied['cross-read']?.status === 403 &&
      result.denied['cross-rename']?.status === 403 &&
      result.denied['cross-delete']?.status === 403 &&
      result.denied.revoked?.status === 403;
    const nonEffects =
      result?.nonEffects?.every((item: any) => {
        const before = JSON.parse(item.before);
        const after = JSON.parse(item.after);
        return (
          JSON.stringify(before.documents) === JSON.stringify(after.documents) &&
          JSON.stringify(before.sideEffects) === JSON.stringify(after.sideEffects)
        );
      }) === true;
    const auditText = JSON.stringify(result?.audit ?? []);
    const sanitized =
      /authorization_denied/u.test(auditText) &&
      !/secret-token|protected content|Tenant B title/u.test(auditText);
    const artifact = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/security-tenant.json');
    const body = normalized(artifact);
    const report =
      /a-editor/u.test(body) &&
      /a-viewer/u.test(body) &&
      /b-editor/u.test(body) &&
      /cross-tenant|tenant.*den/u.test(body) &&
      /revok/u.test(body) &&
      /unauth/u.test(body) &&
      /wrong-role|viewer/u.test(body) &&
      /non-effect|unchanged|side effect/u.test(body) &&
      /audit/u.test(body) &&
      /token|secret|leak/u.test(body) &&
      /synthetic|fixture/u.test(body) &&
      !/ui.*(?:proves|evidence)/u.test(body);
    const passed =
      sourcePreserved &&
      observation.status === 0 &&
      deniedCorrect &&
      nonEffects &&
      sanitized &&
      Boolean(artifact) &&
      report;
    return {
      passed,
      quality: passed
        ? 1
        : deniedCorrect && nonEffects && sanitized
          ? 0.75
          : deniedCorrect
            ? 0.5
            : 0,
      verification: deniedCorrect && nonEffects && sanitized ? 1 : 0,
      integrityFailure: !sourcePreserved,
      evidence: [
        `completed API source read-only: ${sourcePreserved ? 'yes' : 'no'}`,
        `allow/deny horizontal+vertical matrix: ${deniedCorrect ? 'pass' : 'fail'}`,
        `denied mutation durable non-effects: ${nonEffects ? 'pass' : 'fail'}`,
        `denial audit sanitized: ${sanitized ? 'pass' : 'fail'}`,
        `bounded report: ${report ? 'complete' : 'incomplete'}`,
      ],
    };
  },
};

const EXPORT_API = `export class AuthorizationFixture {
  readonly cacheTtlSeconds = 10;
  policyAvailable = true;
  private roles = new Map([['revocable-admin', true], ['stable-admin', true]]);
  private cache = new Map<string, { allow: boolean; expiresAt: number }>();
  private exports: string[] = [];
  private jobs: string[] = [];
  private urls: string[] = [];
  private audits: Array<Record<string, unknown>> = [];
  readonly sessions = new Map([['revocable-admin','session-secret-r'],['stable-admin','session-secret-s']]);

  revoke(id: string): void { this.roles.set(id, false); }
  setPolicyAvailable(value: boolean): void { this.policyAvailable = value; }

  exportResource(id: string, nowSeconds: number): { ok: boolean; source: string; reason?: string } {
    const cached = this.cache.get(id);
    let allow: boolean;
    let source: string;
    let reason = '';
    if (cached && nowSeconds < cached.expiresAt) {
      allow = cached.allow;
      source = 'cache';
      reason = 'cached_decision';
    } else if (!this.policyAvailable) {
      allow = false;
      source = 'policy-unavailable-fail-closed';
      reason = 'fresh_decision_unavailable';
    } else {
      allow = this.roles.get(id) === true;
      source = 'policy';
      reason = allow ? 'authoritative_allow' : 'role_revoked';
      this.cache.set(id, { allow, expiresAt: nowSeconds + this.cacheTtlSeconds });
    }
    this.audits.push({ actor: id, decision: allow ? 'allow' : 'deny', source, reason });
    if (!allow) return { ok: false, source, reason };
    this.exports.push('artifact:' + id + ':' + nowSeconds);
    this.jobs.push('job:' + id + ':' + nowSeconds);
    this.urls.push('https://synthetic.invalid/export/' + id + '/' + nowSeconds);
    return { ok: true, source };
  }

  adminSnapshot() { return { exports:[...this.exports], jobs:[...this.jobs], urls:[...this.urls], audits:this.audits.map((x)=>({...x})) }; }
}
`;

const securityCacheMaterializer: SkillEvalFixtureMaterializer = {
  id: 'security-verification/revocation-policy-cache@1',
  matches: (scenario) => scenario.id === SECURITY_CACHE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-security-cache'));
    writeFixtureFile(destination, 'src/export-api.ts', EXPORT_API);
    writeFixtureFile(
      destination,
      'README.md',
      `# Security verification — revocation/cache/fail-closed

Do not edit the completed authorization implementation. Cache TTL is 10 seconds. Establish revocable-admin success at t=0, revoke at the authoritative directory, observe the documented cached decision inside the stale window, then require a fresh decision after expiry. At that point make policy unavailable and prove fail-closed non-effects. Restore policy: revoked admin remains denied and stable-admin succeeds. Inspect audit source/reason and secret leakage independently.

Write \`.kory-eval/security-cache.json\` with the decision timeline, cache window, allow/deny controls, independent export/job/URL non-effect snapshots, recovery control, sanitized audit review, and bounded synthetic-fixture verdict.
`,
    );
  },
};

const securityCacheScorer: SkillEvalDeterministicScorer = {
  id: 'security-verification/revocation-policy-cache-scorer@1',
  scenarioIds: [SECURITY_CACHE],
  score: ({ workingDirectory }) => {
    const sourcePreserved =
      readFileSync(join(workingDirectory, 'src/export-api.ts'), 'utf8') === EXPORT_API;
    const observation = run(
      workingDirectory,
      `import { AuthorizationFixture } from './src/export-api.ts';
const api = new AuthorizationFixture(); const r:any={};
r.initial = api.exportResource('revocable-admin',0);
api.revoke('revocable-admin');
r.inside = api.exportResource('revocable-admin',5);
const beforeFailClosed = api.adminSnapshot();
api.setPolicyAvailable(false);
r.failClosed = api.exportResource('revocable-admin',11);
const afterFailClosed = api.adminSnapshot();
api.setPolicyAvailable(true);
r.revokedAfterRestore = api.exportResource('revocable-admin',12);
r.stableControl = api.exportResource('stable-admin',12);
r.beforeFailClosed = beforeFailClosed; r.afterFailClosed = afterFailClosed; r.final = api.adminSnapshot();
console.log(JSON.stringify(r));`,
    );
    let result: any = null;
    try {
      result = JSON.parse(observation.output);
    } catch {
      result = null;
    }
    const timeline =
      result?.initial?.ok === true &&
      result?.initial?.source === 'policy' &&
      result?.inside?.ok === true &&
      result?.inside?.source === 'cache' &&
      result?.failClosed?.ok === false &&
      /fail-closed/u.test(result?.failClosed?.source ?? '') &&
      result?.revokedAfterRestore?.ok === false &&
      result?.revokedAfterRestore?.reason === 'role_revoked' &&
      result?.stableControl?.ok === true;
    const nonEffects =
      JSON.stringify(result?.beforeFailClosed?.exports) ===
        JSON.stringify(result?.afterFailClosed?.exports) &&
      JSON.stringify(result?.beforeFailClosed?.jobs) ===
        JSON.stringify(result?.afterFailClosed?.jobs) &&
      JSON.stringify(result?.beforeFailClosed?.urls) ===
        JSON.stringify(result?.afterFailClosed?.urls);
    const audit = JSON.stringify(result?.final?.audits ?? []);
    const sanitized =
      /fresh_decision_unavailable|role_revoked/u.test(audit) && !/session-secret/u.test(audit);
    const artifact = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/security-cache.json');
    const body = normalized(artifact);
    const report =
      /10/u.test(body) &&
      /cache|stale/u.test(body) &&
      /t=5|5 second|inside/u.test(body) &&
      /t=11|11 second|after.*expiry|refresh/u.test(body) &&
      /fail.?closed/u.test(body) &&
      /export|artifact/u.test(body) &&
      /job/u.test(body) &&
      /url/u.test(body) &&
      /unchanged|non-effect|zero/u.test(body) &&
      /stable-admin/u.test(body) &&
      /role_revoked|revoked/u.test(body) &&
      /audit/u.test(body) &&
      /synthetic|fixture/u.test(body);
    const passed =
      sourcePreserved &&
      observation.status === 0 &&
      timeline &&
      nonEffects &&
      sanitized &&
      Boolean(artifact) &&
      report;
    return {
      passed,
      quality: passed ? 1 : timeline && nonEffects && sanitized ? 0.75 : timeline ? 0.5 : 0,
      verification: timeline && nonEffects && sanitized ? 1 : 0,
      integrityFailure: !sourcePreserved,
      evidence: [
        `completed authorization source read-only: ${sourcePreserved ? 'yes' : 'no'}`,
        `bounded stale window + post-expiry fail-closed timeline: ${timeline ? 'pass' : 'fail'}`,
        `fresh-decision failure durable non-effects: ${nonEffects ? 'pass' : 'fail'}`,
        `restored revoked/stable controls + sanitized audit: ${sanitized ? 'pass' : 'fail'}`,
      ],
    };
  },
};

const WORKER_SOURCE = `interface Message { id: string; key: string; deliveryCount: number; acked: boolean }

export function simulateReplayRecovery(consecutiveRestarts = 2) {
  const message: Message = { id: 'm1', key: 'receipt-key-1', deliveryCount: 0, acked: false };
  const receipts = new Set<string>();
  let externalEffects = 0;
  const timeline: Array<Record<string, unknown>> = [];
  let restart = 0;

  const deliver = (crashPoint: 'after-write-before-ack' | 'after-replay-before-ack' | 'none') => {
    message.deliveryCount += 1;
    timeline.push({ event: 'delivered', delivery: message.deliveryCount, backlog: message.acked ? 0 : 1 });
    if (!receipts.has(message.key)) {
      receipts.add(message.key);
      externalEffects += 1;
      timeline.push({ event: 'receipt-durable', key: message.key, externalEffects });
      if (crashPoint === 'after-write-before-ack') throw new Error('simulated worker termination');
    } else {
      timeline.push({ event: 'replay-recognized', key: message.key, duplicateEffectSuppressed: true });
      if (crashPoint === 'after-replay-before-ack') throw new Error('simulated worker termination');
    }
    message.acked = true;
    timeline.push({ event: 'ack', delivery: message.deliveryCount });
  };

  try { deliver('after-write-before-ack'); } catch { timeline.push({ event: 'restart', cycle: ++restart, recoverySeconds: 6 }); }
  for (let cycle = 1; cycle < consecutiveRestarts; cycle += 1) {
    try { deliver('after-replay-before-ack'); } catch { timeline.push({ event: 'restart', cycle: ++restart, recoverySeconds: 7 }); }
  }
  deliver('none');
  return {
    receipts: [...receipts],
    externalEffects,
    deliveryCount: message.deliveryCount,
    acknowledged: message.acked,
    backlog: message.acked ? 0 : 1,
    staleLeases: 0,
    healthy: message.acked,
    recoveryObjectiveSeconds: 20,
    maxRecoverySeconds: Math.max(...timeline.filter((item) => item.event === 'restart').map((item) => Number(item.recoverySeconds)), 0),
    timeline,
  };
}
`;

const reliabilityReplayMaterializer: SkillEvalFixtureMaterializer = {
  id: 'reliability-verification/worker-replay-recovery@1',
  matches: (scenario) => scenario.id === RELIABILITY_REPLAY,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-reliability-replay'));
    writeFixtureFile(destination, 'src/worker-fixture.ts', WORKER_SOURCE);
    writeFixtureFile(
      destination,
      'README.md',
      `# Reliability verification — worker replay recovery

Do not change the fixture. Use \`simulateReplayRecovery(2)\` to exercise the post-durable-receipt/pre-ack termination and a second consecutive restart during replay recognition. Verify exactly one durable receipt/external effect, replay suppression, eventual ack, zero backlog/stale leases, steady health, and measured restart recovery <=20s from the restart events.

Write \`.kory-eval/reliability-replay.json\` with disturbance/invariant matrix, event timeline, durable receipt vs broker delivery/ack evidence, recovery timing, and a bounded synthetic-fixture verdict. Distinguish replay delivery from duplicate business effect.
`,
    );
  },
};

const reliabilityReplayScorer: SkillEvalDeterministicScorer = {
  id: 'reliability-verification/worker-replay-recovery-scorer@1',
  scenarioIds: [RELIABILITY_REPLAY],
  score: ({ workingDirectory }) => {
    const sourcePreserved =
      readFileSync(join(workingDirectory, 'src/worker-fixture.ts'), 'utf8') === WORKER_SOURCE;
    const observation = run(
      workingDirectory,
      `import { simulateReplayRecovery } from './src/worker-fixture.ts'; console.log(JSON.stringify(simulateReplayRecovery(2)));`,
    );
    let result: any = null;
    try {
      result = JSON.parse(observation.output);
    } catch {
      result = null;
    }
    const behavior =
      result?.receipts?.length === 1 &&
      result?.externalEffects === 1 &&
      result?.deliveryCount === 3 &&
      result?.acknowledged === true &&
      result?.backlog === 0 &&
      result?.staleLeases === 0 &&
      result?.healthy === true &&
      result?.maxRecoverySeconds <= 20 &&
      result?.timeline?.filter((item: any) => item.event === 'restart').length === 2 &&
      result?.timeline?.filter((item: any) => item.event === 'replay-recognized').length >= 2;
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/reliability-replay.json',
    );
    const body = normalized(artifact);
    const report =
      /receipt/u.test(body) &&
      /replay/u.test(body) &&
      /ack/u.test(body) &&
      /backlog/u.test(body) &&
      /restart/u.test(body) &&
      /20/u.test(body) &&
      /6|7/u.test(body) &&
      /external effect|business effect/u.test(body) &&
      /exactly one|one durable|1/u.test(body) &&
      /synthetic|fixture/u.test(body);
    const passed =
      sourcePreserved && observation.status === 0 && behavior && Boolean(artifact) && report;
    return {
      passed,
      quality: passed ? 1 : behavior ? 0.75 : 0,
      verification: behavior ? 1 : 0,
      integrityFailure: !sourcePreserved,
      evidence: [
        `fixture source read-only: ${sourcePreserved ? 'yes' : 'no'}`,
        `two restart/replay cycles, one effect, eventual ack: ${behavior ? 'pass' : 'fail'}`,
        `recovery objective measured from restart events: ${report ? 'reported' : 'missing'}`,
      ],
    };
  },
};

const BLACKHOLE_SOURCE = `export function runReliabilityExperiment() {
  const baseline = { phase:'baseline', rps:120, coreCorrect:true, p95Ms:155, recommendationSuccessPct:99.8, attemptsPerRequest:1.0, memoryMiB:420, openConnections:52, errorBacklog:0, healthy:true };
  const blackhole = { phase:'blackhole-30s', rps:120, coreCorrect:true, p95Ms:612, p99Ms:742, degradedMarker:true, recommendationSuccessPct:0, attemptsPerRequest:1.9, retryCap:2, memoryMiB:446, openConnections:58, maxInFlight:232, errorBacklog:0, healthy:true };
  const recovery = { phase:'recovered', secondsAfterRestore:8, rps:120, coreCorrect:true, p95Ms:162, recommendationSuccessPct:99.7, attemptsPerRequest:1.01, memoryMiB:424, openConnections:53, errorBacklog:0, healthy:true, manualIntervention:false };
  const soak = [
    { minute:0, memoryMiB:424, openConnections:53, errorBacklog:0, errorsPct:0.05, coreCorrect:true },
    { minute:10, memoryMiB:428, openConnections:54, errorBacklog:0, errorsPct:0.04, coreCorrect:true },
    { minute:20, memoryMiB:426, openConnections:53, errorBacklog:0, errorsPct:0.05, coreCorrect:true, cacheExpired:true },
    { minute:30, memoryMiB:429, openConnections:55, errorBacklog:0, errorsPct:0.04, coreCorrect:true, cleanupRan:true },
    { minute:45, memoryMiB:427, openConnections:54, errorBacklog:0, errorsPct:0.04, coreCorrect:true },
  ];
  return { contract:{ maxDegradedLatencyMs:800, retryAttemptCap:2, workloadRps:120, blackholeSeconds:30, soakMinutes:45 }, baseline, blackhole, recovery, soak };
}
`;

const reliabilityBlackholeMaterializer: SkillEvalFixtureMaterializer = {
  id: 'reliability-verification/noncritical-backend-blackhole@1',
  matches: (scenario) => scenario.id === RELIABILITY_BLACKHOLE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-reliability-blackhole'));
    writeFixtureFile(destination, 'src/reliability-fixture.ts', BLACKHOLE_SOURCE);
    writeFixtureFile(
      destination,
      'README.md',
      `# Reliability verification — noncritical dependency blackhole

Do not change the fixture. \`runReliabilityExperiment()\` supplies steady baseline, 30-second accept-without-response disturbance at fixed 120 rps, automatic recovery, and a 45-minute synthetic soak crossing cache expiry and cleanup.

Verify core correctness, <=800ms degraded contract plus explicit degraded marker, retry attempts <=2, bounded in-flight/connections/memory/backlog, return to baseline-like success/latency/retries/health without manual intervention, and no monotonic resource/backlog drift across the soak. Write \`.kory-eval/reliability-blackhole.json\` with disturbance/invariant matrix, phase metrics, recovery timing, soak trend assessment, and explicit synthetic-fixture evidence label.
`,
    );
  },
};

const reliabilityBlackholeScorer: SkillEvalDeterministicScorer = {
  id: 'reliability-verification/noncritical-backend-blackhole-scorer@1',
  scenarioIds: [RELIABILITY_BLACKHOLE],
  score: ({ workingDirectory }) => {
    const sourcePreserved =
      readFileSync(join(workingDirectory, 'src/reliability-fixture.ts'), 'utf8') ===
      BLACKHOLE_SOURCE;
    const observation = run(
      workingDirectory,
      `import { runReliabilityExperiment } from './src/reliability-fixture.ts'; console.log(JSON.stringify(runReliabilityExperiment()));`,
    );
    let result: any = null;
    try {
      result = JSON.parse(observation.output);
    } catch {
      result = null;
    }
    const degraded =
      result?.blackhole?.coreCorrect === true &&
      result?.blackhole?.p95Ms <= 800 &&
      result?.blackhole?.degradedMarker === true &&
      result?.blackhole?.attemptsPerRequest <= result?.blackhole?.retryCap &&
      result?.blackhole?.errorBacklog === 0;
    const recovered =
      result?.recovery?.secondsAfterRestore === 8 &&
      result?.recovery?.recommendationSuccessPct >= 99 &&
      result?.recovery?.p95Ms < 200 &&
      result?.recovery?.attemptsPerRequest < 1.1 &&
      result?.recovery?.manualIntervention === false;
    const soak =
      result?.soak?.length === 5 &&
      result?.soak?.at(-1)?.minute === 45 &&
      result?.soak?.some((item: any) => item.cacheExpired) &&
      result?.soak?.some((item: any) => item.cleanupRan) &&
      Math.max(...result.soak.map((item: any) => item.memoryMiB)) -
        Math.min(...result.soak.map((item: any) => item.memoryMiB)) <=
        10 &&
      result?.soak?.every((item: any) => item.errorBacklog === 0 && item.coreCorrect === true);
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/reliability-blackhole.json',
    );
    const body = normalized(artifact);
    const report =
      /120/u.test(body) &&
      /30/u.test(body) &&
      /800/u.test(body) &&
      /degraded/u.test(body) &&
      /retry/u.test(body) &&
      /2/u.test(body) &&
      /memory/u.test(body) &&
      /connection/u.test(body) &&
      /backlog/u.test(body) &&
      /recover/u.test(body) &&
      /8/u.test(body) &&
      /45/u.test(body) &&
      /cache/u.test(body) &&
      /cleanup/u.test(body) &&
      /synthetic|fixture/u.test(body);
    const passed =
      sourcePreserved &&
      observation.status === 0 &&
      degraded &&
      recovered &&
      soak &&
      Boolean(artifact) &&
      report;
    return {
      passed,
      quality: passed ? 1 : degraded && recovered && soak ? 0.75 : degraded ? 0.5 : 0,
      verification: degraded && recovered && soak ? 1 : 0,
      integrityFailure: !sourcePreserved,
      evidence: [
        `fixture source read-only: ${sourcePreserved ? 'yes' : 'no'}`,
        `blackhole degraded contract/retry/resource bound: ${degraded ? 'pass' : 'fail'}`,
        `automatic recovery: ${recovered ? 'pass' : 'fail'}`,
        `45-minute cache/cleanup soak trend: ${soak ? 'pass' : 'fail'}`,
      ],
    };
  },
};

export const SECURITY_RELIABILITY_VERIFICATION_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    securityTenantMaterializer,
    securityCacheMaterializer,
    reliabilityReplayMaterializer,
    reliabilityBlackholeMaterializer,
  ];

export const SECURITY_RELIABILITY_VERIFICATION_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  securityTenantScorer,
  securityCacheScorer,
  reliabilityReplayScorer,
  reliabilityBlackholeScorer,
];
