import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAttachmentScope } from '../cli-attachments';
import { buildAntigravityPrompt } from '../antigravity';
import { toolsForRole } from '../kory-mcp-bridge';
import { canonicalizePath } from '../../runtime/platform';
import { ToolRegistry, type ToolContext } from '../../tools/registry';
import { ViewImageTool } from '../../tools/image';
import { resolveToolPermissionPolicy } from '../../tools/permission-policy';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import type { ProviderMessage } from '../types';

describe('antigravity attachment view_image bridge path', () => {
  test('stages an attachment, canonicalizes its path, names kory__view_image, and the bridge exposes it', async () => {
    const scope = createCliAttachmentScope();
    try {
      const data = Buffer.from('fake-image-bytes-for-bridge').toString('base64');
      const path = scope.materializeImage(data, 'image/png');
      expect(path).toBeTruthy();
      // Staged file exists and its path is canonical (macOS /var -> /private/var).
      expect(existsSync(path!)).toBe(true);
      expect(path!).toBe(canonicalizePath(path!));

      const messages: ProviderMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', imageData: data, imageMimeType: 'image/png' },
          ],
        },
      ];
      const prompt = buildAntigravityPrompt('Base policy', messages, scope);
      // The prompt names the permitted bridge tool, not a denied native one.
      expect(prompt).toContain('kory__view_image');
      expect(prompt).toContain(path!);
      expect(prompt).not.toContain('your available image/file tool');

      // The bridge exposes kory__view_image for the antigravity roles, so the
      // staged file is reachable only through the bridge grant (mcp:execute).
      for (const role of ['manager', 'worker']) {
        const names = toolsForRole(role).map((tool) => tool.name);
        expect(names).toContain('kory__view_image');
      }

      // The bridge can actually read the staged file through view_image's
      // invocation-bound path scope (the same path the prompt names).
      const chatRoot = mkdtempSync(join(tmpdir(), 'kory-agy-chat-'));
      try {
        const registry = new ToolRegistry();
        registry.register(new ViewImageTool());
        const ctx: ToolContext = {
          sessionId: 'bridge-read-test',
          workingDirectory: chatRoot,
          permissionPolicy: resolveToolPermissionPolicy(
            { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'yolo' },
            'act',
          ),
          allowedPaths: [chatRoot],
        };
        const result = await registry.execute(ctx, {
          id: crypto.randomUUID(),
          name: 'view_image',
          input: { path },
        });
        expect(result.isError).toBe(false);
        expect(result.output).toContain(path!);
        // Bridge CLIs only see the tool result, so the bytes must ride on it.
        expect(result.images?.length).toBe(1);
      } finally {
        rmSync(chatRoot, { recursive: true, force: true });
      }
    } finally {
      scope.cleanup();
    }
  });
});
