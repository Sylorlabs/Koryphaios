<script lang="ts">
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Eye from 'lucide-svelte/icons/eye';
  import Image from 'lucide-svelte/icons/image';
</script>

<div class="mx-auto w-full max-w-4xl space-y-6 p-6">
  <header class="flex items-start gap-3">
    <div class="rounded-xl bg-[var(--color-surface-3)] p-2 text-[var(--color-accent)]">
      <Image size={20} />
    </div>
    <div>
      <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Images</h3>
      <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
        Image viewing is available in chat. Image generation and editing providers are not yet
        implemented as dedicated Koryphaios capabilities.
      </p>
    </div>
  </header>
  <section
    class="flex items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
  >
    <Eye size={18} class="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
    <div>
      <h4 class="font-medium text-[var(--color-text-primary)]">Available: inspect local images</h4>
      <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
        Agents can use the scoped image-viewing tool to inspect supported files from the current
        workspace. Access remains subject to workspace path and size limits.
      </p>
    </div>
  </section>
  <section
    class="flex items-start gap-3 rounded-2xl border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-5"
  >
    <AlertTriangle size={18} class="mt-0.5 shrink-0 text-[var(--color-warning)]" />
    <div>
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="font-medium text-[var(--color-text-primary)]">
          Generation adapters unavailable
        </h4>
        <span
          class="rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 text-[10px] text-[var(--color-warning)]"
          >No credential input</span
        >
      </div>
      <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
        OpenAI Images, Google image models, xAI, Black Forest Labs, fal, Replicate, and Stability AI
        are not exposed here until Koryphaios has real request, response, error, cost, and approval
        handling for each API. Saving a key alone would not make those paths work.
      </p>
    </div>
  </section>
</div>
