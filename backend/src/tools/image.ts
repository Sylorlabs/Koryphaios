// view_image — lets agents look at image files with vision-capable models.
//
// The tool itself returns a small JSON descriptor (no base64 — archives stay
// tiny). The manager detects a successful view_image result and appends the
// actual image bytes to the conversation as an image content block, so the
// next provider turn can see it. The frontend renders the image inline in the
// chat feed via /api/workspace/raw.

import { existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { validatePathAccess } from '../security';
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';

export const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ViewImageResult {
  path: string;
  mimeType: string;
  sizeBytes: number;
  note: string;
}

export class ViewImageTool implements Tool {
  readonly name = 'view_image';
  readonly description =
    'Look at an image file (png/jpg/gif/webp/bmp/svg). The image is attached to the conversation ' +
    'so you can visually analyze it (screenshots, diagrams, UI mocks, charts) and it is shown to ' +
    'the user in the chat. Use this whenever you need to SEE an image rather than read text.';

  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the image file.' },
    },
    required: ['path'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const rel = String(call.input.path ?? '');
    const absPath = rel.startsWith('/') ? rel : join(ctx.workingDirectory, rel);
    const fail = (output: string): ToolCallOutput => ({
      callId: call.id,
      name: this.name,
      output,
      isError: true,
      durationMs: 0,
    });

    const roots = [ctx.workingDirectory, ...(ctx.allowedPaths ?? [])].filter(Boolean);
    const access = validatePathAccess(absPath, roots);
    if (!access.allowed) return fail(`Error: Access denied. ${access.reason}`);
    if (!existsSync(absPath)) return fail(`Image not found: ${absPath}`);

    const mimeType = IMAGE_MIME_TYPES[extname(absPath).toLowerCase()];
    if (!mimeType) {
      return fail(
        `Not a supported image type: ${absPath} (supported: ${Object.keys(IMAGE_MIME_TYPES).join(', ')})`,
      );
    }
    const sizeBytes = statSync(absPath).size;
    if (sizeBytes > MAX_IMAGE_BYTES) {
      return fail(`Image too large (${Math.round(sizeBytes / 1024 / 1024)}MB > 10MB): ${absPath}`);
    }

    const result: ViewImageResult = {
      path: absPath,
      mimeType,
      sizeBytes,
      note: 'Image attached to the conversation as a vision input; also rendered in the chat.',
    };
    return {
      callId: call.id,
      name: this.name,
      output: JSON.stringify(result),
      isError: false,
      durationMs: 0,
    };
  }
}
