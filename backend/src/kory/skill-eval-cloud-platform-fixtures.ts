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

const AWS_BASELINE = 'aws-cloud-full-task-1-individual';
const AWS_RECOVERY = 'aws-cloud-full-task-2-individual';
const GCP_BASELINE = 'gcp-cloud-full-task-1-individual';
const GCP_RECOVERY = 'gcp-cloud-full-task-2-individual';
const AZURE_BASELINE = 'azure-cloud-full-task-1-individual';
const AZURE_RECOVERY = 'azure-cloud-full-task-2-individual';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

function nestedBoolean(value: unknown, key: string, expected: boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => nestedBoolean(item, key, expected));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record[key] === expected) return true;
  return Object.values(record).some((item) => nestedBoolean(item, key, expected));
}

const CLOUD_SIM = `export interface BaselineSpec {
  provider: 'aws'|'gcp'|'azure';
  placement: { managementPlaneEmptyOfWorkload:boolean; workloadBoundary:string; loggingBoundary:string };
  identity: { humanTemporary:boolean; workloadTemporary:boolean; longLivedCredentialRequired:boolean; dedicatedWorkloadIdentity:boolean };
  availability: { zones:number; databaseMultiZoneOrRegional:boolean; standbyClaimedAsReadScale?:boolean };
  network: { explicitBoundary:boolean; privateServicePath:boolean; deniedIsolationProbe:boolean };
  audit: { centralized:boolean; durable:boolean; protected:boolean; ingestionObserved:boolean };
  recovery: { protectedDatabase:boolean; protectedObjects:boolean; protectedVolumesOrEquivalent:boolean; restoreExecuted:boolean; restoredResourceId:string; restoredUsable:boolean };
  change: { targetRegion:string; quotaChecked:boolean; reviewedChange:boolean; destructiveReplacementReviewed:boolean; rollbackExercised:boolean; driftOrEquivalentReviewed:boolean };
  liveProviderVerified:boolean;
}

export interface RecoverySpec {
  provider:'aws'|'gcp'|'azure';
  objectives:{rtoMinutes:number;rpoMinutes:number};
  regionalRecoveryDistinctFromZoneHa:boolean;
  identity:{dedicatedTemporary:boolean;sharedLongLivedCredentialRequired:boolean;sharedNodeRoleForApp?:boolean};
  secondary:{region:string;networkReady:boolean;serviceAvailabilityChecked:boolean;quotaChecked:boolean;capacityReady:boolean};
  isolation:{separateRecoveryBoundary:boolean;primaryCompromiseCannotDeleteAllCopies:boolean;independentKeyOrSecretOwnership:boolean};
  drill:{restoreOrFailoverExecuted:boolean;dataUsable:boolean;recoveryPointTimestamp:string;serviceRestoredTimestamp:string;incidentStartTimestamp:string;observedRpoMinutes:number;observedRtoMinutes:number;failbackExercised:boolean};
  telemetryAvailable:boolean;
  liveProviderVerified:boolean;
}

export function baselineReady(spec:BaselineSpec):boolean {
  return spec.placement.managementPlaneEmptyOfWorkload && !!spec.placement.workloadBoundary && !!spec.placement.loggingBoundary &&
    spec.identity.humanTemporary && spec.identity.workloadTemporary && !spec.identity.longLivedCredentialRequired && spec.identity.dedicatedWorkloadIdentity &&
    spec.availability.zones>=2 && spec.availability.databaseMultiZoneOrRegional && spec.availability.standbyClaimedAsReadScale!==true &&
    spec.network.explicitBoundary && spec.network.privateServicePath && spec.network.deniedIsolationProbe &&
    spec.audit.centralized && spec.audit.durable && spec.audit.protected && spec.audit.ingestionObserved &&
    spec.recovery.protectedDatabase && spec.recovery.protectedObjects && spec.recovery.protectedVolumesOrEquivalent && spec.recovery.restoreExecuted && !!spec.recovery.restoredResourceId && spec.recovery.restoredUsable &&
    !!spec.change.targetRegion && spec.change.quotaChecked && spec.change.reviewedChange && spec.change.destructiveReplacementReviewed && spec.change.rollbackExercised && spec.change.driftOrEquivalentReviewed;
}

export function recoveryReady(spec:RecoverySpec):boolean {
  return spec.objectives.rtoMinutes===240 && spec.objectives.rpoMinutes===15 && spec.regionalRecoveryDistinctFromZoneHa &&
    spec.identity.dedicatedTemporary && !spec.identity.sharedLongLivedCredentialRequired && spec.identity.sharedNodeRoleForApp!==true &&
    !!spec.secondary.region && spec.secondary.networkReady && spec.secondary.serviceAvailabilityChecked && spec.secondary.quotaChecked && spec.secondary.capacityReady &&
    spec.isolation.separateRecoveryBoundary && spec.isolation.primaryCompromiseCannotDeleteAllCopies && spec.isolation.independentKeyOrSecretOwnership &&
    spec.drill.restoreOrFailoverExecuted && spec.drill.dataUsable && !!spec.drill.recoveryPointTimestamp && !!spec.drill.serviceRestoredTimestamp && !!spec.drill.incidentStartTimestamp &&
    spec.drill.observedRpoMinutes<=15 && spec.drill.observedRtoMinutes<=240 && spec.telemetryAvailable;
}
`;

function baselineStartingState(provider: 'aws' | 'gcp' | 'azure'): string {
  if (provider === 'aws') {
    return `${JSON.stringify(
      {
        provider: 'aws',
        managementAccountHasWorkload: true,
        humanCredential: 'iam-access-key',
        computeZones: ['us-east-1a'],
        database: 'rds-single-az',
        audit: 'cloudtrail-event-history-only',
        restoreExecuted: false,
      },
      null,
      2,
    )}\n`;
  }
  if (provider === 'gcp') {
    return `${JSON.stringify(
      {
        provider: 'gcp',
        workloadBoundary: 'single-flat-project',
        deployCredential: 'downloaded-service-account-key',
        network: 'flat-vpc',
        computeZones: ['us-central1-a'],
        audit: 'local-project-only',
        restoreExecuted: false,
      },
      null,
      2,
    )}\n`;
  }
  return `${JSON.stringify(
    {
      provider: 'azure',
      workloadBoundary: 'single-subscription',
      applicationCredential: 'stored-secret',
      network: 'flat-vnet-public-paas',
      computeZones: ['1'],
      audit: 'local-diagnostics-only',
      restoreExecuted: false,
    },
    null,
    2,
  )}\n`;
}

function recoveryStartingState(provider: 'aws' | 'gcp' | 'azure'): string {
  return `${JSON.stringify(
    {
      provider,
      primaryRegion:
        provider === 'aws' ? 'us-east-1' : provider === 'gcp' ? 'us-central1' : 'eastus',
      objectives: { rtoMinutes: 240, rpoMinutes: 15 },
      onlyZoneHaConfigured: true,
      recoveryCopyIsolation: false,
      secondaryQuotaChecked: false,
      restoreOrFailoverExecuted: false,
    },
    null,
    2,
  )}\n`;
}

function baselineMaterializer(
  scenarioId: string,
  provider: 'aws' | 'gcp' | 'azure',
): SkillEvalFixtureMaterializer {
  return {
    id: `${provider}-cloud/production-baseline@1`,
    matches: (scenario) => scenario.id === scenarioId,
    materialize: (destination) => {
      writeFixtureFile(destination, 'package.json', packageJson(`kory-eval-${provider}-baseline`));
      writeFixtureFile(destination, 'src/cloud-sim.ts', CLOUD_SIM);
      writeFixtureFile(
        destination,
        'evidence/starting-state.json',
        baselineStartingState(provider),
      );
      writeFixtureFile(destination, 'tests/.gitkeep', '');
      const providerSpecific =
        provider === 'aws'
          ? 'Use the supplied member workload account and protected log-archive account; human federation is IAM Identity Center/temporary sessions; workload access is dedicated roles. Compute/ALB and RDS availability span at least two AZs. Durable audit means multi-account/Region CloudTrail plus Config aggregation and CloudWatch ownership. RDS Multi-AZ standby is availability, not read scaling. Change evidence is a reviewed CloudFormation change set/drift/rollback path.'
          : provider === 'gcp'
            ? 'Use the supplied organization/folder with workload, network and audit projects; identity is workforce/deployment federation or impersonation plus attached workload identities. Networking uses Shared VPC/private service paths and a demonstrated denied isolation path. Central logging has explicit sink/ownership/retention. Change evidence preserves target project/region, quotas, reviewed resource operations and rollback/recovery.'
            : 'Use the supplied Entra tenant, management groups and workload/network/logging subscriptions; application access uses managed identity and least-privilege RBAC. Networking uses hub/private endpoint/Private DNS paths and a demonstrated denied isolation path. Activity/resource logs use Azure Monitor diagnostic settings with observed ingestion. Change evidence preserves tenant/subscription/region/SKU, quotas and rollback/recovery.';
      writeFixtureFile(
        destination,
        'README.md',
        `# ${provider.toUpperCase()} production-baseline simulator

Preserve the fixed simulator and starting-state evidence. Write \`.kory-eval/cloud-baseline.json\` matching \`BaselineSpec\` and make the simulator pass. ${providerSpecific}

The restored database/object/volume-equivalent path must actually produce a new observable recovery resource/object and prove it usable; backup configuration alone is insufficient. Set \`liveProviderVerified:false\` because this fixture is synthetic. Write \`.kory-eval/cloud-baseline-evidence.json\` with account/project/subscription, Region, principal/resource identities, quota/change/rollback evidence, restore identifiers, and explicit simulated/unavailable labels.
`,
      );
    },
  };
}

function baselineScorer(
  scenarioId: string,
  provider: 'aws' | 'gcp' | 'azure',
): SkillEvalDeterministicScorer {
  return {
    id: `${provider}-cloud/production-baseline-scorer@1`,
    scenarioIds: [scenarioId],
    score: ({ workingDirectory }) => {
      const hidden = runHiddenBunTest(
        workingDirectory,
        `import {expect,test} from 'bun:test';import {readFileSync} from 'node:fs';import {baselineReady,type BaselineSpec} from '../src/cloud-sim';
const s=JSON.parse(readFileSync('.kory-eval/cloud-baseline.json','utf8')) as BaselineSpec;
test('hidden: provider identity and baseline contract',()=>{expect(s.provider).toBe('${provider}');expect(baselineReady(s)).toBe(true);expect(s.liveProviderVerified).toBe(false);});
test('hidden: recovery is observed rather than configured-only',()=>{expect(s.recovery.restoreExecuted).toBe(true);expect(s.recovery.restoredResourceId.length).toBeGreaterThan(2);expect(s.recovery.restoredUsable).toBe(true);});
`,
      );
      const fixed = readFileSync(join(workingDirectory, 'src/cloud-sim.ts'), 'utf8') === CLOUD_SIM;
      const start = readFileSync(join(workingDirectory, 'evidence/starting-state.json'), 'utf8');
      const startPreserved = start.includes(`"provider": "${provider}"`);
      const evidence = artifactText(workingDirectory, '.kory-eval/cloud-baseline-evidence.json');
      const bounded =
        Boolean(evidence.artifact) &&
        /quota/u.test(evidence.text) &&
        /restore|failover/u.test(evidence.text) &&
        /rollback/u.test(evidence.text) &&
        /principal|identity/u.test(evidence.text) &&
        /synthetic|simulated/u.test(evidence.text) &&
        nestedBoolean(evidence.artifact, 'liveProviderVerified', false);
      const passed = hidden.passed && fixed && startPreserved && bounded;
      return {
        passed,
        quality: passed ? 1 : hidden.passed && fixed ? 0.8 : hidden.passed ? 0.6 : 0,
        verification: hidden.passed ? 1 : 0,
        integrityFailure: !fixed || !startPreserved,
        evidence: [
          `${provider} baseline simulation: ${hidden.passed ? 'pass' : 'fail'}`,
          `fixed simulator/start state preserved: ${fixed && startPreserved ? 'yes' : 'no'}`,
          `identity/restore/change evidence: ${bounded ? 'bounded' : 'missing'}`,
          hidden.evidence,
        ],
      };
    },
  };
}

function recoveryMaterializer(
  scenarioId: string,
  provider: 'aws' | 'gcp' | 'azure',
): SkillEvalFixtureMaterializer {
  return {
    id: `${provider}-cloud/regional-recovery@1`,
    matches: (scenario) => scenario.id === scenarioId,
    materialize: (destination) => {
      writeFixtureFile(destination, 'package.json', packageJson(`kory-eval-${provider}-recovery`));
      writeFixtureFile(destination, 'src/cloud-sim.ts', CLOUD_SIM);
      writeFixtureFile(
        destination,
        'evidence/starting-state.json',
        recoveryStartingState(provider),
      );
      writeFixtureFile(destination, 'tests/.gitkeep', '');
      const providerSpecific =
        provider === 'aws'
          ? 'Use dedicated workload roles rather than shared EKS node-role authority. Recovery copies span a secondary Region/recovery account or equivalent isolated boundary, with KMS/key policy ownership that does not make the production account the single destruction point.'
          : provider === 'gcp'
            ? 'Use dedicated attached/short-lived service identities, secondary-region networking/service quotas, and a recovery project whose data plus KMS/Secret Manager ownership cannot be trivially destroyed from the primary workload project.'
            : 'Use dedicated managed identities, secondary-region hub/private connectivity plus exact service/SKU quotas, and a recovery subscription whose data plus Key Vault/key ownership cannot be trivially destroyed from the primary workload subscription.';
      writeFixtureFile(
        destination,
        'README.md',
        `# ${provider.toUpperCase()} Regional recovery simulator

Preserve the fixed simulator/start evidence. Write \`.kory-eval/cloud-recovery.json\` matching \`RecoverySpec\`. Required Regional-outage objectives are exactly RTO 240 minutes and RPO 15 minutes. ${providerSpecific}

Zonal/Multi-AZ/zone-redundant availability is not Regional DR proof. Before failover, prove secondary networking/service availability/quota/capacity. Execute an actual restore or failover and validate data usability. Record incident-start, recovery-point and service-restored timestamps plus calculated observed RPO/RTO. Telemetry must remain available. Failback should be exercised; if it is not, report that limitation explicitly rather than implying success. Set \`liveProviderVerified:false\` and label the fixture synthetic.
`,
      );
    },
  };
}

function recoveryScorer(
  scenarioId: string,
  provider: 'aws' | 'gcp' | 'azure',
): SkillEvalDeterministicScorer {
  return {
    id: `${provider}-cloud/regional-recovery-scorer@1`,
    scenarioIds: [scenarioId],
    score: ({ workingDirectory }) => {
      const hidden = runHiddenBunTest(
        workingDirectory,
        `import {expect,test} from 'bun:test';import {readFileSync} from 'node:fs';import {recoveryReady,type RecoverySpec} from '../src/cloud-sim';
const s=JSON.parse(readFileSync('.kory-eval/cloud-recovery.json','utf8')) as RecoverySpec;
test('hidden: measurable regional recovery objective',()=>{expect(s.provider).toBe('${provider}');expect(recoveryReady(s)).toBe(true);expect(s.liveProviderVerified).toBe(false);});
test('hidden: actual drill and timestamps satisfy objectives',()=>{expect(s.drill.restoreOrFailoverExecuted).toBe(true);expect(s.drill.dataUsable).toBe(true);expect(s.drill.observedRpoMinutes).toBeLessThanOrEqual(15);expect(s.drill.observedRtoMinutes).toBeLessThanOrEqual(240);expect(Date.parse(s.drill.recoveryPointTimestamp)).not.toBeNaN();expect(Date.parse(s.drill.serviceRestoredTimestamp)).not.toBeNaN();});
`,
      );
      const fixed = readFileSync(join(workingDirectory, 'src/cloud-sim.ts'), 'utf8') === CLOUD_SIM;
      const start = readFileSync(join(workingDirectory, 'evidence/starting-state.json'), 'utf8');
      const startPreserved = start.includes(`"provider": "${provider}"`);
      const report = artifactText(workingDirectory, '.kory-eval/cloud-recovery.json');
      const failbackBounded =
        Boolean(report.artifact) &&
        (nestedBoolean(report.artifact, 'failbackExercised', true) ||
          /failback.*unverified|failback.*not.*verified/u.test(report.text));
      const passed = hidden.passed && fixed && startPreserved && failbackBounded;
      return {
        passed,
        quality: passed ? 1 : hidden.passed && fixed ? 0.8 : hidden.passed ? 0.6 : 0,
        verification: hidden.passed ? 1 : 0,
        integrityFailure: !fixed || !startPreserved,
        evidence: [
          `${provider} Regional recovery drill: ${hidden.passed ? 'pass' : 'fail'}`,
          `fixed simulator/start state preserved: ${fixed && startPreserved ? 'yes' : 'no'}`,
          `failback evidence explicitly bounded: ${failbackBounded ? 'yes' : 'missing'}`,
          hidden.evidence,
        ],
      };
    },
  };
}

const awsBaselineMaterializer = baselineMaterializer(AWS_BASELINE, 'aws');
const awsRecoveryMaterializer = recoveryMaterializer(AWS_RECOVERY, 'aws');
const gcpBaselineMaterializer = baselineMaterializer(GCP_BASELINE, 'gcp');
const gcpRecoveryMaterializer = recoveryMaterializer(GCP_RECOVERY, 'gcp');
const azureBaselineMaterializer = baselineMaterializer(AZURE_BASELINE, 'azure');
const azureRecoveryMaterializer = recoveryMaterializer(AZURE_RECOVERY, 'azure');

const awsBaselineScorer = baselineScorer(AWS_BASELINE, 'aws');
const awsRecoveryScorer = recoveryScorer(AWS_RECOVERY, 'aws');
const gcpBaselineScorer = baselineScorer(GCP_BASELINE, 'gcp');
const gcpRecoveryScorer = recoveryScorer(GCP_RECOVERY, 'gcp');
const azureBaselineScorer = baselineScorer(AZURE_BASELINE, 'azure');
const azureRecoveryScorer = recoveryScorer(AZURE_RECOVERY, 'azure');

export const CLOUD_PLATFORM_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  awsBaselineMaterializer,
  awsRecoveryMaterializer,
  gcpBaselineMaterializer,
  gcpRecoveryMaterializer,
  azureBaselineMaterializer,
  azureRecoveryMaterializer,
];

export const CLOUD_PLATFORM_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  awsBaselineScorer,
  awsRecoveryScorer,
  gcpBaselineScorer,
  gcpRecoveryScorer,
  azureBaselineScorer,
  azureRecoveryScorer,
];
