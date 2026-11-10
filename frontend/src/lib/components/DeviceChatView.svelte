<script lang="ts">
  import { onMount } from 'svelte';
  import { deviceStore, type DeviceChatSelection } from '$lib/stores/devices.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { deviceSessionKey } from '$lib/stores/device-routing.svelte';
  import { capturedClick, capturedSubmit } from '$lib/utils/captured-click';
  import { renderChatMarkdown } from '$lib/utils/chat-markdown';
  import '$lib/utils/chat-markdown.css';
  import Monitor from 'lucide-svelte/icons/monitor';
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
  import Send from 'lucide-svelte/icons/send';
  import Square from 'lucide-svelte/icons/square';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  const content = $derived(deviceStore.composerText);
  const busy = $derived(deviceStore.actionPending);
  const chat = $derived(deviceStore.activeChat);
  const snapshot = $derived(deviceStore.snapshot);
  const running = $derived(snapshot?.run?.status === 'active');
  const owner = $derived(deviceStore.captureChat());
  const reviewKey = $derived(chat ? deviceSessionKey(chat) : '');
  const reviewSelection = $derived(reviewKey ? wsStore.captureReview(reviewKey) : null);
  const reviewResponse = $derived(reviewKey ? wsStore.reviewResponses.get(reviewKey) : null);
  const reviewApplying = $derived(!!reviewResponse && reviewResponse.phase !== 'failed');

  const controls = $derived.by(() => {
    const displayed = owner;
    const expectedQuestion = snapshot?.question;
    const displayedReview = reviewSelection;
    return {
      send: () => { if (displayed && deviceStore.ownsChat(displayed)) void deviceStore.send(deviceStore.composerText, displayed); },
      stop: () => { if (displayed) void deviceStore.cancel(displayed); },
      refresh: () => { if (displayed) void deviceStore.refreshChat(displayed); },
      answers: expectedQuestion?.options.map((option) => ({ option,
        select: () => { if (displayed) void deviceStore.answer(displayed, expectedQuestion, option); } })) ?? [],
      keep: () => { if (displayedReview) void wsStore.respondToChanges(displayedReview.review.sessionId, true, displayedReview); },
      reject: () => { if (displayedReview) void wsStore.respondToChanges(displayedReview.review.sessionId, false, displayedReview); },
    };
  });
  function composer(node: HTMLTextAreaElement, value: DeviceChatSelection | null) {
    let displayed = value;
    const input = () => { if (displayed) deviceStore.setComposerDraft(displayed, node.value); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (displayed && deviceStore.ownsChat(displayed)) void deviceStore.send(node.value, displayed);
      }
    };
    node.addEventListener('input', input);
    node.addEventListener('keydown', keydown);
    return { update(value: DeviceChatSelection | null) { displayed = value; },
      destroy() { node.removeEventListener('input', input); node.removeEventListener('keydown', keydown); } };
  }
  onMount(() => {
    const timer = setInterval(() => void deviceStore.refreshChat(), 5000);
    return () => clearInterval(timer);
  });
</script>

<section class="device-chat" aria-label="Remote desktop chat">
  <header>
    <button
      class="icon-button"
      aria-label="Back to this desktop"
      onclick={() => deviceStore.closeChat()}><ArrowLeft size={17} /></button
    ><Monitor size={19} />
    <div><strong>{chat?.deviceName}</strong><span>{chat?.workspaceName} · {chat?.title}</span></div>
    <span class="status">{deviceStore.error ? 'Connection needs attention' : snapshot?.run?.phase ?? 'Opening chat…'}</span>
  </header>
  <div class="transcript" aria-live="polite" aria-relevant="additions text">
    {#if !snapshot}<div class="loading">
        <LoaderCircle size={22} class="animate-spin" /> Opening chat on {chat?.deviceName}…
      </div>{/if}
    {#each snapshot?.messages ?? [] as message (message.id)}<article
        class:user={message.role === 'user'}
      >
        <span class="who"
          >{message.role === 'user'
            ? 'You'
            : message.role === 'assistant'
              ? 'Kory'
              : message.role}</span
        >
        <div class="chat-markdown">{@html renderChatMarkdown(message.content)}</div>
      </article>{/each}
    {#each Object.entries(deviceStore.drafts) as [agent, text] (agent)}{#if text}<article>
          <span class="who">{agent === 'kory-manager' ? 'Kory' : agent} · live</span>
          <div class="chat-markdown">{@html renderChatMarkdown(text)}</div>
        </article>{/if}{/each}
    {#if snapshot && !snapshot.messages.length && !Object.keys(deviceStore.drafts).length}<div
        class="loading"
      >
        Start a chat. Work and files stay on {chat?.deviceName}.
      </div>{/if}
  </div>
  {#if snapshot?.question}<div class="decision">
      <strong>{snapshot.question.question}</strong>
      <div>
        {#each controls.answers as answer}<button
            disabled={busy || !!deviceStore.answerResponse}
            use:capturedClick={answer.select}
            >{answer.option}</button
          >{/each}
      </div>
      {#if deviceStore.answerResponse}<p role="status">{deviceStore.answerResponse.error ?? 'Waiting for the host to resolve this question…'}</p>{/if}
    </div>{/if}
  {#if reviewSelection && reviewSelection.review.changes.length > 0}
    <div class="decision" aria-label="Remote changes review">
      <strong>{reviewSelection.review.changes.length} file change{reviewSelection.review.changes.length === 1 ? '' : 's'} pending review</strong>
      <div>
        <button disabled={reviewApplying} use:capturedClick={controls.keep}>Keep changes</button>
        <button disabled={reviewApplying} use:capturedClick={controls.reject}>Reject changes</button>
      </div>
      {#if reviewResponse}
        <p role={reviewResponse.error ? 'alert' : 'status'} aria-live="polite">
          {reviewResponse.error ?? (reviewResponse.phase === 'submitting' ? 'Sending your decision…' : 'Waiting for confirmation from the host…')}
          {#if reviewResponse.phase === 'uncertain'} Your decision may have executed. Refresh the host status before retrying.{/if}
        </p>
      {/if}
    </div>
  {/if}

  {#if deviceStore.error}<p class="error" role="alert">
      {deviceStore.error}
    </p>{/if}
  <form
    class="composer"
    use:capturedSubmit={controls.send}
  >
    <label for="remote-prompt">Message {chat?.deviceName}</label>
    <div>
      <textarea
        id="remote-prompt"
        value={content}
        use:composer={owner}
        rows="3"
        placeholder="What would you like Kory to do on this desktop?"
      ></textarea>{#if running}<button
          type="button"
          class="send"
          disabled={busy}
          aria-label="Stop remote response"
          use:capturedClick={controls.stop}><Square size={17} /></button
        >{:else}<button
          class="send"
          disabled={busy || !content.trim()}
          aria-label="Send to remote desktop"
          >{#if busy}<LoaderCircle size={17} class="animate-spin" />{:else}<Send
              size={17}
            />{/if}</button
        >{/if}
    </div>
    <span
      >Running on {chat?.deviceName}. {snapshot?.question
        ? 'Waiting for your answer.'
        : 'Device selection is fixed for this chat.'}</span
    >
  </form>
</section>

<style>
  .device-chat {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    height: 100%;
    color: var(--color-text-primary);
    background: var(--color-surface-1);
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--color-border);
  }
  header > div {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 4px;
  }
  header strong {
    font-size: 13px;
  }
  header span {
    font-size: 10px;
    color: var(--color-text-muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .status {
    padding: 5px 8px;
    border-radius: 6px;
    background: var(--color-surface-3);
  }
  button {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
    padding: 8px 12px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 12px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .icon-button {
    padding: 6px;
    border: 0;
    background: transparent;
  }
  .transcript {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  article {
    max-width: 860px;
    width: 100%;
    margin: 0 auto;
    font-size: 13px;
    line-height: 1.7;
  }
  .who {
    font-size: 10px;
    color: var(--color-accent);
    display: block;
    margin-bottom: 6px;
  }
  .user {
    background: var(--color-surface-2);
    padding: 14px 18px;
    border-radius: 12px;
  }
  .loading {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .decision {
    padding: 16px 24px;
    border-top: 1px solid var(--color-border);
    font-size: 12px;
    background: var(--color-surface-2);
  }
  .decision > div {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .decision p {
    font-size: 11px;
    color: var(--color-text-muted);
    margin-top: 6px;
  }
  .composer {
    margin: 12px 20px 18px;
    padding: 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: var(--color-surface-2);
  }
  .composer label {
    font-size: 10px;
    color: var(--color-text-muted);
    display: block;
    margin-bottom: 7px;
  }
  .composer > div {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }
  textarea {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 0;
    resize: vertical;
    color: var(--color-text-primary);
    font-size: 13px;
    line-height: 1.6;
  }
  .send {
    display: grid;
    place-items: center;
    background: var(--color-accent);
    color: var(--color-text-on-accent);
    border: 0;
    width: 36px;
    height: 36px;
    padding: 0;
    flex-shrink: 0;
  }
  .composer > span {
    font-size: 9px;
    color: var(--color-text-muted);
    display: block;
    margin-top: 8px;
  }
  .error {
    font-size: 12px;
    color: var(--color-error);
    padding: 12px 24px;
  }
  @media (max-width: 600px) {
    header {
      padding: 12px;
    }
    .transcript {
      padding: 18px 12px;
    }
    .composer {
      margin: 10px;
    }
    .status {
      display: none;
    }
  }
</style>
