import { describe, expect, test } from 'bun:test';
import {
  INTEGRATION_FAULT_RUNTIME_BLOCKER,
  integrationFaultRuntimeReadiness,
  integrationFaultScenario1Readiness,
  integrationFaultScenario2Readiness,
  runIntegrationFaultScenario1Runtime,
  runIntegrationFaultScenario2Runtime,
} from '../../eval/skills/skill-eval-integration-fault-runtime';

function available(blockers: readonly string[]): boolean {
  if (blockers.length === 0) return true;
  expect(blockers).toEqual([INTEGRATION_FAULT_RUNTIME_BLOCKER]);
  return false;
}

describe('integration-fault-testing V5 local runtime', () => {
  test('readiness remains fail-closed unless every declared local runtime is available', () => {
    const blockers = integrationFaultRuntimeReadiness();
    expect(blockers.length === 0 || blockers.length === 1).toBe(true);
    if (blockers.length > 0) expect(blockers).toEqual([INTEGRATION_FAULT_RUNTIME_BLOCKER]);
  }, 30_000);

  test('scenario 1 resets PostgreSQL after a child insert and proves rollback plus clean recovery', () => {
    const blockers = integrationFaultScenario1Readiness();
    if (!available(blockers)) {
      return;
    }

    const result = runIntegrationFaultScenario1Runtime();
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'PostgreSQL runtime: 17.5',
      'Toxiproxy runtime: 2.',
      'Toxiproxy lifecycle: retained container AutoRemove=false',
      'scenario 1 start state: headers=0 children=0',
      'scenario 1 fault placement: observed active advisory checkpoint after child insert 1 and before COMMIT',
      'scenario 1 reset configuration: reset_peer downstream timeout=0',
      'scenario 1 caller-visible dependency failure: exit=',
      'scenario 1 independent failed state: headers=0 children=0',
      'scenario 1 toxic removal and PostgreSQL readiness through proxy: pass',
      'scenario 1 independent recovered state: headers=1 children=2 expected_children=2',
      'scenario 1 exactly one complete recovered import: pass',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 180_000);

  test('scenario 2 proves commit-before-response-cut idempotency and fresh work after recovery', () => {
    const blockers = integrationFaultScenario2Readiness();
    if (!available(blockers)) {
      return;
    }

    const result = runIntegrationFaultScenario2Runtime();
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'Synthetic dependency runtime: v22.',
      'Toxiproxy runtime: 2.',
      'Toxiproxy lifecycle: retained container AutoRemove=false',
      'scenario 2 start state: dispatches=0',
      'scenario 2 commit-before-cut evidence:',
      'fsync-complete marker observed; durable count=1',
      'scenario 2 reset configuration: reset_peer downstream timeout=0 after commit marker and before delayed response',
      'scenario 2 caller-visible uncertain result:',
      'scenario 2 independent post-cut state: stable-key dispatches=1 total=1',
      'scenario 2 toxic removal and dependency readiness through proxy: pass',
      'scenario 2 same-key replay: HTTP 200 duplicate; stable-key dispatches=1 total=1',
      'scenario 2 fresh-key recovery: HTTP 201 created; stable-key=1 fresh-key=1 total=2',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 120_000);
});
