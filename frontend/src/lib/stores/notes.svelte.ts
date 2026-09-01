/**
 * Notes Network Store
 *
 * Manages the Obsidian-style note network:
 * - CRUD for notes
 * - Graph data (nodes + edges)
 * - Folder tree navigation
 * - Search
 * - Attachments
 * - Settings (persisted to localStorage)
 */

import { isDemoMode } from '$lib/demo.svelte';
import type {
  Note,
  NoteWithLinks,
  GraphData,
  GraphNode,
  GraphEdge,
  FolderNode,
  NoteAttachment,
  TrashedNote,
  NoteRevision,
  NoteRevisionSummary,
  NotesSettings,
  NotesAgentPermissions,
  NoteToolName,
  NotePermissionLevel,
  NotesPermissionPreset,
  UpdateNoteInput,
} from '@koryphaios/shared';
import {
  DEFAULT_NOTES_SETTINGS,
  DEFAULT_NOTES_AGENT_PERMISSIONS,
  applyNotesPermissionPreset,
  detectNotesPermissionPreset,
  normalizeNotesAgentPermissions,
} from '@koryphaios/shared';
import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';
import { apiFetch } from '$lib/api.svelte';
import { projectStore } from './project.svelte';

// ============================================================================
// Constants
// ============================================================================

const NOTES_SETTINGS_KEY = 'koryphaios-notes-settings';
const NOTES_REALTIME_BATCH_MS = 120;
const NOTES_REALTIME_DETAIL_THRESHOLD = 12;
const MAX_PENDING_LOCAL_MUTATIONS = 256;

export type NotesMutationAction = 'create' | 'update' | 'delete' | 'link' | 'unlink';

/** Metadata echoed by the backend for an exact Notes mutation broadcast.
 * Events without origin metadata are deliberately treated as remote. */
export interface NotesRealtimeUpdate {
  action?: NotesMutationAction;
  noteId?: string;
  clientId?: string;
  mutationId?: string;
}

function randomId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

// A client id lives for this renderer process only. It is never persisted and
// carries no authority; it solely lets the backend avoid reflecting this
// renderer's own successful HTTP mutation back as expensive invalidation work.
const notesClientId = randomId('notes-client');

function hasBrowserEnvironment(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

// ============================================================================
// State
// ============================================================================

let _notes = $state.raw<Note[]>([]);
let _currentNote = $state<NoteWithLinks | null>(null);
let _graphData = $state.raw<GraphData>({ nodes: [], edges: [] });
let _folderTree = $state.raw<FolderNode[]>([]);
let _isLoading = $state(false);
let _isSaving = $state(false);
let _searchQuery = $state('');
let _searchResultsTruncated = $state(false);
let _searchResultLimit = $state(50);
let _selectedFolder = $state('/');
let _settings = $state<NotesSettings>(loadSettingsFromStorage());
let _agentPermissions = $state<NotesAgentPermissions>({ ...DEFAULT_NOTES_AGENT_PERMISSIONS });
let _agentPermissionsLoaded = $state(false);
let _agentPermissionsSaving = $state(false);
let _isPanelOpen = $state(false);
let _error = $state<string | null>(null);
let _indexWarning = $state<string | null>(null);
let _isIndexing = $state(false);
let _conflict = $state<{
  noteId: string;
  remote: NoteWithLinks;
  sourceChanged?: boolean;
  sourceDeleted?: boolean;
} | null>(null);
type FailedNotesOperation =
  | { kind: 'load-notes'; folder?: string; query?: string }
  | { kind: 'load-note'; id: string }
  | { kind: 'save-note'; id: string; input: UpdateNoteInput }
  | { kind: 'delete-note'; id: string; revision: number }
  | { kind: 'load-graph' }
  | { kind: 'load-folders' }
  | { kind: 'delete-attachment'; noteId: string; attachmentId: string }
  | { kind: 'import-memory' }
  | { kind: 'sync-project' };
let _failedOperation = $state<FailedNotesOperation | null>(null);
let _settingsRevision = 0;
let _settingsSaveQueue: Promise<void> = Promise.resolve();
let _projectGeneration = 0;
let _notesRequestId = 0;
let _noteRequestId = 0;
let _graphRequestId = 0;
let _folderRequestId = 0;
let _searchRequestId = 0;
let _panelRefreshFlight: { generation: number; promise: Promise<void> } | null = null;
let _indexPollTimer: ReturnType<typeof setTimeout> | null = null;
let _realtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let _hasDeferredRealtimeRefresh = false;
let _queuedGlobalRealtimeRefresh = false;
const _queuedRealtimeUpdates = new Map<string, NotesRealtimeUpdate>();
const _pendingLocalMutationIds = new Set<string>();
const _pendingLocalMutationOrder: string[] = [];

interface ProjectSyncMeta {
  state?: 'idle' | 'running' | 'complete' | 'partial' | 'failed';
  discovered?: number;
  error?: string;
}

let allTags = $derived(Array.from(new Set(_notes.flatMap((note) => note.tags ?? []))));
let _visibleNotes = $derived.by(() => {
  const query = _searchQuery.trim().toLowerCase();
  return _notes.filter((note) => {
    const inFolder =
      _selectedFolder === '/' ||
      note.folderPath === _selectedFolder ||
      note.folderPath.startsWith(`${_selectedFolder}/`);
    if (!inFolder) return false;
    return (
      !query ||
      note.title.toLowerCase().includes(query) ||
      note.content.toLowerCase().includes(query) ||
      (note.tags ?? []).some((tag) => tag.toLowerCase().includes(query))
    );
  });
});

// ============================================================================
// Helpers
// ============================================================================

function loadSettingsFromStorage(): NotesSettings {
  if (!hasBrowserEnvironment()) return { ...DEFAULT_NOTES_SETTINGS };
  try {
    const raw = localStorage.getItem(NOTES_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_NOTES_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<NotesSettings>;
    return {
      ...DEFAULT_NOTES_SETTINGS,
      ...parsed,
      graphPhysics: {
        ...DEFAULT_NOTES_SETTINGS.graphPhysics,
        ...(parsed.graphPhysics ?? {}),
      },
    };
  } catch (err: unknown) {
    console.debug(
      'Failed to load notes settings from localStorage:',
      err instanceof Error ? err.message : String(err),
    );
    return { ...DEFAULT_NOTES_SETTINGS };
  }
}

function saveSettingsToStorage(s: NotesSettings): void {
  if (!hasBrowserEnvironment()) return;
  try {
    localStorage.setItem(NOTES_SETTINGS_KEY, JSON.stringify(s));
  } catch (err: unknown) {
    // Ignore
    console.debug(
      'Failed to save notes settings to localStorage:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: string; message?: string };
    return body.error || body.message || fallback;
  } catch {
    return fallback;
  }
}

function responseDate(value: Date | string | number, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${field} in Notes response`);
  return date;
}

function reviveTrashedNote(note: TrashedNote): TrashedNote {
  return {
    ...note,
    createdAt: responseDate(note.createdAt, 'createdAt'),
    updatedAt: responseDate(note.updatedAt, 'updatedAt'),
    trashedAt: responseDate(note.trashedAt, 'trashedAt'),
  };
}

function reviveRevisionSummary(revision: NoteRevisionSummary): NoteRevisionSummary {
  return {
    ...revision,
    noteCreatedAt: responseDate(revision.noteCreatedAt, 'noteCreatedAt'),
    noteUpdatedAt: responseDate(revision.noteUpdatedAt, 'noteUpdatedAt'),
    createdAt: responseDate(revision.createdAt, 'createdAt'),
  };
}

function setError(
  message: string,
  showToast = true,
  operation: FailedNotesOperation | null = null,
): void {
  _error = message;
  _failedOperation = operation;
  if (showToast) toastStore.error(message);
}

function clearError(): void {
  _error = null;
  _failedOperation = null;
}

function clearOperationError(...kinds: FailedNotesOperation['kind'][]): void {
  if (_failedOperation && kinds.includes(_failedOperation.kind)) clearError();
}

function mergeCatalogNotes(items: Note[], metadataOnly = false): void {
  const byId = new Map(_notes.map((note) => [note.id, note]));
  for (const item of items) {
    const existing = byId.get(item.id);
    byId.set(item.id, {
      ...existing,
      ...item,
      // The unfiltered list endpoint intentionally returns metadata-only rows.
      // Preserve any body already hydrated by search/open/transclusion reads.
      content: metadataOnly && existing ? existing.content : item.content,
    });
  }
  _notes = sortNotesForPanel([...byId.values()]);
}

function replaceCatalogMetadata(items: Note[]): void {
  const prior = new Map(_notes.map((note) => [note.id, note]));
  _notes = sortNotesForPanel(
    items.map((item) => {
      const existing = prior.get(item.id);
      return {
        ...item,
        // A matching revision proves the cached body still belongs to this
        // metadata row. On revision change, discard it rather than serving a
        // stale transclusion; the body will be hydrated on demand.
        content: existing && existing.revision === item.revision ? existing.content : item.content,
      };
    }),
  );
}

function beginLocalMutation(): { mutationId: string; headers: Record<string, string> } {
  const mutationId = randomId('notes-mutation');
  _pendingLocalMutationIds.add(mutationId);
  _pendingLocalMutationOrder.push(mutationId);
  while (_pendingLocalMutationOrder.length > MAX_PENDING_LOCAL_MUTATIONS) {
    const expired = _pendingLocalMutationOrder.shift();
    if (expired) _pendingLocalMutationIds.delete(expired);
  }
  return {
    mutationId,
    headers: {
      'x-kory-client-id': notesClientId,
      'x-kory-mutation-id': mutationId,
    },
  };
}

function finishLocalMutation(mutationId: string, succeeded: boolean): void {
  // Successful ids remain until their exact broadcast is consumed. Failed
  // requests cannot produce a legitimate mutation event and are removed now.
  if (!succeeded) _pendingLocalMutationIds.delete(mutationId);
}

function consumeOwnRealtimeUpdate(update: NotesRealtimeUpdate): boolean {
  if (
    !update.mutationId ||
    update.clientId !== notesClientId ||
    !_pendingLocalMutationIds.has(update.mutationId)
  ) {
    return false;
  }
  _pendingLocalMutationIds.delete(update.mutationId);
  return true;
}

function clearRealtimeRefresh(): void {
  if (_realtimeRefreshTimer) clearTimeout(_realtimeRefreshTimer);
  _realtimeRefreshTimer = null;
  _queuedRealtimeUpdates.clear();
  _queuedGlobalRealtimeRefresh = false;
}

function clearIndexPoll(): void {
  if (_indexPollTimer) clearTimeout(_indexPollTimer);
  _indexPollTimer = null;
}

function scheduleIndexPoll(): void {
  if (_indexPollTimer || !_isIndexing || !projectStore.currentPath) return;
  const projectPath = projectStore.currentPath;
  const generation = _projectGeneration;
  _indexPollTimer = setTimeout(() => {
    _indexPollTimer = null;
    if (!requestScopeIsCurrent(projectPath, generation) || !_isIndexing) return;
    void (async () => {
      await fetchNotes(undefined, undefined, { background: true });
      if (!requestScopeIsCurrent(projectPath, generation)) return;
      if (_isIndexing) scheduleIndexPoll();
      else await Promise.all([fetchGraph(), fetchFolderTree()]);
    })();
  }, 1_000);
}

function applyProjectSyncMeta(sync?: ProjectSyncMeta): void {
  if (!sync?.state) return;
  if (sync.state === 'running') {
    _isIndexing = true;
    _indexWarning = null;
    clearOperationError('sync-project');
    scheduleIndexPoll();
    return;
  }
  _isIndexing = false;
  clearIndexPoll();
  if (sync.state === 'partial') {
    _indexWarning =
      sync.error ??
      `Indexed ${sync.discovered ?? 0} project documents. Some files could not be verified, so their existing entries were preserved.`;
    clearOperationError('sync-project');
    return;
  }
  if (sync.state === 'failed') {
    _indexWarning = null;
    setError(sync.error ?? 'The project note index failed.', false, { kind: 'sync-project' });
    return;
  }
  if (sync.state === 'complete') {
    _indexWarning = null;
    clearOperationError('sync-project');
  }
}

function requestScopeIsCurrent(projectPath: string | null, generation: number): boolean {
  return generation === _projectGeneration && projectPath === projectStore.currentPath;
}

function sortNotesForPanel(items: Note[]): Note[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

// ============================================================================
// API Functions
// ============================================================================

/** Fetch all notes, optionally filtered by folder or search query */
// Full Note shape — the panel reads folderPath/tags/pinned during render, so
// partial objects crash the note list.
const DEMO_NOTES = [
  {
    id: 'n1',
    title: 'Dashboard spec',
    sourcePath: 'notes/spec.md',
    format: 'markdown',
    content:
      '# Analytics Dashboard\n\n- Revenue over time (line)\n- Top sources (bar)\n- Conversion funnel\n\nData comes from the [[API contract]]. See also [[Roadmap]].',
    folderPath: '/',
    tags: ['spec'],
    pinned: true,
    includeInContext: true,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'n2',
    title: 'API contract',
    sourcePath: 'notes/api.md',
    format: 'markdown',
    content:
      '## /api/metrics\n\nReturns { revenue[], sources[], funnel[] }\n\nConsumed by the [[Dashboard spec]].',
    folderPath: '/',
    tags: ['api'],
    pinned: false,
    includeInContext: false,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'n3',
    title: 'Roadmap',
    sourcePath: 'notes/roadmap.md',
    format: 'markdown',
    content:
      '# Roadmap\n\n- Ship the [[Dashboard spec]]\n- Firm up the [[API contract]]\n- Explore [[Realtime streaming]]',
    folderPath: '/planning',
    tags: ['planning'],
    pinned: false,
    includeInContext: false,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'n4',
    title: 'Dashboard delivery map',
    sourcePath: 'canvases/dashboard-delivery-map.canvas.json',
    format: 'markdown',
    content: JSON.stringify({
      v: 1,
      name: 'Dashboard delivery map',
      cards: [
        {
          id: 'c-spec',
          x: 120,
          y: 130,
          w: 190,
          h: 120,
          text: 'Dashboard spec',
          noteId: 'n1',
          color: '#8b7ec8',
        },
        {
          id: 'c-api',
          x: 420,
          y: 250,
          w: 190,
          h: 120,
          text: 'API contract',
          noteId: 'n2',
          color: '#6b9bd1',
        },
        {
          id: 'c-roadmap',
          x: 720,
          y: 130,
          w: 190,
          h: 120,
          text: 'Roadmap',
          noteId: 'n3',
          color: '#5ec4a0',
        },
      ],
      edges: [
        { id: 'e-spec-api', from: 'c-spec', to: 'c-api' },
        { id: 'e-api-roadmap', from: 'c-api', to: 'c-roadmap' },
      ],
    }),
    folderPath: '/canvases',
    tags: ['canvas'],
    pinned: true,
    includeInContext: false,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// Build a real graph from the demo notes (wikilinks → edges, unresolved → ghost
// nodes), matching what the backend graph endpoint returns. A demo-only
// `?graphn=N` query param seeds N synthetic interlinked nodes so the canvas
// renderer can be exercised at scale without a backend.
function buildDemoGraph(source: Note[]): GraphData {
  const search = typeof location !== 'undefined' ? location.search : '';
  const synthN = Number(new URLSearchParams(search).get('graphn') ?? 0);
  if (synthN > 0) {
    const nodes: GraphNode[] = Array.from({ length: synthN }, (_, i) => ({
      id: `s${i}`,
      title: `Node ${i}`,
      folderPath: `/cluster-${i % 12}`,
      tags: [],
      linkCount: 0,
      includeInContext: i % 50 === 0,
    }));
    const edges: GraphEdge[] = [];
    for (let i = 1; i < synthN; i++) {
      const t = Math.floor(i * Math.random());
      edges.push({ from: `s${i}`, to: `s${t}` });
      nodes[i].linkCount++;
      nodes[t].linkCount++;
    }
    return { nodes, edges };
  }

  const byTitle = new Map(source.map((n) => [n.title.toLowerCase(), n]));
  const nodes: GraphNode[] = source.map((n) => ({
    id: n.id,
    title: n.title,
    folderPath: n.folderPath,
    tags: n.tags ?? [],
    linkCount: 0,
    includeInContext: n.includeInContext,
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = [];
  const ghosts = new Map<string, GraphNode>();
  const re = /!?\[\[([^\]|#]+?)(?:[|#][^\]]+?)?\]\]/g;
  for (const n of source) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(n.content ?? ''))) {
      const targetTitle = m[1].trim();
      const target = byTitle.get(targetTitle.toLowerCase());
      if (target) {
        edges.push({ from: n.id, to: target.id });
        nodeById.get(n.id)!.linkCount++;
        nodeById.get(target.id)!.linkCount++;
      } else {
        const gid = `ghost:${targetTitle.toLowerCase()}`;
        if (!ghosts.has(gid)) {
          ghosts.set(gid, {
            id: gid,
            title: targetTitle,
            // Keep demo/evidence graph grouping identical to the backend:
            // unresolved wikilinks live at the root instead of producing an
            // unlabeled legend swatch.
            folderPath: '/',
            tags: [],
            linkCount: 0,
            includeInContext: false,
            unresolved: true,
          });
        }
        edges.push({ from: n.id, to: gid, unresolved: true });
        nodeById.get(n.id)!.linkCount++;
        ghosts.get(gid)!.linkCount++;
      }
    }
  }
  return { nodes: [...nodes, ...ghosts.values()], edges };
}

let _demoSeeded = false;
/** Fetch the complete, metadata-only vault catalog.
 *
 * `folder` and `query` remain in the signature for retry compatibility, but
 * they never narrow the catalog. Visible folder/search state is derived
 * separately so autocomplete, Canvas, queries, and link resolution cannot
 * lose unrelated notes when the sidebar is filtered.
 */
async function fetchNotes(
  _folder?: string,
  _query?: string,
  options: { background?: boolean } = {},
): Promise<boolean> {
  if (isDemoMode) {
    // Seed once. Reassigning on every call would hand $state a fresh reference
    // each time; because fetchGraph() reads _notes synchronously inside the
    // project effect, that turns into a write-a-dep-you-read feedback loop
    // (effect_update_depth_exceeded). User edits still mutate _notes normally.
    if (!_demoSeeded) {
      _notes = DEMO_NOTES.map((n) => ({ ...n })) as unknown as Note[];
      _demoSeeded = true;
    }
    _isLoading = false;
    return true;
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const requestId = ++_notesRequestId;
  const showBlockingLoading = !options.background && _notes.length === 0;
  if (showBlockingLoading) _isLoading = true;
  try {
    const res = await apiFetch(apiUrl('/api/notes'));
    if (res.ok) {
      const data = await res.json();
      if (
        data.ok &&
        Array.isArray(data.data) &&
        requestScopeIsCurrent(requestProject, requestGeneration) &&
        requestId === _notesRequestId
      ) {
        replaceCatalogMetadata(data.data as Note[]);
        applyProjectSyncMeta(data.meta?.projectSync as ProjectSyncMeta | undefined);
        clearOperationError('load-notes');
        return true;
      }
    } else if (
      requestScopeIsCurrent(requestProject, requestGeneration) &&
      requestId === _notesRequestId
    ) {
      setError(await responseMessage(res, 'Failed to load notes'), false, {
        kind: 'load-notes',
      });
    }
  } catch (err) {
    console.error('[notesStore] fetchNotes error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration) && requestId === _notesRequestId) {
      setError(err instanceof Error ? err.message : 'Failed to load notes', false, {
        kind: 'load-notes',
      });
    }
  } finally {
    if (requestScopeIsCurrent(requestProject, requestGeneration) && requestId === _notesRequestId) {
      if (showBlockingLoading) _isLoading = false;
    }
  }
  return false;
}

/** Load the note-panel data when the panel opens or its project changes.
 *
 * This deliberately lives behind an explicit store action. `$effect` is only
 * valid while a Svelte component is initializing; registering one at this
 * module's top level made the static, read-only demo crash before it mounted.
 */
function refreshOpenPanel(): Promise<void> {
  if (!_isPanelOpen || !projectStore.currentPath) return Promise.resolve();
  const generation = _projectGeneration;
  if (_panelRefreshFlight?.generation === generation) return _panelRefreshFlight.promise;

  const flight = {
    generation,
    promise: Promise.resolve(),
  };
  flight.promise = (async () => {
    // The graph is derived from the current note list, so populate notes first.
    // This also avoids racing a freshly selected project against its old graph.
    const hadCatalog = _notes.length > 0;
    if (!(await fetchNotes(undefined, undefined, { background: hadCatalog }))) return;
    if (generation !== _projectGeneration) return;
    _hasDeferredRealtimeRefresh = false;
    await Promise.all([fetchFolderTree(), fetchGraph()]);
  })().finally(() => {
    if (_panelRefreshFlight === flight) _panelRefreshFlight = null;
  });
  _panelRefreshFlight = flight;
  return flight.promise;
}

async function fetchCatalogNoteDetail(id: string): Promise<NoteWithLinks | null> {
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  try {
    const response = await apiFetch(apiUrl(`/api/notes/${id}`));
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; data?: NoteWithLinks };
    if (!body.ok || !body.data || !requestScopeIsCurrent(requestProject, requestGeneration)) {
      return null;
    }
    mergeCatalogNotes([body.data]);
    return body.data;
  } catch (error) {
    console.debug(
      '[notesStore] catalog detail refresh failed:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function hydrateTransclusionBodies(note: NoteWithLinks): void {
  const titles = new Set<string>();
  const pattern = /!\[\[([^\]|#]+?)(?:[|#][^\]]+?)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(note.content)) !== null && titles.size < 16) {
    const title = match[1]?.trim().toLowerCase();
    if (title) titles.add(title);
  }
  if (titles.size === 0) return;
  const targets = _notes.filter(
    (candidate) =>
      candidate.id !== note.id && titles.has(candidate.title.toLowerCase()) && !candidate.content,
  );
  for (const target of targets) void fetchCatalogNoteDetail(target.id);
}

/** Fetch a single note by ID (includes links and attachments) */
async function fetchNote(id: string): Promise<boolean> {
  if (isDemoMode) {
    // No backend in the full demo — resolve the note from the in-memory list
    // so opening a note actually loads its content (the /api/notes shim only
    // returns an empty array, which would blank the editor/preview pane).
    const found = _notes.find((n) => n.id === id) as Note | undefined;
    _currentNote = found
      ? ({ ...found, outlinks: [], backlinks: [], attachments: [] } as NoteWithLinks)
      : null;
    _isLoading = false;
    return Boolean(found);
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const requestId = ++_noteRequestId;
  try {
    const res = await apiFetch(apiUrl(`/api/notes/${id}`));
    if (res.ok) {
      const data = await res.json();
      if (
        data.ok &&
        data.data &&
        requestScopeIsCurrent(requestProject, requestGeneration) &&
        requestId === _noteRequestId
      ) {
        _currentNote = data.data as NoteWithLinks;
        mergeCatalogNotes([data.data as NoteWithLinks]);
        hydrateTransclusionBodies(data.data as NoteWithLinks);
        _conflict = null;
        clearOperationError('load-note');
        return true;
      }
    } else if (
      requestScopeIsCurrent(requestProject, requestGeneration) &&
      requestId === _noteRequestId
    ) {
      setError(await responseMessage(res, 'Failed to load note'), true, { kind: 'load-note', id });
    }
  } catch (err) {
    console.error('[notesStore] fetchNote error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration) && requestId === _noteRequestId) {
      setError(err instanceof Error ? err.message : 'Failed to load note', true, {
        kind: 'load-note',
        id,
      });
    }
  } finally {
    // Note reads do not own the sidebar's catalog-loading indicator. Keeping
    // that flag untouched prevents the list from blinking out on every click.
  }
  return false;
}

/** Read a full note without changing the active editor selection.
 * List responses intentionally omit bodies for scale, so document consumers
 * such as Canvas must use this route before parsing persisted content. */
async function readNote(id: string): Promise<NoteWithLinks | null> {
  if (isDemoMode) {
    const found = _notes.find((note) => note.id === id);
    return found
      ? ({ ...found, outlinks: [], backlinks: [], attachments: [] } as NoteWithLinks)
      : null;
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  try {
    const response = await apiFetch(apiUrl(`/api/notes/${id}`));
    if (!response.ok) {
      if (requestScopeIsCurrent(requestProject, requestGeneration)) {
        setError(await responseMessage(response, 'Failed to load note'));
      }
      return null;
    }
    const body = (await response.json()) as { ok?: boolean; data?: NoteWithLinks };
    if (!body.ok || !body.data || !requestScopeIsCurrent(requestProject, requestGeneration)) {
      return null;
    }
    mergeCatalogNotes([body.data]);
    clearError();
    return body.data;
  } catch (error) {
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(error instanceof Error ? error.message : 'Failed to load note');
    }
    return null;
  }
}

/** Open a note by title (searches notes list, then fetches by ID) */
async function openNoteByTitle(title: string): Promise<void> {
  const found = _notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
  if (found) {
    await fetchNote(found.id);
    return;
  }
  // Fallback through the project/request guarded search path so a response
  // from the previous workspace can never open under the new project header.
  const [note] = await searchNotes(title);
  if (note) await fetchNote(note.id);
  else toastStore.error(`Note not found: ${title}`);
}

/** Create a new note */
async function createNote(input: {
  title: string;
  content?: string;
  folderPath?: string;
  tags?: string[];
  pinned?: boolean;
  includeInContext?: boolean;
  format?: 'markdown' | 'html';
}): Promise<Note | null> {
  if (isDemoMode) {
    const now = new Date();
    const note = {
      id: globalThis.crypto?.randomUUID?.() ?? `demo-${now.getTime()}`,
      title: input.title ?? 'Untitled',
      content: input.content ?? '',
      folderPath: input.folderPath ?? '/',
      tags: input.tags ?? [],
      pinned: input.pinned ?? false,
      includeInContext: input.includeInContext ?? false,
      format: input.format ?? 'markdown',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    } as Note;
    _notes = [note, ..._notes];
    return note;
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  _isSaving = true;
  try {
    const res = await apiFetch(apiUrl('/api/notes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...mutation.headers },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        mutationSucceeded = true;
        const note = data.data as Note;
        if (!requestScopeIsCurrent(requestProject, requestGeneration)) return null;
        mergeCatalogNotes([note]);
        if (_isPanelOpen) void fetchFolderTree();
        clearError();
        return note;
      }
    }
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(await responseMessage(res, 'Failed to create note'));
    }
    return null;
  } catch (err) {
    console.error('[notesStore] createNote error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to create note');
    }
    return null;
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) _isSaving = false;
  }
}

/** Update an existing note */
async function updateNote(id: string, input: UpdateNoteInput): Promise<Note | null> {
  if (isDemoMode) {
    // No backend in the demo — edit the in-memory note in place. Without this
    // the /api/notes shim returns [], which would overwrite the note with an
    // empty array and corrupt the list on every autosave.
    const existing = _notes.find((n) => n.id === id) as Note | undefined;
    if (!existing) return null;
    const changes = { ...input };
    delete changes.expectedRevision;
    delete changes.restoreDeletedSource;
    const updated = {
      ...existing,
      ...changes,
      revision: existing.revision + 1,
      updatedAt: new Date(),
    } as Note;
    _notes = _notes.map((n) => (n.id === id ? updated : n));
    if (_currentNote && _currentNote.id === id) {
      _currentNote = { ..._currentNote, ...updated };
    }
    return updated;
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  const priorFolder = _notes.find((note) => note.id === id)?.folderPath;
  _isSaving = true;
  try {
    const currentRevision =
      _currentNote?.id === id
        ? _currentNote.revision
        : _notes.find((note) => note.id === id)?.revision;
    const payload: UpdateNoteInput = {
      ...input,
      expectedRevision: input.expectedRevision ?? currentRevision,
    };
    const res = await apiFetch(apiUrl(`/api/notes/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...mutation.headers },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      let conflictDetails: { sourceChanged?: boolean; sourceDeleted?: boolean } = {};
      try {
        const conflictBody = (await res.clone().json()) as {
          details?: { sourceChanged?: boolean; sourceDeleted?: boolean };
        };
        conflictDetails = conflictBody.details ?? {};
      } catch {
        // The follow-up GET still supplies the authoritative remote revision.
      }
      const remoteResponse = await apiFetch(apiUrl(`/api/notes/${id}`));
      if (remoteResponse.ok && requestScopeIsCurrent(requestProject, requestGeneration)) {
        const remoteBody = (await remoteResponse.json()) as { ok?: boolean; data?: NoteWithLinks };
        if (remoteBody.ok && remoteBody.data) {
          _conflict = { noteId: id, remote: remoteBody.data, ...conflictDetails };
        }
      }
      if (requestScopeIsCurrent(requestProject, requestGeneration)) {
        setError(
          conflictDetails.sourceDeleted
            ? 'The project source file was deleted elsewhere. Recreate it or accept the deletion.'
            : 'This note changed elsewhere. Review the newer version before saving.',
        );
      }
      return null;
    }
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        mutationSucceeded = true;
        const updated = data.data as Note;
        if (!requestScopeIsCurrent(requestProject, requestGeneration)) return null;
        // Update in-memory list
        mergeCatalogNotes([updated]);
        // Update current note if it matches
        if (_currentNote && _currentNote.id === id) {
          _currentNote = {
            ..._currentNote,
            ...updated,
          };
        }
        if (_isPanelOpen && priorFolder !== updated.folderPath) void fetchFolderTree();
        _conflict = null;
        clearOperationError('save-note');
        return updated;
      }
    }
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(await responseMessage(res, 'Failed to save note'), true, {
        kind: 'save-note',
        id,
        input: payload,
      });
    }
    return null;
  } catch (err) {
    console.error('[notesStore] updateNote error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to save note', true, {
        kind: 'save-note',
        id,
        input,
      });
    }
    return null;
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) _isSaving = false;
  }
}

/** Delete a note by ID */
async function deleteNote(id: string, expectedRevision?: number): Promise<boolean> {
  if (isDemoMode) {
    _notes = _notes.filter((n) => n.id !== id);
    if (_currentNote?.id === id) _currentNote = null;
    toastStore.success('Note moved to trash');
    return true;
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const revision =
    expectedRevision ??
    (_currentNote?.id === id
      ? _currentNote.revision
      : _notes.find((note) => note.id === id)?.revision);
  if (!revision) {
    setError('Reload this note before deleting it.');
    return false;
  }
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  try {
    const res = await apiFetch(apiUrl(`/api/notes/${id}`), {
      method: 'DELETE',
      headers: { 'x-kory-note-revision': String(revision), ...mutation.headers },
    });
    if (res.ok) {
      mutationSucceeded = true;
      if (requestScopeIsCurrent(requestProject, requestGeneration)) {
        _notes = _notes.filter((n) => n.id !== id);
        if (_currentNote?.id === id) {
          _currentNote = null;
        }
        if (_isPanelOpen) void fetchFolderTree();
        toastStore.success('Note moved to trash');
        clearOperationError('delete-note');
      }
      return true;
    }
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(await responseMessage(res, 'Failed to delete note'), true, {
        kind: 'delete-note',
        id,
        revision,
      });
    }
    return false;
  } catch (err) {
    console.error('[notesStore] deleteNote error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to delete note', true, {
        kind: 'delete-note',
        id,
        revision,
      });
    }
    return false;
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
  }
}

/** Fetch graph data (nodes + edges) */
async function fetchGraph(): Promise<boolean> {
  if (isDemoMode) {
    _graphData = buildDemoGraph(_notes);
    return true;
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const requestId = ++_graphRequestId;
  try {
    const res = await apiFetch(apiUrl('/api/notes/graph'));
    if (res.ok) {
      const data = await res.json();
      if (
        data.ok &&
        data.data &&
        requestScopeIsCurrent(requestProject, requestGeneration) &&
        requestId === _graphRequestId
      ) {
        _graphData = data.data as GraphData;
        applyProjectSyncMeta(data.meta?.projectSync as ProjectSyncMeta | undefined);
        clearOperationError('load-graph');
        return true;
      }
      if (
        requestScopeIsCurrent(requestProject, requestGeneration) &&
        requestId === _graphRequestId
      ) {
        setError('The graph response was incomplete.', false, { kind: 'load-graph' });
      }
    } else if (
      requestScopeIsCurrent(requestProject, requestGeneration) &&
      requestId === _graphRequestId
    ) {
      setError(await responseMessage(res, 'Failed to load note graph'), false, {
        kind: 'load-graph',
      });
    }
  } catch (err) {
    console.error('[notesStore] fetchGraph error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration) && requestId === _graphRequestId) {
      setError(err instanceof Error ? err.message : 'Failed to load note graph', false, {
        kind: 'load-graph',
      });
    }
  }
  return false;
}

/** Fetch folder tree */
async function fetchFolderTree(): Promise<boolean> {
  if (isDemoMode) return true;
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const requestId = ++_folderRequestId;
  try {
    const res = await apiFetch(apiUrl('/api/notes/folders'));
    if (res.ok) {
      const data = await res.json();
      if (
        data.ok &&
        Array.isArray(data.data) &&
        requestScopeIsCurrent(requestProject, requestGeneration) &&
        requestId === _folderRequestId
      ) {
        _folderTree = data.data as FolderNode[];
        clearOperationError('load-folders');
        return true;
      }
    } else if (
      requestScopeIsCurrent(requestProject, requestGeneration) &&
      requestId === _folderRequestId
    ) {
      setError(await responseMessage(res, 'Failed to load note folders'), false, {
        kind: 'load-folders',
      });
    }
  } catch (err) {
    console.error('[notesStore] fetchFolderTree error:', err);
    if (
      requestScopeIsCurrent(requestProject, requestGeneration) &&
      requestId === _folderRequestId
    ) {
      setError(err instanceof Error ? err.message : 'Failed to load note folders', false, {
        kind: 'load-folders',
      });
    }
  }
  return false;
}

/** Search notes by query string */
async function searchNotes(q: string): Promise<Note[]> {
  if (!q.trim()) return [];
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const requestId = ++_searchRequestId;
  try {
    const res = await apiFetch(apiUrl(`/api/notes/search?q=${encodeURIComponent(q)}`));
    if (res.ok) {
      const data = await res.json();
      if (
        data.ok &&
        Array.isArray(data.data) &&
        requestScopeIsCurrent(requestProject, requestGeneration) &&
        requestId === _searchRequestId
      ) {
        _searchResultsTruncated = data.meta?.truncated === true;
        _searchResultLimit =
          Number.isSafeInteger(data.meta?.limit) && data.meta.limit > 0 ? data.meta.limit : 50;
        return data.data as Note[];
      }
    }
    if (
      requestScopeIsCurrent(requestProject, requestGeneration) &&
      requestId === _searchRequestId
    ) {
      _searchResultsTruncated = false;
    }
    return [];
  } catch (err) {
    console.error('[notesStore] searchNotes error:', err);
    if (
      requestScopeIsCurrent(requestProject, requestGeneration) &&
      requestId === _searchRequestId
    ) {
      _searchResultsTruncated = false;
    }
    return [];
  }
}

/** Upload an attachment for a note */
async function uploadAttachment(noteId: string, file: File): Promise<NoteAttachment | null> {
  if (isDemoMode) {
    toastStore.error('Attachments are not available in the demo');
    return null;
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiFetch(apiUrl(`/api/notes/${noteId}/attachments`), {
      method: 'POST',
      headers: mutation.headers,
      body: formData,
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        mutationSucceeded = true;
        const attachment = data.data as NoteAttachment;
        if (!requestScopeIsCurrent(requestProject, requestGeneration)) return null;
        // Update current note's attachment list
        if (_currentNote && _currentNote.id === noteId) {
          _currentNote = {
            ..._currentNote,
            attachments: [...(_currentNote.attachments ?? []), attachment],
          };
        }
        toastStore.success(`Uploaded ${file.name}`);
        return attachment;
      }
    }
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(await responseMessage(res, 'Failed to upload attachment'));
    }
    return null;
  } catch (err) {
    console.error('[notesStore] uploadAttachment error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to upload attachment');
    }
    return null;
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
  }
}

/** Delete an attachment */
async function deleteAttachment(noteId: string, attachmentId: string): Promise<boolean> {
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  try {
    const res = await apiFetch(apiUrl(`/api/notes/${noteId}/attachments/${attachmentId}`), {
      method: 'DELETE',
      headers: mutation.headers,
    });
    if (res.ok) {
      mutationSucceeded = true;
      if (
        requestScopeIsCurrent(requestProject, requestGeneration) &&
        _currentNote &&
        _currentNote.id === noteId
      ) {
        _currentNote = {
          ..._currentNote,
          attachments: (_currentNote.attachments ?? []).filter((a) => a.id !== attachmentId),
        };
      }
      if (requestScopeIsCurrent(requestProject, requestGeneration)) {
        clearOperationError('delete-attachment');
        toastStore.success('Attachment deleted');
      }
      return true;
    }
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(await responseMessage(res, 'Failed to delete attachment'), true, {
        kind: 'delete-attachment',
        noteId,
        attachmentId,
      });
    }
    return false;
  } catch (err) {
    console.error('[notesStore] deleteAttachment error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to delete attachment', true, {
        kind: 'delete-attachment',
        noteId,
        attachmentId,
      });
    }
    return false;
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
  }
}

/** Import memory content as a note */
async function importMemoryAsNotes(): Promise<void> {
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  try {
    const res = await apiFetch(apiUrl('/api/notes/import-memory'), {
      method: 'POST',
      headers: mutation.headers,
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
        mutationSucceeded = true;
        if (!requestScopeIsCurrent(requestProject, requestGeneration)) return;
        const report = data.data as {
          entries?: Array<{
            status: 'created' | 'updated' | 'unchanged' | 'failed';
            note?: Note;
            source?: { name?: string };
            error?: string;
          }>;
          counts?: { created?: number; updated?: number; unchanged?: number; failed?: number };
          partial?: boolean;
        };
        const entries = Array.isArray(report.entries) ? report.entries : [];
        const imported = entries.flatMap((entry) => (entry.note ? [entry.note] : []));

        // The import response already contains the authoritative notes. Merge
        // just those records into the complete catalog; refetching the entire
        // notes table, graph, and folder tree can freeze large local vaults.
        const importedIds = new Set(imported.map((note) => note.id));
        _notes = sortNotesForPanel([
          ...imported,
          ..._notes.filter((note) => !importedIds.has(note.id)),
        ]);

        const graphNodes = new Map(_graphData.nodes.map((node) => [node.id, node]));
        for (const note of imported) {
          graphNodes.set(note.id, {
            id: note.id,
            title: note.title,
            folderPath: note.folderPath,
            tags: note.tags ?? [],
            linkCount: graphNodes.get(note.id)?.linkCount ?? 0,
            includeInContext: note.includeInContext,
          });
        }
        _graphData = { ..._graphData, nodes: [...graphNodes.values()] };

        const ensureFolderPath = (nodes: FolderNode[], folderPath: string): FolderNode[] => {
          const segments = folderPath.split('/').filter(Boolean);
          let currentPath = '';
          let currentNodes = nodes;
          for (const segment of segments) {
            currentPath += `/${segment}`;
            let node = currentNodes.find((candidate) => candidate.path === currentPath);
            if (!node) {
              node = { path: currentPath, name: segment, noteCount: 0, children: [] };
              currentNodes.push(node);
              currentNodes.sort((a, b) => a.name.localeCompare(b.name));
            }
            currentNodes = node.children;
          }
          return nodes;
        };
        const nextFolderTree = structuredClone(_folderTree);
        for (const note of imported) ensureFolderPath(nextFolderTree, note.folderPath);
        _folderTree = nextFolderTree;

        const created = report.counts?.created ?? 0;
        const updated = report.counts?.updated ?? 0;
        const unchanged = report.counts?.unchanged ?? 0;
        const failed = report.counts?.failed ?? 0;
        const summary = `${created} created, ${updated} updated, ${unchanged} unchanged`;
        if (report.partial || failed > 0) {
          setError(`Memory import was partial: ${summary}, ${failed} failed.`, true, {
            kind: 'import-memory',
          });
        } else {
          clearError();
          toastStore.success(`Memory import complete: ${summary}`);
        }
      } else {
        setError(data.error ?? 'Failed to import memory', true, { kind: 'import-memory' });
      }
    } else {
      setError(await responseMessage(res, 'Failed to import memory'), true, {
        kind: 'import-memory',
      });
    }
  } catch (err) {
    console.error('[notesStore] importMemoryAsNotes error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to import memory', true, {
        kind: 'import-memory',
      });
    }
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
  }
}

/** Re-index real Markdown and HTML files from the open project. */
async function syncProjectDocuments(): Promise<void> {
  if (isDemoMode) {
    toastStore.success('Notes are already loaded in the demo');
    return;
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  try {
    const res = await apiFetch(apiUrl('/api/notes/sync-project'), {
      method: 'POST',
      headers: mutation.headers,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    mutationSucceeded = true;
    if (!requestScopeIsCurrent(requestProject, requestGeneration)) return;
    await Promise.all([fetchNotes(), fetchGraph(), fetchFolderTree()]);
    const result = data.data as { discovered?: number; truncated?: boolean; message?: string };
    if (result.truncated) {
      _indexWarning =
        result.message ??
        `Indexed ${result.discovered ?? 0} project documents. Some files could not be verified, so their existing entries were preserved.`;
      toastStore.warning(_indexWarning);
    } else {
      _indexWarning = null;
      toastStore.success(`Indexed ${result.discovered ?? 0} project documents`);
    }
  } catch (err) {
    console.error('[notesStore] syncProjectDocuments error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to index project documents', true, {
        kind: 'sync-project',
      });
    }
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
  }
}

/** Fetch agent note-tool permissions from backend */
async function fetchAgentPermissions(): Promise<void> {
  try {
    const res = await apiFetch(apiUrl('/api/notes/settings/agent-permissions'));
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        _agentPermissions = normalizeNotesAgentPermissions(data.data as NotesAgentPermissions);
        _agentPermissionsLoaded = true;
      }
    }
  } catch (err) {
    console.error('[notesStore] fetchAgentPermissions error:', err);
  }
}

/** Apply a permission preset and persist */
async function applyAgentPermissionPreset(
  preset: Exclude<NotesPermissionPreset, 'custom'>,
): Promise<void> {
  const next = applyNotesPermissionPreset(preset);
  _agentPermissions = next;
  await saveAgentPermissions(next);
}

/** Update a single tool permission */
async function setAgentToolPermission(
  tool: NoteToolName,
  level: NotePermissionLevel,
): Promise<void> {
  const tools = { ..._agentPermissions.tools, [tool]: level };
  const next: NotesAgentPermissions = {
    preset: detectNotesPermissionPreset(tools),
    tools,
  };
  _agentPermissions = next;
  await saveAgentPermissions(next);
}

/** Persist agent permissions to backend */
async function saveAgentPermissions(permissions: NotesAgentPermissions): Promise<boolean> {
  _agentPermissionsSaving = true;
  try {
    const res = await apiFetch(apiUrl('/api/notes/settings/agent-permissions'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(permissions),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        _agentPermissions = normalizeNotesAgentPermissions(data.data as NotesAgentPermissions);
        return true;
      }
    }
    toastStore.error('Failed to save note permissions');
    return false;
  } catch (err) {
    console.error('[notesStore] saveAgentPermissions error:', err);
    toastStore.error('Failed to save note permissions');
    return false;
  } finally {
    _agentPermissionsSaving = false;
  }
}

/** Reset agent permissions to defaults */
async function resetAgentPermissions(): Promise<void> {
  try {
    const res = await apiFetch(apiUrl('/api/notes/settings/agent-permissions/reset'), {
      method: 'POST',
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        _agentPermissions = normalizeNotesAgentPermissions(data.data as NotesAgentPermissions);
        toastStore.success('Note permissions reset');
      }
    } else {
      toastStore.error('Failed to reset note permissions');
    }
  } catch (err) {
    console.error('[notesStore] resetAgentPermissions error:', err);
    toastStore.error('Failed to reset note permissions');
  }
}

/** Fetch settings from the backend (source of truth for context injection).
 *  Server values win over the localStorage mirror. */
let _settingsFetched = $state(false);
async function fetchSettings(): Promise<void> {
  try {
    const res = await apiFetch(apiUrl('/api/notes/settings'));
    if (!res.ok) return;
    const data = (await res.json()) as { ok?: boolean; data?: Partial<NotesSettings> };
    if (data.ok && data.data) {
      _settings = {
        ..._settings,
        ...data.data,
        graphPhysics: {
          ..._settings.graphPhysics,
          ...(data.data.graphPhysics ?? {}),
        },
      };
      saveSettingsToStorage(_settings);
      _settingsFetched = true;
      clearError();
    }
  } catch (err) {
    console.warn('[notesStore] fetchSettings failed:', err);
    setError('Failed to load Notes settings', false);
  }
}

/** Update settings — persisted to the BACKEND (which honors them when building
 *  agent context) with localStorage as a fast-boot mirror. */
async function updateSettings(patch: Partial<NotesSettings>): Promise<boolean> {
  const previous = _settings;
  const revision = ++_settingsRevision;
  _settings = {
    ..._settings,
    ...patch,
    graphPhysics: {
      ..._settings.graphPhysics,
      ...((patch.graphPhysics as Partial<NotesSettings['graphPhysics']>) ?? {}),
    },
  };
  saveSettingsToStorage(_settings);
  const persist = async (): Promise<boolean> => {
    try {
      const res = await apiFetch(apiUrl('/api/notes/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await responseMessage(res, 'Failed to save Notes settings'));
      const data = (await res.json()) as { ok?: boolean; data?: NotesSettings };
      if (!data.ok || !data.data) throw new Error('Failed to save Notes settings');
      if (revision === _settingsRevision) {
        _settings = { ...data.data };
        saveSettingsToStorage(_settings);
      }
      clearError();
      return true;
    } catch (err) {
      console.warn('[notesStore] failed to persist settings to backend:', err);
      if (revision === _settingsRevision) {
        _settings = previous;
        saveSettingsToStorage(_settings);
      }
      setError(err instanceof Error ? err.message : 'Failed to save Notes settings');
      return false;
    }
  };
  const operation = _settingsSaveQueue.then(persist, persist);
  _settingsSaveQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function importNoteFile(file: File): Promise<Note | null> {
  if (!/\.(md|markdown|html|htm)$/i.test(file.name)) {
    setError('Only Markdown and HTML files can be imported');
    return null;
  }
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await apiFetch(apiUrl('/api/notes/import-file'), {
      method: 'POST',
      headers: mutation.headers,
      body: formData,
    });
    if (!res.ok) throw new Error(await responseMessage(res, 'Failed to import note'));
    const data = (await res.json()) as { ok?: boolean; data?: Note };
    if (!data.ok || !data.data) throw new Error('Failed to import note');
    mutationSucceeded = true;
    if (!requestScopeIsCurrent(requestProject, requestGeneration)) return null;
    mergeCatalogNotes([data.data]);
    if (_isPanelOpen) void fetchFolderTree();
    clearError();
    toastStore.success(`Imported ${file.name}`);
    return data.data;
  } catch (err) {
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to import note');
    }
    return null;
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
  }
}

async function exportNote(id: string): Promise<boolean> {
  if (!hasBrowserEnvironment()) return false;
  try {
    const response = await apiFetch(apiUrl(`/api/notes/${id}/export`));
    if (!response.ok) throw new Error(await responseMessage(response, 'Failed to export note'));
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'note.md';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    clearError();
    return true;
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to export note');
    return false;
  }
}

/** List recoverable notes for the active project. */
async function listTrashedNotes(): Promise<TrashedNote[]> {
  if (isDemoMode) return [];
  try {
    const response = await apiFetch(apiUrl('/api/notes/trash'));
    if (!response.ok) {
      throw new Error(await responseMessage(response, 'Failed to load trash'));
    }
    const body = (await response.json()) as { ok?: boolean; data?: TrashedNote[] };
    if (!body.ok || !Array.isArray(body.data)) throw new Error('Failed to load trash');
    clearError();
    return body.data.map(reviveTrashedNote);
  } catch (error) {
    setError(error instanceof Error ? error.message : 'Failed to load trash');
    return [];
  }
}

/** Restore a soft-deleted note without waiting for its WebSocket reflection. */
async function restoreTrashedNote(note: TrashedNote): Promise<Note | null> {
  if (isDemoMode) return null;
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  try {
    const response = await apiFetch(apiUrl(`/api/notes/${note.id}/restore`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...mutation.headers },
      body: JSON.stringify({ expectedRevision: note.revision }),
    });
    if (!response.ok) {
      throw new Error(await responseMessage(response, 'Failed to restore note'));
    }
    const body = (await response.json()) as { ok?: boolean; data?: Note };
    if (!body.ok || !body.data) throw new Error('Failed to restore note');
    mutationSucceeded = true;
    if (!requestScopeIsCurrent(requestProject, requestGeneration)) return null;
    mergeCatalogNotes([body.data]);
    if (_isPanelOpen) {
      void Promise.all([fetchFolderTree(), fetchGraph()]);
    }
    clearError();
    toastStore.success(`Restored ${body.data.title}`);
    return body.data;
  } catch (error) {
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(error instanceof Error ? error.message : 'Failed to restore note');
    }
    return null;
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
  }
}

async function listNoteRevisions(noteId: string): Promise<NoteRevisionSummary[]> {
  if (isDemoMode) return [];
  try {
    const response = await apiFetch(apiUrl(`/api/notes/${noteId}/revisions`));
    if (!response.ok) {
      throw new Error(await responseMessage(response, 'Failed to load note history'));
    }
    const body = (await response.json()) as { ok?: boolean; data?: NoteRevisionSummary[] };
    if (!body.ok || !Array.isArray(body.data)) throw new Error('Failed to load note history');
    clearError();
    return body.data.map(reviveRevisionSummary);
  } catch (error) {
    setError(error instanceof Error ? error.message : 'Failed to load note history');
    return [];
  }
}

async function getNoteRevision(noteId: string, revision: number): Promise<NoteRevision | null> {
  if (isDemoMode) return null;
  try {
    const response = await apiFetch(apiUrl(`/api/notes/${noteId}/revisions/${revision}`));
    if (!response.ok) {
      throw new Error(await responseMessage(response, 'Failed to load note revision'));
    }
    const body = (await response.json()) as { ok?: boolean; data?: NoteRevision };
    if (!body.ok || !body.data) throw new Error('Failed to load note revision');
    clearError();
    return { ...reviveRevisionSummary(body.data), content: body.data.content };
  } catch (error) {
    setError(error instanceof Error ? error.message : 'Failed to load note revision');
    return null;
  }
}

/** Restore an immutable snapshot as a new monotonic revision. */
async function restoreNoteRevision(
  noteId: string,
  revision: number,
  expectedRevision: number,
): Promise<Note | null> {
  if (isDemoMode) return null;
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  const mutation = beginLocalMutation();
  let mutationSucceeded = false;
  try {
    const response = await apiFetch(apiUrl(`/api/notes/${noteId}/revisions/${revision}/restore`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...mutation.headers },
      body: JSON.stringify({ expectedRevision }),
    });
    if (!response.ok) {
      throw new Error(await responseMessage(response, 'Failed to restore note revision'));
    }
    const body = (await response.json()) as { ok?: boolean; data?: Note };
    if (!body.ok || !body.data) throw new Error('Failed to restore note revision');
    mutationSucceeded = true;
    if (!requestScopeIsCurrent(requestProject, requestGeneration)) return null;
    mergeCatalogNotes([body.data]);
    if (_currentNote?.id === noteId) _currentNote = { ..._currentNote, ...body.data };
    if (_isPanelOpen) void Promise.all([fetchFolderTree(), fetchGraph()]);
    clearError();
    toastStore.success(`Restored revision ${revision}`);
    return body.data;
  } catch (error) {
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(error instanceof Error ? error.message : 'Failed to restore note revision');
    }
    return null;
  } finally {
    finishLocalMutation(mutation.mutationId, mutationSucceeded);
  }
}

/** Download a deterministic, lossless archive for the active project vault. */
async function exportVault(): Promise<boolean> {
  if (!hasBrowserEnvironment() || isDemoMode) return false;
  try {
    const response = await apiFetch(apiUrl('/api/notes/export'));
    if (!response.ok) {
      throw new Error(await responseMessage(response, 'Failed to export vault'));
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'koryphaios-vault.tar';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    clearError();
    toastStore.success('Vault archive ready');
    return true;
  } catch (error) {
    setError(error instanceof Error ? error.message : 'Failed to export vault');
    return false;
  }
}

async function reconcileCurrentNoteAfterCatalogRefresh(): Promise<void> {
  const current = _currentNote;
  if (!current) return;
  const summary = _notes.find((note) => note.id === current.id);
  if (!summary) {
    _conflict = { noteId: current.id, remote: current, sourceDeleted: true };
    return;
  }
  if (summary.revision <= current.revision) return;
  const remote = await fetchCatalogNoteDetail(current.id);
  if (remote && _currentNote?.id === current.id && remote.revision > current.revision) {
    // Preserve the editor's local object. NotesPanel deliberately keeps the
    // same-id draft stable; conflict resolution is the only safe place to
    // replace it when the store cannot observe component-local dirty state.
    _conflict = { noteId: current.id, remote };
  }
}

async function flushRealtimeUpdates(): Promise<void> {
  _realtimeRefreshTimer = null;
  if (!_isPanelOpen || !projectStore.currentPath) {
    _hasDeferredRealtimeRefresh = true;
    _queuedRealtimeUpdates.clear();
    _queuedGlobalRealtimeRefresh = false;
    return;
  }

  const updates = [..._queuedRealtimeUpdates.values()];
  const requiresCatalogRefresh =
    _queuedGlobalRealtimeRefresh || updates.length > NOTES_REALTIME_DETAIL_THRESHOLD;
  _queuedRealtimeUpdates.clear();
  _queuedGlobalRealtimeRefresh = false;

  let needsGraphRefresh = requiresCatalogRefresh || updates.length > 0;
  let needsFolderRefresh = requiresCatalogRefresh;
  let detailFailed = false;

  if (requiresCatalogRefresh) {
    if (await fetchNotes(undefined, undefined, { background: true })) {
      await reconcileCurrentNoteAfterCatalogRefresh();
    }
  } else {
    for (const update of updates) {
      const id = update.noteId;
      if (!id) {
        detailFailed = true;
        continue;
      }
      const existing = _notes.find((note) => note.id === id);
      if (update.action === 'delete') {
        _notes = _notes.filter((note) => note.id !== id);
        needsFolderRefresh = true;
        if (_currentNote?.id === id) {
          _conflict = {
            noteId: id,
            remote: _currentNote,
            sourceDeleted: true,
          };
        }
        continue;
      }

      const currentBeforeRefresh = _currentNote?.id === id ? _currentNote : null;
      const remote = await fetchCatalogNoteDetail(id);
      if (!remote) {
        detailFailed = true;
        continue;
      }
      if (!existing || existing.folderPath !== remote.folderPath) needsFolderRefresh = true;
      if (
        currentBeforeRefresh &&
        _currentNote?.id === id &&
        remote.revision > currentBeforeRefresh.revision
      ) {
        _conflict = { noteId: id, remote };
      } else if (
        currentBeforeRefresh &&
        _currentNote?.id === id &&
        (update.action === 'link' || update.action === 'unlink')
      ) {
        // Link-only events do not edit the draft body. Reconcile relation
        // metadata in place without replacing title/content fields that may
        // currently have unsaved component-local edits.
        _currentNote = {
          ..._currentNote,
          outlinks: remote.outlinks,
          backlinks: remote.backlinks,
          attachments: remote.attachments,
        };
      }
    }
  }

  if (detailFailed) {
    const refreshed = await fetchNotes(undefined, undefined, { background: true });
    if (refreshed) await reconcileCurrentNoteAfterCatalogRefresh();
    needsFolderRefresh = true;
    needsGraphRefresh = true;
  }

  const refreshes: Promise<boolean>[] = [];
  if (needsGraphRefresh) refreshes.push(fetchGraph());
  if (needsFolderRefresh) refreshes.push(fetchFolderTree());
  await Promise.all(refreshes);
}

/** Queue one backend Notes mutation. Remote bursts are coalesced; exact
 * reflections of this renderer's own mutation are consumed without reads. */
function handleRealtimeUpdate(update: NotesRealtimeUpdate): void {
  if (consumeOwnRealtimeUpdate(update)) return;
  if (!_isPanelOpen || !projectStore.currentPath) {
    _hasDeferredRealtimeRefresh = true;
    return;
  }
  if (!update.noteId || !update.action) {
    _queuedGlobalRealtimeRefresh = true;
  } else {
    _queuedRealtimeUpdates.set(update.noteId, update);
  }
  if (_realtimeRefreshTimer) return;
  _realtimeRefreshTimer = setTimeout(() => void flushRealtimeUpdates(), NOTES_REALTIME_BATCH_MS);
}

async function retryFailedOperation(): Promise<void> {
  const operation = _failedOperation;
  if (!operation) return;
  clearError();
  if (operation.kind === 'load-notes') {
    await fetchNotes(operation.folder, operation.query);
  } else if (operation.kind === 'load-note') {
    await fetchNote(operation.id);
  } else if (operation.kind === 'save-note') {
    await updateNote(operation.id, operation.input);
  } else if (operation.kind === 'delete-note') {
    await deleteNote(operation.id, operation.revision);
  } else if (operation.kind === 'load-graph') {
    await fetchGraph();
  } else if (operation.kind === 'load-folders') {
    await fetchFolderTree();
  } else if (operation.kind === 'delete-attachment') {
    await deleteAttachment(operation.noteId, operation.attachmentId);
  } else if (operation.kind === 'import-memory') {
    await importMemoryAsNotes();
  } else if (operation.kind === 'sync-project') {
    await syncProjectDocuments();
  }
}

/** Set the active note to null (deselect) */
function clearCurrentNote(): void {
  _currentNote = null;
}

/** Clear every project-scoped view before loading a different project.
 *
 * Keeping the previous project's list or selected note visible while the next
 * request is in flight can expose stale content and can make a save target the
 * wrong project header. The component preserves any dirty draft separately
 * before calling this transition boundary.
 */
function beginProjectTransition(): void {
  _projectGeneration++;
  if (isDemoMode) _demoSeeded = false;
  _notes = [];
  _currentNote = null;
  _graphData = { nodes: [], edges: [] };
  _folderTree = [];
  _searchResultsTruncated = false;
  _conflict = null;
  _error = null;
  _indexWarning = null;
  _isIndexing = false;
  clearIndexPoll();
  clearRealtimeRefresh();
  _hasDeferredRealtimeRefresh = false;
  _failedOperation = null;
  _isLoading = false;
  _isSaving = false;
}

/** Set the visible search without replacing the complete vault catalog.
 * Full-text hits hydrate their bodies into that catalog, which keeps content
 * search and transclusion useful without downloading every large note. */
async function setSearchQuery(q: string): Promise<void> {
  _searchQuery = q;
  if (!q.trim()) {
    _searchResultsTruncated = false;
    return;
  }
  const results = await searchNotes(q);
  if (_searchQuery !== q) return;
  mergeCatalogNotes(results);
}

/** Folder selection is a local view over the complete catalog. */
async function selectFolder(path: string): Promise<void> {
  _selectedFolder = path;
}

// ============================================================================
// Export
// ============================================================================

export const notesStore = {
  // State getters
  /** Complete vault catalog. Bodies are hydrated on demand, but filtering
   * never removes catalog identities. Kept as `notes` for component API
   * compatibility. */
  get notes() {
    return _notes;
  },
  get catalog() {
    return _notes;
  },
  get visibleNotes() {
    return _visibleNotes;
  },
  get currentNote() {
    return _currentNote;
  },
  get graphData() {
    return _graphData;
  },
  get folderTree() {
    return _folderTree;
  },
  get isLoading() {
    return _isLoading;
  },
  get isSaving() {
    return _isSaving;
  },
  get isPanelOpen() {
    return _isPanelOpen;
  },
  get hasDeferredRealtimeRefresh() {
    return _hasDeferredRealtimeRefresh;
  },
  get searchQuery() {
    return _searchQuery;
  },
  get searchResultsTruncated() {
    return _searchResultsTruncated;
  },
  get searchResultLimit() {
    return _searchResultLimit;
  },
  get selectedFolder() {
    return _selectedFolder;
  },
  get settings() {
    return _settings;
  },
  get agentPermissions() {
    return _agentPermissions;
  },
  get agentPermissionsLoaded() {
    return _agentPermissionsLoaded;
  },
  get agentPermissionsSaving() {
    return _agentPermissionsSaving;
  },
  get allTags() {
    return allTags;
  },
  get error() {
    return _error;
  },
  get indexWarning() {
    return _indexWarning;
  },
  get isIndexing() {
    return _isIndexing;
  },
  get conflict() {
    return _conflict;
  },
  get failedOperation() {
    return _failedOperation;
  },

  // Setters
  set currentNote(note: NoteWithLinks | null) {
    _currentNote = note;
  },
  set isPanelOpen(value: boolean) {
    if (_isPanelOpen === value) return;
    _isPanelOpen = value;
    if (value) {
      void refreshOpenPanel();
    } else {
      if (_queuedGlobalRealtimeRefresh || _queuedRealtimeUpdates.size > 0) {
        _hasDeferredRealtimeRefresh = true;
      }
      clearIndexPoll();
      clearRealtimeRefresh();
    }
  },

  // Functions
  fetchNotes,
  refreshOpenPanel,
  fetchNote,
  readNote,
  openNoteByTitle,
  createNote,
  updateNote,
  deleteNote,
  fetchGraph,
  fetchFolderTree,
  searchNotes,
  uploadAttachment,
  deleteAttachment,
  importMemoryAsNotes,
  syncProjectDocuments,
  importNoteFile,
  exportNote,
  exportVault,
  listTrashedNotes,
  restoreTrashedNote,
  listNoteRevisions,
  getNoteRevision,
  restoreNoteRevision,
  handleRealtimeUpdate,
  retryFailedOperation,
  updateSettings,
  fetchSettings,
  get settingsFetched() {
    return _settingsFetched;
  },
  fetchAgentPermissions,
  applyAgentPermissionPreset,
  setAgentToolPermission,
  resetAgentPermissions,
  clearCurrentNote,
  beginProjectTransition,
  setSearchQuery,
  selectFolder,
  clearError,
  clearConflict() {
    _conflict = null;
  },
};
