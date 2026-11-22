import type { ProjectIconColor } from '@koryphaios/shared';

/**
 * The exact CSS a ProjectIcon paints per color token. Icon rendering and any
 * UI swatch (settings pickers, previews) must both read from here so a swatch
 * is guaranteed to match the tile it selects.
 */
export const PROJECT_ICON_COLOR_CSS: Record<ProjectIconColor, string> = {
  accent: 'var(--color-accent)',
  blue: 'var(--color-info)',
  green: 'var(--color-success)',
  orange: 'var(--color-warning)',
  pink: 'var(--color-pink, var(--color-accent))',
  purple: 'var(--color-purple, var(--color-accent))',
  teal: 'var(--color-teal, var(--color-info))',
};
