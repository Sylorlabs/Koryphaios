import type {
  NoteBase,
  NoteBaseDefinition,
  NoteBaseQueryResult,
  NotePropertySchema,
} from '@koryphaios/shared';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { projectStore } from './project.svelte';

let _bases = $state.raw<NoteBase[]>([]);
let _trashed = $state.raw<NoteBase[]>([]);
let _schemas = $state.raw<NotePropertySchema[]>([]);
let _active = $state<NoteBase | null>(null);
let _result = $state.raw<NoteBaseQueryResult | null>(null);
let _loading = $state(false);
let _saving = $state(false);
let _error = $state<string | null>(null);
let generation = 0;

export const DEFAULT_NOTE_BASE_DEFINITION: NoteBaseDefinition = {
  version: 1,
  sort: [{ field: { source: 'system', field: 'updated' }, direction: 'desc' }],
  view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
};

function headers(projectPath: string, json = false): Headers {
  const value = new Headers({ 'X-Koryphaios-Project': projectPath });
  if (json) value.set('Content-Type', 'application/json');
  return value;
}

async function message(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

function reviveBase(base: NoteBase): NoteBase {
  return {
    ...base,
    createdAt: new Date(base.createdAt),
    updatedAt: new Date(base.updatedAt),
    ...(base.trashedAt ? { trashedAt: new Date(base.trashedAt) } : {}),
  };
}

function reviveResult(result: NoteBaseQueryResult): NoteBaseQueryResult {
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    })),
  };
}

function scope(): { path: string; generation: number } | null {
  const path = projectStore.currentPath;
  return path ? { path, generation } : null;
}

function scopeStillCurrent(request: { path: string; generation: number }): boolean {
  return request.generation === generation && request.path === projectStore.currentPath;
}

async function refresh(): Promise<void> {
  const request = scope();
  if (!request) {
    clear();
    return;
  }
  _loading = true;
  _error = null;
  try {
    const [basesResponse, schemasResponse] = await Promise.all([
      apiFetch(apiUrl('/api/notes/bases?includeTrashed=true'), {
        headers: headers(request.path),
      }),
      apiFetch(apiUrl('/api/notes/properties/schemas'), { headers: headers(request.path) }),
    ]);
    if (!basesResponse.ok) throw new Error(await message(basesResponse, 'Failed to load Bases'));
    if (!schemasResponse.ok) {
      throw new Error(await message(schemasResponse, 'Failed to load property schemas'));
    }
    const basesBody = (await basesResponse.json()) as { ok?: boolean; data?: NoteBase[] };
    const schemasBody = (await schemasResponse.json()) as {
      ok?: boolean;
      data?: NotePropertySchema[];
    };
    if (!basesBody.ok || !Array.isArray(basesBody.data)) throw new Error('Invalid Bases response');
    if (!schemasBody.ok || !Array.isArray(schemasBody.data)) {
      throw new Error('Invalid property schema response');
    }
    if (!scopeStillCurrent(request)) return;
    const allBases = basesBody.data.map(reviveBase);
    _bases = allBases.filter((base) => !base.trashedAt);
    _trashed = allBases.filter((base) => base.trashedAt);
    _schemas = schemasBody.data.map((schema) => ({
      ...schema,
      createdAt: new Date(schema.createdAt),
      updatedAt: new Date(schema.updatedAt),
    }));
    if (_active) _active = _bases.find((base) => base.id === _active?.id) ?? null;
  } catch (error) {
    if (scopeStillCurrent(request)) {
      _error = error instanceof Error ? error.message : 'Failed to load Bases';
    }
  } finally {
    if (scopeStillCurrent(request)) _loading = false;
  }
}

async function create(name: string, definition = DEFAULT_NOTE_BASE_DEFINITION): Promise<NoteBase | null> {
  const request = scope();
  if (!request) return null;
  _saving = true;
  _error = null;
  try {
    const response = await apiFetch(apiUrl('/api/notes/bases'), {
      method: 'POST',
      headers: headers(request.path, true),
      body: JSON.stringify({ name, definition }),
    });
    if (!response.ok) throw new Error(await message(response, 'Failed to create Base'));
    const body = (await response.json()) as { ok?: boolean; data?: NoteBase };
    if (!body.ok || !body.data) throw new Error('Invalid Base response');
    const base = reviveBase(body.data);
    if (scopeStillCurrent(request)) {
      _bases = [..._bases, base].sort((left, right) => left.name.localeCompare(right.name));
      _active = base;
      await query(base.id);
    }
    return base;
  } catch (error) {
    if (scopeStillCurrent(request)) {
      _error = error instanceof Error ? error.message : 'Failed to create Base';
    }
    return null;
  } finally {
    if (scopeStillCurrent(request)) _saving = false;
  }
}

async function update(
  base: NoteBase,
  input: { name?: string; definition?: NoteBaseDefinition },
): Promise<NoteBase | null> {
  const request = scope();
  if (!request) return null;
  _saving = true;
  _error = null;
  try {
    const response = await apiFetch(apiUrl(`/api/notes/bases/${encodeURIComponent(base.id)}`), {
      method: 'PUT',
      headers: headers(request.path, true),
      body: JSON.stringify({ expectedRevision: base.revision, ...input }),
    });
    if (!response.ok) throw new Error(await message(response, 'Failed to save Base'));
    const body = (await response.json()) as { ok?: boolean; data?: NoteBase };
    if (!body.ok || !body.data) throw new Error('Invalid Base response');
    const saved = reviveBase(body.data);
    if (scopeStillCurrent(request)) {
      _bases = _bases
        .map((candidate) => (candidate.id === saved.id ? saved : candidate))
        .sort((left, right) => left.name.localeCompare(right.name));
      _active = saved;
      await query(saved.id);
    }
    return saved;
  } catch (error) {
    if (scopeStillCurrent(request)) {
      _error = error instanceof Error ? error.message : 'Failed to save Base';
    }
    return null;
  } finally {
    if (scopeStillCurrent(request)) _saving = false;
  }
}

async function trash(base: NoteBase): Promise<boolean> {
  const request = scope();
  if (!request) return false;
  _saving = true;
  try {
    const response = await apiFetch(
      apiUrl(`/api/notes/bases/${encodeURIComponent(base.id)}?expectedRevision=${base.revision}`),
      { method: 'DELETE', headers: headers(request.path) },
    );
    if (!response.ok) throw new Error(await message(response, 'Failed to move Base to Trash'));
    const body = (await response.json()) as { ok?: boolean; data?: NoteBase };
    if (!body.ok || !body.data) throw new Error('Invalid Base Trash response');
    const trashed = reviveBase(body.data);
    if (scopeStillCurrent(request)) {
      _bases = _bases.filter((candidate) => candidate.id !== base.id);
      _trashed = [..._trashed.filter((candidate) => candidate.id !== base.id), trashed].sort(
        (left, right) => left.name.localeCompare(right.name),
      );
      if (_active?.id === base.id) {
        _active = null;
        _result = null;
      }
    }
    return true;
  } catch (error) {
    if (scopeStillCurrent(request)) {
      _error = error instanceof Error ? error.message : 'Failed to move Base to Trash';
    }
    return false;
  } finally {
    if (scopeStillCurrent(request)) _saving = false;
  }
}

async function restore(base: NoteBase): Promise<boolean> {
  const request = scope();
  if (!request) return false;
  _saving = true;
  _error = null;
  try {
    const response = await apiFetch(
      apiUrl(`/api/notes/bases/${encodeURIComponent(base.id)}/restore`),
      {
        method: 'POST',
        headers: headers(request.path, true),
        body: JSON.stringify({ expectedRevision: base.revision }),
      },
    );
    if (!response.ok) throw new Error(await message(response, 'Failed to restore Base'));
    const body = (await response.json()) as { ok?: boolean; data?: NoteBase };
    if (!body.ok || !body.data) throw new Error('Invalid Base restore response');
    const restored = reviveBase(body.data);
    if (scopeStillCurrent(request)) {
      _trashed = _trashed.filter((candidate) => candidate.id !== restored.id);
      _bases = [..._bases.filter((candidate) => candidate.id !== restored.id), restored].sort(
        (left, right) => left.name.localeCompare(right.name),
      );
      _active = restored;
      await query(restored.id);
    }
    return true;
  } catch (error) {
    if (scopeStillCurrent(request)) {
      _error = error instanceof Error ? error.message : 'Failed to restore Base';
    }
    return false;
  } finally {
    if (scopeStillCurrent(request)) _saving = false;
  }
}

async function query(baseId: string, offset = 0): Promise<NoteBaseQueryResult | null> {
  const request = scope();
  if (!request) return null;
  _loading = true;
  _error = null;
  try {
    const response = await apiFetch(
      apiUrl(`/api/notes/bases/${encodeURIComponent(baseId)}/query`),
      {
        method: 'POST',
        headers: headers(request.path, true),
        body: JSON.stringify({ limit: 100, offset }),
      },
    );
    if (!response.ok) throw new Error(await message(response, 'Failed to query Base'));
    const body = (await response.json()) as { ok?: boolean; data?: NoteBaseQueryResult };
    if (!body.ok || !body.data) throw new Error('Invalid Base query response');
    const result = reviveResult(body.data);
    if (scopeStillCurrent(request) && _active?.id === baseId) _result = result;
    return result;
  } catch (error) {
    if (scopeStillCurrent(request)) {
      _error = error instanceof Error ? error.message : 'Failed to query Base';
    }
    return null;
  } finally {
    if (scopeStillCurrent(request)) _loading = false;
  }
}

async function select(base: NoteBase | null): Promise<void> {
  _active = base;
  _result = null;
  if (base) await query(base.id);
}

function beginProjectTransition(): void {
  generation++;
  clear();
}

function clear(): void {
  _bases = [];
  _trashed = [];
  _schemas = [];
  _active = null;
  _result = null;
  _loading = false;
  _saving = false;
  _error = null;
}

export const noteBasesStore = {
  get bases() {
    return _bases;
  },
  get trashed() {
    return _trashed;
  },
  get schemas() {
    return _schemas;
  },
  get active() {
    return _active;
  },
  get result() {
    return _result;
  },
  get loading() {
    return _loading;
  },
  get saving() {
    return _saving;
  },
  get error() {
    return _error;
  },
  refresh,
  create,
  update,
  trash,
  restore,
  query,
  select,
  beginProjectTransition,
  clearError() {
    _error = null;
  },
};
