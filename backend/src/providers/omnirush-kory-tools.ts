import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPrivateCliTextArtifact } from './private-cli-transport';
import type { ProviderToolDef } from './types';
import { canonicalizePath } from '../runtime/platform';
import { bundleOmnirushPlugin } from './omnirush-plugin-bundle' with { type: 'macro' };

const PLUGIN = await bundleOmnirushPlugin();

export function createOmnirushKoryToolsArtifact(
  tools: readonly ProviderToolDef[],
  authFile: string,
  backendUrl = 'http://127.0.0.1:3001',
  systemPrompt = '',
) {
  const artifact = createPrivateCliTextArtifact('omnirush-kory-plugin', PLUGIN, 'mjs');
  try {
    const normalized = tools.map((t) => ({
      ...t,
      name: t.name.startsWith('kory__') ? t.name : `kory__${t.name}`,
    }));
    const names = normalized.map((t) => t.name);
    if (
      new Set(names).size !== names.length ||
      names.some((n) => !/^kory__[a-zA-Z0-9_-]+$/.test(n))
    ) {
      throw new Error('Omnirush tool names must be unique Kory tool names');
    }
    const turnContent = JSON.stringify({ tools: normalized, authFile, backendUrl, systemPrompt });
    writeFileSync(join(artifact.directory, 'turn.json'), turnContent, { mode: 0o600 });
    const permission = Object.fromEntries([['*', 'deny'], ...names.map((n) => [n, 'allow'])]);
    const workspace = join(artifact.directory, 'workspace');
    const home = join(artifact.directory, 'home');
    mkdirSync(workspace, { mode: 0o700 });
    // The OpenCode project-plugin resolver only considers a checkout rooted at
    // a VCS marker. This is a disposable marker, never the user's repository.
    mkdirSync(join(workspace, '.git', 'refs', 'heads'), { recursive: true, mode: 0o700 });
    mkdirSync(join(workspace, '.git', 'refs', 'tags'), { recursive: true, mode: 0o700 });
    mkdirSync(join(workspace, '.git', 'objects'), { mode: 0o700 });
    mkdirSync(join(workspace, '.git', 'info'), { mode: 0o700 });
    writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/kory\n', { mode: 0o600 });
    writeFileSync(
      join(workspace, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tbare = false\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(workspace, '.git', 'description'),
      'Koryphaios disposable OpenCode project\n',
      { mode: 0o600 },
    );
    mkdirSync(home, { mode: 0o700 });
    const projectPluginDirectory = join(workspace, '.opencode', 'plugins', 'kory-tools');
    mkdirSync(projectPluginDirectory, { recursive: true, mode: 0o700 });
    // OpenCode 2.x discovers project plugins from `.opencode/plugins/<name>`;
    // it does not load the legacy `plugin` config key from a managed project.
    // Keep the bundled module and its per-turn settings together in that
    // disposable project root so the provider lock cannot strip the bridge.
    writeFileSync(
      join(projectPluginDirectory, 'index.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./ready.json', import.meta.url), ${JSON.stringify(JSON.stringify({ tools: names }))});\n${PLUGIN}`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(projectPluginDirectory, 'package.json'),
      JSON.stringify({ type: 'module', main: 'index.mjs' }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(projectPluginDirectory, 'turn.json'),
      JSON.stringify({
        tools: normalized,
        authFile,
        backendUrl,
        systemPrompt,
        readyFile: join(projectPluginDirectory, 'ready.json'),
      }),
      { mode: 0o600 },
    );
    const configContent = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: [pathToFileURL(artifact.path).href],
      permission,
      formatter: false,
      lsp: false,
      compaction: { auto: false },
    });
    // Omnirush 2.x strips OPENCODE_CONFIG_CONTENT while its provider lock is
    // active. Keep the same private config in the disposable project root so
    // the launcher can load the plugin through its project-config gate.
    writeFileSync(join(workspace, 'opencode.json'), configContent, { mode: 0o600 });
    return {
      artifact,
      authFile,
      workspace: canonicalizePath(workspace),
      environment: {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_STATE_HOME: join(home, 'state'),
      },
      configContent,
      assertReady() {
        let ready;
        try {
          const readyPath = existsSync(join(projectPluginDirectory, 'ready.json'))
            ? join(projectPluginDirectory, 'ready.json')
            : join(artifact.directory, 'ready.json');
          ready = JSON.parse(readFileSync(readyPath, 'utf8'));
        } catch {
          /* fail closed below */
        }
        if (JSON.stringify(ready?.tools) !== JSON.stringify(names))
          throw new Error(
            `Omnirush did not load the Kory tool plugin. Refresh or update the CLI (${existsSync(join(projectPluginDirectory, 'ready.json')) ? 'invalid-ready' : 'missing-ready'}).`,
          );
      },
    };
  } catch (error) {
    artifact.cleanup();
    throw error;
  }
}

export type OmnirushKoryToolsArtifact = ReturnType<typeof createOmnirushKoryToolsArtifact>;
