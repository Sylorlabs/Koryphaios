/**
 * Host platform detection and platform-correct keyboard labelling.
 *
 * This is the *only* place in the frontend allowed to branch on the OS. UI must
 * never spell a shortcut literally — a hard-coded `Ctrl+Shift+V` is wrong on
 * macOS and a hard-coded `⌘K` is wrong everywhere else. Bind the abstract `Mod`
 * token instead and render it through `formatShortcut`/`formatKey`, so the label
 * follows the platform the user is actually on.
 */

export type Platform = 'mac' | 'windows' | 'linux';

export interface RuntimeInfo {
  os: string;
  osVersion: string | null;
  browser: string | null;
  browserVersion: string | null;
}

interface PlatformProfiles {
  /** Primary modifier, as it reads on the physical key cap. */
  mod: string;
  /** Bare Ctrl. macOS prints this on the key cap as a caret. */
  ctrl: string;
  /** Windows/Super key. */
  meta: string;
  alt: string;
  shift: string;
  enter: string;
  escape: string;
  backspace: string;
  delete: string;
  tab: string;
  space: string;
  /** Single-glyph spellings for the four arrow keys, in DOM key order. */
  arrows: Record<string, string>;
}

const MAC: PlatformProfiles = {
  mod: '⌘',
  ctrl: '⌃',
  meta: '⌘',
  alt: '⌥',
  shift: '⇧',
  enter: '↵',
  escape: 'esc',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  space: '␣',
  arrows: { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' },
};

const WINDOWS: PlatformProfiles = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  meta: 'Win',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Del',
  tab: 'Tab',
  space: 'Space',
  arrows: { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' },
};

const LINUX: PlatformProfiles = {
  ...WINDOWS,
  meta: 'Super',
};

const PROFILES: Record<Platform, PlatformProfiles> = {
  mac: MAC,
  windows: WINDOWS,
  linux: LINUX,
};

let cachedPlatform: Platform | null = null;

function sniff(): Platform {
  if (typeof navigator === 'undefined') return 'linux';
  // Chromium/WebKit on the desktop app expose a normalised platform token; the
  // user-agent strings are the fallback for older WebKitGTK builds.
  const hinted =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  const haystack = `${hinted} ${navigator.userAgent}`.toUpperCase();
  if (haystack.includes('MAC') || haystack.includes('DARWIN') || haystack.includes('IPHONE')) {
    return 'mac';
  }
  if (haystack.includes('WIN')) return 'windows';
  return 'linux';
}

/** The OS this browser window is running on. */
export function getPlatform(): Platform {
  if (cachedPlatform === null) cachedPlatform = sniff();
  return cachedPlatform;
}

function profile(): PlatformProfiles {
  return PROFILES[getPlatform()];
}

/** Test seam: the detected platform is cached, so tests can pin it. */
export function setPlatformForTesting(platform: Platform | null): void {
  cachedPlatform = platform;
}

export function isMac(): boolean {
  return getPlatform() === 'mac';
}

export function isWindows(): boolean {
  return getPlatform() === 'windows';
}

export function isLinux(): boolean {
  return getPlatform() === 'linux';
}

function normalizeVersion(version: string): string {
  return version.replace(/_/g, '.');
}

function firstMatch(userAgent: string, patterns: Array<[string, RegExp]>): [string, string] | null {
  for (const [name, pattern] of patterns) {
    const match = userAgent.match(pattern);
    if (match?.[1]) return [name, match[1]];
  }
  return null;
}

/**
 * Returns concise host/runtime information for user-authorized diagnostics.
 * Keep user-agent parsing here with platform detection so UI components never
 * read navigator directly or need to maintain OS-specific parsing rules.
 */
export function getRuntimeInfo(): RuntimeInfo {
  if (typeof navigator === 'undefined') {
    return { os: 'Linux', osVersion: null, browser: null, browserVersion: null };
  }

  const userAgent = navigator.userAgent;
  const platform = getPlatform();
  const os = platform === 'mac' ? 'macOS' : platform === 'windows' ? 'Windows' : 'Linux';
  const osVersionMatch =
    platform === 'mac'
      ? userAgent.match(/Mac OS X ([\d_\.]+)/i)
      : platform === 'windows'
        ? userAgent.match(/Windows NT ([\d\.]+)/i)
        : null;
  const browser = firstMatch(userAgent, [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/i],
    ['Opera', /(?:OPR|Opera)\/([\d.]+)/i],
    ['Firefox', /Firefox\/([\d.]+)/i],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/i],
    ['Safari', /Version\/([\d.]+).*Safari/i],
  ]);

  return {
    os,
    osVersion: osVersionMatch?.[1] ? normalizeVersion(osVersionMatch[1]) : null,
    browser: browser?.[0] ?? null,
    browserVersion: browser?.[1] ?? null,
  };
}

/** The platform's primary modifier, for composing a one-off hint. Prefer `formatShortcut`. */
export function getModKeyName(): string {
  return profile().mod;
}

/**
 * Formats one key token for display: `Mod` becomes ⌘ on macOS and Ctrl
 * everywhere else, `Meta` becomes ⌘ / Win / Super, and the platform's own glyph
 * spellings are used for the navigation and editing keys.
 */
export function formatKey(key: string): string {
  if (key === 'Mod') return profile().mod;
  const p = profile();
  if (key === 'Meta' || key === 'OS' || key === 'Super') return p.meta;
  if (key === 'Ctrl' || key === 'Control') return p.ctrl;
  if (key === 'Alt' || key === 'Option') return p.alt;
  if (key === 'Shift') return p.shift;
  if (key === 'Enter' || key === 'Return') return p.enter;
  if (key === 'Esc' || key === 'Escape') return p.escape;
  if (key === 'Backspace') return p.backspace;
  if (key === 'Delete' || key === 'Del') return p.delete;
  if (key === 'Tab') return p.tab;
  if (key === ' ') return p.space;
  if (p.arrows[key]) return p.arrows[key];
  // The fn key is labelled in lower case on the key cap itself.
  if (key.toLowerCase() === 'fn') return 'fn';
  return key;
}

/** Formats a chord given as separate tokens: `formatChord('Mod', 'Shift', 'V')`. */
export function formatChord(...keys: string[]): string {
  return keys.map(formatKey).join('+');
}

/**
 * Formats a chord written with `+` separators: `formatShortcut('Mod+Shift+V')`.
 * Use this for every user-visible shortcut hint so no label can hard-code a
 * modifier that belongs to a different platform.
 */
export function formatShortcut(chord: string): string {
  return chord.split('+').map(formatKey).join('+');
}
