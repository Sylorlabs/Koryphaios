import { expect, test } from 'bun:test';
import {
  awsBaselineEffectiveAccessEvidenceIsExplicit,
  awsRecoveryEnvironmentEvidenceIsExplicit,
  gcpFailbackEvidenceIsExplicit,
} from '../skill-eval-cloud-platform-fixtures';

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
    account: { workload: 'workload-account', recovery: 'recovery-account' },
    region: { primary: 'us-east-1', secondary: 'us-west-2' },
    identity: { principal: 'operator-role', workloadRole: 'app-role' },
    network: { vpc: 'secondary-vpc' },
    data: { kms: 'recovery-key', backup: 'restore-42' },
    operations: {
      quota: 'checked',
      cloudtrail: 'central',
      config: 'aggregated',
      cloudwatch: 'available',
      failover: 'observed',
      rollback: 'reviewed',
    },
    liveProviderVerified: false,
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
    account: 'workload-account',
    region: 'us-east-1',
    identity: { principal: 'workload-role' },
    kms: { keyPolicy: 'scoped', keyGrant: 'workload-only' },
    verification: { allowed: ['s3:GetObject'], denied: ['kms:ScheduleKeyDeletion'] },
    liveProviderVerified: false,
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
