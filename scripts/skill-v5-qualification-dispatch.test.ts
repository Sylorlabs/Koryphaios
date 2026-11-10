import { expect, test } from 'bun:test';
import {
  QualificationDispatch,
  qualificationInfrastructureStatus,
} from './skill-v5-qualification-dispatch';

test('candidate semantic failure and baseline infrastructure failure identify the correct arm', () => {
  const candidate = {
    taskFailure: 'OpenCode stateless output violated the patch contract (details redacted).',
    infrastructureFailure: undefined,
  };
  const baseline = {
    infrastructureFailure: {
      kind: 'provider' as const,
      detail: 'OpenCode stateless process failed (details redacted).',
      retryable: false,
      evidence: ['OpenCode stateless process failed (details redacted).'],
    },
  };
  expect(
    qualificationInfrastructureStatus(
      candidate.infrastructureFailure,
      baseline.infrastructureFailure,
    ),
  ).toEqual({
    withSkillInfrastructureFailure: false,
    withoutSkillInfrastructureFailure: true,
    infrastructureFailure: true,
    detail: 'without-skill: OpenCode stateless process failed (details redacted).',
  });
  expect(candidate.taskFailure).toContain('patch contract');
});

test('infrastructure reporting prefixes each failed arm and preserves aggregate status', () => {
  const failure = {
    kind: 'provider' as const,
    retryable: false,
    detail: 'details redacted',
    evidence: ['details redacted'],
  };
  expect(qualificationInfrastructureStatus(failure, undefined)).toEqual({
    withSkillInfrastructureFailure: true,
    withoutSkillInfrastructureFailure: false,
    infrastructureFailure: true,
    detail: 'with-skill: details redacted',
  });
  expect(qualificationInfrastructureStatus(failure, failure)).toEqual({
    withSkillInfrastructureFailure: true,
    withoutSkillInfrastructureFailure: true,
    infrastructureFailure: true,
    detail: 'with-skill: details redacted | without-skill: details redacted',
  });
  expect(qualificationInfrastructureStatus(undefined, undefined)).toEqual({
    withSkillInfrastructureFailure: false,
    withoutSkillInfrastructureFailure: false,
    infrastructureFailure: false,
    detail: '',
  });
});

test('quota failure stops new work without discarding already dispatched pairs', () => {
  const queue = new QualificationDispatch(20);
  expect([queue.take(), queue.take(), queue.take(), queue.take()]).toEqual([0, 1, 2, 3]);
  queue.observe([
    { kind: 'provider', retryable: false, detail: 'usage limit', evidence: ['provider denial'] },
  ]);
  expect(queue.take()).toBeUndefined();
  expect(queue.notStarted).toBe(16);
  expect(queue.stopReason).toBe('usage limit');
  queue.observe([{ kind: 'provider', retryable: false, detail: 'later failure', evidence: [] }]);
  expect(queue.stopReason).toBe('usage limit');
});

test('behavioral failure and retryable infrastructure do not stop remaining tasks', () => {
  const queue = new QualificationDispatch(3);
  queue.observe([undefined]);
  expect(queue.take()).toBe(0);
  queue.observe([
    { kind: 'provider', retryable: true, detail: 'temporary unavailable', evidence: [] },
  ]);
  expect(queue.take()).toBe(1);
  queue.observe([
    { kind: 'setup', retryable: false, detail: 'scenario-specific setup', evidence: [] },
  ]);
  expect(queue.take()).toBe(2);
  expect(queue.take()).toBeUndefined();
  expect(queue.notStarted).toBe(0);
  expect(queue.stopReason).toBeNull();
});
