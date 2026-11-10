import { describe, expect, test } from 'bun:test';
import type { ResolvedSkill, SkillResolverResult } from '../skills';
import { applySkillPruningPlan, planSkillPruning } from '../skill-pruning-planner';

function item(
  name: string,
  options: {
    direct?: boolean;
    reason?: string;
    depth?: number;
    broader?: string[];
    requires?: string[];
    chars?: number;
  } = {},
): ResolvedSkill {
  const promptText = `\n\n### ${name}\n${'x'.repeat(options.chars ?? 20)}`;
  const skill = {
    skill: {
      name,
      source: 'bundled',
      metadata: {
        version: '1',
        baseVersion: '1',
        baseHash: 'hash',
        domains: [],
        targetMedia: [],
        shouldTrigger: [],
        shouldNotTrigger: [],
        evidence: [],
        contextBudget: 10_000,
        sourceScope: 'local-only',
        broader: options.broader ?? [],
        facets: [],
        depth: options.depth ?? 1,
        requires: options.requires ?? [],
        conflicts: [],
        activation: [],
        excludes: [],
        invocationMode: 'model-invoked',
        pathScopes: [],
      },
    },
  }.skill as unknown as ResolvedSkill['skill'];
  return {
    skill,
    reason:
      options.reason ??
      (options.direct === false ? 'Broader concept of owner' : 'Matched task evidence'),
    directSelection: options.direct ?? true,
    representation: 'minimal',
    promptText,
    contextCost: promptText.length,
    fullContextCost: promptText.length,
    omittedDetailChars: 0,
  };
}

function resolution(selected: ResolvedSkill[]): SkillResolverResult {
  return {
    selected,
    collisions: [],
    selectionConflicts: [],
    hierarchyErrors: [],
    omittedByBudget: [],
    compressedByBudget: [],
    rejectedCandidates: [],
    rejectedCandidateCount: 0,
    rejectedCandidatesTruncated: false,
    blocked: false,
    warnings: [],
    omittedLazyAncestors: [],
    manifestHash: 'original',
    promptText: 'original prompt',
    contextBudget: 10_000,
    contextOverheadCost: 0,
    totalContextCost: 10,
    evidence: {} as SkillResolverResult['evidence'],
  };
}

describe('skill pruning planner', () => {
  test('protects pins, assigned/core skills, and the closure of retained direct skills', () => {
    const original = resolution([
      item('task-routing'),
      item('assigned-worker', { reason: 'Pinned explicitly for this task' }),
      item('specific-owner', { depth: 5, broader: ['shared-foundation'] }),
      item('shared-foundation', { direct: false, reason: 'Broader concept of specific-owner' }),
      item('broad-owner', { depth: 1 }),
      item('unused-broad', { direct: false }),
    ]);
    const plan = planSkillPruning(original, {
      assignedSkills: ['assigned-worker'],
      requiredCoreSkills: ['task-routing'],
      maxOptionalSkills: 2,
    });

    expect(plan.failed).toBe(false);
    expect(plan.selected.map((entry) => entry.skill.name)).toEqual([
      'task-routing',
      'assigned-worker',
      'specific-owner',
      'shared-foundation',
    ]);
    expect(plan.prunedSkillNames).toEqual(['broad-owner', 'unused-broad']);
    expect(applySkillPruningPlan(original, plan).promptText).toContain('specific-owner');
  });

  test('ranks direct specificity before broader optional skills deterministically', () => {
    const original = resolution([
      item('task-routing'),
      item('broad-direct', { depth: 1 }),
      item('specific-direct', { depth: 4 }),
      item('another-specific', { depth: 4 }),
    ]);
    const plan = planSkillPruning(original, { maxOptionalSkills: 1 });
    expect(plan.selected.map((entry) => entry.skill.name)).toEqual([
      'task-routing',
      'another-specific',
    ]);
  });

  test('protects resolver-required task-routing by default', () => {
    const original = resolution([item('task-routing'), item('optional')]);
    const plan = planSkillPruning(original, { maxOptionalSkills: 0 });

    expect(plan.failed).toBe(false);
    expect(plan.selected.map((entry) => entry.skill.name)).toEqual(['task-routing']);
    expect(plan.prunedSkillNames).toEqual(['optional']);
  });

  test('normalizes a token budget to characters and keeps high-risk direct owners', () => {
    const original = resolution([
      item('task-routing', { chars: 30 }),
      item('high-risk-owner', { chars: 200 }),
      item('optional', { chars: 300, direct: false }),
    ]);
    const plan = planSkillPruning(original, {
      protectHighRiskDirectOwners: true,
      budgetTokens: 20,
      charsPerToken: 4,
      maxOptionalSkills: 1,
    });
    expect(plan.budgetChars).toBe(80);
    expect(plan.selected.map((entry) => entry.skill.name)).toEqual([
      'task-routing',
      'high-risk-owner',
    ]);
    expect(plan.prunedSkillNames).toEqual(['optional']);
  });

  test('protects the required Koryphaios cores and explicit user pins', () => {
    const original = resolution([
      item('task-routing'),
      item('repository-environment-discovery'),
      item('testing-engineering'),
      item('verification'),
      item('debugging'),
      item('security-review'),
      item('plan-mode', { reason: 'Pinned explicitly for this task' }),
      item('response-style', { reason: 'Pinned explicitly for this task' }),
      item('optional', { direct: false }),
    ]);
    const plan = planSkillPruning(original, {
      explicitPins: ['plan-mode', 'response-style'],
      requiredCoreSkills: [
        'task-routing',
        'repository-environment-discovery',
        'testing-engineering',
        'verification',
        'debugging',
        'security-review',
      ],
      repositoryMutation: true,
      taskContract: { taskKind: 'bug', risk: 'high' },
      maxOptionalSkills: 0,
    });
    expect(plan.selected.map((entry) => entry.skill.name)).toEqual(
      original.selected.slice(0, 8).map((entry) => entry.skill.name),
    );
    expect(plan.prunedSkillNames).toEqual(['optional']);
  });

  test('returns the original selection when planning encounters malformed legacy data', () => {
    const original = resolution([item('task-routing'), item('stable')]);
    (original.selected[1]!.skill as unknown as { metadata: null }).metadata = null;
    const plan = planSkillPruning(original);
    expect(plan.failed).toBe(true);
    expect(plan.selected).toBe(original.selected);
    expect(applySkillPruningPlan(original, plan)).toBe(original);
  });

  test('fails open when a protected root is unavailable', () => {
    const original = resolution([item('task-routing'), item('optional')]);
    const plan = planSkillPruning(original, { requiredCoreSkills: ['missing-root'] });

    expect(plan.failed).toBe(true);
    expect(plan.selected).toBe(original.selected);
    expect(applySkillPruningPlan(original, plan)).toBe(original);
  });

  test('fails open when a declared dependency is unavailable', () => {
    const original = resolution([
      item('task-routing'),
      item('owner', { requires: ['missing-dependency'] }),
    ]);
    const plan = planSkillPruning(original);

    expect(plan.failed).toBe(true);
    expect(plan.selected).toBe(original.selected);
    expect(applySkillPruningPlan(original, plan)).toBe(original);
  });
});
