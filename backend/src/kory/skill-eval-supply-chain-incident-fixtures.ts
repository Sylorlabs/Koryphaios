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

const SUPPLY_RELEASE = 'supply-chain-security-full-task-1';
const SUPPLY_INCIDENT = 'supply-chain-security-full-task-2';
const CHECKOUT_INCIDENT = 'incident-response-full-task-1';
const QUEUE_INCIDENT = 'incident-response-full-task-2';

const SUPPLY_SIM = `export interface ReleaseQualification {
  artifactDigest:string;sourceRevision:string;approvedBuilder:string;approvedWorkflow:string;allowedParameters:Record<string,string>;
  lockfileEnforced:boolean;inputs:Array<{kind:string;name:string;identity:string;immutable:boolean}>;
  sbom:{format:string;components:string[];omissions:string[];completenessClaim:boolean};
  privilegedJobs:string[];mutablePrivilegedInputs:string[];
  provenance:{subjectDigest:string;sourceRevision:string;builder:string;workflow:string;parameters:Record<string,string>;valid:boolean};
  signature:{subjectDigest:string;cryptographicallyValid:boolean;issuer:string;workflowIdentity:string;authorized:boolean};
  cleanRebuild:{digest:string;matched:boolean};verdict:'accept'|'reject';liveProviderVerified:boolean;
  ownership:{pipelineMechanics:string;keyCustody:string};
}
export function qualifyRelease(s:ReleaseQualification):boolean {
  const params=Object.entries(s.allowedParameters).every(([k,v])=>s.provenance.parameters[k]===v);
  const identity=s.provenance.builder===s.approvedBuilder&&s.provenance.workflow===s.approvedWorkflow&&s.signature.workflowIdentity===s.approvedWorkflow;
  const subject=s.provenance.subjectDigest===s.artifactDigest&&s.signature.subjectDigest===s.artifactDigest&&s.provenance.sourceRevision===s.sourceRevision;
  const mutable=s.inputs.filter(x=>!x.immutable).map(x=>x.identity).sort();
  return s.lockfileEnforced&&s.sbom.omissions.length>0&&!s.sbom.completenessClaim&&s.privilegedJobs.length>0&&JSON.stringify(mutable)===JSON.stringify([...s.mutablePrivilegedInputs].sort())&&subject&&params&&s.provenance.valid&&s.signature.cryptographicallyValid&&!s.signature.authorized&&!identity&&s.cleanRebuild.matched&&s.cleanRebuild.digest===s.artifactDigest&&s.verdict==='reject'&&!s.liveProviderVerified&&s.ownership.pipelineMechanics==='cicd-engineering'&&s.ownership.keyCustody==='secrets-key-management';
}

export interface SupplyIncidentResponse {
  preserved:string[];promotionStoppedDigests:string[];resolvedCompromisedVersion:string;staleSbomVersion:string;affectedDigests:string[];
  credential:{availableDuringInstall:boolean;exfiltration:'unproven'|'proven';rotated:boolean};
  replacement:{version:string;locked:boolean;cleanIsolatedBuild:boolean;credentialAvailableDuringInstall:boolean;toolInputIdentitiesRecorded:boolean;digest:string};
  replacementSbom:{generatedFromResolvedBuild:boolean;components:string[];preservedOldSbom:boolean};
  verification:{expectedDigest:string;builderIdentityValid:boolean;signerIdentityValid:boolean;provenanceSubjectValid:boolean;sourceValid:boolean;parametersValid:boolean;attestationPolicyValid:boolean;liveProviderVerified:boolean};
  withdrawnDigests:string[];downstreamNotificationOwner:string;downstreamRebuildOwner:string;restored:boolean;
}
export function recoverSupplyIncident(s:SupplyIncidentResponse):boolean {
  const preserve=['lockfile','artifact-digests','stale-sbom','provenance','signature-bundle','ci-logs'].every(x=>s.preserved.includes(x));
  const contained=s.affectedDigests.length>0&&s.affectedDigests.every(x=>s.promotionStoppedDigests.includes(x)&&s.withdrawnDigests.includes(x));
  const fresh=!s.replacementSbom.components.includes('codec-helper@2.4.1')&&s.replacementSbom.components.includes(s.replacement.version);
  const verified=s.verification.expectedDigest===s.replacement.digest&&s.verification.builderIdentityValid&&s.verification.signerIdentityValid&&s.verification.provenanceSubjectValid&&s.verification.sourceValid&&s.verification.parametersValid&&s.verification.attestationPolicyValid&&!s.verification.liveProviderVerified;
  return preserve&&contained&&s.resolvedCompromisedVersion==='codec-helper@2.4.1'&&s.staleSbomVersion==='codec-helper@2.4.0'&&s.credential.availableDuringInstall&&s.credential.exfiltration==='unproven'&&s.credential.rotated&&s.replacement.locked&&s.replacement.cleanIsolatedBuild&&!s.replacement.credentialAvailableDuringInstall&&s.replacement.toolInputIdentitiesRecorded&&s.replacementSbom.generatedFromResolvedBuild&&s.replacementSbom.preservedOldSbom&&fresh&&verified&&!!s.downstreamNotificationOwner&&!!s.downstreamRebuildOwner&&s.restored;
}
`;

const RELEASE_CORPUS = `${JSON.stringify(
  {
    artifactDigest: 'sha256:4f8d9a1c-release',
    sourceRevision: 'git:9b7f1d2',
    approvedBuilder:
      'https://github.com/kory/release/.github/workflows/release.yml@refs/heads/main',
    approvedWorkflow: 'kory/release/.github/workflows/release.yml@refs/heads/main',
    allowedParameters: { platform: 'linux/amd64,linux/arm64', mode: 'release' },
    inputs: [
      { kind: 'action', name: 'checkout', identity: 'actions/checkout@8ade135a', immutable: true },
      { kind: 'action', name: 'setup-bun', identity: 'vendor/setup-bun@v2', immutable: false },
      { kind: 'base-image', name: 'distroless', identity: 'sha256:base123', immutable: true },
      { kind: 'toolchain', name: 'bun', identity: '1.3.2', immutable: true },
    ],
    resolvedComponents: ['app@1.8.0', 'codec-helper@2.4.0', 'native-pack@3.2.1'],
    sbomComponents: ['app@1.8.0', 'codec-helper@2.4.0'],
    privilegedJobs: ['release-sign', 'publish-image'],
    provenance: {
      subjectDigest: 'sha256:4f8d9a1c-release',
      sourceRevision: 'git:9b7f1d2',
      builder: 'https://github.com/fork/release/.github/workflows/release.yml@refs/heads/main',
      workflow: 'fork/release/.github/workflows/release.yml@refs/heads/main',
      parameters: { platform: 'linux/amd64,linux/arm64', mode: 'release' },
      valid: true,
    },
    signature: {
      subjectDigest: 'sha256:4f8d9a1c-release',
      cryptographicallyValid: true,
      issuer: 'https://token.actions.githubusercontent.com',
      workflowIdentity: 'fork/release/.github/workflows/release.yml@refs/heads/main',
    },
    cleanRebuildDigest: 'sha256:4f8d9a1c-release',
  },
  null,
  2,
)}\n`;

const SUPPLY_INCIDENT_CORPUS = `${JSON.stringify(
  {
    compromised: 'codec-helper@2.4.1',
    staleSbom: 'codec-helper@2.4.0',
    reviewedReplacement: 'codec-helper@2.4.2',
    affectedDigests: ['sha256:affected-a', 'sha256:affected-b'],
    replacementDigest: 'sha256:clean-fixed',
    publishingTokenAvailableDuringInstall: true,
  },
  null,
  2,
)}\n`;

const INCIDENT_SIM = `export interface TimelineEntry{minute:number;kind:'declare'|'role'|'freeze'|'preserve'|'communicate'|'mitigate'|'observe'|'handoff'|'close';owner:string;detail:string}
export interface CheckoutIncident {
  severity:string;roles:{ic:string;operations:string;communications:string;scribe:string};timeline:TimelineEntry[];
  preservedBeforeMitigation:string[];mutationsFrozen:boolean;mitigation:{owner:string;action:string;reversible:boolean;undo:string;startMinute:number};
  communication:{impact:string;status:string;unknowns:string[];nextUpdate:string;rootCauseConfirmed:boolean};
  recovery:Array<{minute:number;fiveXx:number;p95Ms:number;checkoutProbe:boolean;dependencyHealthy:boolean;rollbackState:string}>;
  observationWindowMinutes:number;recurrenceMinute:number;temporaryDivergence:string[];followups:Array<{owner:string;item:string}>;closed:boolean;
}
export function checkoutRecovered(s:CheckoutIncident):boolean {
  const roles=Object.values(s.roles);const roleBeforeMutation=Math.max(...s.timeline.filter(x=>x.kind==='role'||x.kind==='declare').map(x=>x.minute))<s.mitigation.startMinute;
  const preserved=['rollout','configuration','telemetry','logs'].every(x=>s.preservedBeforeMitigation.includes(x));
  const afterRecurrence=s.recovery.filter(x=>x.minute>=s.recurrenceMinute);
  const stable=afterRecurrence.length>=2&&afterRecurrence.every(x=>x.fiveXx<=1&&x.p95Ms<=600&&x.checkoutProbe&&x.dependencyHealthy&&/rolled-back|stable/i.test(x.rollbackState));
  return /^sev/i.test(s.severity)&&new Set(roles).size===4&&roles.every(Boolean)&&roleBeforeMutation&&s.mutationsFrozen&&preserved&&s.mitigation.owner===s.roles.operations&&s.mitigation.reversible&&!!s.mitigation.undo&&s.communication.impact.length>0&&s.communication.status.length>0&&s.communication.unknowns.length>0&&!!s.communication.nextUpdate&&!s.communication.rootCauseConfirmed&&s.observationWindowMinutes>=s.recurrenceMinute-s.mitigation.startMinute&&stable&&s.temporaryDivergence.length>0&&s.followups.every(x=>!!x.owner&&!!x.item)&&s.closed;
}

export interface QueueIncident {
  roles:{ic:string;operations:string;communications:string;scribe:string};timeline:TimelineEntry[];
  impact:{regions:string[];tenants:number;backlogAgeMinutes:number;usefulWorkPerMinute:number};
  preservedBeforeMitigation:string[];duplicateActionsFrozen:boolean;mitigation:{owner:string;action:string;reversible:boolean;undo:string;minute:number;mutations:number};
  recovery:Array<{minute:number;usefulWorkPerMinute:number;errorRate:number;backlog:number;duplicateSideEffects:number;crossRegionReconciled:boolean}>;
  observationWindowMinutes:number;replayRecurrenceMinute:number;handoff:Array<{owner:string;item:string}>;liveFaultExperimentRun:boolean;closed:boolean;
}
export function queueRecovered(s:QueueIncident):boolean {
  const preserve=['offsets','acknowledgements','dedup-state','downstream-effects'].every(x=>s.preservedBeforeMitigation.includes(x));
  const afterReplay=s.recovery.filter(x=>x.minute>=s.replayRecurrenceMinute);const stable=afterReplay.length>=2&&afterReplay.every(x=>x.usefulWorkPerMinute>0&&x.errorRate<=0.02&&x.backlog===0&&x.duplicateSideEffects===0&&x.crossRegionReconciled);
  const handoff=['replay-reconciliation','temporary-routing','reliability-experiment','unresolved-hypothesis'].every(i=>s.handoff.some(x=>x.item===i&&!!x.owner));
  return Object.values(s.roles).every(Boolean)&&new Set(Object.values(s.roles)).size===4&&s.impact.regions.length>0&&s.impact.tenants>0&&s.impact.backlogAgeMinutes>0&&s.impact.usefulWorkPerMinute>=0&&preserve&&s.duplicateActionsFrozen&&s.mitigation.owner===s.roles.operations&&s.mitigation.reversible&&!!s.mitigation.undo&&s.mitigation.mutations===1&&s.observationWindowMinutes>=s.replayRecurrenceMinute-s.mitigation.minute&&stable&&handoff&&!s.liveFaultExperimentRun&&s.closed;
}
`;

const CHECKOUT_CORPUS = `${JSON.stringify(
  {
    rolloutMinute: -12,
    baseline: { fiveXx: 0.004, p95Ms: 280 },
    incident: { fiveXx: 0.27, p95Ms: 590 },
    recurrenceMinute: 18,
    availableMitigations: ['rollback-release', 'disable-new-checkout-path'],
  },
  null,
  2,
)}\n`;
const QUEUE_CORPUS = `${JSON.stringify(
  {
    affectedRegion: 'us-west-2',
    tenantCount: 37,
    backlogAgeMinutes: 41,
    replayRecurrenceMinute: 25,
    failoverMayReplayProcessedBeforeAck: true,
  },
  null,
  2,
)}\n`;

function fixed(root: string, path: string, expected: string): boolean {
  return readFileSync(join(root, path), 'utf8') === expected;
}

const releaseMaterializer: SkillEvalFixtureMaterializer = {
  id: 'supply-chain-security/release-trust-qualification@1',
  matches: (s) => s.id === SUPPLY_RELEASE,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-supply-release'));
    writeFixtureFile(d, 'src/supply-sim.ts', SUPPLY_SIM);
    writeFixtureFile(d, 'evidence/release.json', RELEASE_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Supply-chain release qualification fixture

Inspect the fixed synthetic release evidence and write \`.kory-eval/release-qualification.json\` as \`ReleaseQualification\`. Establish artifact/source/builder/workflow/parameter expectations first. Reconcile the SBOM against the resolved graph, inventory all artifact-changing inputs, flag mutable inputs crossing the privileged release boundary, and distinguish cryptographic validity from signer/builder authorization. A matching clean rebuild is corroborative only. The correct fixture verdict is rejection. Set \`liveProviderVerified:false\`; this corpus is synthetic. Pipeline mechanics belong to \`cicd-engineering\`; key custody belongs to \`secrets-key-management\`.
`,
    );
  },
};

const releaseScorer: SkillEvalDeterministicScorer = {
  id: 'supply-chain-security/release-trust-qualification-scorer@1',
  scenarioIds: [SUPPLY_RELEASE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{qualifyRelease,type ReleaseQualification}from'../src/supply-sim';const c=JSON.parse(readFileSync('evidence/release.json','utf8'));const s=JSON.parse(readFileSync('.kory-eval/release-qualification.json','utf8')) as ReleaseQualification;test('hidden: valid crypto/reproducibility cannot override unapproved identity',()=>{expect(s.artifactDigest).toBe(c.artifactDigest);expect(s.sourceRevision).toBe(c.sourceRevision);expect(s.approvedBuilder).toBe(c.approvedBuilder);expect(s.approvedWorkflow).toBe(c.approvedWorkflow);expect(s.sbom.omissions).toContain('native-pack@3.2.1');expect(s.mutablePrivilegedInputs).toContain('vendor/setup-bun@v2');expect(s.signature.cryptographicallyValid).toBe(true);expect(s.signature.authorized).toBe(false);expect(qualifyRelease(s)).toBe(true);});\n`,
    );
    const integrity =
      fixed(workingDirectory, 'src/supply-sim.ts', SUPPLY_SIM) &&
      fixed(workingDirectory, 'evidence/release.json', RELEASE_CORPUS);
    const passed = hidden.passed && integrity;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !integrity,
      evidence: [
        `artifact/input/provenance/signature policy simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed synthetic evidence preserved: ${integrity ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const supplyIncidentMaterializer: SkillEvalFixtureMaterializer = {
  id: 'supply-chain-security/compromised-dependency-response@1',
  matches: (s) => s.id === SUPPLY_INCIDENT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-supply-incident'));
    writeFixtureFile(d, 'src/supply-sim.ts', SUPPLY_SIM);
    writeFixtureFile(d, 'evidence/incident.json', SUPPLY_INCIDENT_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Compromised dependency response fixture

Write \`.kory-eval/supply-incident.json\` as \`SupplyIncidentResponse\`. Preserve suspect evidence before remediation, stop promotion of every affected digest, and derive scope from enforced lockfile/build/provenance evidence rather than the stale SBOM. The publishing token was reachable during dependency install, so rotate it while keeping exfiltration explicitly \`unproven\`. Rebuild the reviewed fixed version in the supplied clean isolated environment with release credentials unavailable during dependency installation, regenerate/reconcile the SBOM, verify replacement digest/identity/provenance/attestation policy, withdraw affected artifacts, and assign downstream notification/rebuild owners. Set live-provider verification false because the evidence is synthetic.
`,
    );
  },
};

const supplyIncidentScorer: SkillEvalDeterministicScorer = {
  id: 'supply-chain-security/compromised-dependency-response-scorer@1',
  scenarioIds: [SUPPLY_INCIDENT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{recoverSupplyIncident,type SupplyIncidentResponse}from'../src/supply-sim';const c=JSON.parse(readFileSync('evidence/incident.json','utf8'));const s=JSON.parse(readFileSync('.kory-eval/supply-incident.json','utf8')) as SupplyIncidentResponse;test('hidden: scope, credential response, clean rebuild and restoration are evidence-bound',()=>{expect(s.resolvedCompromisedVersion).toBe(c.compromised);expect(s.staleSbomVersion).toBe(c.staleSbom);expect(s.affectedDigests.sort()).toEqual([...c.affectedDigests].sort());expect(s.replacement.version).toBe(c.reviewedReplacement);expect(s.replacement.digest).toBe(c.replacementDigest);expect(recoverSupplyIncident(s)).toBe(true);});\n`,
    );
    const integrity =
      fixed(workingDirectory, 'src/supply-sim.ts', SUPPLY_SIM) &&
      fixed(workingDirectory, 'evidence/incident.json', SUPPLY_INCIDENT_CORPUS);
    const passed = hidden.passed && integrity;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !integrity,
      evidence: [
        `compromise containment/rebuild/restoration state machine: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed synthetic evidence preserved: ${integrity ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const checkoutMaterializer: SkillEvalFixtureMaterializer = {
  id: 'incident-response/checkout-rollout-command@1',
  matches: (s) => s.id === CHECKOUT_INCIDENT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-incident-checkout'));
    writeFixtureFile(d, 'src/incident-sim.ts', INCIDENT_SIM);
    writeFixtureFile(d, 'evidence/checkout.json', CHECKOUT_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Checkout rollout incident fixture

Operate the fixed synthetic incident and write \`.kory-eval/checkout-incident.json\` as \`CheckoutIncident\`. Establish one IC plus distinct operations/comms/scribe roles before further mutation, freeze independent flag changes, and preserve rollout/configuration/telemetry/log evidence before mitigation. Execute exactly one reversible mitigation under the operations owner, communicate observed impact/status/unknowns without asserting an unproven root cause, and verify 5xx, latency, representative checkout, dependency health and rollback state through the supplied recurrence point. Close only with temporary divergence and named follow-up ownership.
`,
    );
  },
};

const checkoutScorer: SkillEvalDeterministicScorer = {
  id: 'incident-response/checkout-rollout-command-scorer@1',
  scenarioIds: [CHECKOUT_INCIDENT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{checkoutRecovered,type CheckoutIncident}from'../src/incident-sim';const c=JSON.parse(readFileSync('evidence/checkout.json','utf8'));const s=JSON.parse(readFileSync('.kory-eval/checkout-incident.json','utf8')) as CheckoutIncident;test('hidden: command precedes mutation and recovery survives recurrence',()=>{expect(s.recurrenceMinute).toBe(c.recurrenceMinute);expect(s.recovery.some(x=>x.minute>=c.recurrenceMinute)).toBe(true);expect(checkoutRecovered(s)).toBe(true);});\n`,
    );
    const integrity =
      fixed(workingDirectory, 'src/incident-sim.ts', INCIDENT_SIM) &&
      fixed(workingDirectory, 'evidence/checkout.json', CHECKOUT_CORPUS);
    const passed = hidden.passed && integrity;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !integrity,
      evidence: [
        `checkout command/change-control/recovery simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed incident timeline preserved: ${integrity ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const queueMaterializer: SkillEvalFixtureMaterializer = {
  id: 'incident-response/multi-region-queue-outage@1',
  matches: (s) => s.id === QUEUE_INCIDENT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-incident-queue'));
    writeFixtureFile(d, 'src/incident-sim.ts', INCIDENT_SIM);
    writeFixtureFile(d, 'evidence/queue.json', QUEUE_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Multi-region queue outage fixture

Write \`.kory-eval/queue-incident.json\` as \`QueueIncident\`. Quantify region/tenant/backlog/useful-work impact, freeze duplicate independent actions, preserve offsets/acknowledgements/dedup/downstream effects before failover, and let only the operations owner perform one reversible traffic/failover mutation. Verify useful-work rate, error rate, backlog drain, independent duplicate-side-effect count, and cross-region reconciliation through the replay recurrence point. Hand off replay reconciliation, temporary routing, the later reliability experiment, and unresolved hypothesis. Do not run a fault experiment while the incident is live.
`,
    );
  },
};

const queueScorer: SkillEvalDeterministicScorer = {
  id: 'incident-response/multi-region-queue-outage-scorer@1',
  scenarioIds: [QUEUE_INCIDENT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{queueRecovered,type QueueIncident}from'../src/incident-sim';const c=JSON.parse(readFileSync('evidence/queue.json','utf8'));const s=JSON.parse(readFileSync('.kory-eval/queue-incident.json','utf8')) as QueueIncident;test('hidden: failover is single-owner and replay-safe recovery is independently verified',()=>{expect(s.impact.regions).toContain(c.affectedRegion);expect(s.impact.tenants).toBe(c.tenantCount);expect(s.impact.backlogAgeMinutes).toBe(c.backlogAgeMinutes);expect(s.replayRecurrenceMinute).toBe(c.replayRecurrenceMinute);expect(queueRecovered(s)).toBe(true);});\n`,
    );
    const integrity =
      fixed(workingDirectory, 'src/incident-sim.ts', INCIDENT_SIM) &&
      fixed(workingDirectory, 'evidence/queue.json', QUEUE_CORPUS);
    const passed = hidden.passed && integrity;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !integrity,
      evidence: [
        `queue failover/replay recovery state machine: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed outage corpus preserved: ${integrity ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

export const SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [releaseMaterializer, supplyIncidentMaterializer, checkoutMaterializer, queueMaterializer];

export const SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  releaseScorer,
  supplyIncidentScorer,
  checkoutScorer,
  queueScorer,
];
