<script lang="ts">
  import { ChevronDown, Shield, Terminal, FileCode, Globe, MessageSquare, Brain } from 'lucide-svelte';
  import { slide } from 'svelte/transition';

  interface Rule {
    id: string;
    icon: any;
    title: string;
    shortDesc: string;
    fullDesc: string;
    color: string;
  }

  const rules: Rule[] = [
    {
      id: 'security',
      icon: Shield,
      title: 'Security First',
      shortDesc: 'Sandboxed execution & safe defaults',
      fullDesc: 'All commands run in a sandboxed environment. Dangerous operations like rm -rf /, sudo, and system modifications are blocked by default. Network access is restricted unless explicitly enabled.',
      color: 'var(--color-success)',
    },
    {
      id: 'autonomy',
      icon: Brain,
      title: 'Freedom to Build',
      shortDesc: 'No tedious initialization required',
      fullDesc: 'Koryphaios auto-detects your environment, CLI tools, and preferences. Just start typing - no complex setup, no mandatory configuration files. Everything just works.',
      color: 'var(--color-accent)',
    },
    {
      id: 'terminal',
      icon: Terminal,
      title: 'Terminal Access',
      shortDesc: 'Full shell with background processes',
      fullDesc: 'Run any terminal command with full access to your project directory. Start background processes like dev servers, and manage them easily. All output is streamed live.',
      color: 'var(--color-info)',
    },
    {
      id: 'files',
      icon: FileCode,
      title: 'File Operations',
      shortDesc: 'Read, write, edit with confidence',
      fullDesc: 'Create, modify, and organize files. Multi-file edits are atomic - if something goes wrong, changes can be rolled back. Git integration tracks every modification.',
      color: 'var(--color-warning)',
    },
    {
      id: 'web',
      icon: Globe,
      title: 'Web Search & Fetch',
      shortDesc: 'Access documentation and APIs',
      fullDesc: 'Search the web for documentation, fetch API references, and look up best practices. Perfect for researching libraries, checking syntax, or finding examples.',
      color: 'var(--color-purple)',
    },
    {
      id: 'delegation',
      icon: MessageSquare,
      title: 'Smart Delegation',
      shortDesc: 'Specialist agents for complex tasks',
      fullDesc: 'The manager handles simple tasks directly. For complex work, it delegates to specialist workers (UI, Backend, Test) who focus on their domain. Everything is reviewed before completion.',
      color: 'var(--color-pink)',
    },
  ];

  let expandedId = $state<string | null>(null);

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }
</script>

<div class="rules-container">
  <div class="rules-grid">
    {#each rules as rule}
      <button
        class="rule-bubble"
        class:expanded={expandedId === rule.id}
        style="--bubble-color: {rule.color}"
        onclick={() => toggleExpand(rule.id)}
        aria-expanded={expandedId === rule.id}
      >
        <div class="bubble-header">
          <div class="icon-wrapper" style="background: {rule.color}20; color: {rule.color}">
            <rule.icon size={20} />
          </div>
          <div class="bubble-title">
            <h3>{rule.title}</h3>
            <p class="short-desc">{rule.shortDesc}</p>
          </div>
          <ChevronDown 
            size={18} 
            class="chevron"
            style="transform: rotate({expandedId === rule.id ? '180deg' : '0deg'})"
          />
        </div>
        
        {#if expandedId === rule.id}
          <div class="bubble-content" transition:slide={{ duration: 200 }}>
            <p>{rule.fullDesc}</p>
          </div>
        {/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .rules-container {
    padding: 1rem;
  }

  .rules-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.75rem;
  }

  .rule-bubble {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 1rem;
    cursor: pointer;
    transition: all 0.2s ease;
    text-align: left;
    width: 100%;
    position: relative;
    overflow: hidden;
  }

  .rule-bubble::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: var(--bubble-color);
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .rule-bubble:hover {
    border-color: var(--bubble-color);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    transform: translateY(-2px);
  }

  .rule-bubble:hover::before,
  .rule-bubble.expanded::before {
    opacity: 1;
  }

  .rule-bubble.expanded {
    border-color: var(--bubble-color);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  }

  .bubble-header {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .icon-wrapper {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .bubble-title {
    flex: 1;
    min-width: 0;
  }

  .bubble-title h3 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .short-desc {
    margin: 0.25rem 0 0;
    font-size: 0.8rem;
    color: var(--color-text-muted);
    line-height: 1.4;
  }

  .bubble-content {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--color-border);
  }

  .bubble-content p {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.6;
    color: var(--color-text-secondary);
  }

  /* Single column on very small screens */
  @media (max-width: 640px) {
    .rules-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
