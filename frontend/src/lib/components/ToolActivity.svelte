<script lang="ts">
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';
  import Copy from 'lucide-svelte/icons/copy';
  import Check from 'lucide-svelte/icons/check';
  import ToolActivity from './ToolActivity.svelte';
  import ToolActivityIcon from './ToolActivityIcon.svelte';
  import SubagentSection from './SubagentSection.svelte';
  import type { FeedEntryLocal } from '$lib/types';
  import type { SubagentTranscript } from '@koryphaios/shared';
  import { toolPresentation } from '$lib/utils/tool-presentation';
  import { copyText } from '$lib/utils/clipboard';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { openAgentThread } from '$lib/utils/agent-thread-navigation';
  import { slide } from 'svelte/transition';
  import { cubicInOut } from 'svelte/easing';
  import { requestReaderResize } from '$lib/utils/expand-anchor';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { formatShortcut } from '$lib/utils/platform';
  import { narrateToolGroup } from '$lib/utils/tool-narration';
  let { entry, open = $bindable(false), transcript, showIcon = true } = $props<{
    entry: FeedEntryLocal;
    open?: boolean;
    transcript?: string;
    showIcon?: boolean;
  }>();
  const id = $props.id();
  let trigger = $state<HTMLButtonElement>();
  let copied = $state(false);
  let inputCopied = $state(false);
  const tool = $derived(toolPresentation(entry));
  const toolIdentity = $derived(tool.mcpIdentity || (tool.nativeActivity ? '' : tool.toolName));
  const criticAgentId = $derived(tool.name === 'critic_review' && typeof tool.input.agentId === 'string' ? tool.input.agentId : '');
  const criticOutcome = $derived(
    criticAgentId
      ? (entry.metadata?.toolResult as { criticOutcome?: string } | undefined)?.criticOutcome
      : undefined,
  );
  const spawnedAgentId = $derived(tool.name === 'delegate_to_worker' && typeof tool.input.agentId === 'string' ? tool.input.agentId : '');
  const grouped = $derived(entry.type === 'tool_group');
  const steps: FeedEntryLocal[] = $derived(entry.entries ?? []);
  const commandDetails = $derived(!grouped && transcript === undefined && tool.kind === 'command');
  const separatedDetails = $derived(commandDetails || (!grouped && transcript === undefined && tool.workspace));
  // Bridge arguments are already unpacked into fields; its raw preview can
  // still contain the dispatcher/server identity from an archived event.
  const inputPreview = $derived(!tool.internalBridge && typeof entry.metadata?.toolInputPreview === 'string' ? entry.metadata.toolInputPreview : '');
  const durationMs = $derived((entry.metadata?.toolResult as { durationMs?: number } | undefined)?.durationMs);
  // The source never recorded how long this call took (imported chats): show no
  // duration at all rather than a ticking clock or "0 ms".
  const durationUnknown = $derived(isDurationUnknown(entry));
  const subagent = $derived(subagentOf(entry));
  const subagentSessionId = $derived(typeof entry.metadata?.sessionId === 'string' ? entry.metadata.sessionId : '');
  const toolComplete = $derived(tool.complete || (grouped && steps.length > 0 && steps.every((s) => s.type === 'tool_result')));
  let now = $state(Date.now());
  $effect(() => {
    if (toolComplete || (!grouped && durationUnknown)) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(timer);
  });
  const MAX_LIVE_TOOL_MS = 15 * 60 * 1000;
  const liveDurationMs = $derived(
    !toolComplete && !durationUnknown ? Math.min(Math.max(0, now - (entry.timestamp ?? now)), MAX_LIVE_TOOL_MS) : 0,
  );
  const resolvedDurationMs = $derived(durationUnknown ? 0 : toolComplete ? (durationMs ?? 0) : liveDurationMs);
  // Grouped operations (e.g. "Explored") run multiple tool calls. Show the sum
  // of their durations, ticking continuously across all children instead of
  // stopping when the first one finishes.
  const groupDurationMs = $derived.by(() => {
    if (!grouped || !steps.length) return resolvedDurationMs;
    return steps.reduce((sum, child) => {
      if (isDurationUnknown(child)) return sum;
      const childResult = child.metadata?.toolResult as { durationMs?: number } | undefined;
      const childDuration = childResult?.durationMs;
      if (typeof childDuration === 'number' && Number.isFinite(childDuration) && childDuration > 0) {
        return sum + childDuration;
      }
      if (child.type === 'tool_call') {
        const live = Math.min(Math.max(0, now - (child.timestamp ?? now)), MAX_LIVE_TOOL_MS);
        return sum + live;
      }
      return sum;
    }, 0);
  });
  const durationLabel = $derived(groupDurationMs > 0 ? formatDuration(groupDurationMs) : '');
  const failureTarget = $derived(
    tool.target !== tool.toolName &&
    tool.target !== tool.displayName &&
    tool.target !== tool.mcpIdentity &&
    !['tool', 'file', 'workspace', 'command', 'page', 'Tool name unavailable'].includes(tool.target)
      ? tool.target
      : '',
  );
  const groupAction = $derived(steps.some((step) => step.type === 'tool_call') ? 'Exploring' : 'Explored');
  // The collapsed group narrates what the agent did, in order ("Read a.ts and
  // b.ts → searched “x”"); the verb keeps the action styling, the rest is the
  // clickable target. Falls back to the plain count when there is nothing to say.
  const groupNarration = $derived.by(() => {
    if (!grouped) return null;
    const line = narrateToolGroup(steps);
    const space = line.indexOf(' ');
    if (!line || space < 0) return null;
    return { verb: line.slice(0, space), rest: line.slice(space + 1) };
  });
  const body = $derived(transcript ?? (separatedDetails || tool.failed ? tool.output : tool.changes || tool.content || tool.output));
  const displayBody = $derived.by(() => {
    if (!tool.workspace || !body.trim().match(/^[{[]/)) return body;
    try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
  });
  const preview = $derived(displayBody.length > 4_000 ? `${displayBody.slice(0, 4_000)}\n\n…output clipped` : displayBody);
  const commandSummary = $derived(
    tool.kind === 'command' && tool.commandIsLong && !tool.failed
      ? tool.complete
        ? 'Command executed'
        : 'Executing command'
      : null,
  );
  const computerReceipt = $derived(tool.computerUse);
  let screenshotUrl = $state('');
  let screenshotState = $state<'loading' | 'ready' | 'unavailable'>('loading');
  $effect(() => {
    const screenshot = computerReceipt?.screenshot;
    if (!screenshot || !open) { screenshotUrl = ''; return; }
    screenshotState = 'loading';
    let disposed = false;
    let objectUrl = '';
    void apiFetch(apiUrl(`/api/v1/computer-use/screenshots/${encodeURIComponent(screenshot.id)}?sessionId=${encodeURIComponent(entry.metadata?.sessionId as string ?? sessionStore.activeSessionId)}`))
      .then((response) => response.ok ? response.blob() : Promise.reject(new Error('Screenshot unavailable')))
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        screenshotUrl = objectUrl;
        screenshotState = 'ready';
      })
      .catch(() => { if (!disposed) { screenshotUrl = ''; screenshotState = 'unavailable'; } });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      screenshotUrl = '';
    };
  });

  function isDurationUnknown(row: FeedEntryLocal): boolean {
    return row.durationUnknown === true ||
      (row.metadata?.toolResult as { timeUnknown?: boolean } | undefined)?.timeUnknown === true;
  }

  function subagentOf(row: FeedEntryLocal): SubagentTranscript | null {
    const value = row.metadata?.subagent as SubagentTranscript | undefined;
    if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !Array.isArray(value.turns)) return null;
    return value;
  }

  function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    const remS = Math.round(s % 60);
    if (m < 60) return `${m}m ${remS}s`;
    const h = Math.floor(m / 60);
    const remM = Math.round(m % 60);
    if (h < 24) return `${h}h ${remM}m`;
    const d = Math.floor(h / 24);
    const remH = Math.round(h % 24);
    return `${d}d ${remH}h`;
  }

  function detailTransition(node: HTMLElement) {
    const reducedMotion = typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    return slide(node, { duration: reducedMotion ? 0 : 200, easing: cubicInOut });
  }

  function setOpen(value: boolean) {
    requestReaderResize(trigger);
    open = value;
  }

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    const agentThreadId = criticAgentId || spawnedAgentId;
    if (agentThreadId && sessionStore.activeSessionId) {
      openAgentThread(sessionStore.activeSessionId, agentThreadId);
      return;
    }
    setOpen(!open);
  }

  async function copyOutput() {
    await copyText(computerReceipt ? JSON.stringify(computerReceipt, null, 2) : body || tool.command);
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }

  async function copyInput() {
    await copyText(tool.command || inputPreview || JSON.stringify(tool.input, null, 2));
    inputCopied = true;
    setTimeout(() => (inputCopied = false), 1600);
  }

  function inputValue(value: unknown): string {
    const valueText = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
    return valueText.length > 4_000 ? `${valueText.slice(0, 4_000)}\n…input clipped` : valueText;
  }
</script>

{#snippet inputFields(fields: [string, unknown][])}
  <dl class="input-fields">
    {#each fields as [key, value]}
      <div>
        <dt>{key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')}</dt>
        <dd>{inputValue(value)}</dd>
      </div>
    {/each}
  </dl>
{/snippet}

<div class="tool-activity" class:failed={tool.failed}>
  <button
    bind:this={trigger}
    type="button"
    class="tool-summary"
    aria-expanded={criticAgentId || spawnedAgentId ? undefined : open}
    aria-controls={open ? id : undefined}
    aria-describedby={[
      !grouped && transcript === undefined && toolIdentity && tool.target !== toolIdentity && (!tool.failed || tool.mcpIdentity) ? `${id}-name` : '',
      durationLabel ? `${id}-duration` : '',
    ].filter(Boolean).join(' ') || undefined}
    onclick={toggle}
    title={criticAgentId ? 'Open Critic evaluation chat' : spawnedAgentId ? 'Open delegated agent chat' : grouped ? 'View explored files and searches' : `View details · ${toolIdentity || tool.action} · ${tool.paths.join(', ') || tool.command || tool.target}`}
  >
    {#if showIcon}<ToolActivityIcon {entry} />{/if}
    {#if criticAgentId}
        <span class="action">Critic {tool.complete
        ? criticOutcome === 'run_failed_after_output'
          ? 'failed after partial output'
          : criticOutcome === 'run_failed'
          ? 'failed to run'
          : criticOutcome === 'verdict_failed'
            ? 'failed review'
            : criticOutcome === 'passed'
              ? 'passed'
              : tool.failed
                ? 'failed'
                : 'completed'
        : 'running'}</span>
      <span class="target">View evaluation</span>
    {:else if spawnedAgentId}
      <span class="action">{tool.action}</span>
      <span class="target">Open {tool.target} chat</span>
    {:else if transcript !== undefined}
      <span class="action">Completed</span><span class="target">background task</span>
    {:else if grouped && groupNarration}
      <span class="action">{groupNarration.verb}</span>
      <span class="target narration">{groupNarration.rest}</span>
    {:else if grouped}
      <span class="action">{groupAction}</span>
      <span class="target">{steps.length} {steps.length === 1 ? 'operation' : 'operations'}</span>
    {:else}
      <span class="action">{tool.failed ? tool.failureLabel : commandSummary ?? tool.action}</span>
      {#if !commandSummary && (!tool.failed || failureTarget)}
        <span class="target" class:mono={tool.kind === 'file' || tool.kind === 'command'}>{tool.failed ? failureTarget : tool.target}</span>
      {/if}
      {#if toolIdentity && tool.target !== toolIdentity && (!tool.failed || tool.mcpIdentity)}
        <span id={`${id}-name`} class="tool-name" aria-hidden="true">{toolIdentity}</span>
      {/if}
    {/if}
    {#if durationLabel}
      <!-- Keep the ticking duration available as a description, not part of the action name. -->
      <span id={`${id}-duration`} class="tool-duration tabular-nums" aria-hidden="true">{durationLabel}</span>
    {/if}
    <ChevronRight size={12} class={`disclosure ${open ? 'expanded' : ''}`} />
  </button>

  {#if subagent && !grouped}
    <SubagentSection {subagent} sessionId={subagentSessionId} ownerId={entry.id} />
  {/if}

  {#if open}
    <section id={id} class="tool-detail" aria-label="Tool details" aria-hidden={!open} inert={!open} transition:detailTransition>
       <header>
        <span class="detail-title">{computerReceipt ? 'Computer-use receipt' : transcript !== undefined ? 'Background task' : grouped ? 'Files & searches' : tool.failed ? 'Error' : tool.changes ? 'Changes' : tool.command ? 'Command' : tool.content ? 'Contents' : tool.complete ? 'Output' : 'Input'}</span>
        <div class="detail-actions">
          {#if !separatedDetails && (body || tool.command)}
            <button type="button" onclick={copyOutput} aria-label="Copy output" title="Copy output">
              {#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
            </button>
          {/if}
           <button type="button" aria-label="Collapse details" title="Collapse details" onclick={(event) => {
             event.stopPropagation();
             setOpen(false);
             trigger?.focus({ preventScroll: true });
           }}><ChevronUp size={14} /></button>
        </div>
      </header>
      {#if !grouped && transcript === undefined && tool.mcpIdentity}
        <p class="mcp-identity">{tool.mcpIdentity}</p>
      {/if}
      {#if grouped}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="group-steps" role="region" aria-label="Operations" tabindex="0">
          {#each steps as step (step.id)}
            <ToolActivity entry={step} />
          {/each}
        </div>
      {:else if separatedDetails}
        <div class="command-panels">
          <section class="command-panel" aria-label={commandDetails ? 'Command input' : 'Tool input'}>
            <div class="panel-heading">
              <span>Input</span>
              <small>{tool.displayName || 'Shell command'}</small>
              {#if tool.command || inputPreview || (!commandDetails && tool.fields.length)}
                <button type="button" onclick={copyInput} aria-label={commandDetails ? 'Copy command' : 'Copy input'} title={commandDetails ? 'Copy command' : 'Copy input'}>
                  {#if inputCopied}<Check size={13} />{:else}<Copy size={13} />{/if}
                </button>
              {/if}
            </div>
            {#if tool.workingDirectory}
              <div class="command-directory"><span>Working directory</span><code>{tool.workingDirectory}</code></div>
            {/if}
            {#if tool.command}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div class="command panel-body" role="region" aria-label="Command" tabindex="0"><span aria-hidden="true">{'$ '}</span>{tool.command}</div>
            {:else if inputPreview}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <pre class="panel-body" tabindex="0" aria-label="Recorded input">{inputPreview}</pre>
            {:else if !commandDetails && tool.fields.length}
              <div class="panel-body">{@render inputFields(tool.fields)}</div>
            {:else}
              <p class="empty panel-body">{commandDetails ? 'No command input was recorded.' : 'No input was recorded.'}</p>
            {/if}
            {#if commandDetails && tool.additionalFields.length}
              <details class="raw-output command-arguments">
                <summary onclick={(event) => event.stopPropagation()}>Arguments</summary>
                {@render inputFields(tool.additionalFields)}
              </details>
            {/if}
          </section>
          <section class="command-panel" class:output-failed={tool.failed} aria-label={commandDetails ? 'Command output' : 'Tool response'}>
            <div class="panel-heading">
              <span>Output</span>
              <small class:output-status-failed={tool.failed}>{tool.failed ? 'Failed' : tool.complete ? 'Completed' : 'Running'}{durationLabel ? ` · ${durationLabel}` : durationUnknown && !grouped ? ' · time unknown' : ''}</small>
              {#if body}
                <button type="button" onclick={copyOutput} aria-label="Copy output" title="Copy output">
                  {#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
                </button>
              {/if}
            </div>
            {#if body}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <pre class="tool-output-pre panel-body max-h-80 overflow-auto" tabindex="0" aria-label="Tool output">{preview}</pre>
            {:else}
              <p class="empty panel-body">{tool.complete ? 'No output was reported.' : 'Waiting for output…'}</p>
            {/if}
          </section>
        </div>
      {:else if computerReceipt}
        <dl class="computer-receipt">
          <div><dt>Target</dt><dd>{computerReceipt.target ? `${computerReceipt.target.title} · ${computerReceipt.target.appId} · window ${computerReceipt.target.windowId} · PID ${computerReceipt.target.pid}` : 'Computer session'}</dd></div>
          <div><dt>Action</dt><dd>{computerReceipt.action.replace(/^computer_/, '').replace(/_/g, ' ')}</dd></div>
          {#if computerReceipt.elementId}<div><dt>Element</dt><dd><code>{computerReceipt.elementId}</code></dd></div>{/if}
          {#if computerReceipt.x !== undefined && computerReceipt.y !== undefined}<div><dt>Coordinates</dt><dd>({computerReceipt.x}, {computerReceipt.y}) · window-relative fallback</dd></div>{/if}
          {#if computerReceipt.button}<div><dt>Button</dt><dd>{computerReceipt.button}</dd></div>{/if}
          {#if computerReceipt.path?.length}<div><dt>Drag path</dt><dd>{computerReceipt.path.map(({ x, y }) => `(${x}, ${y})`).join(' → ')}</dd></div>{/if}
          {#if computerReceipt.key}<div><dt>Key</dt><dd><code>{formatShortcut(computerReceipt.key)}</code></dd></div>{/if}
          {#if computerReceipt.delta !== undefined}<div><dt>Scroll delta</dt><dd>{computerReceipt.delta}</dd></div>{/if}
          {#if computerReceipt.ms !== undefined}<div><dt>Wait</dt><dd>{computerReceipt.ms} ms</dd></div>{/if}
          {#if computerReceipt.textLength !== undefined}<div><dt>Text</dt><dd>{computerReceipt.textLength} characters · content hidden</dd></div>{/if}
          <div><dt>Status</dt><dd>{computerReceipt.status === 'failed' ? 'Failed' : 'Completed'}{durationLabel ? ` · ${durationLabel}` : durationUnknown ? ' · time unknown' : ''}</dd></div>
          <div><dt>Result</dt><dd class:receipt-failed={computerReceipt.status === 'failed'}>{computerReceipt.message}</dd></div>
        </dl>
        {#if computerReceipt.targets}
          <div class="computer-elements"><div class="detail-label">{computerReceipt.targets.length} windows discovered</div>{#each computerReceipt.targets as target}<span>{target.title} · {target.appId} · window {target.windowId} · PID {target.pid}</span>{/each}</div>
        {/if}
        {#if computerReceipt.elements}
          <div class="computer-elements"><div class="detail-label">{computerReceipt.elements.length} controls discovered</div>{#each computerReceipt.elements as element}<span><code>{element.elementId}</code> {element.role}{element.name ? ` · ${element.name}` : ''} · {element.enabled ? 'enabled' : 'disabled'} · {element.actions.join(', ')}</span>{/each}</div>
        {/if}
        {#if screenshotUrl}<img class="computer-screenshot" src={screenshotUrl} alt="Authorized computer-use observation" onerror={() => { screenshotUrl = ''; screenshotState = 'unavailable'; }} />
        {:else if computerReceipt.screenshot}<p class="empty">{screenshotState === 'loading' ? 'Loading screenshot…' : 'Screenshot expired or unavailable. Previews are kept for up to 10 minutes.'}</p>{/if}
      {:else}
        {#if tool.paths.length}
          <div class="file-paths">{#each tool.paths as path}<span>{path}</span>{/each}</div>
        {:else if tool.workingDirectory}
          <div class="file-paths">{tool.workingDirectory}</div>
        {/if}
        {#if tool.command}
          <div class="detail-label">Command</div>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="command" role="region" aria-label="Command" tabindex="0"><span aria-hidden="true">{'$ '}</span>{tool.command}</div>
        {/if}
        {#if body}
          {#if tool.command}<div class="detail-label output-label">Output</div>{/if}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <pre class="tool-output-pre max-h-80 overflow-auto" class:diff={!!tool.changes && !tool.failed} tabindex="0" aria-label={tool.changes && !tool.failed ? 'File changes' : 'Tool output'}>{#if tool.changes && !tool.failed}{#each preview.split('\n') as line}<span class="diff-line" class:added={line.startsWith('+') && !line.startsWith('+++')} class:removed={line.startsWith('-') && !line.startsWith('---')}>{line}{'\n'}</span>{/each}{:else}{preview}{/if}</pre>
        {:else if !tool.command && !tool.complete && tool.fields.length}
          {@render inputFields(tool.fields)}
        {:else if tool.command}
          <p class="empty output-empty">No output was reported.</p>
        {:else}
          <p class="empty">{tool.complete ? 'No output was reported.' : 'No input was recorded.'}</p>
        {/if}
         {#if tool.changes && tool.output && !tool.failed}
           <details class="raw-output">
             <summary onclick={(event) => event.stopPropagation()}>Tool response</summary>
             <pre>{tool.output}</pre>
           </details>
         {/if}
         {#if (body || tool.command) && tool.additionalFields.length && transcript === undefined}
           <details class="raw-output">
             <summary onclick={(event) => event.stopPropagation()}>Arguments</summary>
             {@render inputFields(tool.additionalFields)}
           </details>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .tool-activity { min-width: 0; }
  .tool-summary { display: flex; align-items: center; gap: 6px; max-width: 100%; min-height: 28px; padding: 2px 0; text-align: left; font-size: 13px; line-height: 1.6; }
  .action { flex-shrink: 0; color: var(--color-text-muted); }
  .target { min-width: 0; color: var(--color-text-secondary); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--color-text-secondary) 25%, transparent); text-underline-offset: 3px; overflow-wrap: anywhere; }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  /* One line: the newest clauses are already kept by the narrator. */
  .narration { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }
  .tool-name { min-width: 0; font: 11px/1.6 var(--font-mono); color: var(--color-text-muted); overflow-wrap: anywhere; }
  .tool-duration { flex-shrink: 0; font-size: 11px; color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
  .mcp-identity { margin: 0 0 10px; font: 11px/1.6 var(--font-mono); color: var(--color-text-muted); overflow-wrap: anywhere; }
  .tool-summary:hover .target, .tool-summary:focus-visible .target { color: var(--color-accent); text-decoration-color: currentColor; }
  .failed .action { color: var(--color-error); }
  .tool-summary :global(.disclosure) { flex-shrink: 0; color: var(--color-text-muted); transition: transform 120ms ease; }
  .tool-summary :global(.disclosure.expanded) { transform: rotate(90deg); }
  .tool-detail { margin: 6px 0 12px; padding: 10px 14px 14px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-surface-2) 65%, transparent); }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .detail-title { font-size: 12px; font-weight: 500; color: var(--color-text-secondary); }
  .failed .detail-title { color: var(--color-error); }
  .detail-actions { display: flex; margin-left: auto; gap: 2px; }
  .detail-actions button { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-sm); color: var(--color-text-muted); }
  .detail-actions button:hover { color: var(--color-text-primary); background: var(--color-surface-3); }
  button:focus-visible, [tabindex]:focus-visible, summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; border-radius: var(--radius-sm); }
  .file-paths { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font: 11px/1.6 var(--font-mono); color: var(--color-text-muted); overflow-wrap: anywhere; }
  .command, pre { margin: 0; padding: 0; font: 12px/1.65 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-text-secondary); scrollbar-width: thin; }
  .command { max-height: 10rem; overflow: auto; color: var(--color-text-primary); }
  .command span { color: var(--color-text-muted); }
  .detail-label { margin: 0 0 4px; font-size: 11px; font-weight: 500; color: var(--color-text-muted); }
  .output-label { margin-top: 14px; }
  .command + .detail-label { margin-top: 14px; }
  pre { max-height: 20rem; overflow: auto; border: 0; border-radius: 0; background: transparent; }
  .diff-line { display: block; min-height: 1.65em; padding: 0 6px; }
  .diff { white-space: normal; }
  .diff-line { white-space: pre-wrap; }
  .added { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 7%, transparent); }
  .removed { color: var(--color-error); background: color-mix(in srgb, var(--color-error) 7%, transparent); }
  .input-fields { margin: 0; max-height: 20rem; overflow: auto; }
  .input-fields > div + div { margin-top: 12px; }
  dt { font-size: 11px; color: var(--color-text-muted); }
  dd { margin: 2px 0 0; font: 12px/1.6 var(--font-mono); color: var(--color-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty { margin: 0; font-size: 12px; color: var(--color-text-muted); }
  .output-empty { margin-top: 4px; }
  .command-panels { display: flex; flex-direction: column; gap: 12px; }
  .command-panel { min-width: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-1); }
  .panel-heading { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 5px 12px; border-bottom: 1px solid var(--color-border); background: color-mix(in srgb, var(--color-surface-2) 65%, transparent); }
  .panel-heading > span { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); }
  .panel-heading small { font-size: 11px; color: var(--color-text-muted); }
  .panel-heading button { display: grid; place-items: center; width: 26px; height: 26px; margin-left: auto; border-radius: var(--radius-sm); color: var(--color-text-muted); }
  .panel-heading button:hover { color: var(--color-text-primary); background: var(--color-surface-3); }
  .command-panel .panel-body { padding: 12px; }
  .command-directory { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 10px 12px 0; font-size: 11px; color: var(--color-text-muted); }
  .command-directory code { font: 10px/1.6 var(--font-mono); overflow-wrap: anywhere; color: var(--color-text-secondary); }
  .command-arguments { margin: 0; padding: 0 12px 12px; }
  .output-failed { border-color: color-mix(in srgb, var(--color-error) 35%, var(--color-border)); }
  .panel-heading .output-status-failed { color: var(--color-error); }
  .group-steps { display: flex; flex-direction: column; gap: 2px; max-height: 24rem; overflow: auto; scrollbar-width: thin; }
  .computer-receipt { display: grid; gap: 10px; margin: 0; }
  .computer-receipt > div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 10px; }
  .computer-receipt dt { color: var(--color-text-muted); }
  .computer-receipt dd { margin: 0; }
  .receipt-failed { color: var(--color-error); }
  .computer-elements { display: grid; gap: 5px; margin-top: 14px; max-height: 20rem; overflow: auto; overflow-wrap: anywhere; font: 11px/1.6 var(--font-mono); color: var(--color-text-secondary); }
  .computer-screenshot { display: block; max-width: 100%; max-height: 420px; margin-top: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .raw-output { margin-top: 12px; color: var(--color-text-muted); font-size: 11px; }
  .raw-output summary { cursor: pointer; width: fit-content; }
  .raw-output pre, .raw-output .input-fields { margin-top: 8px; }
  @media (prefers-reduced-motion: reduce) { .tool-summary :global(.disclosure) { transition: none; } }
</style>
