/**
 * Tool activity glyphs.
 *
 * Every tool icon is a self-contained SVG string plus a plain-CSS animation
 * (see activity-glyphs.css). Keeping the markup here instead of inside a
 * Svelte template means the icon lab preview renders exactly the same bytes
 * the app renders, so what you see in the lab is what ships.
 *
 * Rules for new glyphs:
 *  - Every icon sits on a 24x24 grid with consistent 3px optical padding
 *    (live area 3..21, 1.5px stroke, round caps and joins).
 *  - The whole icon never rotates, pulses or fades as a unit. Motion belongs
 *    to the thing the icon depicts (a page turning, a pencil writing, a commit
 *    travelling along a branch), not to the icon as a decoration.
 *  - `pathLength="100"` + `stroke-dasharray: 100 100` is the draw-in primitive.
 *  - `style="--agi-d: ..."` staggers copies of one animation.
 *  - The idle (non-running) state must already be a complete, legible icon:
 *    animation-disabled and completed entries both fall back to it.
 */
import type { ToolIcon } from '../utils/tool-presentation';

export interface ActivityGlyph {
  /** Short name shown in the icon lab. */
  label: string;
  /** What actually moves, shown in the icon lab. */
  motion: string;
  svg: string;
}

const glyph = (body: string): string =>
  `<svg class="agi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const activityGlyphs: Record<ToolIcon, ActivityGlyph> = {
  'file-read': {
    label: 'Read file',
    motion: 'Pupil glides smoothly across a line of text while the line scans in',
    svg: glyph(`
      <path d="M2.5 11.2s3.8-5.4 9.5-5.4 9.5 5.4 9.5 5.4-3.8 5.4-9.5 5.4-9.5-5.4-9.5-5.4z"/>
      <g class="agi-pupil"><circle cx="12" cy="11.2" r="2.4"/></g>
      <path class="agi-read-line agi-dim" pathLength="100" d="M5.5 20h13"/>
    `),
  },

  'file-create': {
    label: 'Create file',
    motion: 'Blank page draws itself, corner folds down, plus settles into place',
    svg: glyph(`
      <path class="agi-create-page" pathLength="100" d="M13.5 3H6.5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5z"/>
      <path class="agi-create-fold" d="M13.5 3v5.5H19"/>
      <path class="agi-create-plus" d="M12 11.2v5.6M9.2 14h5.6"/>
    `),
  },

  'file-edit': {
    label: 'Edit file',
    motion: 'Pencil rapidly scribes across the baseline while a clean stroke follows it',
    svg: glyph(`
      <g class="agi-pencil">
        <path d="M16.8 3.6a1.8 1.8 0 0 1 2.5 2.5L9.5 15.9 5.5 17l1.1-4z"/>
        <path class="agi-dim" d="M14.8 5.6l2.5 2.5"/>
      </g>
      <path class="agi-ink" pathLength="100" d="M4.5 20.2h15"/>
    `),
  },

  'file-delete': {
    label: 'Delete file',
    motion: 'Lid lifts smoothly, a scrap drops into the bin, lid settles back',
    svg: glyph(`
      <g class="agi-lid">
        <path d="M4 6.5h16"/>
        <path d="M9.2 6.5V4.6a1.4 1.4 0 0 1 1.4-1.4h2.8a1.4 1.4 0 0 1 1.4 1.4v1.9"/>
      </g>
      <path d="M6.2 6.5l.8 12.2a1.8 1.8 0 0 0 1.8 1.7h6.4a1.8 1.8 0 0 0 1.8-1.7l.8-12.2"/>
      <path class="agi-dim" d="M10 10.5v6M14 10.5v6"/>
      <path class="agi-scrap" d="M10.6 2h2.8v2.4h-2.8z"/>
    `),
  },

  'file-move': {
    label: 'Move / rename',
    motion: 'Both arrows glide slightly in their pointed direction, pause, and loop',
    svg: glyph(`
      <g class="agi-move-right">
        <path d="M4 8.5h14"/>
        <path d="M14.5 5L18 8.5 14.5 12"/>
      </g>
      <g class="agi-move-left">
        <path d="M20 15.5H6"/>
        <path d="M9.5 12L6 15.5 9.5 19"/>
      </g>
    `),
  },

  command: {
    label: 'Terminal',
    motion: 'A command types itself in, the caret follows the text, then the line clears',
    svg: glyph(`
      <rect x="3" y="4" width="18" height="16" rx="2.2"/>
      <path class="agi-dim" d="M3 8.5h18"/>
      <circle cx="5.8" cy="6.25" r=".55" fill="currentColor" stroke="none" class="agi-dim"/>
      <circle cx="8" cy="6.25" r=".55" fill="currentColor" stroke="none" class="agi-dim"/>
      <path class="agi-dim" d="M6.2 11.8l2.4 2.4-2.4 2.4"/>
      <path class="agi-cmd-line" pathLength="100" d="M10.5 16.2h6.8"/>
      <path class="agi-cmd-caret" d="M10.5 14.6v3"/>
    `),
  },

  search: {
    label: 'Search',
    motion: 'Lens sweeps smoothly over the page and ticks when it finds a match',
    svg: glyph(`
      <g class="agi-mag">
        <circle cx="10.5" cy="10.5" r="5.8"/>
        <path d="M14.7 14.7L20 20"/>
        <path class="agi-found" pathLength="100" d="M8 10.6l1.7 1.7 3.2-3.4"/>
      </g>
    `),
  },

  folder: {
    label: 'Folder / tool group',
    motion: 'Cohesive folder opens from the top along its bottom hinge and closes smoothly',
    svg: glyph(`
      <path d="M3 7a2 2 0 0 1 2-2h3.8a1.5 1.5 0 0 1 1.1.5l1.6 1.7H19a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <path class="agi-folder-front" d="M3 10.8h18l-.8 7.4a2 2 0 0 1-2 1.8H5.8a2 2 0 0 1-2-1.8z"/>
    `),
  },

  web: {
    label: 'Web / browse',
    motion: 'Clean meridian arcs rotate smoothly across the globe',
    svg: glyph(`
      <circle cx="12" cy="12" r="8.5"/>
      <path class="agi-dim" d="M3.6 12h16.8"/>
      <path class="agi-dim" d="M5.2 7.8c1.9 1 4.2 1.5 6.8 1.5s4.9-.5 6.8-1.5"/>
      <path class="agi-dim" d="M5.2 16.2c1.9-1 4.2-1.5 6.8-1.5s4.9.5 6.8 1.5"/>
      <ellipse class="agi-meridian" style="--agi-d:0s" cx="12" cy="12" rx="4.2" ry="8.5"/>
      <ellipse class="agi-meridian" style="--agi-d:-1.6s" cx="12" cy="12" rx="4.2" ry="8.5"/>
    `),
  },

  fetch: {
    label: 'Fetch page',
    motion: 'Arrow leads a growing stream downward as the tray progress line fills',
    svg: glyph(`
      <path d="M4 15.5v2.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5"/>
      <path class="agi-fetch-stream" pathLength="100" d="M12 3.5v10.5"/>
      <g class="agi-incoming">
        <path d="M8.8 10.8L12 14l3.2-3.2"/>
      </g>
      <path class="agi-fetch-fill" pathLength="100" d="M7.2 17.5h9.6"/>
    `),
  },

  checklist: {
    label: 'Checklist',
    motion: 'Three checks are ticked off top to bottom, then the list starts over',
    svg: glyph(`
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.2"/>
      <path class="agi-check" style="--agi-d:0s" pathLength="100" d="M6.5 8.2l1.4 1.4 2.3-2.4"/>
      <path class="agi-check" style="--agi-d:0.25s" pathLength="100" d="M6.5 12.6l1.4 1.4 2.3-2.4"/>
      <path class="agi-check" style="--agi-d:0.5s" pathLength="100" d="M6.5 17l1.4 1.4 2.3-2.4"/>
      <path class="agi-dim" d="M12.2 8h5.3M12.2 12.4h5.3M12.2 16.8h4"/>
    `),
  },

  note: {
    label: 'Notes',
    motion: 'Lines are written on the page, the page turns smoothly, and new lines are written',
    svg: glyph(`
      <rect x="4" y="3.5" width="16" height="17" rx="2"/>
      <path class="agi-dim" d="M8 3.5v17M5.5 8h1.4M5.5 12h1.4M5.5 16h1.4"/>
      <path class="agi-note-line" style="--agi-d:0s" pathLength="100" d="M10.4 8.2h6"/>
      <path class="agi-note-line" style="--agi-d:0.18s" pathLength="100" d="M10.4 12h6"/>
      <path class="agi-note-line" style="--agi-d:0.36s" pathLength="100" d="M10.4 15.8h4.2"/>
      <path class="agi-note-page" d="M8.8 4.8h10v14.4h-10"/>
    `),
  },

  base: {
    label: 'Bases / table',
    motion: 'A cell highlight glides smoothly across the grid',
    svg: glyph(`
      <rect x="3.5" y="4.2" width="17" height="15.6" rx="2"/>
      <path class="agi-dim" d="M3.5 9.4h17M3.5 14.6h17M11.2 9.4v10.4"/>
      <rect class="agi-cell-cursor" x="4.3" y="5" width="6.2" height="3.6" rx=".7" fill="currentColor" stroke="none"/>
    `),
  },

  network: {
    label: 'Note network',
    motion: 'A packet travels smoothly from the hub out to each connected node',
    svg: glyph(`
      <path class="agi-dim" d="M12 7.2v3.2M12 10.4 6.5 16.2M12 10.4l5.5 5.8"/>
      <circle cx="12" cy="5" r="2.2"/>
      <circle cx="5.2" cy="18" r="2.2"/>
      <circle cx="18.8" cy="18" r="2.2"/>
      <circle class="agi-net-packet" cx="12" cy="10.4" r="1.35" fill="currentColor" stroke="none"/>
    `),
  },

  canvas: {
    label: 'Canvas',
    motion: 'A split-pane divider glides smoothly back and forth',
    svg: glyph(`
      <rect x="3.5" y="4.2" width="17" height="15.6" rx="2"/>
      <path class="agi-dim" d="M3.5 8.6h17"/>
      <g class="agi-split">
        <path d="M9.6 8.6v11.2"/>
        <path class="agi-dim" d="M8.4 13.2h2.4"/>
      </g>
      <path class="agi-dim" d="M13 11.8h4.8M13 15.4h3.2"/>
    `),
  },

  properties: {
    label: 'Properties',
    motion: 'Three slider knobs glide smoothly along their tracks',
    svg: glyph(`
      <path class="agi-dim" d="M3.5 7.2h17M3.5 12h17M3.5 16.8h17"/>
      <path class="agi-k1" d="M8.2 5.5v3.4"/>
      <path class="agi-k2" d="M15 10.3v3.4"/>
      <path class="agi-k3" d="M9.8 15.1v3.4"/>
    `),
  },

  history: {
    label: 'History',
    motion: 'The clock hand sweeps smoothly backwards through earlier revisions',
    svg: glyph(`
      <path class="agi-dim" d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8"/>
      <path d="M3.8 4.8v3.8h3.8"/>
      <path class="agi-clock-hand" d="M12 7.8V12l2.8 1.8"/>
    `),
  },

  draft: {
    label: 'Draft',
    motion: 'A line of text is composed with a caret, then cleared for the next take',
    svg: glyph(`
      <path d="M13.5 3H6.5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5z"/>
      <path class="agi-dim" d="M13.5 3v5.5H19M8 11.2h5.2M8 14h8"/>
      <path class="agi-draft-line" pathLength="100" d="M8 16.8h6"/>
      <path class="agi-draft-caret" d="M8 15.6v2.4"/>
    `),
  },

  attachment: {
    label: 'Attachment',
    motion: 'A photo card with sun and mountains slides into a classic paperclip',
    svg: glyph(`
      <g class="agi-attach-photo">
        <rect x="9.5" y="7.5" width="11" height="11.5" rx="2"/>
        <circle class="agi-dim" cx="13" cy="11" r="1.1"/>
        <path class="agi-dim" d="M10.2 17.2l3.1-3.2 2.2 2.1 2.2-2.4 2.1 3.5"/>
      </g>
      <path class="agi-clip" d="M13.5 7.2v7.3a2.2 2.2 0 0 1-4.4 0V6.3a3.3 3.3 0 0 1 6.6 0v7.8a4.4 4.4 0 0 1-8.8 0V8.2"/>
    `),
  },

  critic: {
    label: 'Critic / review',
    motion: 'A verdict is checked off smoothly',
    svg: glyph(`
      <path d="M12 3 4.8 5.8v5.5c0 4.5 3 7.9 7.2 9.7 4.2-1.8 7.2-5.2 7.2-9.7V5.8z"/>
      <path class="agi-critic-check" pathLength="100" d="M8.8 11.8l2.2 2.2 4.4-4.6"/>
    `),
  },

  agent: {
    label: 'Agent',
    motion: 'Eyes glide smoothly across a task while signal arcs transmit from the antenna',
    svg: glyph(`
      <path class="agi-bot-wave" style="--agi-d:0s" pathLength="100" d="M9.4 4.2a3.8 3.8 0 0 1 5.2 0"/>
      <path class="agi-bot-wave" style="--agi-d:0.35s" pathLength="100" d="M7.6 2.5a6.2 6.2 0 0 1 8.8 0"/>
      <rect x="4.5" y="7.5" width="15" height="12" rx="3"/>
      <path class="agi-dim" d="M12 3.8v3.7M2.8 12.2v2.8M21.2 12.2v2.8"/>
      <circle cx="12" cy="3.6" r="1" fill="currentColor" stroke="none"/>
      <g class="agi-bot-eyes">
        <circle cx="9.4" cy="12.8" r="1.2" fill="currentColor" stroke="none"/>
        <circle cx="14.6" cy="12.8" r="1.2" fill="currentColor" stroke="none"/>
      </g>
      <path class="agi-dim" d="M9.8 16.4h4.4"/>
    `),
  },

  session: {
    label: 'Session',
    motion: 'Three balanced typing dots wave smoothly inside the message bubble',
    svg: glyph(`
      <path d="M20.2 14.2a2.4 2.4 0 0 1-2.4 2.4H9.2L4.6 20v-3.4a2.4 2.4 0 0 1-.8-1.8V6.4A2.4 2.4 0 0 1 6.2 4h11.6a2.4 2.4 0 0 1 2.4 2.4z"/>
      <circle class="agi-type-dot" style="--agi-d:0s" cx="8.2" cy="10.4" r="1.05" fill="currentColor" stroke="none"/>
      <circle class="agi-type-dot" style="--agi-d:-0.22s" cx="12" cy="10.4" r="1.05" fill="currentColor" stroke="none"/>
      <circle class="agi-type-dot" style="--agi-d:-0.44s" cx="15.8" cy="10.4" r="1.05" fill="currentColor" stroke="none"/>
    `),
  },

  git: {
    label: 'Git',
    motion: 'Branch curve draws smoothly while a commit glides along the curve to merge',
    svg: glyph(`
      <path class="agi-dim" d="M6.5 4v11.5"/>
      <path class="agi-dim" d="M17.5 8.5v1.5c0 2.5-2 4.2-4.5 4.2H9"/>
      <path class="agi-git-flow" pathLength="100" d="M17.5 8.5v1.5c0 2.5-2 4.2-4.5 4.2H6.5v1.3"/>
      <circle cx="6.5" cy="6" r="2.2"/>
      <circle cx="6.5" cy="18" r="2.2"/>
      <circle cx="17.5" cy="6" r="2.2"/>
      <circle class="agi-commit" cx="17.5" cy="6" r="1.45" fill="currentColor" stroke="none"/>
    `),
  },

  context: {
    label: 'Context / files',
    motion: 'A sheet glides smoothly out of the stack to the front',
    svg: glyph(`
      <rect class="agi-dim" x="4.2" y="3.5" width="11" height="13.8" rx="1.8"/>
      <rect x="8.2" y="6.2" width="11" height="13.8" rx="1.8"/>
      <path class="agi-dim" d="M11 10.4h5.4M11 13.4h5.4M11 16.4h3.4"/>
      <rect class="agi-context-sheet" x="11.6" y="9.2" width="7.4" height="4.8" rx=".8" fill="currentColor" stroke="none"/>
    `),
  },

  skill: {
    label: 'Skill',
    motion: 'The tassel swings from the corner of the cap, then settles',
    svg: glyph(`
      <path d="M12 5.4 3.4 9.6 12 13.8l8.6-4.2z"/>
      <path d="M7.2 11.6v3.1c0 1.7 2.1 2.9 4.8 2.9s4.8-1.2 4.8-2.9v-3.1"/>
      <g class="agi-tassel">
        <path d="M19.6 10.4v4.2"/>
        <circle cx="19.6" cy="15.4" r="1.05" fill="currentColor" stroke="none"/>
      </g>
    `),
  },

  tool: {
    label: 'Tool / generic',
    motion: 'A cog turns steadily while an unknown tool runs',
    svg: glyph(`
      <g class="agi-cog-group">
        <path d="M10.9 3.5L12 3.4L13.1 3.5L13.8 5.9L15.1 6.4L17.3 5.2L18.1 5.9L18.8 6.7L17.6 8.9L18.1 10.2L20.5 10.9L20.6 12L20.5 13.1L18.1 13.8L17.6 15.1L18.8 17.3L18.1 18.1L17.3 18.8L15.1 17.6L13.8 18.1L13.1 20.5L12 20.6L10.9 20.5L10.2 18.1L8.9 17.6L6.7 18.8L5.9 18.1L5.2 17.3L6.4 15.1L5.9 13.8L3.5 13.1L3.4 12L3.5 10.9L5.9 10.2L6.4 8.9L5.2 6.7L5.9 5.9L6.7 5.2L8.9 6.4L10.2 5.9Z"/>
        <circle cx="12" cy="12" r="2.6"/>
      </g>
    `),
  },
};

export const activityGlyphOrder = Object.keys(activityGlyphs) as ToolIcon[];
