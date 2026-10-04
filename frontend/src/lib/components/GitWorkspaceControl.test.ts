import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGitState, ChatPullRequest } from '@koryphaios/shared';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  refresh: vi.fn(),
  closeDiff: vi.fn(),
  openDiff: vi.fn(),
  reportConflicts: vi.fn(),
  clearConflicts: vi.fn(),
}));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.request }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/git.svelte', () => ({
  gitStore: {
    refreshStatus: mocks.refresh,
    closeDiff: mocks.closeDiff,
    openDiff: mocks.openDiff,
    reportConflicts: mocks.reportConflicts,
    clearConflicts: mocks.clearConflicts,
  },
}));
import GitWorkspaceControl from './GitWorkspaceControl.svelte';
const hash = 'a'.repeat(40);
const otherHash = 'b'.repeat(40);
const snapshot: ChatGitState = {
  sessionId: 'chat-a',
  isolated: true,
  isRepo: true,
  repositoryPath: '/isolated/chat-a',
  branch: 'chat-main',
  head: hash,
  dirty: false,
  changedFiles: 0,
  operationInProgress: false,
  githubRepository: 'owner/repo',
  refs: [
    { ref: 'refs/heads/chat-main', name: 'chat-main', kind: 'branch', hash },
    { ref: 'refs/heads/feature', name: 'feature', kind: 'branch', hash: otherHash },
  ],
  commits: [{ hash, subject: 'Initial commit', author: 'Test', date: '2026-01-01' }],
  sourceRefs: [
    { ref: 'refs/heads/source-feature', name: 'source-feature', kind: 'branch', hash: otherHash },
  ],
  sourceCommits: [],
};
const pr: ChatPullRequest = {
  number: 42,
  title: 'A helpful PR',
  repository: 'owner/repo',
  url: 'https://github.com/owner/repo/pull/42',
  state: 'open',
  draft: false,
  author: 'author',
  baseBranch: 'main',
  headBranch: 'feature',
  headCommit: otherHash,
  changedFiles: 3,
  additions: 12,
  deletions: 2,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockImplementation(async (url: string, init: RequestInit) => {
    if (url === '/api/git/status')
      return Response.json({
        ok: true,
        data: {
          isRepo: true,
          status: [],
          ahead: 1,
          behind: 0,
          remote: 'https://github.com/owner/repo.git',
        },
      });
    if (url === '/api/git/chat/switch')
      return Response.json({ ok: true, data: { ...snapshot, branch: 'feature', head: otherHash } });
    if (url === '/api/git/chat/pull-requests') return Response.json({ ok: true, data: [pr] });
    if (url === '/api/git/chat/pull-requests/42') return Response.json({ ok: true, data: pr });
    if (url.startsWith('/api/git/chat/commit'))
      return Response.json({
        ok: true,
        data: {
          hash,
          subject: 'Commit detail',
          message: 'Full commit description',
          author: 'Test',
          date: '2026-01-01',
          stat: 'file.ts | 2 +-',
        },
      });
    return Response.json({ ok: true, data: snapshot });
  });
});
async function open(tab = 'Branches') {
  await fireEvent.click(await screen.findByRole('button', { name: /^chat-main/ }));
  if (tab !== 'Changes') await fireEvent.click(screen.getByRole('tab', { name: tab }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh Git' })).not.toBeDisabled(),
  );
}
async function choose(label: string, option: RegExp) {
  await fireEvent.click(screen.getByRole('combobox', { name: label }));
  await fireEvent.click(screen.getByRole('option', { name: option }));
}
function switchCalls() {
  return mocks.request.mock.calls.filter(([url]) => url === '/api/git/chat/switch');
}

describe('per-chat Git workspace controls', () => {
  it('switches the same chat and pins its session header and current HEAD', async () => {
    const { container } = render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open();
    expect(container.querySelector('select')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Git workspace' })).toBeVisible();
    expect(screen.queryByText(/Other chats and the source project stay unchanged/)).toBeNull();
    await choose('Branch or tag', /^feature$/);
    await fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));
    await waitFor(() => expect(switchCalls()).toHaveLength(1));
    const [, init] = switchCalls()[0];
    expect(init.headers['X-Koryphaios-Session']).toBe('chat-a');
    expect(JSON.parse(init.body)).toEqual({
      expectedHead: hash,
      expectedBranch: 'chat-main',
      target: { kind: 'branch', ref: 'refs/heads/feature', source: false, expectedHash: otherHash },
    });
    expect(mocks.request.mock.calls.some(([url]) => url === '/api/sessions')).toBe(false);
  });
  it('loads full commit details only on demand and requires a working branch', async () => {
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open();
    expect(mocks.request.mock.calls.some(([url]) => url.includes('/commit?'))).toBe(false);
    await fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    await choose('Commit', /Initial commit/);
    expect(screen.getByRole('button', { name: 'Create branch' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Revision details' }));
    expect(await screen.findByText('Full commit description')).toBeVisible();
    expect(screen.getByLabelText('Commit file changes')).toHaveTextContent('file.ts');
    await fireEvent.input(screen.getByRole('textbox', { name: /New branch/ }), {
      target: { value: 'from-commit' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    expect(JSON.parse(switchCalls()[0][1].body).target).toMatchObject({
      kind: 'commit',
      ref: hash,
      branch: 'from-commit',
    });
  });
  it('shows PR details and opens the pinned PR head in this chat', async () => {
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open();
    await fireEvent.click(screen.getByRole('tab', { name: 'PRs' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Open pull requests' })).not.toBeDisabled(),
    );
    await choose('Open pull requests', /#42 · A helpful PR/);
    expect(await screen.findByRole('link', { name: '#42 A helpful PR' })).toHaveAttribute(
      'href',
      pr.url,
    );
    expect(screen.getByText(/3 files/)).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'Check out PR' }));
    expect(JSON.parse(switchCalls()[0][1].body).target).toEqual({
      kind: 'pull-request',
      number: 42,
      branch: 'pr/42',
      expectedHash: otherHash,
    });
  });
  it.each([{ dirty: true, changedFiles: 2 }, { operationInProgress: true }])(
    'blocks unsafe switching: %o',
    async (overrides) => {
      mocks.request.mockImplementation(async (url: string) =>
        Response.json({
          ok: true,
          data:
            url === '/api/git/status'
              ? { isRepo: true, status: [] }
              : { ...snapshot, ...overrides },
        }),
      );
      render(GitWorkspaceControl, { sessionId: 'chat-a' });
      await fireEvent.click(await screen.findByRole('button', { name: /^chat-main/ }));
      await fireEvent.click(screen.getByRole('tab', { name: 'Branches' }));
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Branch or tag' })).not.toBeDisabled(),
      );
      await choose('Branch or tag', /^feature$/);
      expect(screen.getByRole('button', { name: 'Switch branch' })).toBeDisabled();
    },
  );
  it('blocks UI switching during an active run', async () => {
    render(GitWorkspaceControl, { sessionId: 'chat-a', busy: true });
    await fireEvent.click(await screen.findByRole('button', { name: /^chat-main/ }));
    await fireEvent.click(screen.getByRole('tab', { name: 'Branches' }));
    expect(screen.getByRole('button', { name: 'Switch branch' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('active work');
  });
  it('resets on chat changes even when both chats belong to the same source project', async () => {
    let finish!: (value: Response) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    await view.rerender({ sessionId: 'chat-b' });
    await screen.findByRole('button', { name: /^chat-main/ });
    finish(Response.json({ ok: true, data: { ...snapshot, branch: 'old-chat-branch' } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('old-chat-branch')).toBeNull();
    expect(mocks.request.mock.calls.at(-1)?.[1].headers['X-Koryphaios-Session']).toBe('chat-b');
  });
  it('imports source branches only with an explicit new chat branch', async () => {
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open();
    await choose('Branch or tag', /^source-feature · source/);
    expect(screen.getByRole('button', { name: 'Create branch' })).toBeDisabled();
    await fireEvent.input(screen.getByRole('textbox', { name: /New branch/ }), {
      target: { value: 'imported' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    expect(JSON.parse(switchCalls()[0][1].body).target).toMatchObject({
      source: true,
      branch: 'imported',
      ref: 'refs/heads/source-feature',
    });
  });

  it('stages files before committing and pins every write to the chat', async () => {
    let staged = false;
    let committed = false;
    mocks.request.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/api/git/status')
        return Response.json({
          ok: true,
          data: {
            isRepo: true,
            status: committed ? [] : [{ path: 'src/file.ts', status: 'modified', staged }],
          },
        });
      if (url === '/api/git/stage') staged = true;
      if (url === '/api/git/commit') committed = true;
      return Response.json({ ok: true, data: snapshot });
    });
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open('Changes');
    await fireEvent.input(screen.getByRole('textbox', { name: 'Commit message' }), {
      target: { value: 'Fix file' },
    });
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Stage src/file.ts' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit' })).not.toBeDisabled());
    await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Commit message' }), {
      key: 'Enter',
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(''),
    );
    const writes = mocks.request.mock.calls.filter(([url]) =>
      ['/api/git/stage', '/api/git/commit'].includes(url),
    );
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0][1].body)).toEqual({ file: 'src/file.ts', unstage: false });
    expect(JSON.parse(writes[1][1].body)).toEqual({ message: 'Fix file' });
    for (const [, init] of writes) expect(init.headers['X-Koryphaios-Session']).toBe('chat-a');
  });

  it('preserves the commit message and shows the Git error on failure', async () => {
    mocks.request.mockImplementation(async (url: string) => {
      if (url === '/api/git/status')
        return Response.json({
          ok: true,
          data: { isRepo: true, status: [{ path: 'file', status: 'added', staged: true }] },
        });
      if (url === '/api/git/commit')
        return Response.json({ ok: false, error: 'Commit hook failed' }, { status: 500 });
      return Response.json({ ok: true, data: snapshot });
    });
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open('Changes');
    await fireEvent.input(screen.getByRole('textbox', { name: 'Commit message' }), {
      target: { value: 'Keep this draft' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Commit hook failed');
    expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue('Keep this draft');
  });

  it.each([
    ['unresolved', ['file.ts'], true],
    ['resolved', [], false],
  ] as const)(
    'allows completing a %s merge only after conflicts are resolved',
    async (_state, conflicts, disabled) => {
      mocks.request.mockImplementation(async (url: string) =>
        Response.json({
          ok: true,
          data:
            url === '/api/git/status'
              ? {
                  isRepo: true,
                  conflicts,
                  status: [{ path: 'file.ts', status: 'modified', staged: true }],
                }
              : { ...snapshot, operationInProgress: true },
        }),
      );
      render(GitWorkspaceControl, { sessionId: 'chat-a' });
      await open('Changes');
      await fireEvent.input(screen.getByRole('textbox', { name: 'Commit message' }), {
        target: { value: 'Resolve merge' },
      });
      expect((screen.getByRole('button', { name: 'Commit' }) as HTMLButtonElement).disabled).toBe(
        disabled,
      );
    },
  );

  it('opens the selected staged diff', async () => {
    mocks.request.mockImplementation(async (url: string) =>
      Response.json({
        ok: true,
        data:
          url === '/api/git/status'
            ? { isRepo: true, status: [{ path: 'file.ts', status: 'modified', staged: true }] }
            : snapshot,
      }),
    );
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open('Changes');
    await fireEvent.click(screen.getByRole('button', { name: 'View diff for file.ts (staged)' }));
    expect(mocks.openDiff).toHaveBeenCalledWith('file.ts', true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('requires an explicit remote before pushing, then refreshes remote state', async () => {
    let remote: string | null = null;
    mocks.request.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/api/git/status')
        return Response.json({ ok: true, data: { isRepo: true, status: [], remote } });
      if (url === '/api/git/remote') remote = JSON.parse(init.body as string).url;
      return Response.json({ ok: true, data: snapshot });
    });
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open('Changes');
    expect(screen.getByRole('button', { name: 'Push' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    await fireEvent.input(screen.getByRole('textbox', { name: 'Remote URL' }), {
      target: { value: 'https://github.com/owner/repo.git' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save remote' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Push' })).not.toBeDisabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    await waitFor(() =>
      expect(mocks.request.mock.calls.some(([url]) => url === '/api/git/push')).toBe(true),
    );
    expect(
      mocks.request.mock.calls.find(([url]) => url === '/api/git/push')?.[1].headers[
        'X-Koryphaios-Session'
      ],
    ).toBe('chat-a');
  });

  it('routes merge conflicts into recovery and displays the failure', async () => {
    const original = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (url: string, init: RequestInit) =>
      url === '/api/git/merge'
        ? Response.json({
            ok: false,
            data: { hasConflicts: true, conflicts: ['file.ts'], output: 'CONFLICT in file.ts' },
          })
        : original(url, init),
    );
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open();
    await choose('Branch or tag', /^feature$/);
    await fireEvent.click(screen.getByRole('button', { name: 'Merge into current' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('CONFLICT in file.ts');
    expect(mocks.reportConflicts).toHaveBeenCalledWith(['file.ts']);
  });

  it('supports keyboard tabs and restores focus on Escape', async () => {
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open('Changes');
    await fireEvent.keyDown(screen.getByRole('tab', { name: 'Changes' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Branches' })).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /^chat-main/ })).toHaveFocus();
  });

  it('filters branches and lets Escape close the dropdown before the panel', async () => {
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open();
    await fireEvent.click(screen.getByRole('combobox', { name: 'Branch or tag' }));
    const search = await screen.findByRole('textbox', { name: 'Search Branch or tag' });
    await fireEvent.input(search, { target: { value: 'source' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('source-feature');
    await fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog')).toBeVisible();
    await fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on outside clicks', async () => {
    render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await open();
    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores late file status after changing chats', async () => {
    let finish!: (response: Response) => void;
    const original = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((url: string, init: RequestInit) =>
      url === '/api/git/status' &&
      (init.headers as Record<string, string>)['X-Koryphaios-Session'] === 'chat-a'
        ? new Promise<Response>((resolve) => (finish = resolve))
        : original(url, init),
    );
    const view = render(GitWorkspaceControl, { sessionId: 'chat-a' });
    await fireEvent.click(await screen.findByRole('button', { name: /^chat-main/ }));
    await waitFor(() => expect(finish).toBeDefined());
    await view.rerender({ sessionId: 'chat-b' });
    await open('Changes');
    finish(
      Response.json({
        ok: true,
        data: { isRepo: true, status: [{ path: 'old-chat.ts', status: 'modified', staged: true }] },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('old-chat.ts')).toBeNull();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });
});
