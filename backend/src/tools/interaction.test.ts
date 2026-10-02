import { describe, expect, test } from 'bun:test';
import { DelegateToWorkerTool } from './interaction';
import type { ToolContext } from './registry';

describe('delegate_to_worker skill assignment', () => {
  test('passes normalized worker and critic skill pins through the manager tool boundary', async () => {
    let received: any;
    const ctx = {
      delegateToWorker: async (task: string, domain?: string, skills?: any) => {
        received = { task, domain, skills };
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
      },
    });
    expect(result.isError).toBe(false);
    expect(received).toEqual({
      task: 'Review the implementation',
      domain: 'review',
      skills: { worker: ['verification'], critic: ['testing-engineering'] },
    });
  });
});
