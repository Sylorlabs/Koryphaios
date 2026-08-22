import { apiFetch } from '$lib/api.svelte';
import { projectStore, type WorkspaceNavigationSnapshot } from '$lib/stores/project.svelte';
import { apiUrl } from '$lib/utils/api-url';

type NavigationResult =
  { ok: true; snapshot: WorkspaceNavigationSnapshot } | { ok: false; error: string };

export async function selectProjectNavigation(path: string): Promise<NavigationResult> {
  const response = await apiFetch(apiUrl('/api/workspace/select'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    data?: WorkspaceNavigationSnapshot;
    error?: string;
  };
  if (!response.ok || !body.ok || !body.data) {
    return { ok: false, error: body.error || 'Project folder is unavailable' };
  }
  projectStore.reconcile(body.data);
  return { ok: true, snapshot: body.data };
}
