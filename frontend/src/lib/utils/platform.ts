/** Utility for OS platform detection in the browser */

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    navigator.platform.toUpperCase().indexOf('MAC') >= 0 ||
    navigator.userAgent.toUpperCase().indexOf('MAC') >= 0
  );
}

export function isWindows(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    navigator.platform.toUpperCase().indexOf('WIN') >= 0 ||
    navigator.userAgent.toUpperCase().indexOf('WIN') >= 0
  );
}

export function isLinux(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    navigator.platform.toUpperCase().indexOf('LINUX') >= 0 ||
    navigator.userAgent.toUpperCase().indexOf('LINUX') >= 0
  );
}

/** Returns the platform's primary modifier key name (Ctrl or ⌘) */
export function getModKeyName(): string {
  return isMac() ? '⌘' : 'Ctrl';
}

/** Returns the platform's primary modifier key symbol for display (Ctrl or Meta) */
export function getModKeyLabel(): string {
  return isMac() ? 'Meta' : 'Ctrl';
}

/** Formats a key string for display based on the platform */
export function formatKey(key: string): string {
  if (key === 'Mod') {
    if (isMac()) return '⌘';
    if (isWindows()) return 'Ctrl';
    return 'Ctrl'; // Linux: Ctrl is the standard modifier for app shortcuts
  }
  if (key === 'Meta') {
    if (isMac()) return '⌘';
    if (isWindows()) return '⊞';
    return 'Super'; // Linux: the Meta key is the Super key
  }
  return key;
}
