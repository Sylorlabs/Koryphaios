/**
 * General utility helper functions
 */

import { randomBytes } from 'crypto';

/**
 * Generate a unique ID
 */
export function generateId(prefix?: string): string {
  const id = randomBytes(8).toString('hex');
  return prefix ? `${prefix}-${id}` : id;
}

/**
 * Debounce function calls
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      func(...args);
    }, wait);
  };
}

/**
 * Throttle function calls
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as T;
  }

  if (obj instanceof Array) {
    return obj.map(item => deepClone(item)) as T;
  }

  if (typeof obj === 'object') {
    const cloned = {} as T;
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        cloned[key] = deepClone(obj[key]);
      }
    }
    return cloned;
  }

  return obj;
}

/**
 * Safely parse JSON with error handling
 */
export function safeJsonParse<T = unknown>(json: string, defaultValue?: T): T | undefined {
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Format duration in milliseconds to human readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Escape regex special characters
 */
export function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a string matches any of the given patterns
 */
export function matchesPatterns(str: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    if (pattern.includes('*') || pattern.includes('?')) {
      // Convert glob pattern to regex
      const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^${regexPattern}$`).test(str);
    }
    return str.includes(pattern);
  });
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
  } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelay = 1000, maxDelay = 10000, backoffFactor = 2 } = options;

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = Math.min(initialDelay * Math.pow(backoffFactor, attempt), maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

/**
 * Create a promise that resolves after a specified delay
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a promise that times out after a specified duration
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

/**
 * Alias for withTimeout for backward compatibility
 */
export const timeout = withTimeout;

/**
 * Parse a stack trace string into structured data
 */
export function parseStackTrace(stackTrace: string): Array<{
  function?: string;
  file?: string;
  line?: number;
  column?: number;
  source?: string;
}> {
  const lines = stackTrace.split('\n');
  const frames: Array<{
    function?: string;
    file?: string;
    line?: number;
    column?: number;
    source?: string;
  }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Error:')) continue;

    // Match different stack trace formats
    // Node.js format: "at functionName (file:line:column)"
    // Browser format: "functionName@file:line:column"
    const nodeMatch = trimmed.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
    const browserMatch = trimmed.match(/(.+?)@(.+?):(\d+):(\d+)/);

    if (nodeMatch && nodeMatch[2] && nodeMatch[3] && nodeMatch[4]) {
      frames.push({
        function: nodeMatch[1]?.trim() || '<anonymous>',
        file: nodeMatch[2],
        line: parseInt(nodeMatch[3], 10),
        column: parseInt(nodeMatch[4], 10),
        source: trimmed,
      });
    } else if (browserMatch && browserMatch[2] && browserMatch[3] && browserMatch[4]) {
      frames.push({
        function: browserMatch[1]?.trim() || '<anonymous>',
        file: browserMatch[2],
        line: parseInt(browserMatch[3], 10),
        column: parseInt(browserMatch[4], 10),
        source: trimmed,
      });
    } else {
      // Fallback for unrecognized formats
      frames.push({
        source: trimmed,
      });
    }
  }

  return frames;
}

/**
 * Format an error object into a readable string
 */
export function formatError(error: Error | unknown): string {
  if (error instanceof Error) {
    let formatted = `${error.name}: ${error.message}`;

    if (error.stack) {
      formatted += `\n${error.stack}`;
    }

    // Add additional properties if they exist
    const additionalProps = Object.getOwnPropertyNames(error).filter(
      prop => !['name', 'message', 'stack'].includes(prop)
    );

    if (additionalProps.length > 0) {
      formatted += '\nAdditional properties:';
      for (const prop of additionalProps) {
        const value = (error as any)[prop];
        formatted += `\n  ${prop}: ${JSON.stringify(value)}`;
      }
    }

    return formatted;
  }

  if (typeof error === 'string') {
    return error;
  }

  return JSON.stringify(error, null, 2);
}

/**
 * Sanitize a file path for safe usage
 */
export function sanitizePath(path: string): string {
  // Remove null bytes and other dangerous characters
  let sanitized = path.replace(/\0/g, '');

  // Normalize path separators
  sanitized = sanitized.replace(/\\/g, '/');

  // Remove leading/trailing whitespace
  sanitized = sanitized.trim();

  // Remove dangerous path traversal patterns
  sanitized = sanitized.replace(/\.\.+/g, '.');

  // Remove multiple consecutive slashes
  sanitized = sanitized.replace(/\/+/g, '/');

  return sanitized;
}

/**
 * Check if a path is valid and safe
 */
export function isValidPath(path: string): boolean {
  if (!path || typeof path !== 'string') {
    return false;
  }

  // Check for null bytes
  if (path.includes('\0')) {
    return false;
  }

  // Check for dangerous patterns
  const dangerousPatterns = [
    /\.\./, // Path traversal
    /^\/dev\//, // Device files (Unix)
    /^\/proc\//, // Process files (Unix)
    /^\/sys\//, // System files (Unix)
    /^CON$/i, // Windows reserved names
    /^PRN$/i,
    /^AUX$/i,
    /^NUL$/i,
    /^COM[1-9]$/i,
    /^LPT[1-9]$/i,
  ];

  return !dangerousPatterns.some(pattern => pattern.test(path));
}

/**
 * Get file extension from a path
 */
export function getFileExtension(path: string): string {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));

  if (lastDot > lastSlash && lastDot > 0) {
    return path.substring(lastDot + 1).toLowerCase();
  }

  return '';
}

/**
 * Determine programming language from file path
 */
export function getLanguageFromFile(path: string): string | null {
  const extension = getFileExtension(path);

  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    mjs: 'javascript',
    cjs: 'javascript',

    // Python
    py: 'python',
    pyw: 'python',
    pyi: 'python',

    // Go
    go: 'go',

    // Rust
    rs: 'rust',

    // C/C++
    c: 'c',
    cpp: 'cpp',
    cxx: 'cpp',
    cc: 'cpp',
    h: 'c',
    hpp: 'cpp',
    hxx: 'cpp',

    // Java
    java: 'java',

    // C#
    cs: 'csharp',

    // PHP
    php: 'php',

    // Ruby
    rb: 'ruby',

    // Swift
    swift: 'swift',

    // Kotlin
    kt: 'kotlin',
    kts: 'kotlin',

    // Scala
    scala: 'scala',
    sc: 'scala',

    // Shell
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',

    // Web
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',

    // Config
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',

    // Markdown
    md: 'markdown',
    markdown: 'markdown',
  };

  return languageMap[extension] || null;
}

/**
 * Chunk an array into smaller arrays of specified size
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Remove duplicates from an array
 */
export function unique<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

/**
 * Group array elements by a key function
 */
export function groupBy<T, K extends string | number | symbol>(
  array: T[],
  keyFn: (item: T) => K
): Record<K, T[]> {
  return array.reduce(
    (groups, item) => {
      const key = keyFn(item);
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(item);
      return groups;
    },
    {} as Record<K, T[]>
  );
}

/**
 * Check if a value is a plain object
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.constructor === Object &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

/**
 * Merge objects deeply
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  ...sources: Partial<T>[]
): T {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key in source) {
      if (isPlainObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return deepMerge(target, ...sources);
}
