<script lang="ts">
  import type { FeedEntryLocal } from '$lib/types';
  import { toolPresentation, type ToolIcon } from '$lib/utils/tool-presentation';
  import type { ToolIntent } from '$lib/utils/note-tool-presentation';
  // Single source of truth for every tool icon's markup and motion. The SVG
  // strings and the stylesheet ship together so the icon lab preview renders
  // exactly what the app renders.
  import { activityGlyphs } from './activity-glyphs';
  import './activity-glyphs.css';

  import Eye from 'lucide-svelte/icons/eye';
  import List from 'lucide-svelte/icons/list';
  import Search from 'lucide-svelte/icons/search';
  import Plus from 'lucide-svelte/icons/plus';
  import Pencil from 'lucide-svelte/icons/pencil';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Link2 from 'lucide-svelte/icons/link-2';
  import Unlink from 'lucide-svelte/icons/unlink';
  import Check from 'lucide-svelte/icons/check';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';

  let { entry, size = 15 } = $props<{ entry: FeedEntryLocal; size?: number }>();

  const badges: Partial<Record<ToolIntent, typeof Plus>> = {
    read: Eye, list: List, search: Search, create: Plus, edit: Pencil,
    delete: Trash2, restore: RotateCcw, link: Link2, unlink: Unlink,
    review: Check, refresh: RefreshCw,
  };
  const tool = $derived(toolPresentation(entry));
  const grouped = $derived(entry.type === 'tool_group');
  const steps: FeedEntryLocal[] = $derived(entry.entries ?? []);
  const failed = $derived(grouped
    ? steps.some((step) => toolPresentation(step).failed)
    : tool.failed);
  const running = $derived(grouped
    ? steps.some((step) => step.type === 'tool_call')
    : entry.type === 'tool_call');
  const icon = $derived(grouped ? 'folder' : tool.icon);
  const glyph = $derived(activityGlyphs[icon].svg);
  const isTerminal = $derived(icon === 'command');
  // Every icon keeps its own hue so the rail reads as a colourful set, not a
  // row of identical greys. (The terminal keeps its original emerald look.)
  const glyphColors: Record<ToolIcon, string> = {
    'file-read': '#60a5fa', 'file-create': '#4ade80', 'file-edit': '#fbbf24',
    'file-delete': '#fb7185', 'file-move': '#a78bfa', 'command': '#34d399',
    'search': '#22d3ee', 'folder': '#f59e0b', 'web': '#38bdf8', 'fetch': '#2dd4bf',
    'checklist': '#86efac', 'note': '#fcd34d', 'base': '#818cf8', 'network': '#c084fc',
    'canvas': '#5eead4', 'properties': '#f472b6', 'history': '#fb923c', 'draft': '#a3e635',
    'attachment': '#94a3b8', 'critic': '#34d399', 'agent': '#e879f9', 'session': '#93c5fd',
    'git': '#f87171', 'context': '#67e8f9', 'tool': '#f97316',
  };
  const glyphColor = $derived(glyphColors[icon]);
  const Badge = $derived(failed ? AlertTriangle : tool.workspace ? badges[tool.intent] : undefined);
</script>

<span
  class="activity-icon"
  class:running={running && !failed}
  class:failed
  class:has-badge={!!Badge}
  style:width={`${size}px`}
  style:height={`${size}px`}
  style:color={failed ? 'var(--color-error)' : glyphColor}
  aria-hidden="true"
  data-tool-icon={icon}
  data-tool-intent={tool.intent}
  data-tool-state={failed ? 'failed' : running ? 'running' : 'completed'}
>
  {#if isTerminal}
    <!-- Original terminal icon, kept as-is: emerald box, blinking cursor, gentle pulse. -->
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size} class="terminal-glyph" class:running={running && !failed} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.5" class="text-emerald-400"/>
      <path d="M7 9l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400"/>
      <line x1="13" y1="15" x2="17" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-emerald-300 cursor-blink"/>
    </svg>
  {:else}
    {@html glyph}
  {/if}
  {#if Badge}<span class="action-badge"><Badge size={8} strokeWidth={2} /></span>{/if}
</span>

<style>
  /* Layout only. Every glyph's shape and motion live in activity-glyphs.css
     (plain global CSS, because the glyph markup is injected as an HTML string
     and Svelte's scoped hashes would never reach it). Each icon's colour is set
     inline on the span via style:color so the glyph strokes pick it up. */
  .activity-icon {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }
  /* Carve a clean gap around the badge so the glyph's bottom-right corner
     reads like its bottom-left. */
  .has-badge > :global(svg:first-child) {
    -webkit-mask-image: radial-gradient(circle at calc(100% - 2px) calc(100% - 3px), transparent 0, transparent 6px, #000 6.5px);
    mask-image: radial-gradient(circle at calc(100% - 2px) calc(100% - 3px), transparent 0, transparent 6px, #000 6.5px);
  }
  .action-badge {
    position: absolute;
    right: -3px;
    bottom: -2px;
    display: grid;
    place-items: center;
    width: 10px;
    height: 10px;
    border-radius: var(--radius-sm);
    background: transparent;
  }
  /* Keep the original terminal icon exactly: emerald box, blinking cursor, and a
     gentle pulse while it runs. Colours come from the Tailwind emerald classes. */
  .terminal-glyph .cursor-blink { opacity: 1; }
  .terminal-glyph.running { animation: terminal-subtle 2s ease-in-out infinite; }
  .terminal-glyph.running .cursor-blink { animation: blink 0.8s step-end infinite; }
  @keyframes terminal-subtle { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.03); } }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .terminal-glyph.running,
    .terminal-glyph.running .cursor-blink { animation: none; }
  }
</style>
