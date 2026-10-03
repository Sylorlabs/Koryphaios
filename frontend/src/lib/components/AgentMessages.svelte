<script lang="ts">
  import MessagesSquare from 'lucide-svelte/icons/messages-square';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import Check from 'lucide-svelte/icons/check';
  import X from 'lucide-svelte/icons/x';
  import { requestExpandAnchor } from '$lib/utils/expand-anchor';
  import type { AgentMessage, AgentMessageStatus } from '@koryphaios/shared';
  import {
    agentMessagesFor,
    agentMessageUnreadCount,
    decideAgentMessage,
    hydrateAgentMessages,
    markAgentMessagesRead,
    hasPendingAgentApproval,
  } from '$lib/stores/agent-messages.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';

  let expanded = $state(false);
  let deciding = $state('');
  const messagesId = $props.id();

  const activeSessionId = $derived(sessionStore.activeSessionId ?? '');
  const messages = $derived(activeSessionId ? agentMessagesFor(activeSessionId) : []);
  const unread = $derived(activeSessionId ? agentMessageUnreadCount(activeSessionId) : 0);
  const hasPending = $derived(activeSessionId ? hasPendingAgentApproval(activeSessionId) : false);

  $effect(() => {
    if (activeSessionId) {
      void hydrateAgentMessages(activeSessionId);
    }
  });

  $effect(() => {
    if (expanded && activeSessionId) {
      markAgentMessagesRead(activeSessionId);
    }
  });

  const statusStyles: Record<AgentMessageStatus, string> = {
    queued: 'text-[var(--color-text-muted)]',
    pending_approval: 'text-[var(--color-warning)]',
    delivered: 'text-[var(--color-info)]',
    answered: 'text-[var(--color-success)]',
    declined: 'text-[var(--color-text-muted)]',
    failed: 'text-[var(--color-error)]',
  };

  function statusLabel(message: AgentMessage): string {
    switch (message.status) {
      case 'queued':
        return 'queued';
      case 'pending_approval':
        return 'awaiting approval';
      case 'delivered':
        return 'delivered';
      case 'answered':
        return 'answered';
      case 'declined':
        return 'declined';
      case 'failed':
        return 'failed';
    }
  }

  function summaryLine(message: AgentMessage): string {
    const direction = message.fromSessionId === activeSessionId ? 'messaged' : 'message from';
    const party = message.fromSessionId === activeSessionId ? message.toLabel : message.fromLabel;
    return `${direction} ${party}`;
  }

  function relativeTime(ts: number | undefined): string {
    if (!ts) return '';
    const delta = Date.now() - ts;
    if (delta < 60_000) return 'just now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    return `${Math.floor(delta / 86_400_000)}d ago`;
  }

  async function decide(messageId: string, approved: boolean): Promise<void> {
    deciding = messageId;
    try {
      await decideAgentMessage(messageId, approved);
    } finally {
      deciding = '';
    }
  }
</script>

<div
  class="agent-messages border-y border-[var(--color-border)]"
  data-testid="agent-messages-panel"
>
  <button
    type="button"
    class="flex w-full flex-wrap items-center gap-2 py-3 text-left"
    aria-expanded={expanded}
    aria-controls={expanded ? messagesId : undefined}
    onclick={(event) => {
      requestExpandAnchor(event.currentTarget);
      expanded = !expanded;
    }}
  >
    {#if expanded}
      <ChevronDown size={16} class="text-[var(--color-text-muted)]" />
    {:else}
      <ChevronRight size={16} class="text-[var(--color-text-muted)]" />
    {/if}
    <MessagesSquare size={16} class="text-[var(--color-accent)]" />
    <span class="text-sm font-semibold text-[var(--color-text-primary)]">Agent messages</span>
    {#if unread > 0}
      <span
        class="text-xs font-medium text-[var(--color-accent)]"
        aria-label={`${unread} unread`}
        data-testid="agent-messages-unread"
      >
        {unread}
      </span>
    {/if}
    {#if hasPending}
      <span
        class="text-xs font-medium text-[var(--color-warning)]"
      >
        approval needed
      </span>
    {/if}
    <span class="ml-auto text-xs text-[var(--color-text-muted)]">{messages.length}</span>
  </button>

  {#if expanded}
    <!-- The bounded message history needs a keyboard scroll target. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div id={messagesId} class="message-list max-h-80 overflow-y-auto pb-2" role="region" aria-label="Agent messages" tabindex="0">
      {#if messages.length === 0}
        <p class="py-2 text-xs text-[var(--color-text-muted)]">
          No messages yet.
        </p>
      {:else}
        {#each messages as message (message.id)}
          <div
            class="border-t border-[var(--color-border)] py-3"
            data-testid="agent-message-entry"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-semibold text-[var(--color-text-primary)]">
                {summaryLine(message)}
              </span>
              <span class="text-xs {statusStyles[message.status]}">
                {statusLabel(message)}
              </span>
            </div>
            <p class="mt-1 text-xs font-medium text-[var(--color-text-primary)]">
              {message.subject}
              <span class="ml-2 font-normal text-[var(--color-text-muted)]">
                {relativeTime(message.createdAt)}
              </span>
            </p>
            <p class="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--color-text-secondary)]">
              {message.body}
            </p>
            {#if message.reply}
              <p
                class="mt-2 border-l border-[var(--color-border)] pl-3 whitespace-pre-wrap break-words text-sm text-[var(--color-text-primary)]"
              >
                Reply: {message.reply}
              </p>
            {/if}
            {#if message.status === 'pending_approval'}
              <div class="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={deciding === message.id}
                  class="flex min-h-7 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[var(--color-success)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                  onclick={() => decide(message.id, true)}
                >
                  <Check size={12} /> Approve
                </button>
                <button
                  type="button"
                  disabled={deciding === message.id}
                  class="flex min-h-7 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[var(--color-error)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                  onclick={() => decide(message.id, false)}
                >
                  <X size={12} /> Decline
                </button>
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .message-list {
    scrollbar-width: thin;
    overflow-wrap: anywhere;
  }

  .agent-messages button:focus-visible,
  .message-list:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }
</style>
