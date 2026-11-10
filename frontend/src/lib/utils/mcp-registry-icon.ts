/**
 * Registry entries publish no image of their own — only a website and a source
 * repository. Derive something recognizable instead of showing the same
 * Terminal/Globe glyph for every server: GitHub entries get their publisher's
 * avatar, everything else gets the site favicon.
 */

const FAVICON_SERVICE_BASE = 'https://www.google.com/s2/favicons?sz=64&domain_url=';

function parseHttpUrl(raw: string | null | undefined): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url;
}

/** `github.com/<owner>/...` → the owner's avatar; distinct per publisher. */
function githubOwnerAvatar(url: URL): string | null {
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  const owner = url.pathname.split('/').filter(Boolean)[0];
  if (!owner || !/^[A-Za-z0-9._-]+$/.test(owner)) return null;
  return `https://github.com/${owner}.png?size=64`;
}

function faviconFor(url: URL | null): string {
  if (!url) return '';
  return `${FAVICON_SERVICE_BASE}${encodeURIComponent(url.origin)}`;
}

export function mcpRegistryIconUrl(result: {
  websiteUrl: string | null;
  repositoryUrl: string | null;
}): string {
  const repository = parseHttpUrl(result.repositoryUrl);
  const avatar = repository ? githubOwnerAvatar(repository) : null;
  if (avatar) return avatar;
  return faviconFor(parseHttpUrl(result.websiteUrl)) || faviconFor(repository);
}
