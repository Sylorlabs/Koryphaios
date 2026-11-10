<script lang="ts" generics="T extends HierarchySkill">
  import { buildSkillHierarchy, type HierarchySkill } from './skill-hierarchy';

  let { skills, selected, onselect }: {
    skills: readonly T[];
    selected: T;
    onselect: (skill: T) => void;
  } = $props();

  const groups = $derived(buildSkillHierarchy(skills, selected));
</script>

<section aria-label="Skill hierarchy" class="hierarchy">
  <h3>Skill hierarchy</h3>
  <p>Open a related revision to inspect its guidance. Navigation does not activate a draft or resolve a scope conflict.</p>
  {#each groups as group (group.label)}
    {#if group.items.length}
      <nav aria-label={group.label}>
        <h4>{group.label}</h4>
        <p>{group.note}</p>
        <div class="relations">
          {#each group.items as item (item.name)}
            {#if item.selfReference}
              <span class="unavailable">{item.name}: invalid self reference</span>
            {:else if !item.targets.length}
              <span class="unavailable">{item.name}: missing</span>
            {:else}
              {#each item.targets as target (`${target.source}:${target.state}:${target.hash}`)}
                <button
                  type="button"
                  aria-label={`Open ${target.name} (${target.source}, ${target.state})`}
                  onclick={() => onselect(target)}
                >
                  <strong>{target.name}</strong>
                  <small>{target.source} · {target.state}{!target.validation.valid ? ' · invalid' : ''}</small>
                </button>
              {/each}
              {#if !item.available}<span class="unavailable">{item.name}: no valid active revision</span>{/if}
            {/if}
          {/each}
        </div>
      </nav>
    {/if}
  {/each}
  {#if !groups[0]?.items.length}<p>This revision has no broader parent. Required skills and related disciplines remain separate relationships.</p>{/if}
</section>

<style>
  .hierarchy { border-top: 1px solid color-mix(in srgb, var(--color-text-muted) 14%, transparent); border-radius: 0; padding: 18px 0; background: transparent; }
  h3, h4 { margin: 0; color: var(--color-text-primary); }
  h3 { font-size: 15px; }
  h4 { font-size: 13px; }
  p { margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: var(--color-text-muted); }
  nav { margin-top: 16px; }
  .relations { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  button { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 3px; min-height: 44px; max-width: 100%; padding: 7px 10px; border: 0; border-radius: 8px; background: var(--color-surface-2); color: var(--color-text-primary); text-align: left; cursor: pointer; overflow-wrap: anywhere; }
  button:hover { background: var(--color-surface-3); }
  button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
  strong { font-size: 13px; font-weight: 500; }
  small, .unavailable { font-size: 12px; color: var(--color-text-muted); }
  .unavailable { align-self: center; overflow-wrap: anywhere; }
</style>
