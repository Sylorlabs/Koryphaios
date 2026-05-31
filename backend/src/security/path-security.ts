// Path traversal protection and safe path resolution
// Prevents directory traversal attacks via .. sequences, URL encoding, etc.

import { resolve, normalize, relative, isAbsolute, join } from 'path';
import { realpathSync, existsSync } from 'fs';

export interface PathValidationResult {
  allowed: boolean;
  resolvedPath?: string;
  reason?: string;
}

/**
 * Validate that a path is within allowed directories
 * Prevents path traversal attacks including:
 * - ../ sequences
 * - URL encoding: %2e%2e, %252e%252e
 * - Double slashes: //etc/passwd
 * - Null bytes (though Node/Bun should handle these)
 * - Symbolic link traversal
 *
 * @param requestedPath The path to validate (can be relative or absolute)
 * @param allowedRoots Array of allowed root directories
 * @param options Validation options
 */
export function validatePathAccess(
  requestedPath: string,
  allowedRoots: string[],
  options: {
    followSymlinks?: boolean;
    allowAbsolute?: boolean;
  } = {},
): PathValidationResult {
  const { followSymlinks = false, allowAbsolute = false } = options;

  // Check for null bytes (path truncation attempt)
  // Also check URL-encoded null bytes
  if (requestedPath.includes('\0') || requestedPath.toLowerCase().includes('%00')) {
    return { allowed: false, reason: 'Path contains null bytes' };
  }

  // URL decode the path to catch encoded traversal attempts
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    return { allowed: false, reason: 'Invalid URL encoding in path' };
  }

  // Double-decode to catch double-encoding: %252e -> %2e -> .
  let doubleDecodedPath: string;
  try {
    doubleDecodedPath = decodeURIComponent(decodedPath);
  } catch {
    doubleDecodedPath = decodedPath;
  }

  // Use the most decoded version for validation
  const pathToValidate = doubleDecodedPath !== decodedPath ? doubleDecodedPath : decodedPath;

  // Check for traversal patterns in the original and decoded paths
  const traversalPatterns = [
    /\.\.\//, // ../
    /\.\.\\/, // ..\ (Windows)
    /\/\.\.\//, // /../
    /\\\.\.\\/, // \..\ (Windows)
    /^\.\./, // Starts with ..
    /\/\.\.\s*$/, // Ends with /..
    /\.\.\s*$/, // Ends with ..
  ];

  for (const pattern of traversalPatterns) {
    if (pattern.test(pathToValidate) || pattern.test(requestedPath)) {
      return { allowed: false, reason: 'Path traversal sequence detected' };
    }
  }

  // Normalize the path to resolve . and .. sequences safely
  // We use normalize first to clean up the path
  const normalizedPath = normalize(pathToValidate);

  // After normalization, check again for traversal (catches tricky cases)
  if (normalizedPath.startsWith('..') || normalizedPath.includes('/../')) {
    return { allowed: false, reason: 'Path resolves outside allowed directory' };
  }

  // Check for home directory expansion attempts
  if (normalizedPath.startsWith('~/') || normalizedPath === '~') {
    return { allowed: false, reason: 'Home directory expansion not allowed' };
  }

  // Resolve to absolute path
  // If path is relative, we need a base directory
  // For now, assume we validate against each allowed root
  for (const root of allowedRoots) {
    const resolvedPath = resolve(root, normalizedPath);

    // Ensure resolved path is within the root
    const relativeToRoot = relative(root, resolvedPath);

    // Check if path escapes root (starts with .. or is absolute)
    if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
      continue; // Try next root
    }

    // Optional: Check for symlink traversal
    if (followSymlinks && existsSync(resolvedPath)) {
      try {
        const realPath = realpathSync(resolvedPath);
        const realRelative = relative(root, realPath);
        if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
          return { allowed: false, reason: 'Symbolic link traversal detected' };
        }
      } catch {
        // If we can't resolve the symlink, deny access
        return { allowed: false, reason: 'Cannot verify symlink safety' };
      }
    }

    // Path is within this root
    return { allowed: true, resolvedPath };
  }

  // Path not within any allowed root
  return {
    allowed: false,
    reason: allowAbsolute
      ? 'Absolute path not in allowed directories'
      : 'Path resolves outside allowed directory',
  };
}

/**
 * Sanitize a path component (filename) to prevent traversal
 * Useful for user-provided filenames
 */
export function sanitizePathComponent(filename: string): string {
  // Remove null bytes
  let sanitized = filename.replace(/\0/g, '');

  // Remove path separators
  sanitized = sanitized.replace(/[/\\]/g, '');

  // Remove traversal sequences
  sanitized = sanitized.replace(/\.\./g, '');

  // Remove leading dots (hidden files)
  sanitized = sanitized.replace(/^\.+/, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  // Prevent empty filenames
  if (!sanitized) {
    sanitized = 'unnamed';
  }

  return sanitized;
}

/**
 * Validate API path parameters for session IDs and other IDs
 * Prevents injection in URL paths
 */
export function validatePathParameter(
  param: string,
  options: {
    maxLength?: number;
    allowedChars?: RegExp;
  } = {},
): { valid: boolean; reason?: string } {
  const { maxLength = 256, allowedChars = /^[a-zA-Z0-9_-]+$/ } = options;

  if (!param || typeof param !== 'string') {
    return { valid: false, reason: 'Parameter is required' };
  }

  if (param.length > maxLength) {
    return { valid: false, reason: `Parameter exceeds maximum length of ${maxLength}` };
  }

  if (!allowedChars.test(param)) {
    return { valid: false, reason: 'Parameter contains invalid characters' };
  }

  // Check for encoded traversal attempts
  const decoded = decodeURIComponent(param);
  if (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) {
    return { valid: false, reason: 'Parameter contains path traversal sequence' };
  }

  return { valid: true };
}

/**
 * Middleware-compatible path validation for server.ts
 * Returns a Response if validation fails, null if successful
 */
export function validateApiPath(
  pathname: string,
  options: {
    allowedPrefixes?: string[];
    requireSessionId?: boolean;
  } = {},
): Response | null {
  const { allowedPrefixes = ['/api/'], requireSessionId = false } = options;

  // Check that path starts with allowed prefix
  const hasAllowedPrefix = allowedPrefixes.some((prefix) => pathname.startsWith(prefix));
  if (!hasAllowedPrefix) {
    return new Response('Invalid path prefix', { status: 400 });
  }

  // URL decode to catch encoded attacks
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response('Invalid URL encoding', { status: 400 });
  }

  // Double decode
  let doubleDecoded: string;
  try {
    doubleDecoded = decodeURIComponent(decoded);
  } catch {
    doubleDecoded = decoded;
  }

  // Check for traversal in all versions of the path
  const pathsToCheck = [pathname, decoded, doubleDecoded];

  for (const path of pathsToCheck) {
    // Check for null bytes (both raw and encoded)
    if (path.includes('\0') || path.toLowerCase().includes('%00')) {
      return new Response('Invalid characters in path', { status: 400 });
    }

    // Check for traversal patterns and home expansion
    if (path.includes('..') || path.startsWith('~/') || path.startsWith('~')) {
      return new Response('Path traversal detected', { status: 403 });
    }

    // Check for double slashes that might bypass checks
    if (path.includes('//')) {
      return new Response('Invalid path format', { status: 400 });
    }
  }

  // If session ID is required, validate it
  if (requireSessionId) {
    const sessionIdMatch = decoded.match(/\/api\/sessions\/([^\/]+)/);
    if (sessionIdMatch) {
      const sessionId = sessionIdMatch[1];
      const validation = validatePathParameter(sessionId);
      if (!validation.valid) {
        return new Response(`Invalid session ID: ${validation.reason}`, { status: 400 });
      }
    }
  }

  return null;
}

/**
 * Safe path join that prevents traversal
 * Always resolves within the base directory
 */
export function safePathJoin(
  baseDir: string,
  ...pathSegments: string[]
): { safe: boolean; fullPath?: string; reason?: string } {
  // Normalize base directory
  const normalizedBase = normalize(resolve(baseDir));

  // Join and normalize the full path
  const joinedPath = join(normalizedBase, ...pathSegments);
  const normalizedPath = normalize(joinedPath);

  // Ensure the resolved path is within base directory
  const relativePath = relative(normalizedBase, normalizedPath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return { safe: false, reason: 'Path escapes base directory' };
  }

  // Additional check: verify no traversal in segments
  for (const segment of pathSegments) {
    if (segment.includes('..') || segment.includes('/') || segment.includes('\\')) {
      return { safe: false, reason: 'Path segment contains traversal' };
    }
  }

  return { safe: true, fullPath: normalizedPath };
}
