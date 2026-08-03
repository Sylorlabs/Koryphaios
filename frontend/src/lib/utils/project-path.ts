export function projectDisplayName(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
