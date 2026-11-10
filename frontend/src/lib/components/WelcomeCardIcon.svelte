<script lang="ts">
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import Zap from 'lucide-svelte/icons/zap';
  import Paintbrush from 'lucide-svelte/icons/paintbrush';
  import GitBranch from 'lucide-svelte/icons/git-branch';
  import Bug from 'lucide-svelte/icons/bug';
  import Bot from 'lucide-svelte/icons/bot';
  import Terminal from 'lucide-svelte/icons/terminal';
  import Layers from 'lucide-svelte/icons/layers';
  import { isWelcomeIconSource, type WelcomeSuggestionCard } from '@koryphaios/shared';

  let { icon, source, size = 18 }: {
    icon: WelcomeSuggestionCard['icon']; source?: string; size?: number;
  } = $props();
  const icons = { sparkles: Sparkles, zap: Zap, paintbrush: Paintbrush, 'git-branch': GitBranch, bug: Bug, bot: Bot, terminal: Terminal, layers: Layers };
  const Icon = $derived(icons[icon] ?? Sparkles);
</script>

{#if isWelcomeIconSource(source)}
  <img src={source} alt="" width={size} height={size} style={`width: ${size}px; height: ${size}px;`} class="rounded-sm object-contain" />
{:else}
  <Icon {size} />
{/if}
