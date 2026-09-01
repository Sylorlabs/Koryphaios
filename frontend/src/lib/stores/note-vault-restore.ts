import type { VaultRestorePreview, VaultRestoreResult } from '@koryphaios/shared';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';

const MAX_VAULT_ARCHIVE_BYTES = 1024 * 1024 * 1024;

function projectHeaders(projectPath: string): Headers {
  return new Headers({ 'X-Koryphaios-Project': projectPath });
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as {
      error?: string;
      message?: string;
      details?: { message?: string };
    };
    return body.error ?? body.message ?? body.details?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function validateArchive(file: File): void {
  if (file.size === 0) throw new Error('The selected vault archive is empty');
  if (file.size > MAX_VAULT_ARCHIVE_BYTES) {
    throw new Error('Vault archives larger than 1 GiB cannot be restored in one operation');
  }
}

async function submit<T>(
  path: '/api/notes/import-vault/preview' | '/api/notes/import-vault/restore',
  file: File,
  projectPath: string,
  archiveSha256?: string,
): Promise<T> {
  validateArchive(file);
  const form = new FormData();
  form.append('file', file, file.name);
  if (archiveSha256) form.append('archiveSha256', archiveSha256);
  const response = await apiFetch(apiUrl(path), {
    method: 'POST',
    headers: projectHeaders(projectPath),
    body: form,
  });
  if (!response.ok) {
    throw new Error(
      await responseMessage(
        response,
        path.endsWith('/preview')
          ? 'Koryphaios could not inspect this vault archive'
          : 'Koryphaios could not restore this vault archive',
      ),
    );
  }
  const body = (await response.json()) as { ok?: boolean; data?: T };
  if (!body.ok || !body.data) throw new Error('The vault restore response was incomplete');
  return body.data;
}

export function previewNoteVaultRestore(
  file: File,
  projectPath: string,
): Promise<VaultRestorePreview> {
  return submit('/api/notes/import-vault/preview', file, projectPath);
}

export function restoreNoteVault(
  file: File,
  projectPath: string,
  archiveSha256: string,
): Promise<VaultRestoreResult> {
  return submit('/api/notes/import-vault/restore', file, projectPath, archiveSha256);
}
