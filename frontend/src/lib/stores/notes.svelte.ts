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
let _selectedFolder = $state('/');
let _settings = $state<NotesSettings>(loadSettingsFromStorage());
let _agentPermissions = $state<NotesAgentPermissions>({ ...DEFAULT_NOTES_AGENT_PERMISSIONS });
let _agentPermissionsLoaded = $state(false);
let _agentPermissionsSaving = $state(false);
let _isPanelOpen = $state(false);
let _error = $state<string | null>(null);
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

let allTags = $derived(Array.from(new Set(_notes.flatMap((note) => note.tags ?? []))));

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
async function fetchNotes(folder?: string, query?: string): Promise<boolean> {
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
  _isLoading = true;
  try {
    const params = new URLSearchParams();
    if (folder && folder !== '/') params.set('folder', folder);
    if (query) params.set('search', query);
    const qs = params.toString();
    const res = await apiFetch(apiUrl(`/api/notes${qs ? `?${qs}` : ''}`));
    if (res.ok) {
      const data = await res.json();
      if (
        data.ok &&
        Array.isArray(data.data) &&
        requestScopeIsCurrent(requestProject, requestGeneration) &&
        requestId === _notesRequestId
      ) {
        _notes = sortNotesForPanel(data.data as Note[]);
        const sync = data.meta?.projectSync as
          { state?: string; discovered?: number; error?: string } | undefined;
        if (sync?.state === 'partial') {
          setError(
            `${sync.error ?? 'Project note indexing was partial.'} Indexed ${sync.discovered ?? 0} documents; re-index to retry.`,
            false,
            { kind: 'sync-project' },
          );
          return true;
        }
        clearOperationError('load-notes', 'sync-project');
        return true;
      }
    } else if (
      requestScopeIsCurrent(requestProject, requestGeneration) &&
      requestId === _notesRequestId
    ) {
      setError(await responseMessage(res, 'Failed to load notes'), false, {
        kind: 'load-notes',
        folder,
        query,
      });
    }
  } catch (err) {
    console.error('[notesStore] fetchNotes error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration) && requestId === _notesRequestId) {
      setError(err instanceof Error ? err.message : 'Failed to load notes', false, {
        kind: 'load-notes',
        folder,
        query,
      });
    }
  } finally {
    if (requestScopeIsCurrent(requestProject, requestGeneration) && requestId === _notesRequestId) {
      _isLoading = false;
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
async function refreshOpenPanel(): Promise<void> {
  if (!_isPanelOpen || !projectStore.currentPath) return;
  // The graph is derived from the current note list, so populate notes first.
  // This also avoids racing a freshly selected project against its old graph.
  if (!(await fetchNotes())) return;
  await Promise.all([fetchFolderTree(), fetchGraph()]);
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
  _isLoading = true;
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
    if (requestScopeIsCurrent(requestProject, requestGeneration) && requestId === _noteRequestId) {
      _isLoading = false;
    }
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
  _isSaving = true;
  try {
    const res = await apiFetch(apiUrl('/api/notes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        const note = data.data as Note;
        if (!requestScopeIsCurrent(requestProject, requestGeneration)) return null;
        _notes = sortNotesForPanel([note, ..._notes]);
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
      headers: { 'Content-Type': 'application/json' },
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
        const updated = data.data as Note;
        if (!requestScopeIsCurrent(requestProject, requestGeneration)) return null;
        // Update in-memory list
        _notes = sortNotesForPanel(_notes.map((n) => (n.id === id ? updated : n)));
        // Update current note if it matches
        if (_currentNote && _currentNote.id === id) {
          _currentNote = {
            ..._currentNote,
            ...updated,
          };
        }
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
    if (requestScopeIsCurrent(requestProject, requestGeneration)) _isSaving = false;
  }
}

/** Delete a note by ID */
async function deleteNote(id: string, expectedRevision?: number): Promise<boolean> {
  if (isDemoMode) {
    _notes = _notes.filter((n) => n.id !== id);
    if (_currentNote?.id === id) _currentNote = null;
    toastStore.success('Note deleted');
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
  try {
    const res = await apiFetch(apiUrl(`/api/notes/${id}`), {
      method: 'DELETE',
      headers: { 'x-kory-note-revision': String(revision) },
    });
    if (res.ok) {
      if (requestScopeIsCurrent(requestProject, requestGeneration)) {
        _notes = _notes.filter((n) => n.id !== id);
        if (_currentNote?.id === id) {
          _currentNote = null;
        }
        toastStore.success('Note deleted');
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
        const syncState = data.meta?.projectSync?.state as string | undefined;
        const syncError = data.meta?.projectSync?.error as string | undefined;
        if (syncState === 'failed' || syncState === 'partial') {
          setError(
            syncError ??
              (syncState === 'failed'
                ? 'The project note index failed, so the graph may be incomplete.'
                : 'The project note index is partial, so the graph is incomplete.'),
            false,
            { kind: 'sync-project' },
          );
        } else {
          clearOperationError('load-graph', 'sync-project');
        }
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
        return data.data as Note[];
      }
    }
    return [];
  } catch (err) {
    console.error('[notesStore] searchNotes error:', err);
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
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiFetch(apiUrl(`/api/notes/${noteId}/attachments`), {
      method: 'POST',
      body: formData,
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
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
  }
}

/** Delete an attachment */
async function deleteAttachment(noteId: string, attachmentId: string): Promise<boolean> {
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  try {
    const res = await apiFetch(apiUrl(`/api/notes/${noteId}/attachments/${attachmentId}`), {
      method: 'DELETE',
    });
    if (res.ok) {
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
  }
}

/** Import memory content as a note */
async function importMemoryAsNotes(): Promise<void> {
  const requestProject = projectStore.currentPath;
  const requestGeneration = _projectGeneration;
  try {
    const res = await apiFetch(apiUrl('/api/notes/import-memory'), {
      method: 'POST',
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
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
        // just those records into the visible state; refetching the entire
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
  try {
    const res = await apiFetch(apiUrl('/api/notes/sync-project'), {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (!requestScopeIsCurrent(requestProject, requestGeneration)) return;
    await Promise.all([fetchNotes(), fetchGraph(), fetchFolderTree()]);
    const result = data.data as { discovered?: number; truncated?: boolean };
    if (result.truncated) {
      toastStore.warning(
        `Indexed the first ${result.discovered ?? 0} project documents. The scan was partial, so existing entries were preserved.`,
      );
    } else {
      toastStore.success(`Indexed ${result.discovered ?? 0} project documents`);
    }
  } catch (err) {
    console.error('[notesStore] syncProjectDocuments error:', err);
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to index project documents', true, {
        kind: 'sync-project',
      });
    }
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
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await apiFetch(apiUrl('/api/notes/import-file'), {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error(await responseMessage(res, 'Failed to import note'));
    const data = (await res.json()) as { ok?: boolean; data?: Note };
    if (!data.ok || !data.data) throw new Error('Failed to import note');
    if (!requestScopeIsCurrent(requestProject, requestGeneration)) return null;
    _notes = sortNotesForPanel([data.data, ..._notes.filter((note) => note.id !== data.data!.id)]);
    clearError();
    toastStore.success(`Imported ${file.name}`);
    return data.data;
  } catch (err) {
    if (requestScopeIsCurrent(requestProject, requestGeneration)) {
      setError(err instanceof Error ? err.message : 'Failed to import note');
    }
    return null;
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
  _conflict = null;
  _error = null;
  _failedOperation = null;
  _isLoading = false;
  _isSaving = false;
}

/** Set search query and re-fetch notes */
async function setSearchQuery(q: string): Promise<void> {
  _searchQuery = q;
  await fetchNotes(_selectedFolder !== '/' ? _selectedFolder : undefined, q || undefined);
}

/** Select folder and re-fetch notes for it */
async function selectFolder(path: string): Promise<void> {
  _selectedFolder = path;
  await fetchNotes(path !== '/' ? path : undefined, _searchQuery || undefined);
}

// ============================================================================
// Export
// ============================================================================

export const notesStore = {
  // State getters
  get notes() {
    return _notes;
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
  get searchQuery() {
    return _searchQuery;
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
    _isPanelOpen = value;
    if (value) void refreshOpenPanel();
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
