<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import ArchiveRestore from 'lucide-svelte/icons/archive-restore';
  import CheckCircle2 from 'lucide-svelte/icons/check-circle-2';
  import FileArchive from 'lucide-svelte/icons/file-archive';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import X from 'lucide-svelte/icons/x';
  import type { VaultRestorePreview, VaultRestoreResult } from '@koryphaios/shared';
  import {
    previewNoteVaultRestore,
    restoreNoteVault,
  } from '$lib/stores/note-vault-restore';

  interface Props {
    open: boolean;
    projectPath: string | null;
    onClose: () => void;
    onRestored: (result: VaultRestoreResult) => void | Promise<void>;
  }

  let { open, projectPath, onClose, onRestored }: Props = $props();

  let dialogElement = $state<HTMLDivElement>();
  let fileInput = $state<HTMLInputElement>();
  let selectedFile = $state<File | null>(null);
  let preview = $state<VaultRestorePreview | null>(null);
  let previewProjectPath = $state<string | null>(null);
  let busy = $state<'preview' | 'restore' | null>(null);
  let error = $state<string | null>(null);
  let restored = $state<VaultRestoreResult | null>(null);
  let confirmationArmed = $state(false);
  let previouslyFocused: HTMLElement | null = null;
  let wasOpen = false;

  const totalRecords = $derived(
    preview
      ? preview.notes +
          preview.revisions +
          preview.attachments +
          preview.links +
          preview.bases +
          preview.drafts
      : 0,
  );
  const projectChanged = $derived(
    Boolean(previewProjectPath && previewProjectPath !== projectPath),
  );

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }

  function reset() {
    selectedFile = null;
    preview = null;
    previewProjectPath = null;
    busy = null;
    error = null;
    restored = null;
    confirmationArmed = false;
    if (fileInput) fileInput.value = '';
  }

  function close() {
    if (busy) return;
    reset();
    onClose();
  }

  async function inspect(file: File) {
    selectedFile = file;
    preview = null;
    restored = null;
    confirmationArmed = false;
    error = null;
    if (!projectPath) {
      error = 'Open a project before restoring a vault';
      return;
    }
    const requestProject = projectPath;
    busy = 'preview';
    try {
      const result = await previewNoteVaultRestore(file, requestProject);
      if (projectPath !== requestProject) return;
      preview = result;
      previewProjectPath = requestProject;
    } catch (cause) {
      if (projectPath === requestProject) {
        error = cause instanceof Error ? cause.message : 'Failed to inspect vault archive';
      }
    } finally {
      if (projectPath === requestProject) busy = null;
    }
  }

  function handleFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void inspect(file);
  }

  async function restore() {
    if (!selectedFile || !preview || !preview.canRestore || !projectPath || projectChanged) return;
    if (!confirmationArmed) {
      confirmationArmed = true;
      return;
    }
    const requestProject = projectPath;
    busy = 'restore';
    error = null;
    try {
      const result = await restoreNoteVault(
        selectedFile,
        requestProject,
        preview.archiveSha256,
      );
      if (projectPath !== requestProject) return;
      restored = result;
      confirmationArmed = false;
      await onRestored(result);
    } catch (cause) {
      if (projectPath === requestProject) {
        error = cause instanceof Error ? cause.message : 'Failed to restore vault archive';
        confirmationArmed = false;
      }
    } finally {
      if (projectPath === requestProject) busy = null;
    }
  }

  function focusableElements(): HTMLElement[] {
    if (!dialogElement) return [];
    return Array.from(
      dialogElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('hidden'));
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (confirmationArmed) confirmationArmed = false;
      else close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      dialogElement?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogElement)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    if (open && !wasOpen) {
      previouslyFocused = document.activeElement as HTMLElement | null;
      void tick().then(() => dialogElement?.focus());
    } else if (!open && wasOpen) {
      previouslyFocused?.focus();
      previouslyFocused = null;
    }
    wasOpen = open;
  });

  onDestroy(() => previouslyFocused?.focus());
</script>

{#if open}
  <div
    class="fixed inset-0 z-[90] flex items-center justify-center p-4"
    style="background: color-mix(in srgb, var(--color-surface-0) 82%, transparent);"
    role="presentation"
  >
    <div
      bind:this={dialogElement}
      class="flex max-h-[min(760px,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border shadow-2xl"
      style="border-color: var(--color-border); background: var(--color-surface-1); color: var(--color-text-primary);"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-restore-title"
      aria-describedby="vault-restore-description"
      tabindex="-1"
      onkeydown={handleKeydown}
    >
      <header
        class="flex items-start justify-between gap-4 border-b px-5 py-4"
        style="border-color: var(--color-border);"
      >
        <div class="flex min-w-0 gap-3">
          <div class="mt-0.5 rounded-xl p-2" style="background: var(--color-surface-3); color: var(--color-accent);">
            <ArchiveRestore size={18} />
          </div>
          <div>
            <h2 id="vault-restore-title" class="text-base font-semibold">Restore a Notes vault</h2>
            <p id="vault-restore-description" class="mt-1 text-xs leading-5" style="color: var(--color-text-muted);">
              Inspect first, then safely add the complete archive to the active project. Existing data is never overwritten.
            </p>
          </div>
        </div>
        <button
          type="button"
          class="rounded-lg p-2 hover:bg-[var(--color-surface-3)] disabled:opacity-40"
          aria-label="Close vault restore"
          disabled={Boolean(busy)}
          onclick={close}
        ><X size={16} /></button>
      </header>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <input
          bind:this={fileInput}
          class="sr-only"
          type="file"
          accept=".tar,application/x-tar"
          onchange={handleFile}
        />
        <button
          type="button"
          class="flex w-full items-center justify-between gap-4 rounded-xl border border-dashed px-4 py-4 text-left transition-colors hover:bg-[var(--color-surface-2)] disabled:opacity-50"
          style="border-color: var(--color-border);"
          disabled={Boolean(busy)}
          onclick={() => fileInput?.click()}
        >
          <span class="flex min-w-0 items-center gap-3">
            <FileArchive size={20} style="color: var(--color-text-muted);" />
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium">{selectedFile?.name ?? 'Choose a Koryphaios vault archive'}</span>
              <span class="block text-xs" style="color: var(--color-text-muted);">
                {selectedFile ? formatBytes(selectedFile.size) : 'Deterministic .tar export · up to 1 GiB'}
              </span>
            </span>
          </span>
          <span class="shrink-0 text-xs font-medium" style="color: var(--color-accent);">Choose file</span>
        </button>

        {#if busy === 'preview'}
          <div class="flex items-center gap-2 rounded-xl px-4 py-3 text-sm" style="background: var(--color-surface-2);">
            <LoaderCircle class="animate-spin" size={16} />
            Verifying checksums, paths, references, and collisions…
          </div>
        {/if}

        {#if error}
          <div class="flex gap-2 rounded-xl border px-4 py-3 text-sm" style="border-color: var(--color-error); background: var(--color-error-bg); color: var(--color-error);" role="alert">
            <AlertTriangle class="mt-0.5 shrink-0" size={16} />
            <span>{error}</span>
          </div>
        {/if}

        {#if preview}
          <section class="overflow-hidden rounded-xl border" style="border-color: var(--color-border);">
            <div class="flex items-center justify-between gap-3 border-b px-4 py-3" style="border-color: var(--color-border); background: var(--color-surface-2);">
              <span class="flex items-center gap-2 text-sm font-medium">
                {#if preview.canRestore && !projectChanged}<ShieldCheck size={16} style="color: var(--color-success);" />{:else}<AlertTriangle size={16} style="color: var(--color-warning);" />{/if}
                {preview.canRestore && !projectChanged ? 'Verified and safe to add' : 'Restore is blocked'}
              </span>
              <span class="text-xs" style="color: var(--color-text-muted);">Archive v{preview.archiveVersion}</span>
            </div>
            <dl class="grid grid-cols-2 gap-px bg-[var(--color-border)] sm:grid-cols-3">
              {#each [
                ['Notes', preview.notes],
                ['History', preview.revisions],
                ['Attachments', preview.attachments],
                ['Links', preview.links],
                ['Bases', preview.bases],
                ['Drafts', preview.drafts],
              ] as item}
                <div class="bg-[var(--color-surface-1)] px-4 py-3">
                  <dt class="text-[11px] uppercase tracking-wide" style="color: var(--color-text-muted);">{item[0]}</dt>
                  <dd class="mt-1 text-sm font-semibold">{Number(item[1]).toLocaleString()}</dd>
                </div>
              {/each}
            </dl>
          </section>

          {#if projectChanged}
            <div class="rounded-xl border px-4 py-3 text-sm" style="border-color: var(--color-warning); color: var(--color-warning);" role="alert">
              The active project changed after preview. Inspect the archive again for this project.
            </div>
          {:else if preview.conflicts.length > 0}
            <section class="rounded-xl border p-4" style="border-color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 8%, transparent);">
              <h3 class="text-sm font-semibold">{preview.conflicts.length.toLocaleString()} collision{preview.conflicts.length === 1 ? '' : 's'} must be resolved</h3>
              <ul class="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs" style="color: var(--color-text-secondary);">
                {#each preview.conflicts.slice(0, 100) as conflict}
                  <li>• {conflict.message}</li>
                {/each}
                {#if preview.conflicts.length > 100}<li>• …and {preview.conflicts.length - 100} more</li>{/if}
              </ul>
            </section>
          {:else if preview.canRestore}
            <div class="rounded-xl px-4 py-3 text-xs leading-5" style="background: color-mix(in srgb, var(--color-success) 8%, var(--color-surface-2)); color: var(--color-text-secondary);">
              All {totalRecords.toLocaleString()} records passed integrity and no-overwrite checks. Koryphaios will check again immediately before commit.
            </div>
          {/if}
        {/if}

        {#if restored}
          <div class="flex gap-3 rounded-xl border px-4 py-4" style="border-color: var(--color-success); background: color-mix(in srgb, var(--color-success) 9%, transparent);">
            <CheckCircle2 class="mt-0.5 shrink-0" size={18} style="color: var(--color-success);" />
            <div>
              <p class="text-sm font-semibold">Vault restored</p>
              <p class="mt-1 text-xs" style="color: var(--color-text-muted);">
                Added {restored.restoredNotes.toLocaleString()} notes, {restored.restoredAttachments.toLocaleString()} attachments, {restored.restoredBases.toLocaleString()} Bases, and {restored.restoredDrafts.toLocaleString()} draft branches.
              </p>
            </div>
          </div>
        {/if}
      </div>

      <footer class="flex items-center justify-between gap-3 border-t px-5 py-4" style="border-color: var(--color-border);">
        <p class="hidden text-xs sm:block" style="color: var(--color-text-muted);">
          SHA-256 bound · safe merge · no overwrite
        </p>
        <div class="ml-auto flex items-center gap-2">
          <button type="button" class="rounded-lg px-3 py-2 text-sm hover:bg-[var(--color-surface-3)]" disabled={Boolean(busy)} onclick={close}>
            {restored ? 'Done' : 'Cancel'}
          </button>
          {#if preview?.canRestore && !restored}
            <button
              type="button"
              class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40"
              style="background: {confirmationArmed ? 'var(--color-warning)' : 'var(--color-accent)'}; color: var(--color-on-accent);"
              disabled={Boolean(busy) || projectChanged}
              onclick={() => void restore()}
            >
              {#if busy === 'restore'}<LoaderCircle class="animate-spin" size={15} />{:else}<ArchiveRestore size={15} />{/if}
              {confirmationArmed ? 'Confirm restore' : 'Restore verified archive'}
            </button>
          {/if}
        </div>
      </footer>
    </div>
  </div>
{/if}
