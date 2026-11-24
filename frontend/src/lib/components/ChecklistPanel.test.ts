import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import type { Checklist } from '@koryphaios/shared';
import ChecklistPanel from './ChecklistPanel.svelte';
import { checklistStore } from '$lib/stores/checklists.svelte';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('$lib/api.svelte', () => ({ apiFetch }));
vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: 'chat' } }));
vi.mock('$lib/stores/project.svelte', () => ({ projectStore: { currentPath: '/project' } }));

/** Build server-shaped data so live events and reload use the same contract. */
function checklist(id = 'plan', count = 6): Checklist {
  return {
    id,
    title: `Plan ${id}`,
    scope: 'session',
    sessionId: 'chat',
    createdAt: 1,
    updatedAt: 1,
    activity: [],
    items: Array.from({ length: count }, (_, index) => ({
      id: `step-${index}`,
      title: `Step ${index + 1}`,
      order: index,
      status: index === 0 ? 'done' : 'pending',
      createdAt: 1,
    })),
  };
}

beforeEach(async () => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ json: async () => ({ ok: true, data: [] }) });
  await checklistStore.refresh();
});

it('automatically shows agent events and lets the user collapse and expand the list', async () => {
  render(ChecklistPanel, { open: true });
  checklistStore.handleUpdated({ checklist: checklist() });
  await tick();
  const toggle = screen.getByRole('button', { name: /Collapse checklist: Plan plan/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getAllByRole('checkbox')).toHaveLength(6);
  expect(
    screen.getByRole('checkbox', { name: 'Reopen: Step 1' }).getAttribute('aria-checked'),
  ).toBe('true');
  expect(
    screen.getByRole('list', { name: 'Checklist items' }).classList.contains('docked-items'),
  ).toBe(true);
  await fireEvent.click(toggle);
  expect(screen.queryByRole('checkbox')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: /Expand checklist: Plan plan/ }));
  expect(screen.getAllByRole('checkbox')).toHaveLength(6);
});

it('folds the whole panel to its header and restores the lists', async () => {
  render(ChecklistPanel, { open: true });
  checklistStore.handleUpdated({ checklist: checklist() });
  await tick();
  const header = screen.getByRole('button', { name: 'Collapse checklists' });
  expect(header.getAttribute('aria-expanded')).toBe('true');
  await fireEvent.click(header);
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /Expand checklist: Plan plan/ })).toBeNull();
  const expand = screen.getByRole('button', { name: 'Expand checklists' });
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  await fireEvent.click(expand);
  expect(screen.getAllByRole('checkbox')).toHaveLength(6);
});

it('loads persisted lists and removes them when an agent finishes or closes them', async () => {
  const saved = checklist();
  apiFetch.mockResolvedValue({ json: async () => ({ ok: true, data: [saved] }) });
  render(ChecklistPanel, { open: true });
  await screen.findByRole('button', { name: /Collapse checklist: Plan plan/ });
  checklistStore.handleUpdated({ checklist: { ...saved, archivedAt: 2 } });
  await tick();
  // The panel itself stays while the composer keeps it open; the finished
  // list's row is what goes away.
  expect(screen.queryByRole('button', { name: /Plan plan/ })).toBeNull();
  checklistStore.handleUpdated({ checklist: saved });
  await tick();
  expect(screen.getByText('Step 2')).toBeTruthy();
  checklistStore.handleUpdated({ deletedId: saved.id });
  await tick();
  expect(screen.queryByText('Step 2')).toBeNull();
});

it('archives on user close and retains the panel with an error when closing fails', async () => {
  render(ChecklistPanel, { open: true });
  const saved = checklist();
  checklistStore.handleUpdated({ checklist: saved });
  await tick();
  apiFetch.mockRejectedValueOnce(new Error('Connection lost'));
  await fireEvent.click(screen.getByRole('button', { name: 'Close checklist: Plan plan' }));
  await screen.findByRole('alert');
  expect(screen.getByText('Connection lost')).toBeTruthy();
  expect(screen.getByText('Step 2')).toBeTruthy();
  apiFetch.mockResolvedValueOnce({
    json: async () => ({ ok: true, data: { ...saved, archivedAt: 2 } }),
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Close checklist: Plan plan' }));
  await waitFor(() => expect(screen.queryByText('Step 2')).toBeNull());
  expect(apiFetch).toHaveBeenLastCalledWith(
    expect.stringContaining('/api/checklists/plan'),
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    }),
  );
});

it('offers a dismiss control when /checklist opens an empty panel', async () => {
  const onDismiss = vi.fn();
  render(ChecklistPanel, { open: true, onDismiss });
  await tick();

  // No lists yet: the panel is only here because the command opened it, so the
  // header's dismiss control is the way out without creating and closing one.
  expect(screen.queryByRole('checkbox')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Hide checklists' }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it('scopes a checklist created in a chat to that chat', async () => {
  render(ChecklistPanel, { open: true });
  await fireEvent.click(screen.getByRole('button', { name: /New checklist/ }));
  await fireEvent.input(screen.getByRole('textbox', { name: 'New checklist title' }), {
    target: { value: 'Ship the fix' },
  });
  apiFetch.mockResolvedValueOnce({
    json: async () => ({ ok: true, data: { ...checklist('new'), title: 'Ship the fix' } }),
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/checklists'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'Ship the fix', sessionId: 'chat', scope: 'session' }),
      }),
    ),
  );
});

it('updates progress live and keeps session and project lists in their own scope', async () => {
  render(ChecklistPanel, { open: true });
  const saved = checklist();
  checklistStore.handleUpdated({ checklist: saved });
  checklistStore.handleUpdated({ checklist: { ...checklist('other'), sessionId: 'other-chat' } });
  checklistStore.handleUpdated({
    checklist: { ...checklist('project'), scope: 'project', projectPath: '/project' },
  });
  checklistStore.handleUpdated({
    checklist: { ...checklist('foreign'), scope: 'project', projectPath: '/elsewhere' },
  });
  await tick();
  expect(screen.queryByText('Plan other')).toBeNull();
  expect(screen.queryByText('Plan foreign')).toBeNull();
  expect(screen.getByText('Plan project')).toBeTruthy();
  checklistStore.handleUpdated({
    checklist: {
      ...saved,
      items: saved.items.map((item, index) => (index === 1 ? { ...item, status: 'done' } : item)),
    },
  });
  await tick();
  expect(screen.getByText('2/6')).toBeTruthy();
});
