<script module lang="ts">
  import type { NoteRelationship } from '@koryphaios/shared';
  // Query/index DTOs intentionally stay browser-only; no backend/runtime imports.
  export type NetworkRelationship = NoteRelationship;
  export interface QueryActivation {
    query: string;
    connections?: QueryActivation['results'][number]['path'];
    results: Array<{
      id: string;
      title: string;
      revision: number;
      excerpt: string;
      truncated: boolean;
      score: number;
      sources: string[];
      seedId: string;
      explanation: string;
      path: Array<{
        fromId: string;
        toId: string;
        direction: string;
        kind: string;
        type?: string;
        status?: string;
        provenance: string;
        evidence?: string;
        fromRevision: number;
        toRevision: number;
        relationshipRevision?: number;
        stale: boolean;
      }>;
    }>;
    conflicts: Array<{
      noteId: string;
      reason: string;
      expectedRevision: number;
      currentRevision?: number;
      relatedNoteId?: string;
    }>;
    retrieval: {
      semantic: string;
      index: string;
      exhaustive: boolean;
      coverage?: SemanticIndexStatus;
    };
    truncation: { truncated: boolean; reasons: string[] };
    budget: { limits: Record<string, number>; used: Record<string, number> };
  }
  interface SemanticIndexStatus {
    available: boolean;
    enabled: boolean;
    mode: string;
    eligibleNotes: number;
    indexedNotes: number;
    staleNotes: number;
    coverage: number;
    cursor: string;
    providerIdentity: string | null;
    representationChars: number;
    countsAvailable?: boolean;
    coverageBasis?: string;
    search?: { exhaustive: boolean; scannedVectors: number; maxVectors: number; reason: string };
  }
  interface RebuildResult {
    status: SemanticIndexStatus;
    processed: number;
    indexed: number;
    skipped: number;
    canceled: boolean;
    hasMore: boolean;
  }
  interface PickerNote {
    id: string;
    title: string;
    revision: number;
  }
  interface Envelope<T> {
    data: T;
    success?: boolean;
    ok?: boolean;
    error?: string | { message?: string };
    meta?: { truncated?: boolean };
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import KorySelect from './KorySelect.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import NumberStepper from './NumberStepper.svelte';

  let {
    projectPath,
    onOpenNote,
  }: { projectPath: string | null; onOpenNote: (id: string) => void } = $props();
  let relationships = $state<NetworkRelationship[]>([]);
  let removal = $state<NetworkRelationship | null>(null);
  let notes = $state<PickerNote[]>([]);
  let notesTruncated = $state(false);
  let search = $state('');
  let fromId = $state('');
  let toId = $state('');
  let relationshipType = $state('related_to');
  let evidence = $state('');
  let statusFilter = $state('');
  let query = $state('');
  let semantic = $state(false);
  let maxHops = $state(1);
  let maxChars = $state(6000);
  let activation = $state<QueryActivation | null>(null);
  let errors = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let indexStatus = $state<SemanticIndexStatus | null>(null);
  let rebuildResult = $state<RebuildResult | null>(null);
  let indexingConsent = $state(false);
  let batchLimit = $state(32);
  const canRebuild = $derived(
    Boolean(
      indexStatus?.available &&
      indexStatus.providerIdentity &&
      ['not_opted_in', 'partial', 'ready'].includes(indexStatus.mode),
    ),
  );
  let generation = 0;
  const requests = new Map<string, AbortController>();
  const typeOptions = [
    { value: 'related_to', label: 'Related to' },
    { value: 'supports', label: 'Supports' },
    { value: 'contradicts', label: 'Contradicts' },
    { value: 'depends_on', label: 'Depends on' },
    { value: 'supersedes', label: 'Supersedes' },
  ];
  const statusOptions = [
    { value: '', label: 'All statuses' },
    ...['proposed', 'accepted', 'rejected'].map((value) => ({ value, label: value })),
  ];
  const noteOptions = $derived(
    notes.map((note) => ({
      value: note.id,
      label: note.title,
      description: `Revision ${note.revision} · ${note.id}`,
    })),
  );
  const source = $derived(notes.find((note) => note.id === fromId));
  const target = $derived(notes.find((note) => note.id === toId));
  const canPropose = $derived(Boolean(source && target && fromId !== toId && evidence.trim()));
  const visibleRelationships = $derived(
    relationships.filter((row) => !statusFilter || row.status === statusFilter),
  );

  function label(value: string) {
    return (
      typeOptions.find((option) => option.value === value)?.label ?? value.replaceAll('_', ' ')
    );
  }
  function noteTitle(id: string) {
    return (
      activation?.results.find((note) => note.id === id)?.title ??
      notes.find((note) => note.id === id)?.title ??
      id
    );
  }

  /** Capture scope at dispatch, including an epoch for A → B → A, and abort on replacement/unmount. */
  function begin(lane: string) {
    requests.get(lane)?.abort();
    const controller = new AbortController();
    requests.set(lane, controller);
    const scope = projectPath;
    const epoch = generation;
    const current = () =>
      !controller.signal.aborted &&
      scope === projectPath &&
      epoch === generation &&
      requests.get(lane) === controller;
    busy[lane] = true;
    errors[lane] = '';
    return { controller, scope, current };
  }
  async function request<T>(
    path: string,
    op: ReturnType<typeof begin>,
    method = 'GET',
    body?: unknown,
  ): Promise<Envelope<T>> {
    if (!op.scope) throw new Error('Choose a project first.');
    const response = await apiFetch(apiUrl(`/notes${path}`), {
      method,
      signal: op.controller.signal,
      headers: {
        'X-Koryphaios-Project': op.scope,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await response.json()) as Envelope<T>;
    if (!response.ok || result.success === false || result.ok === false) {
      if (response.status === 409) {
        const message = typeof result.error === 'string' ? result.error : result.error?.message;
        if (method === 'POST' && path === '/relationships' && message?.includes('already exists'))
          throw new Error(
            'A relationship already exists for this directed pair. Refresh the network (All statuses) to review it, or explicitly remove it before proposing new evidence. Rejected relationships also reserve the pair. Document wikilinks are not removed.',
          );
        throw new Error(
          'Revision conflict: refresh the network and note choices, then review the latest evidence. Your action was not retried.',
        );
      }
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : (result.error?.message ?? `Request failed (${response.status}).`),
      );
    }
    return result;
  }
  function failed(lane: string, op: ReturnType<typeof begin>, error: unknown) {
    if (op.current()) errors[lane] = error instanceof Error ? error.message : 'Request failed.';
  }
  async function loadRelationships() {
    removal = null;
    const op = begin('relationships');
    try {
      const result = await request<NetworkRelationship[]>(
        `/relationships${statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''}`,
        op,
      );
      if (op.current()) relationships = result.data;
    } catch (error) {
      failed('relationships', op, error);
    } finally {
      if (op.current()) busy.relationships = false;
    }
  }
  async function loadNotes() {
    const op = begin('notes');
    try {
      const result = await request<PickerNote[]>(
        `/search?q=${encodeURIComponent(search.trim())}`,
        op,
      );
      if (op.current()) {
        notes = result.data;
        notesTruncated = result.meta?.truncated ?? false;
      }
    } catch (error) {
      failed('notes', op, error);
    } finally {
      if (op.current()) busy.notes = false;
    }
  }
  async function loadIndex() {
    if (busy.rebuild) return;
    const op = begin('index');
    try {
      const result = await request<SemanticIndexStatus>('/semantic-index', op);
      if (op.current()) indexStatus = result.data;
    } catch (error) {
      failed('index', op, error);
    } finally {
      if (op.current()) busy.index = false;
    }
  }
  async function propose() {
    if (!canPropose || !source || !target || busy.mutation) return;
    const op = begin('mutation');
    try {
      await request('/relationships', op, 'POST', {
        fromId,
        toId,
        type: relationshipType,
        evidence: evidence.trim(),
        expectedSourceRevision: source.revision,
        expectedTargetRevision: target.revision,
      });
      if (op.current()) {
        evidence = '';
        void loadRelationships();
      }
    } catch (error) {
      failed('mutation', op, error);
    } finally {
      if (op.current()) busy.mutation = false;
    }
  }
  async function review(row: NetworkRelationship, status: 'accepted' | 'rejected') {
    if (busy.mutation || row.status !== 'proposed' || (status === 'accepted' && row.stale)) return;
    const op = begin('mutation');
    try {
      await request(
        `/relationships/${encodeURIComponent(row.fromId)}/${encodeURIComponent(row.toId)}`,
        op,
        'PATCH',
        { status, expectedRevision: row.revision },
      );
      if (op.current()) void loadRelationships();
    } catch (error) {
      failed('mutation', op, error);
    } finally {
      if (op.current()) busy.mutation = false;
    }
  }
  async function removeRelationship(row: NetworkRelationship) {
    if (busy.mutation || removal !== row) return;
    const op = begin('mutation');
    try {
      await request(
        `/relationships/${encodeURIComponent(row.fromId)}/${encodeURIComponent(row.toId)}`,
        op,
        'DELETE',
        { expectedRelationshipRevision: row.revision },
      );
      if (op.current()) {
        void loadRelationships();
        void loadNotes();
      }
    } catch (error) {
      failed('mutation', op, error);
    } finally {
      if (op.current()) {
        removal = null;
        busy.mutation = false;
      }
    }
  }
  async function activate() {
    if (!query.trim() || busy.activation) return;
    const op = begin('activation');
    activation = null;
    try {
      const result = await request<QueryActivation>('/context', op, 'POST', {
        query: query.trim(),
        semantic,
        maxHops,
        maxChars,
        limit: 6,
        excerptChars: 1000,
      });
      if (op.current()) activation = result.data;
    } catch (error) {
      failed('activation', op, error);
    } finally {
      if (op.current()) busy.activation = false;
    }
  }
  async function rebuildIndex(reset = false) {
    if (!indexingConsent || busy.rebuild || !canRebuild) return;
    // Do not let an older status GET overwrite the completed rebuild's status.
    cancel('index');
    const op = begin('rebuild');
    rebuildResult = null;
    try {
      const result = await request<RebuildResult>('/semantic-index/rebuild', op, 'POST', {
        optIn: true,
        limit: batchLimit,
        reset,
      });
      if (op.current()) {
        rebuildResult = result.data;
        indexStatus = result.data.status;
      }
    } catch (error) {
      failed('rebuild', op, error);
    } finally {
      if (op.current()) busy.rebuild = false;
    }
  }
  function cancel(lane: string) {
    requests.get(lane)?.abort();
    busy[lane] = false;
  }
  function cancelRebuild() {
    cancel('rebuild');
    errors.rebuild =
      'Rebuild cancellation requested. Completed batches may remain indexed; refresh status to check progress.';
    void loadIndex();
  }
  function refresh() {
    void loadRelationships();
    void loadNotes();
    void loadIndex();
  }

  $effect(() => {
    const scope = projectPath;
    untrack(() => {
      generation++;
      for (const request of requests.values()) request.abort();
      requests.clear();
      relationships = [];
      removal = null;
      notes = [];
      activation = null;
      indexStatus = null;
      rebuildResult = null;
      indexingConsent = false;
      semantic = false;
      fromId = '';
      toId = '';
      search = '';
      query = '';
      evidence = '';
      errors = {};
      busy = {};
      notesTruncated = false;
      statusFilter = '';
      if (scope) refresh();
    });
    return () => {
      generation++;
      for (const request of requests.values()) request.abort();
    };
  });
</script>

<div class="network-workspace">
  <header class="toolbar">
    <div>
      <h2>Notes network</h2>
      <p>Review evidence relationships and explore a bounded query activation.</p>
    </div>
    <button type="button" onclick={refresh} disabled={!projectPath}>Refresh network</button>
  </header>
  {#if !projectPath}<p role="status">Choose a project to explore its notes.</p>{:else}
    {#each Object.entries(errors).filter(([, message]) => message) as [lane, message]}
      <p role="alert" class="error">{label(lane)}: {message}</p>
    {/each}
    <section aria-label="Relationship review" class="card">
      <div class="toolbar">
        <h3>Evidence relationships</h3>
        <KorySelect
          value={statusFilter}
          options={statusOptions}
          onchange={(value) => {
            statusFilter = value;
            void loadRelationships();
          }}
          label="Relationship status"
          compact
        />
      </div>
      <p>
        Only accepted relationships participate in retrieval. Document links remain references, not
        typed claims. Acceptance is a human review action, not a similarity score.
      </p>
      <p class="muted">
        This is a bounded relationship list, not an exhaustive network inventory. Refresh to see
        external changes.
      </p>
      {#if busy.relationships}<p role="status">Loading relationships…</p>{/if}
      <ul class="relationships">
        {#each visibleRelationships as row (`${row.fromId}:${row.toId}`)}
          <li class="relationship">
            <div class="path">
              <button type="button" onclick={() => onOpenNote(row.fromId)}>{row.fromTitle}</button
              ><span>→ {label(row.type)} →</span><button
                type="button"
                onclick={() => onOpenNote(row.toId)}>{row.toTitle}</button
              >
            </div>
            <p>
              <span class="badge">{row.status}</span> <span class="badge">{row.provenance}</span>
              Revision {row.revision} · Evidence endpoints r{row.sourceRevision} / r{row.targetRevision}
            </p>
            {#if row.actor && Object.keys(row.actor).length}<p class="muted">
                Origin: {Object.entries(row.actor)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(' · ')}
              </p>{/if}
            {#if row.stale}<p class="warning">
                Stale evidence — an endpoint changed. You can reject a pending proposal. To propose
                current evidence, explicitly remove the existing relationship and refresh note
                choices first. Acceptance stays blocked while evidence is stale.
              </p>{/if}
            <blockquote>{row.evidence || 'No evidence recorded.'}</blockquote>
            {#if row.status === 'proposed'}
              <div class="actions">
                <button
                  type="button"
                  disabled={busy.mutation || row.stale}
                  onclick={() => review(row, 'accepted')}
                  aria-label={`Accept ${row.fromTitle} ${label(row.type)} ${row.toTitle}`}
                  >Accept</button
                ><button
                  type="button"
                  disabled={busy.mutation}
                  onclick={() => review(row, 'rejected')}
                  aria-label={`Reject ${row.fromTitle} ${label(row.type)} ${row.toTitle}`}
                  >Reject</button
                >
              </div>
            {/if}
            {#if removal?.fromId === row.fromId && removal?.toId === row.toId}
              <div class="warning" role="group" aria-label="Confirm relationship removal">
                <p>
                  Remove this {removal.status} relationship at revision {removal.revision}? This
                  removes only the typed association. Document wikilinks are not removed and may
                  still appear as references. You can then propose new evidence for this pair; the
                  new proposal still requires review.
                </p>
                <div class="actions">
                  <button
                    type="button"
                    disabled={busy.mutation}
                    onclick={() => removal && removeRelationship(removal)}
                    >Confirm remove relationship</button
                  >
                  <button type="button" disabled={busy.mutation} onclick={() => (removal = null)}
                    >Cancel removal</button
                  >
                </div>
              </div>
            {:else}
              <button
                type="button"
                disabled={busy.mutation || busy.relationships}
                onclick={() => (removal = row)}
                aria-label={`Remove ${row.fromTitle} ${label(row.type)} ${row.toTitle}`}
                >Remove relationship…</button
              >
            {/if}
          </li>
        {:else}<li>No relationships in this view.</li>{/each}
      </ul>
      <details>
        <summary>Propose a relationship</summary>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void loadNotes();
          }}
          class="toolbar"
        >
          <label
            >Find project notes<input
              bind:value={search}
              placeholder="Search note titles or content"
              maxlength="2000"
            /></label
          >
          <button type="submit" disabled={busy.notes}>Find notes</button>
        </form>
        <p class="muted">
          {notes.length} scoped note choices{notesTruncated
            ? ' · Results truncated; narrow your search.'
            : '.'} Search refreshes endpoint revisions; selections outside the results must be chosen
          again.
        </p>
        <div class="proposal-grid">
          <KorySelect
            value={fromId}
            options={noteOptions}
            onchange={(value) => (fromId = value)}
            label="Source note"
            placeholder="Choose source note"
            disabled={busy.notes || busy.mutation}
          />
          <KorySelect
            value={relationshipType}
            options={typeOptions}
            onchange={(value) => (relationshipType = value)}
            label="Relationship type"
          />
          <KorySelect
            value={toId}
            options={noteOptions.filter((note) => note.value !== fromId)}
            onchange={(value) => (toId = value)}
            label="Target note"
            placeholder="Choose target note"
            disabled={busy.notes || busy.mutation}
          />
        </div>
        <label
          >Evidence<textarea
            bind:value={evidence}
            maxlength="2000"
            rows="3"
            placeholder="Quote or explain the evidence for this relationship."
          ></textarea></label
        >
        <button
          type="button"
          onclick={propose}
          disabled={!canPropose || busy.mutation || busy.notes}>Create proposal</button
        >
      </details>
    </section>

    <section aria-label="Query activation" class="card">
      <h3>Query activation</h3>
      <p>
        Run a new read-only retrieval. This is not a historical agent trace, and co-retrieval does
        not establish agreement.
      </p>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void activate();
        }}
      >
        <label
          >Retrieval query<input
            bind:value={query}
            maxlength="2000"
            placeholder="What should these notes help answer?"
          /></label
        >
        <div class="query-controls">
          <SettingsSwitch
            checked={semantic}
            onchange={() => {
              semantic = !semantic;
            }}
            label="Use semantic retrieval"
            description="Use the existing opted-in index; never automatically index note bodies."
            compact
          />
          <NumberStepper
            value={maxHops}
            min={0}
            max={2}
            step={1}
            onchange={(value) => (maxHops = value)}
            label="Graph hops"
          />
          <NumberStepper
            value={maxChars}
            min={256}
            max={16000}
            step={256}
            onchange={(value) => (maxChars = value)}
            label="Excerpt character budget"
          />
        </div>
        <div class="actions">
          <button type="submit" disabled={!query.trim() || busy.activation}>Activate query</button
          >{#if busy.activation}<button type="button" onclick={() => cancel('activation')}
              >Cancel query</button
            ><span role="status">Retrieving…</span>{/if}
        </div>
      </form>
      {#if activation}
        <h4>Activation for “{activation.query}”</h4>
        <p>
          Coverage: {activation.results.length} notes · {activation.retrieval.exhaustive
            ? 'exhaustive'
            : 'bounded, non-exhaustive'} · Semantic: {label(activation.retrieval.semantic)} · Index: {label(
            activation.retrieval.index,
          )}
        </p>
        {#if activation.retrieval.coverage}
          {#if activation.retrieval.coverage.countsAvailable === false}
            <p>Semantic coverage was not evaluated · {label(activation.retrieval.coverage.mode)}</p>
          {:else}
            <p>
              Semantic coverage at activation: {activation.retrieval.coverage.indexedNotes} / {activation
                .retrieval.coverage.eligibleNotes} notes (revision metadata) · {activation.retrieval
                .coverage.staleNotes} stale · {label(activation.retrieval.coverage.mode)}
            </p>
          {/if}
          {#if activation.retrieval.coverage.search}
            <p class:warning={!activation.retrieval.coverage.search.exhaustive}>
              Semantic vectors examined: {activation.retrieval.coverage.search.scannedVectors} / {activation
                .retrieval.coverage.search.maxVectors} maximum · {label(
                activation.retrieval.coverage.search.reason,
              )}.
              {activation.retrieval.coverage.search.exhaustive
                ? 'Current vector scan complete.'
                : 'Non-exhaustive vector search; lexical and graph evidence remain available.'}
            </p>
          {/if}
        {/if}
        <p class:warning={activation.truncation.truncated}>
          Truncation: {activation.truncation.truncated
            ? activation.truncation.reasons.map(label).join(', ') || 'budget reached'
            : 'none reported'}
        </p>
        <details>
          <summary>Retrieval budget</summary>
          <dl class="budget">
            {#each Object.entries(activation.budget.used) as [key, value]}<div>
                <dt>{label(key)}</dt>
                <dd>
                  {value} / {activation.budget.limits[key === 'excerptChars' ? 'maxChars' : key] ??
                    '—'}
                </dd>
              </div>{/each}
          </dl>
          <p class="muted">
            All reported limits: {Object.entries(activation.budget.limits)
              .map(([key, value]) => `${key}: ${value}`)
              .join(' · ')}
          </p>
        </details>
        {#if activation.conflicts.length}<h4>Conflicts and stale evidence</h4>
          <ul>
            {#each activation.conflicts as conflict}<li class="warning">
                {noteTitle(conflict.noteId)}: {label(conflict.reason)} (expected r{conflict.expectedRevision},
                current {conflict.currentRevision === undefined
                  ? 'unavailable'
                  : `r${conflict.currentRevision}`}){conflict.relatedNoteId
                  ? ` · ${noteTitle(conflict.relatedNoteId)}`
                  : ''}
              </li>{/each}
          </ul>{/if}
        {#if activation.connections?.length}
          <details>
            <summary>Examined connections ({activation.connections.length})</summary>
            <p>
              Includes relationships between independently retrieved seeds. Recorded labels are
              claims, not verified facts.
            </p>
            <ul aria-label="Examined note connections">
              {#each activation.connections as step}
                <li>
                  {noteTitle(step.fromId)} (r{step.fromRevision}) → {noteTitle(step.toId)} (r{step.toRevision}):
                  {label(step.type ?? step.kind)} · {step.provenance}
                  {#if step.stale}<strong class="warning">Stale connection evidence</strong>{/if}
                  {#if step.evidence}<blockquote>{step.evidence}</blockquote>{/if}
                </li>
              {/each}
            </ul>
          </details>
        {/if}
        <div class="activation-map" aria-label="Local activation paths">
          <div class="query-node">Query: {activation.query}</div>
          {#each activation.results as result (result.id)}
            <article class="activation-node">
              <div class="path">
                <span aria-hidden="true">↳</span><button
                  type="button"
                  onclick={() => onOpenNote(result.id)}>{result.title}</button
                ><span class="badge">r{result.revision}</span>
              </div>
              <p><strong>Why selected:</strong> {result.explanation}</p>
              <p class="muted">
                Sources: {result.sources.join(', ')} · Ranking score: {result.score.toFixed(3)} (not confidence)
              </p>
              <ol aria-label={`Path to ${result.title}`}>
                <li>Seed: {noteTitle(result.seedId)}</li>
                {#each result.path as step}
                  <li>
                    <span
                      >{noteTitle(step.fromId)} (r{step.fromRevision}) → {noteTitle(step.toId)} (r{step.toRevision})</span
                    >
                    <p>
                      {step.direction} · {step.kind === 'document_link'
                        ? 'Document reference'
                        : label(step.type ?? step.kind)} · {step.provenance}{step.status
                        ? ` · ${step.status}`
                        : ''}{step.relationshipRevision === undefined
                        ? ''
                        : ` · relationship r${step.relationshipRevision}`}
                    </p>
                    {#if step.stale}<strong class="warning">Stale path evidence</strong
                      >{/if}{#if step.evidence}<blockquote>{step.evidence}</blockquote>{/if}
                  </li>
                {/each}
              </ol>
              <pre class="excerpt">{result.excerpt}</pre>
              {#if result.truncated}<p class="warning">
                  Excerpt truncated. Open the note for full context.
                </p>{/if}
            </article>
          {:else}<p>
              No notes selected. Try a more specific query or rebuild an enabled semantic index.
            </p>{/each}
        </div>
      {/if}
    </section>

    <section aria-label="Semantic index" class="card">
      <div class="toolbar">
        <h3>Semantic index</h3>
        <button type="button" onclick={loadIndex} disabled={busy.index || busy.rebuild}
          >Refresh index status</button
        >
      </div>
      <p>
        Embeddings are opt-in. Rebuilding may send scoped note text to the configured embedding
        provider only when server configuration and Notes permissions allow it. Enabling semantic
        query retrieval does not grant indexing permission.
      </p>
      {#if indexStatus}
        <p>
          Index mode: {label(indexStatus.mode)} · {indexStatus.enabled
            ? 'Index opt-in active'
            : 'Index not opted in'} · {indexStatus.providerIdentity
            ? 'Provider configured'
            : 'Provider unconfigured'}
        </p>
        <dl class="budget">
          <div>
            <dt>Index coverage</dt>
            <dd>
              {#if indexStatus.countsAvailable === false}
                Not evaluated (not an empty-vault claim)
              {:else}
                {indexStatus.indexedNotes} / {indexStatus.eligibleNotes} notes ({Math.round(
                  indexStatus.coverage * 100,
                )}%; revision metadata)
              {/if}
            </dd>
          </div>
          <div>
            <dt>Stale vectors</dt>
            <dd>
              {indexStatus.countsAvailable === false ? 'Not evaluated' : indexStatus.staleNotes}
            </dd>
          </div>
          <div>
            <dt>Representation cap</dt>
            <dd>{indexStatus.representationChars} characters per note</dd>
          </div>
        </dl>
        {#if indexStatus.mode === 'permission_denied'}<p class="warning">
            Notes permissions disallow embedding. Change the project permissions before rebuilding.
          </p>{/if}
      {:else}<p>{busy.index ? 'Loading index status…' : 'Index status unavailable.'}</p>{/if}
      <SettingsSwitch
        checked={indexingConsent}
        onchange={() => {
          indexingConsent = !indexingConsent;
        }}
        label="Allow explicit indexing for this project"
        description="I allow this rebuild to send bounded note representations to the configured embedding provider. This local consent resets when leaving the workspace."
        compact
        disabled={busy.rebuild}
      />
      <NumberStepper
        value={batchLimit}
        min={1}
        max={128}
        label="Index batch size"
        onchange={(value) => (batchLimit = value)}
        disabled={busy.rebuild}
      />
      <div class="actions">
        <button
          type="button"
          onclick={() => rebuildIndex()}
          disabled={!indexingConsent || !canRebuild || busy.rebuild}>Rebuild semantic index</button
        >
        <button
          type="button"
          onclick={() => rebuildIndex(true)}
          disabled={!indexingConsent || !canRebuild || busy.rebuild}>Restart index rebuild</button
        >
        {#if busy.rebuild}<button type="button" onclick={cancelRebuild}>Cancel rebuild</button><span
            role="status">Rebuilding…</span
          >{/if}
      </div>
      <p class="muted">
        Each click processes one bounded batch. Rebuild continues the saved cursor; restart scans
        from the beginning.
      </p>
      {#if rebuildResult}<p role="status">
          Processed {rebuildResult.processed} · Indexed {rebuildResult.indexed} · Skipped {rebuildResult.skipped}{rebuildResult.canceled
            ? ' · Canceled'
            : ''}. {rebuildResult.hasMore
            ? 'More notes remain; rebuild again to continue.'
            : 'Batch scan complete.'}
        </p>{/if}
    </section>
  {/if}
</div>

<style>
  .network-workspace {
    height: 100%;
    overflow: auto;
    padding: 1rem;
    color: var(--color-text-primary);
    background: var(--color-surface-1);
    font-size: 0.8125rem;
  }
  h2,
  h3,
  h4 {
    font-weight: 600;
    margin: 0.25rem 0 0.6rem;
  }
  h2 {
    font-size: 1rem;
  }
  p {
    margin: 0.5rem 0;
    overflow-wrap: anywhere;
  }
  .muted,
  .network-workspace > header p {
    color: var(--color-text-muted);
  }
  .toolbar,
  .actions,
  .path,
  .query-controls {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }
  .toolbar {
    justify-content: space-between;
  }
  .actions,
  .query-controls {
    margin: 0.75rem 0;
  }
  .card {
    padding: 1rem;
    margin-top: 1rem;
    border: 1px solid var(--color-border);
    border-radius: 0.75rem;
    background: var(--color-surface-2);
  }
  button,
  input,
  textarea {
    border: 1px solid var(--color-border);
    border-radius: 0.4rem;
    padding: 0.45rem 0.65rem;
    background: var(--color-surface-1);
    color: var(--color-text-primary);
    font: inherit;
  }
  button {
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--color-surface-3);
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button:focus-visible,
  input:focus-visible,
  textarea:focus-visible,
  summary:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0.75rem 0;
    flex: 1;
  }
  input,
  textarea {
    width: 100%;
    min-width: 0;
  }
  textarea {
    resize: vertical;
  }
  .relationships {
    list-style: none;
    padding: 0;
  }
  .relationship {
    border-top: 1px solid var(--color-border);
    padding: 0.85rem 0;
  }
  .badge {
    display: inline-block;
    border: 1px solid var(--color-border);
    border-radius: 1rem;
    padding: 0.1rem 0.45rem;
    font-size: 0.7rem;
  }
  blockquote {
    border-left: 3px solid var(--color-border);
    margin: 0.6rem 0;
    padding: 0.4rem 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
    margin: 0.75rem 0;
  }
  .proposal-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 0.6rem;
  }
  .warning {
    color: var(--color-warning);
  }
  .error {
    color: var(--color-error);
  }
  .budget {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.5rem;
  }
  .budget dt {
    color: var(--color-text-muted);
  }
  .budget dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .activation-map {
    border-left: 2px solid var(--color-accent);
    margin-top: 1rem;
    padding-left: 1rem;
  }
  .query-node {
    display: inline-block;
    border: 1px solid var(--color-accent);
    padding: 0.6rem;
    border-radius: 0.6rem;
    overflow-wrap: anywhere;
  }
  .activation-node {
    margin-top: 1rem;
    border: 1px solid var(--color-border);
    border-radius: 0.6rem;
    padding: 0.8rem;
    background: var(--color-surface-1);
  }
  .activation-node ol {
    padding-left: 1.3rem;
    overflow-wrap: anywhere;
  }
  .excerpt {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    padding: 0.65rem;
    background: var(--color-surface-2);
    border-radius: 0.4rem;
  }
</style>
