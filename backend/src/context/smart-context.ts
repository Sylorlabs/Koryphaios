// Smart Context Detection
// Automatically figures out what files to include based on imports, errors, recent changes

import { readFileSync, existsSync } from 'fs';
import { join, dirname, extname, relative } from 'path';
import { PROJECT_ROOT } from '../runtime/paths';
import { serverLog } from '../logger';
import { execSync } from 'child_process';

export interface ContextHints {
  recentErrors?: Array<{ message: string; file?: string; line?: number }>;
  failingTests?: string[];
  lastCommitMessage?: string;
  changedFiles?: string[];
  openFiles?: string[];
  cursorFile?: string;
  cursorLine?: number;
  selectedText?: string;
  buildErrors?: Array<{ file: string; message: string }>;
  typeErrors?: Array<{ file: string; line: number; message: string }>;
}

export interface RelevantFile {
  path: string;
  relevance: number;
  reason: string;
  content?: string;
}

export class SmartContextDetector {
  private cache = new Map<string, { files: RelevantFile[]; timestamp: number }>();
  private readonly CACHE_TTL = 30 * 1000;

  async getRelevantContext(
    prompt: string,
    basePath: string,
    hints?: ContextHints,
  ): Promise<RelevantFile[]> {
    const cacheKey = `${prompt}-${hints?.cursorFile || 'none'}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.files;
    }

    const files: RelevantFile[] = [];

    // 1. Current cursor file + imports
    if (hints?.cursorFile) {
      const cursorFile = this.resolvePath(hints.cursorFile, basePath);
      if (cursorFile) {
        files.push({
          path: cursorFile,
          relevance: 100,
          reason: 'Current file (cursor position)',
          content: this.readFileSafe(cursorFile),
        });

        const imports = await this.extractImports(cursorFile);
        for (const imp of imports.slice(0, 5)) {
          if (!files.find((f) => f.path === imp)) {
            files.push({
              path: imp,
              relevance: 80,
              reason: `Imported by current file`,
              content: this.readFileSafe(imp),
            });
          }
        }
      }
    }

    // 2. Files with errors
    if (hints?.recentErrors) {
      for (const error of hints.recentErrors.slice(0, 3)) {
        if (error.file) {
          const errorFile = this.resolvePath(error.file, basePath);
          if (errorFile && !files.find((f) => f.path === errorFile)) {
            files.push({
              path: errorFile,
              relevance: 90,
              reason: `Has error: ${error.message.slice(0, 50)}...`,
              content: this.readFileSafe(errorFile),
            });
          }
        }
      }
    }

    // 3. Failing tests
    if (hints?.failingTests) {
      for (const test of hints.failingTests.slice(0, 2)) {
        const testFile = this.resolvePath(test, basePath);
        if (testFile) {
          if (!files.find((f) => f.path === testFile)) {
            files.push({
              path: testFile,
              relevance: 85,
              reason: 'Failing test',
              content: this.readFileSafe(testFile),
            });
          }

          const implFile = this.guessImplementationFromTest(testFile);
          if (implFile && !files.find((f) => f.path === implFile)) {
            files.push({
              path: implFile,
              relevance: 75,
              reason: 'Implementation for failing test',
              content: this.readFileSafe(implFile),
            });
          }
        }
      }
    }

    // 4. Recently changed files
    if (hints?.changedFiles) {
      for (const file of hints.changedFiles.slice(0, 3)) {
        const changedFile = this.resolvePath(file, basePath);
        if (changedFile && !files.find((f) => f.path === changedFile)) {
          files.push({
            path: changedFile,
            relevance: 70,
            reason: 'Recently modified',
            content: this.readFileSafe(changedFile),
          });
        }
      }
    }

    // 5. Open files
    if (hints?.openFiles) {
      for (const file of hints.openFiles) {
        const openFile = this.resolvePath(file, basePath);
        if (openFile && !files.find((f) => f.path === openFile)) {
          files.push({
            path: openFile,
            relevance: 60,
            reason: 'Open in editor',
            content: this.readFileSafe(openFile),
          });
        }
      }
    }

    // 6. Explicit file mentions in prompt
    const mentionedFiles = this.extractFileMentions(prompt, basePath);
    for (const mentioned of mentionedFiles) {
      if (!files.find((f) => f.path === mentioned)) {
        files.push({
          path: mentioned,
          relevance: 95,
          reason: 'Explicitly mentioned in prompt',
          content: this.readFileSafe(mentioned),
        });
      }
    }

    files.sort((a, b) => b.relevance - a.relevance);
    const limitedFiles = this.limitContext(files, 8000);

    this.cache.set(cacheKey, { files: limitedFiles, timestamp: Date.now() });

    serverLog.debug(
      { count: limitedFiles.length, topFiles: limitedFiles.slice(0, 3).map((f) => f.path) },
      'Smart context detected',
    );

    return limitedFiles;
  }

  private async extractImports(filePath: string): Promise<string[]> {
    const content = this.readFileSafe(filePath);
    if (!content) return [];

    const imports: string[] = [];
    const dir = dirname(filePath);

    const es6Regex = /import\s+(?:(?:{[^}]+}|[^'"]+)\s+from\s+)?['"]([^'"]+)['"];?/g;
    let match;
    while ((match = es6Regex.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath.startsWith('.')) {
        const resolved = this.resolveRelativeImport(importPath, dir);
        if (resolved) imports.push(resolved);
      }
    }

    return [...new Set(imports)];
  }

  private resolveRelativeImport(importPath: string, baseDir: string): string | null {
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx'];

    for (const ext of extensions) {
      const fullPath = join(baseDir, importPath + ext);
      if (existsSync(fullPath)) {
        return fullPath;
      }
      const indexPath = join(baseDir, importPath, `index${ext}`);
      if (existsSync(indexPath)) {
        return indexPath;
      }
    }

    return null;
  }

  private guessImplementationFromTest(testPath: string): string | null {
    const patterns = [/\.test\.(ts|tsx|js|jsx)$/, /\.spec\.(ts|tsx|js|jsx)$/, /__tests__\//];

    let implPath = testPath;
    for (const pattern of patterns) {
      implPath = implPath.replace(pattern, '');
    }

    implPath = implPath.replace(/\/(test|tests)\//, '/');

    if (implPath !== testPath && existsSync(implPath)) {
      return implPath;
    }

    return null;
  }

  private extractFileMentions(prompt: string, basePath: string): string[] {
    const mentions: string[] = [];

    const patterns = [
      /(?:file|in|from)\s+['"`]([^'"`]+\.(ts|tsx|js|jsx|py|rs|go|java))['"`]/gi,
      /['"`]([^'"`]+\.(ts|tsx|js|jsx|py|rs|go|java))['"`]/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(prompt)) !== null) {
        const file = match[1];
        const resolved = this.resolvePath(file, basePath);
        if (resolved && !mentions.includes(resolved)) {
          mentions.push(resolved);
        }
      }
    }

    return mentions;
  }

  private resolvePath(file: string, basePath: string): string | null {
    if (file.startsWith('/')) {
      return existsSync(file) ? file : null;
    }

    const resolved = join(basePath, file);
    if (existsSync(resolved)) {
      return resolved;
    }

    const fromRoot = join(PROJECT_ROOT, file);
    if (existsSync(fromRoot)) {
      return fromRoot;
    }

    return null;
  }

  private readFileSafe(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return undefined;
    }
  }

  private limitContext(files: RelevantFile[], maxTokens: number): RelevantFile[] {
    const maxChars = maxTokens * 4;
    let totalChars = 0;
    const result: RelevantFile[] = [];

    for (const file of files) {
      const contentLength = file.content?.length ?? 0;

      if (totalChars + contentLength > maxChars && result.length > 0) {
        if (file.relevance < 80) continue;

        if (file.content) {
          const remaining = maxChars - totalChars;
          file.content = file.content.slice(0, remaining) + '\n... (truncated)';
          result.push(file);
        }
        break;
      }

      totalChars += contentLength;
      result.push(file);
    }

    return result;
  }

  async autoDetectHints(basePath: string): Promise<ContextHints> {
    const hints: ContextHints = {};

    try {
      const changedFiles = execSync(
        'git diff --name-only HEAD 2>/dev/null || git status --short 2>/dev/null',
        {
          cwd: basePath,
          encoding: 'utf-8',
        },
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => line.replace(/^\s*M\s*/, ''));

      if (changedFiles.length > 0) {
        hints.changedFiles = changedFiles;
      }

      const lastCommit = execSync('git log -1 --pretty=%B 2>/dev/null', {
        cwd: basePath,
        encoding: 'utf-8',
      }).trim();

      if (lastCommit) {
        hints.lastCommitMessage = lastCommit;
      }
    } catch {
      // Git not available
    }

    return hints;
  }
}

export const contextDetector = new SmartContextDetector();
