import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(process.cwd(), 'src');
const SOURCE_EXTENSIONS = new Set(['.js', '.svelte', '.ts']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

describe('Lucide imports', () => {
  it('uses finite icon subpaths instead of the package barrel', () => {
    const barrelImport = new RegExp(`from\\s+['"]lucide-${'svelte'}['"]`, 'g');
    const finiteImport = new RegExp(`from\\s+['"]lucide-${'svelte'}/icons/`, 'g');
    const violations: string[] = [];
    let finiteImportCount = 0;

    for (const path of sourceFiles(SOURCE_ROOT)) {
      const source = readFileSync(path, 'utf8');
      if (barrelImport.test(source)) violations.push(path);
      finiteImportCount += source.match(finiteImport)?.length ?? 0;
      barrelImport.lastIndex = 0;
    }

    expect(violations).toEqual([]);
    expect(finiteImportCount).toBeGreaterThan(100);
  });
});
