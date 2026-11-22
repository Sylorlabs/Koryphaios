import Sparkles from 'lucide-svelte/icons/sparkles';
import User from 'lucide-svelte/icons/user';
import Users from 'lucide-svelte/icons/users';

/** All lucide-svelte icons share this generated component type. */
type IconComponent = typeof Sparkles;

export interface AgentModeMeta {
  label: string;
  title: string;
  icon: IconComponent;
  className: string;
}

/**
 * Presentation metadata for the composer's Agent Mode pill.
 *
 * Extracted from CommandInput so the three modes and their labels live in one
 * tested place instead of a 30-line derived block inside a 4.7k-line component.
 */
export function agentModeMetaFor(mode: string): AgentModeMeta {
  if (mode === 'multi') {
    return {
      label: 'Multi-Agent',
      title: 'Agent Mode: Multi-Agent',
      icon: Users,
      className:
        'bg-[var(--color-info-bg)] text-[var(--color-info)] border border-[var(--color-info)]/30',
    };
  }
  if (mode === 'single') {
    return {
      label: 'Single Agent',
      title: 'Agent Mode: Single Agent',
      icon: User,
      className:
        'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:brightness-110',
    };
  }
  return {
    label: 'Auto',
    title: 'Agent Mode: Auto',
    icon: Sparkles,
    className:
      'bg-[var(--color-success-bg)] text-[var(--color-success)] border border-[var(--color-success)]/25 hover:brightness-110',
  };
}
