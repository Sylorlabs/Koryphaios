import type { NoteDraft, NoteDraftSummary } from '@koryphaios/shared';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import type {
  DurableDraftScope,
  DurableDraftSnapshot,
  DurableDraftTransport,
} from '$lib/utils/durable-note-draft';

class DraftHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DraftHttpError';
    this.status = status;
  }
}

function projectHeaders(projectPath: string, json = false): Headers {
  const headers = new Headers({ 'X-Koryphaios-Project': projectPath });
  if (json) headers.set('Content-Type', 'application/json');
  return headers;
}

async function responseError(response: Response, fallback: string): Promise<DraftHttpError> {
  try {
    const body = (await response.clone().json()) as { error?: string; message?: string };
    return new DraftHttpError(body.error ?? body.message ?? fallback, response.status);
  } catch {
    return new DraftHttpError(fallback, response.status);
  }
}

export function reviveNoteDraftSummary(draft: NoteDraftSummary): NoteDraftSummary {
  return {
    ...draft,
    createdAt: new Date(draft.createdAt),
    updatedAt: new Date(draft.updatedAt),
  };
}

function reviveDraft(draft: NoteDraft): NoteDraft {
  return {
    ...draft,
    ...reviveNoteDraftSummary(draft),
  };
}

async function requestDraft(
  path: string,
  projectPath: string,
  init: RequestInit,
): Promise<NoteDraft> {
  const response = await apiFetch(apiUrl(path), {
    ...init,
    headers: projectHeaders(projectPath, true),
  });
  if (!response.ok) throw await responseError(response, 'Draft backup failed');
  const body = (await response.json()) as { ok?: boolean; data?: NoteDraft };
  if (!body.ok || !body.data) throw new DraftHttpError('Draft response was incomplete', 502);
  return reviveDraft(body.data);
}

export const durableNoteDraftTransport: DurableDraftTransport = {
  create(scope: DurableDraftScope, snapshot: DurableDraftSnapshot): Promise<NoteDraft> {
    return requestDraft('/api/notes/drafts', scope.projectPath, {
      method: 'POST',
      body: JSON.stringify({
        noteId: scope.noteId,
        baseRevision: scope.baseRevision,
        baseTitle: scope.baseTitle,
        ...snapshot,
      }),
    });
  },

  update(
    scope: DurableDraftScope,
    draftId: string,
    expectedDraftRevision: number,
    snapshot: DurableDraftSnapshot,
  ): Promise<NoteDraft> {
    return requestDraft(`/api/notes/drafts/${encodeURIComponent(draftId)}`, scope.projectPath, {
      method: 'PUT',
      body: JSON.stringify({ expectedDraftRevision, ...snapshot }),
    });
  },

  async discard(
    scope: DurableDraftScope,
    draftId: string,
    expectedDraftRevision: number,
  ): Promise<void> {
    const response = await apiFetch(
      apiUrl(`/api/notes/drafts/${encodeURIComponent(draftId)}/discard`),
      {
        method: 'POST',
        headers: projectHeaders(scope.projectPath, true),
        body: JSON.stringify({ expectedDraftRevision }),
      },
    );
    if (!response.ok) throw await responseError(response, 'Failed to discard draft');
  },
};

export async function listDurableNoteDrafts(projectPath: string): Promise<NoteDraftSummary[]> {
  const response = await apiFetch(apiUrl('/api/notes/drafts'), {
    headers: projectHeaders(projectPath),
  });
  if (!response.ok) throw await responseError(response, 'Failed to load recovery drafts');
  const body = (await response.json()) as { ok?: boolean; data?: NoteDraftSummary[] };
  if (!body.ok || !Array.isArray(body.data)) {
    throw new DraftHttpError('Draft catalog response was incomplete', 502);
  }
  return body.data.map(reviveNoteDraftSummary);
}

export async function getDurableNoteDraft(
  projectPath: string,
  draftId: string,
): Promise<NoteDraft> {
  const response = await apiFetch(apiUrl(`/api/notes/drafts/${encodeURIComponent(draftId)}`), {
    headers: projectHeaders(projectPath),
  });
  if (!response.ok) throw await responseError(response, 'Failed to load recovery draft');
  const body = (await response.json()) as { ok?: boolean; data?: NoteDraft };
  if (!body.ok || !body.data) throw new DraftHttpError('Draft response was incomplete', 502);
  return reviveDraft(body.data);
}

export async function discardDurableNoteDraft(
  projectPath: string,
  draft: Pick<NoteDraftSummary, 'id' | 'draftRevision'>,
): Promise<void> {
  await durableNoteDraftTransport.discard(
    {
      projectPath,
      noteId: '',
      baseRevision: 1,
      baseTitle: '',
    },
    draft.id,
    draft.draftRevision,
  );
}
