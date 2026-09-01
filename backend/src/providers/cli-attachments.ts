import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serverLog } from '../logger';
import type { ProviderContentBlock } from './types';
import {
  createPrivateCliBinaryArtifact,
  type PrivateCliArtifact,
} from './private-cli-transport';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = join(tmpdir(), 'koryphaios-cli-attachments');

function extensionForMime(mime: string | undefined): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/bmp') return 'bmp';
  return 'png';
}

function pruneStaleCache(now = Date.now()): void {
  try {
    for (const name of readdirSync(CACHE_DIR)) {
      const path = join(CACHE_DIR, name);
      try {
        if (now - statSync(path).mtimeMs > CACHE_MAX_AGE_MS) unlinkSync(path);
      } catch (err: unknown) {
        // A concurrent invocation may already have removed the file.
        serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'cli-attachments: stale cache entry already removed');
      }
    }
  } catch (err: unknown) {
    // Cache cleanup is best effort; attachment creation still reports failures.
    serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'cli-attachments: cache cleanup best-effort failed');
  }
}

/** Materialize an image for text-only CLI prompt transports. Content-addressed
 *  names avoid writing another copy on every history replay. */
export function materializeCliImage(
  imageData: string | undefined,
  mimeType: string | undefined,
): string | null {
  if (!imageData) return null;
  try {
    const bytes = Buffer.from(imageData, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    chmodSync(CACHE_DIR, 0o700);
    pruneStaleCache();
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    const path = join(CACHE_DIR, `${digest}.${extensionForMime(mimeType)}`);
    try {
      statSync(path);
    } catch (err: unknown) {
      serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'cli-attachments: cached file missing — writing new copy');
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    }
    return path;
  } catch (err: unknown) {
    serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'cli-attachments: image materialization failed');
    return null;
  }
}

export function renderCliContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use') {
      parts.push(
        `[tool call: ${block.toolName ?? 'tool'} ${JSON.stringify(block.toolInput ?? {})}]`,
      );
    } else if (block.type === 'tool_result') {
      parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
    } else if (block.type === 'image') {
      const path = materializeCliImage(block.imageData, block.imageMimeType);
      parts.push(
        path
          ? `[Image attachment: ${path}. Inspect this image with your available image/file tool before answering.]`
          : '[Image attachment unavailable: missing, invalid, or larger than 10 MB.]',
      );
    }
  }
  return parts.join('\n');
}

export interface CliAttachmentScope {
  readonly artifacts: readonly PrivateCliArtifact[];
  materializeImage(imageData: string | undefined, mimeType: string | undefined): string | null;
  renderContent(content: string | ProviderContentBlock[]): string;
  cleanup(): void;
}

/** Per-turn attachment storage. Unlike the legacy content cache, every file is
 * held under a 0700 run directory, written 0600, and deleted when the provider
 * subprocess closes. The shared startup pruner in private-cli-transport covers
 * abrupt parent-process crashes. */
export function createCliAttachmentScope(): CliAttachmentScope {
  const artifacts: PrivateCliArtifact[] = [];
  const pathsByContent = new Map<string, string>();
  let cleaned = false;

  const materializeImage = (
    imageData: string | undefined,
    mimeType: string | undefined,
  ): string | null => {
    if (!imageData || cleaned) return null;
    try {
      const bytes = Buffer.from(imageData, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
      // History replay can legitimately contain the same screenshot in more
      // than one context block. Keep one private artifact per distinct image
      // for this turn so a native CLI never receives duplicate image inputs.
      const key = createHash('sha256')
        .update(bytes)
        .update('\0')
        .update(mimeType ?? '')
        .digest('hex');
      const existing = pathsByContent.get(key);
      if (existing) return existing;
      const artifact = createPrivateCliBinaryArtifact(
        'attachment',
        bytes,
        extensionForMime(mimeType),
      );
      artifacts.push(artifact);
      pathsByContent.set(key, artifact.path);
      return artifact.path;
    } catch {
      return null;
    }
  };

  const renderContent = (content: string | ProviderContentBlock[]): string => {
    if (typeof content === 'string') return content;
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) parts.push(block.text);
      else if (block.type === 'tool_use') {
        parts.push(
          `[tool call: ${block.toolName ?? 'tool'} ${JSON.stringify(block.toolInput ?? {})}]`,
        );
      } else if (block.type === 'tool_result') {
        parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
      } else if (block.type === 'image') {
        const path = materializeImage(block.imageData, block.imageMimeType);
        parts.push(
          path
            ? `[Image attachment: ${path}. Inspect this image with your available image/file tool before answering.]`
            : '[Image attachment unavailable: missing, invalid, or larger than 10 MB.]',
        );
      }
    }
    return parts.join('\n');
  };

  return {
    artifacts,
    materializeImage,
    renderContent,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const artifact of artifacts) artifact.cleanup();
      pathsByContent.clear();
    },
  };
}

export function hasImageContent(
  messages: Array<{ content: string | ProviderContentBlock[] }>,
): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((block) => block.type === 'image'),
  );
}
