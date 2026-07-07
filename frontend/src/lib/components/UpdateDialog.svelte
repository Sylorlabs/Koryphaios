<script lang="ts">
  import { updater } from "$lib/stores/updater.svelte";
  import { Download, ExternalLink, Loader2 } from "lucide-svelte";

  let installing = $state(false);

  async function handleInstall() {
    installing = true;
    await updater.installUpdateAndRestart();
  }

  function handleDismiss() {
    updater.closeDialog();
    updater.dismissUpdate();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') handleDismiss();
  }

  // Render the cleaned notes as sections: `### Heading` → heading,
  // `- bullet` → bullet, everything else → paragraph.
  interface NoteBlock {
    kind: 'heading' | 'bullet' | 'text';
    text: string;
  }
  let noteBlocks = $derived.by<NoteBlock[]>(() => {
    const notes = updater.getCleanNotes();
    if (!notes) return [];
    return notes.split('\n').map((line) => {
      const t = line.trim();
      if (/^#{1,6}\s/.test(t)) return { kind: 'heading', text: t.replace(/^#{1,6}\s*/, '') };
      if (/^[-*]\s/.test(t)) return { kind: 'bullet', text: t.replace(/^[-*]\s*/, '') };
      return { kind: 'text', text: t };
    });
  });

  // Guard against missing/invalid pubDate ("Invalid Date").
  let releasedText = $derived.by(() => {
    const p = updater.updateInfo?.pubDate;
    if (!p) return '';
    const d = new Date(p);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  });

  // Strip **bold** / `code` markdown to plain text for the simple renderer.
  function inline(s: string): string {
    return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1');
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if updater.dialogOpen && updater.updateAvailable && updater.updateInfo}
  <div
    class="dialog-overlay"
    onmousedown={(e) => e.target === e.currentTarget && handleDismiss()}
    role="presentation"
  >
    <div
      class="update-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-dialog-title"
      tabindex="-1"
    >
      <div class="update-header">
        <Download size={22} class="text-[var(--color-accent)] shrink-0" />
        <div class="min-w-0">
          <h2 class="update-title" id="update-dialog-title">
            Update available
          </h2>
          <p class="update-subtitle">
            Koryphaios v{updater.updateInfo.version}{releasedText ? ` · ${releasedText}` : ''}
          </p>
        </div>
      </div>

      <div class="update-body">
        {#if noteBlocks.length > 0}
          <div class="notes">
            {#each noteBlocks as block}
              {#if block.kind === 'heading'}
                <h3 class="note-heading">{inline(block.text)}</h3>
              {:else if block.kind === 'bullet'}
                <div class="note-bullet">
                  <span class="note-dot">•</span>
                  <span>{inline(block.text)}</span>
                </div>
              {:else}
                <p class="note-text">{inline(block.text)}</p>
              {/if}
            {/each}
          </div>
        {:else}
          <p class="note-text">A new version of Koryphaios is ready to install.</p>
        {/if}
      </div>

      <div class="update-footer">
        <button
          onclick={updater.openChangelog}
          class="btn btn-secondary flex items-center gap-1.5"
        >
          <ExternalLink size={14} />
          Full changelog
        </button>
        <div class="grow"></div>
        <button onclick={handleDismiss} disabled={installing} class="btn btn-secondary">
          Later
        </button>
        <button onclick={handleInstall} disabled={installing} class="btn btn-primary flex items-center gap-1.5">
          {#if installing}
            <Loader2 size={14} class="animate-spin" />
            Installing…
          {:else}
            <Download size={14} />
            Install & Restart
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(6px);
  }

  .update-dialog {
    width: 100%;
    max-width: 560px;
    max-height: 82vh;
    display: flex;
    flex-direction: column;
    border-radius: 18px;
    border: 1px solid var(--color-border);
    background: var(--color-surface-1);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }

  .update-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px 24px;
    border-bottom: 1px solid var(--color-border);
  }

  .update-title {
    font-size: 1.15rem;
    font-weight: 650;
    color: var(--color-text-primary);
    line-height: 1.2;
  }

  .update-subtitle {
    font-size: 0.8rem;
    color: var(--color-text-muted);
    margin-top: 2px;
  }

  .update-body {
    padding: 8px 24px 4px;
    overflow-y: auto;
    flex: 1;
  }

  .notes {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 0;
  }

  .note-heading {
    font-size: 0.95rem;
    font-weight: 650;
    color: var(--color-text-primary);
    margin-top: 14px;
    margin-bottom: 4px;
  }
  .note-heading:first-child {
    margin-top: 0;
  }

  .note-bullet {
    display: flex;
    gap: 8px;
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--color-text-secondary);
    padding-left: 4px;
  }
  .note-dot {
    color: var(--color-accent);
    flex-shrink: 0;
  }

  .note-text {
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--color-text-secondary);
  }

  .update-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 24px;
    border-top: 1px solid var(--color-border);
  }
  .grow {
    flex: 1;
  }
</style>
