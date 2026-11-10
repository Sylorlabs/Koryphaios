import { describe, expect, test } from 'bun:test';
import {
  CORE_FIRST_SKILL_PRIORITIES,
  compareSkillPriority,
  getSkillPriority,
  orderSkillsCoreFirst,
} from '../skill-priority';

describe('core-first skill priority metadata', () => {
  test('orders the cross-cutting lifecycle without selecting any skill', () => {
    expect(
      orderSkillsCoreFirst([
        'response-style',
        'verification',
        'feature-implementation',
        'implementation',
        'plan-mode',
        'planning',
        'repository-environment-discovery',
        'task-routing',
      ]),
    ).toEqual([
      'task-routing',
      'repository-environment-discovery',
      'planning',
      'plan-mode',
      'implementation',
      'feature-implementation',
      'verification',
      'response-style',
    ]);
  });

  test('keeps specialist ties deterministic and preserves the input membership', () => {
    const input = [
      'custom-specialist',
      'integration-implementation',
      'refactor-implementation',
      'custom-specialist',
      'response-style',
    ];
    const ordered = orderSkillsCoreFirst(input);

    expect(ordered).toEqual([
      'integration-implementation',
      'refactor-implementation',
      'custom-specialist',
      'custom-specialist',
      'response-style',
    ]);
    expect([...ordered].sort()).toEqual([...input].sort());
    expect(input).toEqual([
      'custom-specialist',
      'integration-implementation',
      'refactor-implementation',
      'custom-specialist',
      'response-style',
    ]);
  });

  test('leaves unlisted skills neutral and does not expose provider or model policy', () => {
    const metadata = getSkillPriority('unlisted-specialist');
    expect(metadata).toEqual({
      name: 'unlisted-specialist',
      priority: 0,
      phase: 'neutral',
      rationale: 'No core-first advisory priority is declared.',
    });
    expect(Object.keys(CORE_FIRST_SKILL_PRIORITIES[0]!)).toEqual([
      'name',
      'priority',
      'phase',
      'rationale',
    ]);
    expect(compareSkillPriority('unlisted-specialist', 'response-style')).toBeLessThan(0);
  });

  test('uses alphabetical order only as a deterministic tie-break', () => {
    expect(
      compareSkillPriority('refactor-implementation', 'feature-implementation'),
    ).toBeGreaterThan(0);
    expect(compareSkillPriority('feature-implementation', 'refactor-implementation')).toBeLessThan(
      0,
    );
    expect(compareSkillPriority('same-unlisted-name', 'same-unlisted-name')).toBe(0);
  });

  test('places selected dependencies before dependents without expanding membership', () => {
    const input = [
      'response-style',
      'feature-implementation',
      'repository-environment-discovery',
      'task-routing',
    ];
    const dependencies = new Map([
      ['feature-implementation', ['repository-environment-discovery']],
      ['repository-environment-discovery', ['task-routing']],
      // This dependency was not selected and must not be inserted.
      ['task-routing', ['missing-parent']],
    ] as const);

    expect(orderSkillsCoreFirst(input, dependencies)).toEqual([
      'task-routing',
      'repository-environment-discovery',
      'feature-implementation',
      'response-style',
    ]);
    expect(orderSkillsCoreFirst(input, dependencies)).toHaveLength(input.length);
    expect(input).toEqual([
      'response-style',
      'feature-implementation',
      'repository-environment-discovery',
      'task-routing',
    ]);
  });

  test('retains multiplicity and makes an impossible dependency cycle deterministic', () => {
    const input = ['custom-specialist', 'cycle-b', 'cycle-a', 'custom-specialist'];
    const dependencies = new Map([
      ['cycle-a', ['cycle-b']],
      ['cycle-b', ['cycle-a']],
    ] as const);

    expect(orderSkillsCoreFirst(input, dependencies)).toEqual([
      'custom-specialist',
      'custom-specialist',
      'cycle-b',
      'cycle-a',
    ]);
    expect([...orderSkillsCoreFirst(input, dependencies)].sort()).toEqual([...input].sort());
  });
});
