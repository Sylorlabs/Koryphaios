import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { error: mocks.toastError, success: vi.fn() },
}));

import WorkflowPanel from './WorkflowPanel.svelte';

function workflowResponse() {
  return {
    ok: true,
    json: async () => ({
      ok: true,
      data: {
        definitions: [
          {
            id: 'task-workflow',
            name: 'Workflow',
            description: 'A general evidence-backed workflow.',
            autoStartSafe: true,
            stages: [],
          },
        ],
        drafts: [],
        runs: [],
      },
    }),
  };
}

describe('WorkflowPanel composer placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiFetch.mockResolvedValue(workflowResponse());
  });

  it('renders as a composer-anchored section without a fullscreen modal shell', async () => {
    const onclose = vi.fn();
    const { container } = render(WorkflowPanel, {
      props: { open: true, sessionId: 'session-1', onclose },
    });

    const panel = await screen.findByTestId('workflow-composer-panel');
    expect(panel.tagName).toBe('SECTION');
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('[class~="fixed"][class~="inset-0"]')).toBeNull();
    expect(screen.queryByText('Design Quality Loop')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start workflow' })).toBeVisible();

    await fireEvent.click(screen.getByRole('button', { name: 'Close workflows' }));
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('starts the generic workflow without sending a template id', async () => {
    render(WorkflowPanel, {
      props: { open: true, sessionId: 'session-1', onclose: vi.fn() },
    });
    await screen.findByTestId('workflow-composer-panel');
    mocks.apiFetch.mockClear();

    await fireEvent.input(screen.getByLabelText('Task'), {
      target: { value: 'Fix the composer controls' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }));

    await vi.waitFor(() => {
      const startCall = mocks.apiFetch.mock.calls.find(
        ([url]) => url === '/api/agent/workflows/start',
      );
      expect(startCall).toBeTruthy();
      expect(JSON.parse(String(startCall?.[1]?.body))).toEqual({
        sessionId: 'session-1',
        task: 'Fix the composer controls',
      });
    });
  });
});
