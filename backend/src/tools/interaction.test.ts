import { describe, expect, test } from 'bun:test';
import { DelegateToWorkerTool, RequestCriticReviewTool } from './interaction';
import { ManageAgentsTool } from './manage-agents';
import type { ToolContext } from './registry';
import type { SkillAssignment } from '../kory/skill-assignment';

describe('request_critic_review', () => {
  test('records the manager reason for the turn-level Auto decision', async () => {
    let requestedReason: string | undefined;
    const result = await new RequestCriticReviewTool().run({
      sessionId: 'session', workingDirectory: '/tmp',
      requestCriticReview: (reason) => { requestedReason = reason; },
    }, {
      id: 'review-call', name: 'request_critic_review',
      input: { reason: 'The factual claim needs an independent source check.' },
    });
    expect(result.isError).toBe(false);
    expect(requestedReason).toBe('The factual claim needs an independent source check.');
  });

  test('fails closed when the manager decision callback is unavailable', async () => {
    const result = await new RequestCriticReviewTool().run({
      sessionId: 'session', workingDirectory: '/tmp',
    }, {
      id: 'review-call', name: 'request_critic_review', input: { reason: 'Check this claim.' },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('unavailable');
  });
});

describe('delegate_to_worker skill assignment', () => {
  test('passes model and reasoning with normalized worker and critic skill pins', async () => {
    let received: { task: string; domain?: string; skills?: SkillAssignment; model?: string; reasoningLevel?: string } | undefined;
    const ctx = {
      delegateToWorker: async (task: string, domain?: string, skills?: SkillAssignment, model?: string, reasoningLevel?: string) => {
        received = { task, domain, skills, model, reasoningLevel };
        return 'completed';
      },
    } as ToolContext;
    const result = await new DelegateToWorkerTool().run(ctx, {
      id: 'delegate-test',
      name: 'delegate_to_worker',
      input: {
        task: 'Review the implementation',
        domain: 'review',
        workerSkills: ['verification', 'verification'],
        criticSkills: ['testing-engineering', 'testing-engineering'],
        model: 'openai:gpt-test',
        reasoningLevel: 'high',
      },
    });
    expect(result.isError).toBe(false);
    expect(received).toEqual({
      task: 'Review the implementation',
      domain: 'review',
      skills: { worker: ['verification'], critic: ['testing-engineering'] },
      model: 'openai:gpt-test',
      reasoningLevel: 'high',
    });
  });
});

describe('manager worker controls', () => {
  test('passes the complete worker control request to the manager boundary', async () => {
    let received: Record<string, unknown> | undefined;
    const ctx = {
      manageAgents: async (input: Record<string, unknown>) => {
        received = input;
        return 'ok';
      },
    } as ToolContext;
    const result = await new ManageAgentsTool().run(ctx, {
      id: 'manage-test',
      name: 'manage_agents',
      input: {
        action: 'set_controls',
        agentId: 'worker-1',
        model: 'openai:gpt-test',
        reasoningLevel: 'high',
      },
    });
    expect(result.isError).toBe(false);
    expect(received).toEqual({
      action: 'set_controls',
      agentId: 'worker-1',
      model: 'openai:gpt-test',
      reasoningLevel: 'high',
    });
  });
});
