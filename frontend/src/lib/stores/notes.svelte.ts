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

import type {
  Note,
  NoteWithLinks,
  GraphData,
  FolderNode,
  NoteAttachment,
  NotesSettings,
  NotesAgentPermissions,
  NoteToolName,
  NotePermissionLevel,
  NotesPermissionPreset,
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
import { browser } from '$app/environment';
import { projectStore } from './project.svelte';

// ============================================================================
// Constants
// ============================================================================

const NOTES_SETTINGS_KEY = 'koryphaios-notes-settings';

// ============================================================================
// State
// ============================================================================

let _notes = $state<Note[]>([]);
let _currentNote = $state<NoteWithLinks | null>(null);
let _graphData = $state<GraphData>({ nodes: [], edges: [] });
let _folderTree = $state<FolderNode[]>([]);
let _isLoading = $state(false);
let _isSaving = $state(false);
let _searchQuery = $state('');
let _selectedFolder = $state('/');
let _settings = $state<NotesSettings>(loadSettingsFromStorage());
let _agentPermissions = $state<NotesAgentPermissions>({ ...DEFAULT_NOTES_AGENT_PERMISSIONS });
let _agentPermissionsLoaded = $state(false);
let _agentPermissionsSaving = $state(false);

// ============================================================================
// Helpers
// ============================================================================

function loadSettingsFromStorage(): NotesSettings {
  if (!browser) return { ...DEFAULT_NOTES_SETTINGS };
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
  } catch {
    return { ...DEFAULT_NOTES_SETTINGS };
  }
}

function saveSettingsToStorage(s: NotesSettings): void {
  if (!browser) return;
  try {
    localStorage.setItem(NOTES_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Ignore
  }
}

// ============================================================================
// API Functions
// ============================================================================

/** Fetch all notes, optionally filtered by folder or search query */
async function fetchNotes(folder?: string, query?: string): Promise<void> {
  _isLoading = true;
  try {
    const params = new URLSearchParams();
    if (folder && folder !== '/') params.set('folder', folder);
    if (query) params.set('search', query);
    if (projectStore.currentPath) params.set('projectRoot', projectStore.currentPath);
    const qs = params.toString();
    const res = await apiFetch(apiUrl(`/api/notes${qs ? `?${qs}` : ''}`));
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
        _notes = data.data as Note[];
      }
    } else {
      console.error('[notesStore] fetchNotes failed:', res.status);
    }
  } catch (err) {
    console.error('[notesStore] fetchNotes error:', err);
  } finally {
    _isLoading = false;
  }
}

/** Fetch a single note by ID (includes links and attachments) */
async function fetchNote(id: string): Promise<void> {
  _isLoading = true;
  try {
    const res = await apiFetch(apiUrl(`/api/notes/${id}`));
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        _currentNote = data.data as NoteWithLinks;
      }
    } else {
      toastStore.error('Failed to load note');
    }
  } catch (err) {
    console.error('[notesStore] fetchNote error:', err);
    toastStore.error('Failed to load note');
  } finally {
    _isLoading = false;
  }
}

/** Open a note by title (searches notes list, then fetches by ID) */
async function openNoteByTitle(title: string): Promise<void> {
  const found = _notes.find(
    (n) => n.title.toLowerCase() === title.toLowerCase()
  );
  if (found) {
    await fetchNote(found.id);
    return;
  }
  // Fallback: search then open first match
  const searchRes = await apiFetch(
    apiUrl(`/api/notes?q=${encodeURIComponent(title)}&limit=1`)
  );
  if (searchRes.ok) {
    const data = await searchRes.json();
    if (data.ok && Array.isArray(data.data) && data.data.length > 0) {
      const note = data.data[0] as Note;
      await fetchNote(note.id);
    } else {
      toastStore.error(`Note not found: ${title}`);
    }
  }
}

/** Create a new note */
async function createNote(input: {
  title: string;
  content?: string;
  folderPath?: string;
  tags?: string[];
  pinned?: boolean;
  includeInContext?: boolean;
}): Promise<Note | null> {
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
        _notes = [note, ..._notes];
        return note;
      }
    }
    toastStore.error('Failed to create note');
    return null;
  } catch (err) {
    console.error('[notesStore] createNote error:', err);
    toastStore.error('Failed to create note');
    return null;
  } finally {
    _isSaving = false;
  }
}

/** Update an existing note */
async function updateNote(
  id: string,
  input: {
    title?: string;
    content?: string;
    folderPath?: string;
    tags?: string[];
    pinned?: boolean;
    includeInContext?: boolean;
  }
): Promise<Note | null> {
  _isSaving = true;
  try {
    const res = await apiFetch(apiUrl(`/api/notes/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        const updated = data.data as Note;
        // Update in-memory list
        _notes = _notes.map((n) => (n.id === id ? updated : n));
        // Update current note if it matches
        if (_currentNote && _currentNote.id === id) {
          _currentNote = {
            ..._currentNote,
            ...updated,
          };
        }
        return updated;
      }
    }
    toastStore.error('Failed to save note');
    return null;
  } catch (err) {
    console.error('[notesStore] updateNote error:', err);
    toastStore.error('Failed to save note');
    return null;
  } finally {
    _isSaving = false;
  }
}

/** Delete a note by ID */
async function deleteNote(id: string): Promise<boolean> {
  try {
    const res = await apiFetch(apiUrl(`/api/notes/${id}`), {
      method: 'DELETE',
    });
    if (res.ok) {
      _notes = _notes.filter((n) => n.id !== id);
      if (_currentNote?.id === id) {
        _currentNote = null;
      }
      toastStore.success('Note deleted');
      return true;
    }
    toastStore.error('Failed to delete note');
    return false;
  } catch (err) {
    console.error('[notesStore] deleteNote error:', err);
    toastStore.error('Failed to delete note');
    return false;
  }
}

/** Fetch graph data (nodes + edges) */
async function fetchGraph(): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (projectStore.currentPath) params.set('projectRoot', projectStore.currentPath);
    const res = await apiFetch(apiUrl(`/api/notes/graph?${params.toString()}`));
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        _graphData = data.data as GraphData;
      }
    }
  } catch (err) {
    console.error('[notesStore] fetchGraph error:', err);
  }
}

/** Fetch folder tree */
async function fetchFolderTree(): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (projectStore.currentPath) params.set('projectRoot', projectStore.currentPath);
    const res = await apiFetch(apiUrl(`/api/notes/folders?${params.toString()}`));
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
        _folderTree = data.data as FolderNode[];
      }
    }
  } catch (err) {
    console.error('[notesStore] fetchFolderTree error:', err);
  }
}

/** Search notes by query string */
async function searchNotes(q: string): Promise<Note[]> {
  if (!q.trim()) return [];
  try {
    const res = await apiFetch(
      apiUrl(`/api/notes?q=${encodeURIComponent(q)}`)
    );
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
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
async function uploadAttachment(
  noteId: string,
  file: File
): Promise<NoteAttachment | null> {
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiFetch(
      apiUrl(`/api/notes/${noteId}/attachments`),
      {
        method: 'POST',
        body: formData,
      }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.data) {
        const attachment = data.data as NoteAttachment;
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
    toastStore.error('Failed to upload attachment');
    return null;
  } catch (err) {
    console.error('[notesStore] uploadAttachment error:', err);
    toastStore.error('Failed to upload attachment');
    return null;
  }
}

/** Delete an attachment */
async function deleteAttachment(
  noteId: string,
  attachmentId: string
): Promise<boolean> {
  try {
    const res = await apiFetch(
      apiUrl(`/api/notes/${noteId}/attachments/${attachmentId}`),
      { method: 'DELETE' }
    );
    if (res.ok) {
      if (_currentNote && _currentNote.id === noteId) {
        _currentNote = {
          ..._currentNote,
          attachments: (_currentNote.attachments ?? []).filter(
            (a) => a.id !== attachmentId
          ),
        };
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error('[notesStore] deleteAttachment error:', err);
    return false;
  }
}

/** Import memory content as a note */
async function importMemoryAsNotes(): Promise<void> {
  try {
    const res = await apiFetch(apiUrl('/api/notes/import-memory'), {
      method: 'POST',
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
        toastStore.success('Memory imported as notes');
        await fetchNotes();
        await fetchGraph();
        await fetchFolderTree();
      } else {
        toastStore.error(data.error ?? 'Failed to import memory');
      }
    } else {
      toastStore.error('Failed to import memory');
    }
  } catch (err) {
    console.error('[notesStore] importMemoryAsNotes error:', err);
    toastStore.error('Failed to import memory');
  }
}

/** Re-index real Markdown and HTML files from the open project. */
async function syncProjectDocuments(): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (projectStore.currentPath) params.set('projectRoot', projectStore.currentPath);
    const res = await apiFetch(apiUrl(`/api/notes/sync-project?${params.toString()}`), { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    await Promise.all([fetchNotes(), fetchGraph(), fetchFolderTree()]);
    const result = data.data as { discovered?: number };
    toastStore.success(`Indexed ${result.discovered ?? 0} project documents`);
  } catch (err) {
    console.error('[notesStore] syncProjectDocuments error:', err);
    toastStore.error('Failed to index project documents');
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
    }
  } catch (err) {
    console.warn('[notesStore] fetchSettings failed:', err);
  }
}

/** Update settings — persisted to the BACKEND (which honors them when building
 *  agent context) with localStorage as a fast-boot mirror. */
function updateSettings(patch: Partial<NotesSettings>): void {
  _settings = {
    ..._settings,
    ...patch,
    graphPhysics: {
      ..._settings.graphPhysics,
      ...((patch.graphPhysics as Partial<NotesSettings['graphPhysics']>) ?? {}),
    },
  };
  saveSettingsToStorage(_settings);
  void apiFetch(apiUrl('/api/notes/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { ok?: boolean; data?: NotesSettings };
      if (data.ok && data.data) {
        _settings = { ...data.data };
        saveSettingsToStorage(_settings);
      }
    })
    .catch((err) => {
      console.warn('[notesStore] failed to persist settings to backend:', err);
      toastStore.warning('Notes settings saved locally but not synced to the server');
    });
}

/** Set the active note to null (deselect) */
function clearCurrentNote(): void {
  _currentNote = null;
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

  // Setters
  set currentNote(note: NoteWithLinks | null) {
    _currentNote = note;
  },

  // Functions
  fetchNotes,
  fetchNote,
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
  setSearchQuery,
  selectFolder,
};
