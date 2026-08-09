import { describe, expect, test } from 'vitest';
import {
  checklistFromPlan,
  implementationPrompt,
  latestPlanText,
  validatePlanReadiness,
} from './plan-handoff';

describe('plan handoff', () => {
  test('uses the latest manager response as the approved plan', () => {
    expect(
      latestPlanText([
        {
          id: '1',
          timestamp: 1,
          type: 'content',
          agentId: 'kory',
          agentName: 'Kory',
          glowClass: '',
          text: 'old',
        },
        {
          id: '2',
          timestamp: 2,
          type: 'content',
          agentId: 'kory',
          agentName: 'Kory',
          glowClass: '',
          text: 'final plan',
        },
      ]),
    ).toBe('final plan');
  });

  test('turns numbered plan steps into dependency-ordered goal items', () => {
    const items = checklistFromPlan(
      '1. Inspect the current flow\n2. Implement the mode\n3. Verify the handoff',
    );
    expect(items.map((item) => item.title)).toEqual([
      'Inspect the current flow',
      'Implement the mode',
      'Verify the handoff',
    ]);
    expect(items[1]?.dependsOn).toEqual([items[0]?.id]);
  });

  test('uses implementation steps instead of numbered acceptance criteria', () => {
    const items = checklistFromPlan(
      '## Detailed implementation plan\n1. Build the mode\n2. Wire the handoff\n\n## Acceptance criteria\n1. It works\n2. It reloads',
    );
    expect(items.map((item) => item.title)).toEqual(['Build the mode', 'Wire the handoff']);
  });

  test('the clean implementation prompt carries only the approved context', () => {
    const prompt = implementationPrompt(
      'Fix Plan Mode',
      '1. Add a session mode\n<!-- KORY_PLAN_READY -->',
    );
    expect(prompt).toContain('Objective:\nFix Plan Mode');
    expect(prompt).toContain('Approved plan:\n1. Add a session mode');
    expect(prompt).not.toContain('KORY_PLAN_READY');
  });

  test('does not trust the readiness marker without the complete plan contract', () => {
    expect(validatePlanReadiness('1. Do work\n<!-- KORY_PLAN_READY -->').ready).toBe(false);
  });

  test('accepts a complete structured plan with actionable steps', () => {
    const plan = `## Decision summary\nD\n## Current-state evidence\nE\n## Detailed implementation plan\n1. Build it\n2. Test it\n## User journey and failure states\nU\n## Risks and alternatives\nR\n## Acceptance criteria\nA\n## Verification plan\nV\n## Remaining assumptions\nNone\n<!-- KORY_PLAN_READY -->`;
    expect(validatePlanReadiness(plan)).toEqual({ ready: true, missing: [] });
  });
});
