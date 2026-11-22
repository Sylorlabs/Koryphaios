import { describe, expect, test } from 'bun:test';
import { agentBehaviorBoundariesPass } from '../../eval/skills/skill-eval-skill-authoring-evaluation-fixtures';

const cleanBehavior = {
  scopeExpansion: false,
  reasksExistingApproval: false,
  silentFallback: false,
  stopsBeforeEvidence: false,
  loadsIrrelevantContext: false,
};

const behaviorKeys = Object.keys(cleanBehavior) as Array<keyof typeof cleanBehavior>;

describe('skill authoring agent behavior promotion gate', () => {
  test('passes only when every behavior boundary is explicitly false', () => {
    expect(agentBehaviorBoundariesPass({ agentBehavior: cleanBehavior })).toBe(true);
  });

  for (const key of behaviorKeys) {
    test(`fails when ${key} is true`, () => {
      expect(
        agentBehaviorBoundariesPass({
          agentBehavior: { ...cleanBehavior, [key]: true },
        }),
      ).toBe(false);
    });

    test(`fails when ${key} is missing`, () => {
      const agentBehavior = { ...cleanBehavior } as Partial<typeof cleanBehavior>;
      delete agentBehavior[key];
      expect(agentBehaviorBoundariesPass({ agentBehavior })).toBe(false);
    });
  }

  test('fails for a missing or malformed agentBehavior object', () => {
    expect(agentBehaviorBoundariesPass({})).toBe(false);
    expect(agentBehaviorBoundariesPass({ agentBehavior: null })).toBe(false);
    expect(agentBehaviorBoundariesPass({ agentBehavior: 'clean' })).toBe(false);
  });
});
