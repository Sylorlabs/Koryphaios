import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { VaultRestorePreview, VaultRestoreResult } from '@koryphaios/shared';
import NotesVaultRestoreDialog from './NotesVaultRestoreDialog.svelte';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('$lib/api.svelte', () => ({ apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([0, 3])(
  'preserves %i relationship counts through the HTTP store, preview total and committed summary',
  async (relationships) => {
    const preview: VaultRestorePreview = {
      format: 'koryphaios-notes-vault',
      archiveVersion: 2,
      projectName: 'Archive',
      archiveSha256: 'a'.repeat(64),
      notes: 2,
      revisions: 0,
      attachments: 0,
      links: 1,
      relationships,
      bases: 0,
      drafts: 0,
      noOpNotes: 0,
      conflicts: [],
      canRestore: true,
      mode: 'safe-merge',
    };
    const result: VaultRestoreResult = {
      ...preview,
      restoredNotes: 2,
      restoredRevisions: 0,
      restoredAttachments: 0,
      restoredLinks: 1,
      restoredRelationships: relationships,
      restoredBases: 0,
      restoredDrafts: 0,
    };
    apiFetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify({
            ok: true,
            data: url.endsWith('/preview') ? preview : result,
          }),
          { status: 200 },
        ),
    );
    const onRestored = vi.fn();
    const view = render(NotesVaultRestoreDialog, {
      open: true,
      projectPath: '/project-a',
      onClose: vi.fn(),
      onRestored,
    });
    await fireEvent.change(view.container.querySelector('input[type=file]')!, {
      target: { files: [new File(['archive bytes'], 'notes.tar')] },
    });
    await screen.findByText(
      `All ${3 + relationships} records passed integrity and no-overwrite checks. Koryphaios will check again immediately before commit.`,
    );
    expect(screen.getByText('Relationships').nextElementSibling).toHaveTextContent(
      String(relationships),
    );
    expect(screen.getByText('Document links').nextElementSibling).toHaveTextContent('1');
    await fireEvent.click(screen.getByRole('button', { name: 'Restore verified archive' }));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
    await screen.findByText('Vault restored');
    expect(screen.getByText(/Added 2 notes/)).toHaveTextContent(
      `1 document links, ${relationships} relationships`,
    );
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(result));
    const [, init] = apiFetch.mock.calls[1];
    expect(init.headers.get('X-Koryphaios-Project')).toBe('/project-a');
    expect(init.body.get('archiveSha256')).toBe(preview.archiveSha256);
  },
);
