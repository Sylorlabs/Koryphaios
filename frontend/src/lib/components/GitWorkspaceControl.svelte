<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import GitBranch from 'lucide-svelte/icons/git-branch';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import X from 'lucide-svelte/icons/x';
  import Plus from 'lucide-svelte/icons/plus';
  import Minus from 'lucide-svelte/icons/minus';
  import ArrowUp from 'lucide-svelte/icons/arrow-up';
  import ArrowDown from 'lucide-svelte/icons/arrow-down';
  import CheckCircle2 from 'lucide-svelte/icons/check-circle-2';
  import GitCommitHorizontal from 'lucide-svelte/icons/git-commit-horizontal';
  import KorySelect from './KorySelect.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { gitStore } from '$lib/stores/git.svelte';
  import type { GitFileStatus } from '$lib/stores/git.svelte';
  import type {
    ChatGitState,
    ChatGitTarget,
    ChatGitDetails,
    ChatPullRequest,
  } from '@koryphaios/shared';

  let {
    sessionId,
    busy = false,
    revision = 0,
    placement = 'context',
  }: {
    sessionId: string;
    busy?: boolean;
    revision?: number;
    placement?: 'context' | 'composer';
  } = $props();
  let expanded = $state(false);
  let snapshot = $state<ChatGitState | null>(null);
  let loading = $state(false);
  let switching = $state(false);
  let error = $state('');
  let kind = $state<'branch' | 'commit' | 'pull-request'>('branch');
  let selected = $state('');
  let newBranch = $state('');
  let commitHash = $state('');
  let commitSource = $state('chat');
  let prs = $state<ChatPullRequest[]>([]);
  let prNumber = $state('');
  let pr = $state<ChatPullRequest | null>(null);
  let details = $state<ChatGitDetails | null>(null);
  let detailsOpen = $state(false);
  let detailLoading = $state(false);
  let prLoading = $state(false);
  let generation = 0;
  let detailGeneration = 0;
  let prGeneration = 0;
  let fileGeneration = 0;
  let files = $state<GitFileStatus[]>([]);
  let filesReady = $state(false);
  let conflicts = $state<string[]>([]);
  let fileLoading = $state(false);
  let ahead = $state(0);
  let behind = $state(0);
  let remote = $state<string | null>(null);
  let remoteOpen = $state(false);
  let remoteUrl = $state('');
  let message = $state('');
  let action = $state('');
  let notice = $state('');
  let tab = $state('changes');
  let root = $state<HTMLElement>();
  let trigger = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();
  let panelStyle = $state('');
  const tabs = [
    { value: 'changes', label: 'Changes' },
    { value: 'branches', label: 'Branches' },
    { value: 'history', label: 'History' },
    { value: 'prs', label: 'PRs' },
  ];
  const staged = $derived(files.filter((file) => file.staged));
  const unstaged = $derived(files.filter((file) => !file.staged));
  const locked = $derived(busy || switching || !!action || loading || fileLoading);
  const canWrite = $derived(!!snapshot?.head && filesReady && !locked);
  const canCommit = $derived(canWrite && !conflicts.length && !!staged.length && !!message.trim());

  const revisions = $derived([
    ...(snapshot?.refs ?? []).map((item) => ({ ...item, key: `chat:${item.ref}`, source: false })),
    ...(snapshot?.sourceRefs ?? []).map((item) => ({
      ...item,
      key: `source:${item.ref}`,
      source: true,
    })),
  ]);
  const chosen = $derived(revisions.find((item) => item.key === selected));
  const commits = $derived(
    (commitSource === 'source' ? snapshot?.sourceCommits : snapshot?.commits) ?? [],
  );
  const requiresBranch = $derived(
    kind !== 'branch' || !!chosen?.source || chosen?.kind !== 'branch',
  );
  const target = $derived.by((): ChatGitTarget | null => {
    if (kind === 'pull-request')
      return pr
        ? { kind, number: pr.number, branch: newBranch.trim(), expectedHash: pr.headCommit }
        : null;
    if (kind === 'commit')
      return commitHash.trim()
        ? {
            kind,
            ref: commitHash.trim(),
            source: commitSource === 'source',
            branch: newBranch.trim(),
            ...(details?.hash === commitHash.trim() && { expectedHash: details.hash }),
          }
        : null;
    return chosen
      ? {
          kind,
          ref: chosen.ref,
          source: chosen.source,
          expectedHash: chosen.hash,
          ...(newBranch.trim() && { branch: newBranch.trim() }),
        }
      : null;
  });
  const canSwitch = $derived(
    !!snapshot?.head &&
      !!target &&
      !busy &&
      !loading &&
      !switching &&
      !action &&
      !fileLoading &&
      !snapshot.dirty &&
      !snapshot.operationInProgress &&
      (!requiresBranch || !!newBranch.trim()) &&
      (kind !== 'branch' ||
        !!newBranch.trim() ||
        chosen?.source ||
        chosen?.name !== snapshot.branch),
  );
  const currentPr = $derived(snapshot?.selection?.pullRequest);

  async function request(path: string, id: string, init: RequestInit = {}) {
    const response = await apiFetch(
      apiUrl(path),
      { ...init, headers: { 'X-Koryphaios-Session': id, 'Content-Type': 'application/json' } },
      60_000,
    );
    const body = await response.json();
    if (!response.ok || !body.ok) {
      if (id === sessionId && body.data?.hasConflicts)
        gitStore.reportConflicts(body.data.conflicts ?? []);
      throw new Error(body.error || body.data?.output || 'Git request failed.');
    }
    return body.data;
  }
  function clearDetails() {
    detailGeneration++;
    details = null;
    detailsOpen = false;
    detailLoading = false;
  }
  async function refreshFiles(id: string) {
    const epoch = ++fileGeneration;
    fileLoading = true;
    try {
      const value = await request('/api/git/status', id);
      if (epoch !== fileGeneration || id !== sessionId) return;
      files = value.status ?? [];
      conflicts = value.conflicts ?? [];
      ahead = value.ahead ?? 0;
      behind = value.behind ?? 0;
      remote = value.remote ?? null;
      filesReady = !!value.isRepo;
    } catch (cause) {
      if (epoch === fileGeneration && id === sessionId) {
        filesReady = false;
        error = cause instanceof Error ? cause.message : 'Could not load changes.';
      }
    } finally {
      if (epoch === fileGeneration && id === sessionId) fileLoading = false;
    }
  }
  async function refreshAll(id: string) {
    if (id !== sessionId) return;
    error = '';
    await Promise.all([refresh(id), ...(expanded ? [refreshFiles(id)] : [])]);
  }
  function positionPanel() {
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const above = rect.top > window.innerHeight - rect.bottom;
    const space = above ? rect.top - 14 : window.innerHeight - rect.bottom - 14;
    panelStyle = `position:fixed;left:${left}px;width:${width}px;max-height:${Math.max(100, Math.min(460, space))}px;${above ? `bottom:${window.innerHeight - rect.top + 8}px` : `top:${rect.bottom + 8}px`}`;
  }
  async function togglePanel(event: MouseEvent) {
    expanded = !expanded;
    if (!expanded) return;
    positionPanel();
    void refreshAll(sessionId);
    await tick();
    if (event.detail === 0) {
      panel?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    } else {
      panel?.focus({ preventScroll: true });
    }
  }
  function closePanel(restoreFocus = false) {
    expanded = false;
    if (restoreFocus) trigger?.focus();
  }
  function selectTab(value: string) {
    if (value === tab) return;
    tab = value;
    if (value !== 'changes')
      changeKind(value === 'branches' ? 'branch' : value === 'history' ? 'commit' : 'pull-request');
  }
  onMount(() => {
    const outside = (event: PointerEvent) => {
      if (expanded && !root?.contains(event.target as Node)) closePanel();
    };
    const reposition = () => {
      if (expanded) positionPanel();
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  });
  async function mutate(path: string, label: string, body?: unknown) {
    if (!canWrite) return;
    const id = sessionId;
    action = label;
    error = '';
    notice = '';
    try {
      await request(`/api/git/${path}`, id, {
        method: 'POST',
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      if (id !== sessionId) return;
      if (path === 'commit') message = '';
      if (['commit', 'merge', 'pull'].includes(path)) gitStore.clearConflicts();
      if (path === 'remote') remoteOpen = false;
      notice = `${label} complete`;
      gitStore.closeDiff();
      void gitStore.refreshStatus();
      await refreshAll(id);
    } catch (cause) {
      if (id === sessionId) {
        // A failed merge/pull may still have changed the worktree.
        const failure = cause instanceof Error ? cause.message : `${label} failed.`;
        await refreshAll(id);
        if (id === sessionId) error = failure;
      }
    } finally {
      if (id === sessionId) action = '';
    }
  }
  async function refresh(id: string) {
    if (!id) return;
    const epoch = ++generation;
    loading = true;
    try {
      const next = (await request('/api/git/chat', id)) as ChatGitState;
      if (epoch !== generation || id !== sessionId) return;
      snapshot = next;
      if (!selected) selected = next.branch ? `chat:refs/heads/${next.branch}` : '';
    } catch (cause) {
      if (epoch === generation && id === sessionId)
        error = cause instanceof Error ? cause.message : 'Could not load this chat’s Git state.';
    } finally {
      if (epoch === generation && id === sessionId) loading = false;
    }
  }
  $effect(() => {
    const id = sessionId;
    untrack(() => {
      snapshot = null;
      selected = '';
      commitHash = '';
      newBranch = '';
      pr = null;
      prs = [];
      prNumber = '';
      kind = 'branch';
      commitSource = 'chat';
      expanded = false;
      error = '';
      switching = false;
      files = [];
      filesReady = false;
      conflicts = [];
      fileLoading = false;
      ahead = behind = 0;
      remote = null;
      remoteOpen = false;
      remoteUrl = '';
      message = '';
      action = notice = '';
      tab = 'changes';
      fileGeneration++;
      clearDetails();
      prGeneration++;
      prLoading = false;
      void refresh(id);
    });
    return () => {
      generation++;
      detailGeneration++;
      prGeneration++;
      fileGeneration++;
    };
  });
  let lastRefreshKey = '';
  $effect(() => {
    const key = `${sessionId}:${revision}:${busy}`;
    if (key === lastRefreshKey) return;
    const prior = lastRefreshKey;
    lastRefreshKey = key;
    if (prior && !busy)
      untrack(() => {
        if (!switching && !action) void refreshAll(sessionId);
      });
  });

  async function showDetails() {
    const id = sessionId;
    const ref = kind === 'commit' ? commitHash.trim() : (chosen?.ref ?? snapshot?.head);
    const source = kind === 'commit' ? commitSource === 'source' : !!chosen?.source;
    if (!ref) return;
    const epoch = ++detailGeneration;
    detailLoading = true;
    detailsOpen = true;
    try {
      const value = await request(
        `/api/git/chat/commit?ref=${encodeURIComponent(ref)}&source=${source}`,
        id,
      );
      if (id === sessionId && epoch === detailGeneration) {
        details = value;
        error = '';
      }
    } catch (cause) {
      if (id === sessionId && epoch === detailGeneration)
        error = cause instanceof Error ? cause.message : 'Could not load revision details.';
    } finally {
      if (id === sessionId && epoch === detailGeneration) detailLoading = false;
    }
  }
  async function loadPrs() {
    const id = sessionId;
    const epoch = ++prGeneration;
    prLoading = true;
    try {
      const values = await request('/api/git/chat/pull-requests', id);
      if (id === sessionId && epoch === prGeneration) {
        prs = values;
        error = '';
      }
    } catch (cause) {
      if (id === sessionId && epoch === prGeneration)
        error = cause instanceof Error ? cause.message : 'Could not load PRs.';
    } finally {
      if (id === sessionId && epoch === prGeneration) prLoading = false;
    }
  }
  async function loadPr(value: string) {
    const number = Number(value.replace(/^#/, ''));
    if (!Number.isSafeInteger(number) || number < 1) {
      error = 'Enter a positive PR number.';
      return;
    }
    const id = sessionId;
    const epoch = ++prGeneration;
    prLoading = true;
    pr = null;
    try {
      const value = await request(`/api/git/chat/pull-requests/${number}`, id);
      if (id === sessionId && epoch === prGeneration) {
        pr = value;
        prNumber = String(number);
        if (!newBranch) newBranch = `pr/${number}`;
        error = '';
      }
    } catch (cause) {
      if (id === sessionId && epoch === prGeneration)
        error = cause instanceof Error ? cause.message : 'Could not load this PR.';
    } finally {
      if (id === sessionId && epoch === prGeneration) prLoading = false;
    }
  }
  function changeKind(value: string) {
    kind = value as typeof kind;
    clearDetails();
    newBranch = '';
    error = '';
    if (kind === 'pull-request' && pr) newBranch = `pr/${pr.number}`;
    if (kind === 'pull-request' && snapshot?.githubRepository && !prs.length) void loadPrs();
  }
  async function switchRevision() {
    if (!canSwitch || !target || !snapshot?.head) return;
    const id = sessionId;
    const payload = { target, expectedHead: snapshot.head, expectedBranch: snapshot.branch };
    switching = true;
    error = '';
    try {
      const next = await request('/api/git/chat/switch', id, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (id !== sessionId) return;
      generation++;
      snapshot = next;
      newBranch = '';
      selected = `chat:refs/heads/${next.branch}`;
      kind = 'branch';
      tab = 'branches';
      clearDetails();
      gitStore.closeDiff();
      void gitStore.refreshStatus();
      await refreshFiles(id);
      if (id === sessionId) notice = `Switched to ${next.branch}`;
    } catch (cause) {
      if (id === sessionId)
        error = cause instanceof Error ? cause.message : 'Could not switch this chat.';
    } finally {
      if (id === sessionId) switching = false;
    }
  }
</script>

<svelte:window
  onfocus={() => {
    if (sessionId && !busy && !switching && !action) void refreshAll(sessionId);
  }}
/>

{#if sessionId}
  <section
    bind:this={root}
    class="git-workspace {placement === 'composer' ? 'composer-placement' : ''}"
    aria-label="Git for this chat"
  >
    <div class="git-toolbar">
      <button
        bind:this={trigger}
        type="button"
        class="git-toggle"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={expanded ? `git-panel-${sessionId}` : undefined}
        title={snapshot?.branch ?? 'Git'}
        onclick={togglePanel}
      >
        <GitBranch size={placement === 'composer' ? 17 : 14} />
        <span class="branch-name"
          >{snapshot?.branch ??
            (snapshot?.head ? 'Detached' : loading ? 'Loading…' : 'Git unavailable')}</span
        >
        {#if snapshot?.dirty}<span class="change-count">{snapshot.changedFiles}</span>{/if}
        <ChevronDown size={14} class="toggle-chevron" />
      </button>
    </div>
    {#if expanded}
      <div
        bind:this={panel}
        id={`git-panel-${sessionId}`}
        class="git-panel"
        style={panelStyle}
        role="dialog"
        aria-label="Git workspace"
        tabindex="-1"
        onkeydown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.stopPropagation();
            closePanel(true);
          }
        }}
      >
        <header class="panel-header">
          <div class="panel-heading">
            <div class="panel-revision">
              <GitBranch size={14} />
              <strong class="branch-name" title={snapshot?.repositoryPath}
                >{snapshot?.branch ?? (snapshot?.head ? 'Detached HEAD' : 'Git')}</strong
              >
            </div>
          </div>
          {#if snapshot?.head}<code class="head-hash" title={snapshot.head}
              >{snapshot.head.slice(0, 8)}</code
            >{/if}
          <button
            type="button"
            class="icon-button"
            aria-label="Refresh Git"
            disabled={locked}
            onclick={() => refreshAll(sessionId)}
            ><RefreshCw size={15} class={loading || fileLoading ? 'spin' : ''} /></button
          >
          <button
            type="button"
            class="icon-button"
            aria-label="Close Git"
            onclick={() => closePanel(true)}><X size={16} /></button
          >
        </header>
        <div
          class="tabs"
          role="tablist"
          tabindex="-1"
          aria-label="Git views"
          onkeydown={(event) => {
            const index = tabs.findIndex((item) => item.value === tab);
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            selectTab(tabs[next].value);
            (event.currentTarget as HTMLElement)
              .querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [next]?.focus();
          }}
        >
          {#each tabs as item}
            <button
              type="button"
              role="tab"
              id={`git-tab-${sessionId}-${item.value}`}
              aria-selected={tab === item.value}
              aria-controls={`git-view-${sessionId}`}
              tabindex={tab === item.value ? 0 : -1}
              onclick={() => selectTab(item.value)}
              >{item.label}{#if item.value === 'changes' && snapshot?.changedFiles}<span
                  class="muted">{snapshot.changedFiles}</span
                >{/if}</button
            >
          {/each}
        </div>
        <div
          class="panel-body"
          id={`git-view-${sessionId}`}
          role="tabpanel"
          aria-labelledby={`git-tab-${sessionId}-${tab}`}
        >
          {#if error}<p role="alert" class="error">{error}</p>{/if}
          {#if busy}<p class="warning" role="status">Git actions paused during active work.</p>{/if}
          {#if snapshot?.operationInProgress}<p class="warning">
              Resolve the current Git operation first.
            </p>{/if}
          {#if snapshot}
            {#if tab === 'changes'}
              {#if fileLoading && !filesReady}<p class="empty">Loading changes…</p>
              {:else if filesReady && !files.length}
                <div class="clean-state">
                  <CheckCircle2 size={14} />
                  <strong>Working tree clean</strong>
                </div>
              {/if}
              {#each [{ label: 'Staged', items: staged, staged: true }, { label: 'Changes', items: unstaged, staged: false }] as group}
                {#if group.items.length}
                  <section class="file-group" aria-label={group.label}>
                    <div class="group-heading">
                      <span>{group.label} <span class="muted">{group.items.length}</span></span
                      ><button
                        type="button"
                        class="text-button"
                        disabled={!canWrite}
                        onclick={() =>
                          mutate('stage', group.staged ? 'Unstage' : 'Stage', {
                            file: '.',
                            unstage: group.staged,
                          })}>{group.staged ? 'Unstage all' : 'Stage all'}</button
                      >
                    </div>
                    <div class="file-list">
                      {#each group.items as file (`${file.path}:${file.staged}`)}
                        <div class="file-row">
                          <span class="file-status {file.status}" title={file.status}
                            >{file.status === 'untracked'
                              ? '?'
                              : file.status.slice(0, 1).toUpperCase()}</span
                          >
                          <button
                            type="button"
                            class="file-name"
                            title={file.path}
                            aria-label={`View diff for ${file.path}${file.staged ? ' (staged)' : ''}`}
                            onclick={() => {
                              gitStore.openDiff(file.path, file.staged);
                              closePanel();
                            }}>{file.path}</button
                          >
                          {#if file.additions || file.deletions}<span class="diff-stat"
                              ><span class="additions">+{file.additions ?? 0}</span><span
                                class="deletions">−{file.deletions ?? 0}</span
                              ></span
                            >{/if}
                          <button
                            type="button"
                            class="icon-button"
                            aria-label={`${file.staged ? 'Unstage' : 'Stage'} ${file.path}`}
                            disabled={!canWrite}
                            onclick={() =>
                              mutate('stage', file.staged ? 'Unstage' : 'Stage', {
                                file: file.path,
                                unstage: file.staged,
                              })}
                            >{#if file.staged}<Minus size={13} />{:else}<Plus
                                size={13}
                              />{/if}</button
                          >
                        </div>
                      {/each}
                    </div>
                  </section>
                {/if}
              {/each}
              <form
                class="commit-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  if (canCommit) void mutate('commit', 'Commit', { message: message.trim() });
                }}
              >
                <textarea
                  id={`git-commit-message-${sessionId}`}
                  aria-label="Commit message"
                  bind:value={message}
                  placeholder="Commit message"
                  rows="2"
                  disabled={locked}
                  onkeydown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      if (canCommit) void mutate('commit', 'Commit', { message: message.trim() });
                    }
                  }}
                ></textarea>
                <div class="actions">
                  <span class="muted"
                    >{staged.length ? `${staged.length} staged` : 'Stage files to commit'}</span
                  ><button type="submit" class="primary" disabled={!canCommit}
                    ><GitCommitHorizontal size={15} />{action === 'Commit'
                      ? 'Committing…'
                      : 'Commit'}</button
                  >
                </div>
              </form>
            {:else}
              {#if snapshot.dirty}<p class="warning">Commit changes before switching.</p>{/if}
              {#if tab === 'branches'}
                <span class="field-label">Branch or tag</span>
                <KorySelect
                  compact
                  searchable
                  label="Branch or tag"
                  value={selected}
                  options={revisions.map((item) => ({
                    value: item.key,
                    label: `${item.name}${item.source ? ' · source' : ''}${item.kind === 'tag' ? ' · tag' : ''}`,
                  }))}
                  onchange={(value) => {
                    selected = value;
                    clearDetails();
                  }}
                  disabled={locked}
                />
              {:else if tab === 'history'}
                <KorySelect
                  compact
                  label="Commit repository"
                  value={commitSource}
                  options={[
                    { value: 'chat', label: 'This chat' },
                    { value: 'source', label: 'Source project' },
                  ]}
                  onchange={(value) => {
                    commitSource = value;
                    commitHash = '';
                    clearDetails();
                  }}
                  disabled={locked}
                />
                <KorySelect
                  compact
                  label="Commit"
                  value={commitHash}
                  options={commits.map((commit) => ({
                    value: commit.hash,
                    label: `${commit.hash.slice(0, 8)} · ${commit.subject}`,
                  }))}
                  onchange={(value) => {
                    commitHash = value;
                    clearDetails();
                  }}
                  allowCustom
                  customLabel="Enter hash"
                  customPlaceholder="Commit hash"
                  placeholder="Select a commit"
                  disabled={locked}
                />
              {:else if !snapshot.githubRepository}
                <p class="empty">No GitHub remote</p>
              {:else}
                <div class="group-heading">
                  <span class="muted">{snapshot.githubRepository}</span><button
                    type="button"
                    class="icon-button"
                    aria-label="Refresh PRs"
                    disabled={locked || prLoading}
                    onclick={loadPrs}><RefreshCw size={12} /></button
                  >
                </div>
                <KorySelect
                  compact
                  label="Open pull requests"
                  value={pr ? String(pr.number) : ''}
                  options={prs.map((item) => ({
                    value: String(item.number),
                    label: `#${item.number} · ${item.title}${item.draft ? ' · draft' : ''}`,
                  }))}
                  onchange={loadPr}
                  disabled={locked || prLoading}
                  placeholder={prLoading ? 'Loading PRs…' : 'Select a PR'}
                />
                <form
                  class="pr-lookup"
                  onsubmit={(event) => {
                    event.preventDefault();
                    if (!locked && !prLoading && prNumber.trim()) void loadPr(prNumber);
                  }}
                >
                  <input
                    type="text"
                    inputmode="numeric"
                    aria-label="PR number"
                    bind:value={prNumber}
                    placeholder="PR number"
                    disabled={locked || prLoading}
                  />
                  <button type="submit" disabled={locked || prLoading || !prNumber.trim()}
                    >Load</button
                  >
                </form>
                {#if pr}<div class="revision-details" aria-label="Pull request details">
                    <a href={pr.url} target="_blank" rel="noopener noreferrer"
                      >#{pr.number} {pr.title}</a
                    >
                    <p class="muted">{pr.headBranch} → {pr.baseBranch} · {pr.state}</p>
                    {#if pr.changedFiles !== undefined}<p>
                        {pr.changedFiles} files ·
                        <span class="additions">+{pr.additions ?? 0}</span>
                        <span class="deletions">−{pr.deletions ?? 0}</span>
                      </p>{/if}
                  </div>{/if}
              {/if}
              {#if tab !== 'prs' || snapshot.githubRepository}
                {#if kind !== 'pull-request'}
                  <button
                    type="button"
                    class="text-button details-button"
                    disabled={detailLoading || locked || !target}
                    onclick={() => (detailsOpen ? clearDetails() : showDetails())}
                    >{detailLoading
                      ? 'Loading…'
                      : detailsOpen
                        ? 'Hide details'
                        : 'Revision details'}</button
                  >
                  {#if detailsOpen && details}<div
                      class="revision-details"
                      aria-label="Commit details"
                    >
                      <strong>{details.subject}</strong>
                      <p class="muted">
                        {details.author} · {details.date.slice(0, 10)} ·
                        <code>{details.hash.slice(0, 8)}</code>
                      </p>
                      <pre>{details.message}</pre>
                      {#if details.stat}<pre
                          aria-label="Commit file changes">{details.stat}</pre>{/if}
                    </div>{/if}
                {/if}
                <label class="branch-label"
                  >New branch{#if requiresBranch}<span class="muted">required</span>{/if}<input
                    type="text"
                    bind:value={newBranch}
                    placeholder={kind === 'pull-request' ? 'pr/123' : 'feature/my-change'}
                    maxlength="255"
                    disabled={locked}
                    autocomplete="off"
                    spellcheck="false"
                  /></label
                >
                <div class="actions">
                  {#if tab === 'branches'}<button
                      type="button"
                      disabled={!canWrite ||
                        snapshot.dirty ||
                        snapshot.operationInProgress ||
                        !chosen ||
                        chosen.source ||
                        chosen.kind !== 'branch' ||
                        chosen.name === snapshot.branch}
                      onclick={() => chosen && mutate('merge', 'Merge', { branch: chosen.name })}
                      >Merge into current</button
                    >{/if}
                  <button
                    type="button"
                    class="primary"
                    disabled={!canSwitch || prLoading}
                    onclick={switchRevision}
                    >{switching
                      ? 'Switching…'
                      : kind === 'pull-request'
                        ? 'Check out PR'
                        : newBranch.trim() || requiresBranch
                          ? 'Create branch'
                          : 'Switch branch'}</button
                  >
                </div>
              {/if}
            {/if}
          {:else if loading}<p class="empty">Loading Git…</p>{/if}
          {#if notice && !error}<p class="muted" role="status">{notice}</p>{/if}
          {#if remoteOpen}
            <form
              class="remote-form"
              onsubmit={(event) => {
                event.preventDefault();
                if (canWrite && remoteUrl.trim())
                  void mutate('remote', 'Remote setup', { url: remoteUrl.trim() });
              }}
            >
              <label class="branch-label"
                >Remote URL<input
                  aria-label="Remote URL"
                  type="text"
                  bind:value={remoteUrl}
                  placeholder="https://github.com/owner/repo.git"
                  disabled={locked}
                  autocomplete="off"
                  spellcheck="false"
                /></label
              >
              <div class="actions">
                <button type="button" onclick={() => (remoteOpen = false)}>Cancel</button><button
                  type="submit"
                  class="primary"
                  disabled={!canWrite || !remoteUrl.trim()}>Save remote</button
                >
              </div>
            </form>
          {/if}
        </div>
        {#if snapshot}
          <footer class="panel-footer">
            <button
              type="button"
              class="remote-button"
              title={remote ?? 'Configure a remote to push and pull'}
              disabled={locked}
              onclick={() => {
                remoteOpen = !remoteOpen;
                remoteUrl = remote ?? '';
              }}>{remote ? 'Remote' : 'Add remote'}</button
            >
            {#if currentPr}<a
                class="muted"
                href={currentPr.url}
                target="_blank"
                rel="noopener noreferrer">#{currentPr.number}</a
              >{/if}
            <button
              type="button"
              title={remote ? 'Pull from origin' : 'Add a remote first'}
              disabled={!canWrite || !remote || snapshot.dirty || snapshot.operationInProgress}
              onclick={() => mutate('pull', 'Pull')}
              ><ArrowDown size={12} /> Pull{#if behind}<span class="muted">{behind}</span
                >{/if}</button
            >
            <button
              type="button"
              title={remote ? 'Push to origin' : 'Add a remote first'}
              disabled={!canWrite || !remote || snapshot.operationInProgress}
              onclick={() => mutate('push', 'Push')}
              ><ArrowUp size={12} /> Push{#if ahead}<span class="muted">{ahead}</span>{/if}</button
            >
          </footer>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .git-workspace {
    position: relative;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .git-toolbar {
    display: flex;
    align-items: center;
  }
  .git-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    text-align: left;
    min-height: var(--size-button-height-sm);
    max-width: min(240px, 42vw);
    padding: 0 var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
  }
  .composer-placement .git-toggle {
    min-height: var(--size-button-height-lg);
    padding: 0 var(--space-3);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text-primary);
  }
  .git-toggle[aria-expanded='true'] {
    background: var(--color-surface-3);
    border-color: var(--color-border-bright);
  }
  .git-toggle :global(.toggle-chevron) {
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-out);
  }
  .git-toggle[aria-expanded='true'] :global(.toggle-chevron) {
    transform: rotate(180deg);
  }
  .git-toggle :global(svg) {
    flex-shrink: 0;
  }
  .branch-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-primary);
  }
  .muted {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
  }
  button {
    cursor: pointer;
    transition:
      background var(--duration-fast) var(--ease-out),
      color var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
  }
  button:hover:not(:disabled) {
    background: var(--color-surface-3);
  }
  button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .git-panel {
    display: flex;
    flex-direction: column;
    z-index: 90;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
    background: var(--color-surface-2);
    box-shadow: 0 6px 20px color-mix(in srgb, var(--color-surface-0) 35%, transparent);
    overflow: hidden;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
  .git-panel:focus {
    outline: none;
  }
  .panel-header,
  .panel-footer {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    flex-shrink: 0;
  }
  .panel-heading {
    display: grid;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
  }
  .panel-revision {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .panel-revision :global(svg) {
    flex-shrink: 0;
  }
  .head-hash {
    padding: 0 var(--space-1);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  strong {
    color: var(--color-text-primary);
    font-weight: var(--font-medium);
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--size-8);
    height: var(--size-8);
    border-radius: var(--radius-lg);
    flex-shrink: 0;
    color: var(--color-text-muted);
  }
  .icon-button:hover:not(:disabled) {
    color: var(--color-text-primary);
  }
  .change-count {
    min-width: var(--size-4);
    padding: 0 var(--space-1);
    border-radius: var(--radius-full);
    background: var(--color-warning-bg);
    font-size: var(--text-xs);
    color: var(--color-warning);
    text-align: center;
  }
  .tabs {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-2);
    border-block: 1px solid var(--color-border);
    flex-shrink: 0;
  }
  .tabs button {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: var(--space-1);
    min-width: 0;
    min-height: var(--size-8);
    padding: var(--space-1) var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-lg);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--color-text-muted);
  }
  .tabs button[aria-selected='true'] {
    color: var(--color-text-primary);
    border-color: var(--color-border);
    background: var(--color-surface-3);
  }
  .tabs button:focus-visible {
    outline-offset: -2px;
  }
  .panel-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    overflow-y: auto;
    min-height: 0;
  }
  p {
    margin: 0;
  }
  .empty {
    text-align: center;
    color: var(--color-text-muted);
    padding: var(--space-6) 0;
  }
  .clean-state {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3) 0;
    text-align: center;
  }
  .clean-state :global(svg) {
    color: var(--color-success);
  }
  .warning,
  .error {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-lg);
    font-size: var(--text-xs);
  }
  .warning {
    color: var(--color-warning);
    background: var(--color-warning-bg);
  }
  .error {
    color: var(--color-error);
    background: var(--color-error-bg);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .group-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--size-6);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }
  .group-heading > span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .text-button {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-2);
    min-height: var(--size-button-height-sm);
    border-radius: var(--radius-lg);
    flex-shrink: 0;
  }
  .file-list {
    max-height: var(--size-40);
    overflow-y: auto;
  }
  .file-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--size-8);
    padding: 0 var(--space-1);
    border-radius: var(--radius-lg);
  }
  .file-row:hover {
    background: var(--color-surface-3);
  }
  .file-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: left;
    font-size: var(--text-xs);
    padding: var(--space-1) 0;
    border-radius: var(--radius-lg);
  }
  .file-status {
    width: var(--size-4);
    flex-shrink: 0;
    font-size: var(--text-xs);
    text-align: center;
    color: var(--color-warning);
  }
  .file-status.added,
  .file-status.untracked,
  .additions {
    color: var(--color-success);
  }
  .file-status.deleted,
  .deletions {
    color: var(--color-error);
  }
  .diff-stat {
    display: flex;
    gap: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .commit-form,
  .remote-form {
    display: grid;
    gap: var(--space-2);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
  }
  input,
  textarea {
    width: 100%;
    min-width: 0;
    background: var(--color-surface-1);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
    min-height: var(--size-input-height-md);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-lg);
    font: inherit;
    transition:
      border-color var(--duration-fast) var(--ease-out),
      box-shadow var(--duration-fast) var(--ease-out);
  }
  input::placeholder,
  textarea::placeholder {
    color: var(--color-text-muted);
  }
  input:focus,
  textarea:focus {
    outline: none;
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 15%, transparent);
  }
  input:disabled,
  textarea:disabled {
    opacity: 0.55;
  }
  textarea {
    resize: none;
    min-height: var(--size-16);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .actions > button:last-child {
    margin-left: auto;
  }
  .actions button,
  .pr-lookup button,
  .panel-footer button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: var(--size-button-height-lg);
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-3);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }
  .actions button:hover:not(:disabled),
  .pr-lookup button:hover:not(:disabled),
  .panel-footer button:hover:not(:disabled) {
    background: var(--color-surface-4);
    border-color: var(--color-border-bright);
  }
  .actions .primary {
    background: var(--color-accent);
    color: var(--color-on-accent);
    border-color: var(--color-accent);
  }
  .actions .primary:hover:not(:disabled) {
    background: var(--color-accent-hover, var(--color-accent));
  }
  .actions .primary:disabled {
    opacity: 1;
    background: var(--color-surface-3);
    color: var(--color-text-muted);
    border-color: var(--color-border);
  }
  .branch-label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }
  .branch-label input {
    flex-basis: 100%;
  }
  .field-label {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }
  .pr-lookup {
    display: flex;
    gap: var(--space-2);
  }
  .revision-details {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-1);
    overflow-wrap: anywhere;
  }
  .details-button {
    align-self: flex-start;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    max-height: var(--size-40);
    overflow: auto;
    margin: 0;
  }
  a {
    color: var(--color-accent);
  }
  .panel-footer {
    border-top: 1px solid var(--color-border);
    background: var(--color-surface-1);
  }
  .panel-footer .remote-button {
    margin-right: auto;
    border-color: transparent;
    background: transparent;
    color: var(--color-text-muted);
    padding: var(--space-1) var(--space-2);
  }
  .panel-footer .remote-button:hover:not(:disabled) {
    color: var(--color-text-primary);
  }
  .git-panel :global(.spin) {
    animation: git-spin 1s linear infinite;
  }
  @keyframes git-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .git-panel :global(.spin) {
      animation: none;
    }
    button,
    .git-toggle :global(.toggle-chevron),
    input,
    textarea {
      transition: none;
    }
  }
</style>
