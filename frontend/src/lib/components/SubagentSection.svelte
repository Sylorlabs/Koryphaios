<script lang="ts">
  // A sub-agent's own conversation, nested under the tool call that ran it
  // (imported chats). Collapsed it is one line; expanded it is a compact
  // transcript built with the same renderers as the parent: assistant turns go
  // through partsToFeedEntries (the one parts expansion), reasoning through
  // ThinkingBlock, text through the chat markdown renderer and tools through
  // ToolActivity — which renders a nested sub-agent recursively.
  //
  // Large transcripts are not shipped in the message payload: the API sends a
  // `stub` (name/model/turn count plus the path of the transcript inside the
  // stored message) and the full turns are fetched on first expand.
  import type { SubagentStub, SubagentTranscript, SubagentTurn, TranscriptPart } from '@koryphaios/shared';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import ThinkingBlock from './ThinkingBlock.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import type { FeedEntryLocal } from '$lib/types';
  import { partsToFeedEntries } from '$lib/stores/transcript-turns';
  import { renderChatMarkdown } from '$lib/utils/chat-markdown';
  import { requestReaderResize } from '$lib/utils/expand-anchor';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';

  interface Props {
    subagent?: SubagentTranscript | null;
    /** Set when the transcript was stripped from the list payload for size. */
    stub?: SubagentStub | null;
    /** Session the parent row belongs to; nested rows carry it like any row. */
    sessionId: string;
    /** Stable id of the owning tool row, used to derive nested row ids. */
    ownerId: string;
  }

  let { subagent, stub, sessionId, ownerId }: Props = $props();

  /** Turns rendered per page; a huge transcript reveals itself progressively. */
  const PAGE_SIZE = 50;

  const id = $props.id();
  let trigger = $state<HTMLButtonElement>();
  let expanded = $state(false);
  let visibleCount = $state(PAGE_SIZE);
  let fetched = $state<SubagentTranscript | undefined>();
  let loading = $state(false);
  let loadError = $state(false);

  const transcript = $derived(fetched ?? subagent ?? undefined);
  const turns = $derived(
    transcript && Array.isArray(transcript.turns) ? transcript.turns : [],
  );
  // Before the fetch lands, the stub's turn count still labels the row.
  const turnCount = $derived(transcript ? turns.length : (stub?.turnCount ?? 0));
  const name = $derived(transcript?.name ?? stub?.name ?? 'Sub-agent');
  const model = $derived(transcript?.model ?? stub?.model);
  const task = $derived(transcript?.task ?? stub?.task);
  const visibleTurns = $derived(turns.slice(0, visibleCount));
  const remaining = $derived(Math.max(0, turns.length - visibleCount));

  function isTranscript(value: unknown): value is SubagentTranscript {
    const v = value as SubagentTranscript | undefined;
    return !!v && typeof v === 'object' && typeof v.name === 'string' && Array.isArray(v.turns);
  }

  async function load() {
    if (!stub || transcript || loading) return;
    loading = true;
    loadError = false;
    try {
      const res = await apiFetch(
        apiUrl(
          `/api/messages/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(stub.ref.messageId)}?path=${stub.ref.path.join(',')}`,
        ),
      );
      const result = await parseJsonResponse<{ ok?: boolean; data?: { subagent?: unknown } }>(res);
      if (result.ok && isTranscript(result.data?.subagent)) {
        fetched = result.data.subagent;
      } else {
        loadError = true;
      }
    } catch {
      loadError = true;
    } finally {
      loading = false;
    }
  }

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    // Same reader-resize request a tool row's disclosure makes, so the summary
    // keeps its screen position while the nested transcript opens or closes.
    requestReaderResize(trigger);
    expanded = !expanded;
    if (expanded) void load();
  }

  function showMore(event: MouseEvent) {
    event.stopPropagation();
    requestReaderResize(event.currentTarget);
    visibleCount += PAGE_SIZE;
  }

  /** A recorded transcript is never live: a block with no end has no known
   *  duration, so it must neither shimmer nor tick. Display data only — the
   *  order of the parts is untouched. */
  function settled(parts: readonly TranscriptPart[]): TranscriptPart[] {
    return parts.map((part): TranscriptPart => {
      if (part.kind === 'reasoning' && part.endedAt === undefined) {
        return { ...part, endedAt: part.startedAt, timeUnknown: true };
      }
      if (part.kind === 'tool' && part.endedAt === undefined && !part.timeUnknown) {
        return { ...part, timeUnknown: true };
      }
      return part;
    });
  }

  function rowsFor(turn: Extract<SubagentTurn, { role: 'assistant' }>, index: number): FeedEntryLocal[] {
    return partsToFeedEntries({
      sessionId,
      messageId: `${ownerId}-sub-${index}`,
      parts: settled(Array.isArray(turn.parts) ? turn.parts : []),
      agentName: name,
      glowClass: '',
    });
  }

  function clock(createdAt: number | undefined): string {
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return 'Time unknown';
    return new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="subagent">
  <button
    bind:this={trigger}
    type="button"
    class="subagent-summary"
    aria-expanded={expanded}
    aria-controls={expanded ? id : undefined}
    onclick={toggle}
    title={expanded ? 'Hide sub-agent transcript' : 'Show sub-agent transcript'}
  >
    <ChevronRight size={12} class={`disclosure ${expanded ? 'expanded' : ''}`} />
    <span class="subagent-kind">Sub-agent</span>
    <span class="sep">·</span>
    <span class="subagent-name">{name}</span>
    <span class="sep">·</span>
    <span class="subagent-count">{turnCount} {turnCount === 1 ? 'turn' : 'turns'}</span>
    {#if model}
      <span class="sep">·</span>
      <span class="subagent-model">{model}</span>
    {/if}
  </button>

  {#if expanded}
    <div id={id} class="subagent-transcript" role="region" aria-label={`${name} sub-agent transcript`}>
      {#if loading}
        <p class="empty">Loading sub-agent transcript…</p>
      {:else if loadError}
        <p class="empty">
          Couldn't load the sub-agent transcript.
          <button type="button" class="show-more" onclick={(e) => { e.stopPropagation(); void load(); }}>Retry</button>
        </p>
      {:else}
      {#if task}
        <div class="subagent-task">
          <div class="turn-label">Task</div>
          <p class="plain-text">{task}</p>
        </div>
      {/if}
      {#if turnCount === 0}
        <p class="empty">No turns were recorded.</p>
      {:else}
        <ol class="turns">
          {#each visibleTurns as turn, index (index)}
            <li class="turn" data-role={turn.role}>
              <div class="turn-meta">
                <span class="turn-label">{turn.role === 'user' ? 'User' : name}</span>
                <span class="turn-time tabular-nums">{clock(turn.createdAt)}</span>
              </div>
              {#if turn.role === 'user'}
                <p class="plain-text user-text">{turn.text}</p>
              {:else}
                {#each rowsFor(turn, index) as row (row.id)}
                  {#if row.type === 'thinking'}
                    <ThinkingBlock
                      text={row.text}
                      durationMs={row.durationMs}
                      thinkingStartedAt={row.thinkingStartedAt}
                      agentName={row.agentName}
                      finalized={row.thinkingFinalized ?? false}
                      thinkingTokens={row.metadata?.thinkingTokens as number | undefined}
                      timeUnknown={row.durationUnknown === true}
                    />
                  {:else if row.type === 'content'}
                    <div class="markdown-content nested-content">{@html renderChatMarkdown(row.text)}</div>
                  {:else}
                    <ToolActivity entry={row} />
                  {/if}
                {/each}
              {/if}
            </li>
          {/each}
        </ol>
        {#if remaining > 0}
          <button type="button" class="show-more" onclick={showMore}>
            Show {Math.min(PAGE_SIZE, remaining)} more {Math.min(PAGE_SIZE, remaining) === 1 ? 'turn' : 'turns'} ({remaining} remaining)
          </button>
        {/if}
      {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .subagent { min-width: 0; }
  .subagent-summary { display: flex; align-items: center; gap: 6px; max-width: 100%; min-height: 24px; padding: 1px 0; text-align: left; font-size: 12px; line-height: 1.6; color: var(--color-text-muted); }
  .subagent-summary:hover .subagent-name, .subagent-summary:focus-visible .subagent-name { color: var(--color-accent); }
  .subagent-summary :global(.disclosure) { flex-shrink: 0; color: var(--color-text-muted); transition: transform 120ms ease; }
  .subagent-summary :global(.disclosure.expanded) { transform: rotate(90deg); }
  .subagent-kind { flex-shrink: 0; }
  .sep { flex-shrink: 0; opacity: 0.6; }
  .subagent-name { min-width: 0; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subagent-count { flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .subagent-model { min-width: 0; font: 11px/1.6 var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subagent-transcript { margin: 4px 0 8px 5px; padding: 2px 0 2px 12px; border-left: 1px solid var(--color-border); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .turns { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
  .turn { min-width: 0; }
  .turn-meta { display: flex; align-items: baseline; gap: 8px; }
  .turn-label { font-size: 11px; font-weight: 500; color: var(--color-text-secondary); }
  .turn-time { font-size: 11px; color: var(--color-text-muted); }
  .plain-text { margin: 2px 0 0; font-size: 13px; line-height: 1.6; color: var(--color-text-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
  .subagent-task .plain-text { color: var(--color-text-secondary); }
  .nested-content { font-size: 13px; color: var(--color-text-primary); overflow-wrap: anywhere; }
  .empty { margin: 0; font-size: 12px; color: var(--color-text-muted); }
  .show-more { align-self: flex-start; font-size: 12px; color: var(--color-accent); padding: 2px 0; }
  .show-more:hover { text-decoration: underline; }
  button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; border-radius: var(--radius-sm); }
  @media (prefers-reduced-motion: reduce) { .subagent-summary :global(.disclosure) { transition: none; } }
</style>
