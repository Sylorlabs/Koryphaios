import { expect, test } from 'bun:test';
import {
  awsBaselineEffectiveAccessEvidenceIsExplicit,
  awsRecoveryEnvironmentEvidenceIsExplicit,
  gcpFailbackEvidenceIsExplicit,
} from '../../eval/skills/skill-eval-cloud-platform-fixtures';

test('GCP recovery treats an explicit false failbackExercised field as a bounded limitation', () => {
  expect(
    gcpFailbackEvidenceIsExplicit(
      { drill: { failbackExercised: false } },
      '"failbackexercised":false',
    ),
  ).toBe(true);
  expect(gcpFailbackEvidenceIsExplicit({ drill: {} }, '{}')).toBe(false);
});

test('AWS recovery requires the broader synthetic environment evidence named by the full task', () => {
  const artifact = {
    evidenceKind: 'synthetic',
    liveProviderVerified: false,
    requirementsConfirmed: {
      account: true,
      region: true,
      workload: true,
      compliance: true,
      network: true,
      identity: true,
      data: true,
      availability: true,
      operational: true,
    },
    environment: {
      workloadAccount: 'workload-account',
      recoveryAccount: 'recovery-account',
      primaryRegion: 'us-east-1',
      secondaryRegion: 'us-west-2',
      callerPrincipal: 'operator-role',
      workloadRole: 'app-role',
      networkPath: ['private recovery subnet'],
    },
    effectiveAccess: {
      iam: { allowedPaths: ['recovery read'], deniedPaths: ['production key deletion'] },
      kms: { keyPolicyOwner: 'recovery account', grantScope: 'workload restore only' },
    },
    audit: {
      cloudTrail: 'central trail',
      config: 'aggregated config',
      cloudWatch: 'recovery alarms',
    },
    quotaEvidence: 'secondary region quotas checked',
    backupOrFailoverEvidence: 'restore-42 verified usable',
    rollbackEvidence: 'rollback reviewed',
    decisionSequence: ['observe', 'restore', 'verify'],
  };
  const text = JSON.stringify(artifact).toLowerCase();
  expect(awsRecoveryEnvironmentEvidenceIsExplicit(artifact, text)).toBe(true);
  expect(
    awsRecoveryEnvironmentEvidenceIsExplicit(
      { evidenceKind: 'synthetic', liveProviderVerified: false },
      '{"evidencekind":"synthetic","liveproviderverified":false}',
    ),
  ).toBe(false);
});

test('AWS baseline requires effective IAM allow/deny and KMS evidence', () => {
  const artifact = {
    evidenceKind: 'synthetic',
    liveProviderVerified: false,
    requirementsConfirmed: {
      account: true,
      region: true,
      workload: true,
      compliance: true,
      network: true,
      identity: true,
      data: true,
      availability: true,
      operational: true,
    },
    environment: {
      accountId: 'workload-account',
      region: 'us-east-1',
      callerPrincipal: 'workload-role',
      workloadRole: 'application-role',
      networkPath: ['private subnet to object store'],
    },
    effectiveAccess: {
      iam: { allowedPaths: ['s3:GetObject'], deniedPaths: ['kms:ScheduleKeyDeletion'] },
      kms: { keyPolicyOwner: 'security account', grantScope: 'workload key use only' },
    },
    audit: {
      cloudTrail: 'organization trail',
      config: 'account aggregator',
      cloudWatch: 'access alarms',
    },
    decisionSequence: ['inspect', 'apply', 'verify'],
  };
  const text = JSON.stringify(artifact).toLowerCase();
  expect(awsBaselineEffectiveAccessEvidenceIsExplicit(artifact, text)).toBe(true);
  expect(
    awsBaselineEffectiveAccessEvidenceIsExplicit(
      { evidenceKind: 'synthetic', liveProviderVerified: false },
      '{"evidencekind":"synthetic","liveproviderverified":false}',
    ),
  ).toBe(false);
});
