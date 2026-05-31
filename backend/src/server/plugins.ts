import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { serverLog } from '../logger';
import { BACKEND_ROOT, PROJECT_ROOT } from '../runtime/paths';
import type { ToolRegistry } from '../tools';

/**
 * Load local plugins from valid plugin directories
 */
export async function loadPlugins(registry: ToolRegistry) {
  const candidates = [join(BACKEND_ROOT, 'src', 'plugins'), join(PROJECT_ROOT, 'plugins')];

  const loaded = new Set<string>();

  for (const pluginsDir of candidates) {
    if (!existsSync(pluginsDir)) continue;

    try {
      const files = readdirSync(pluginsDir);

      for (const file of files) {
        if ((file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts')) {
          try {
            const modulePath = join(pluginsDir, file);
            const module = await import(modulePath);
            const ToolClass = module.default;

            if (ToolClass && typeof ToolClass === 'function') {
              const toolInstance = new ToolClass();
              if (toolInstance.name && typeof toolInstance.run === 'function') {
                if (loaded.has(toolInstance.name)) continue;
                registry.register(toolInstance);
                loaded.add(toolInstance.name);
                serverLog.debug(
                  { plugin: toolInstance.name, path: pluginsDir },
                  'Loaded local plugin',
                );
              }
            }
          } catch (err) {
            serverLog.warn({ file, err }, 'Failed to load plugin');
          }
        }
      }
    } catch (err) {
      serverLog.warn({ pluginsDir, err }, 'Error scanning plugins directory');
    }
  }

  if (loaded.size > 0) {
    serverLog.info({ count: loaded.size }, 'Loaded local plugins');
  }
}
