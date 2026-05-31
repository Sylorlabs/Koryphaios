/**
 * TypeScript language handler implementation
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { BaseLanguageHandler } from './base-language-handler.js';
import type {
  DetectionOptions,
  LanguageError,
  StackFrame,
  LanguageDebugCapabilities,
  LanguageDebugConfig,
  LanguageDebugSession,
  PerformanceAnalysis,
} from '../types/languages.js';
import { SupportedLanguage } from '../types/languages.js';
import { Logger } from '../utils/logger.js';

export class TypeScriptHandler extends BaseLanguageHandler {
  private tscPath: string | undefined;
  private eslintPath: string | undefined;
  private nodePath: string | undefined;

  constructor(options: Record<string, unknown> = {}, logger?: Logger) {
    super(SupportedLanguage.TYPESCRIPT, options, logger);
  }

  getFileExtensions(): string[] {
    return ['.ts', '.tsx', '.d.ts'];
  }

  getConfigFiles(): string[] {
    return [
      'tsconfig.json',
      'tsconfig.build.json',
      'tsconfig.dev.json',
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml',
      'eslint.config.js',
      'package.json',
    ];
  }

  protected async doInitialize(): Promise<void> {
    // Find TypeScript compiler
    this.tscPath = await this.findExecutable('tsc');
    if (!this.tscPath) {
      throw new Error(
        'TypeScript compiler not found. Please install TypeScript to use TypeScript error detection.'
      );
    }

    // Find Node.js for runtime support
    this.nodePath = await this.findExecutable('node');
    if (!this.nodePath) {
      this.logger.warn('Node.js not found. Some TypeScript features may be limited.');
    }

    // Find ESLint for additional linting
    this.eslintPath = await this.findExecutable('eslint');
    if (!this.eslintPath) {
      this.logger.warn('ESLint not found. TypeScript-specific linting will be limited.');
    }

    this.logger.info('TypeScript handler initialized', {
      tscPath: this.tscPath,
      nodePath: this.nodePath,
      eslintPath: this.eslintPath,
    });
  }

  protected async doDispose(): Promise<void> {
    this.tscPath = undefined;
    this.nodePath = undefined;
    this.eslintPath = undefined;
  }

  protected async checkAvailability(): Promise<boolean> {
    try {
      const result = await this.runCommand(this.tscPath!, ['--version']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async detectErrors(source: string, options?: DetectionOptions): Promise<LanguageError[]> {
    const errors: LanguageError[] = [];

    // TypeScript compilation check
    const compileErrors = await this.validateSyntax(source);
    errors.push(...compileErrors);

    // ESLint validation if available and enabled
    if (this.eslintPath && options?.enableLinting !== false) {
      const lintErrors = await this.runESLint(source, options?.filePath || 'temp.ts');
      errors.push(...lintErrors);
    }

    return errors;
  }

  protected async validateSyntax(source: string): Promise<LanguageError[]> {
    try {
      const tempFile = `/tmp/ts-syntax-check-${Date.now()}.ts`;
      await fs.writeFile(tempFile, source);

      // Create a minimal tsconfig.json for the check
      const tsconfigFile = `/tmp/tsconfig-${Date.now()}.json`;
      const tsconfig = {
        compilerOptions: {
          target: 'ES2020',
          module: 'commonjs',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        files: [tempFile],
      };
      await fs.writeFile(tsconfigFile, JSON.stringify(tsconfig, null, 2));

      const result = await this.runCommand(this.tscPath!, ['--project', tsconfigFile, '--noEmit']);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});
      await fs.unlink(tsconfigFile).catch(() => {});

      if (result.exitCode === 0) {
        return [];
      }

      return this.parseTypeScriptErrors(result.stdout + result.stderr, 'temp.ts');
    } catch (error) {
      return [
        this.createError(
          `TypeScript compilation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'temp.ts',
          1,
          1,
          'error'
        ),
      ];
    }
  }

  private async runESLint(source: string, filePath: string): Promise<LanguageError[]> {
    if (!this.eslintPath) {
      return [];
    }

    try {
      const tempFile = `/tmp/eslint-ts-check-${Date.now()}.ts`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand(this.eslintPath, [
        '--format',
        'json',
        '--parser',
        '@typescript-eslint/parser',
        '--no-eslintrc',
        '--config',
        JSON.stringify({
          env: { browser: true, node: true, es2021: true },
          extends: ['eslint:recommended', '@typescript-eslint/recommended'],
          parser: '@typescript-eslint/parser',
          parserOptions: {
            ecmaVersion: 2021,
            sourceType: 'module',
          },
          plugins: ['@typescript-eslint'],
        }),
        tempFile,
      ]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      if (result.stdout) {
        return this.parseESLintOutput(result.stdout, filePath);
      }

      return [];
    } catch (error) {
      this.logger.debug('ESLint execution failed', error);
      return [];
    }
  }

  private parseTypeScriptErrors(output: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Parse TypeScript compiler errors: temp.ts(5,10): error TS2304: Cannot find name 'foo'.
      const match = line.match(/(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)/);
      if (match) {
        errors.push(
          this.createError(
            match[6] || 'Unknown error',
            filePath,
            parseInt(match[2] || '1'),
            parseInt(match[3] || '1'),
            match[4] === 'error' ? 'error' : 'warning',
            match[5]
          )
        );
      }
    }

    return errors;
  }

  private parseESLintOutput(output: string, filePath: string): LanguageError[] {
    try {
      const results = JSON.parse(output);
      const errors: LanguageError[] = [];

      for (const result of results) {
        for (const message of result.messages || []) {
          errors.push(
            this.createError(
              message.message,
              filePath,
              message.line || 1,
              message.column || 1,
              this.mapESLintSeverity(message.severity),
              message.ruleId
            )
          );
        }
      }

      return errors;
    } catch {
      return [];
    }
  }

  private mapESLintSeverity(severity: number): 'error' | 'warning' | 'info' | 'hint' {
    switch (severity) {
      case 2:
        return 'error';
      case 1:
        return 'warning';
      default:
        return 'info';
    }
  }

  parseStackTrace(stackTrace: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = stackTrace.split('\n');

    for (const line of lines) {
      // TypeScript/Node.js stack trace format
      const match = line.match(/\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
      if (match) {
        frames.push({
          function: match[1] || '<unknown>',
          file: match[2] || '<unknown>',
          line: parseInt(match[3] || '1'),
          column: parseInt(match[4] || '1'),
        });
      } else {
        // Alternative format
        const altMatch = line.match(/\s*at\s+(.+?):(\d+):(\d+)/);
        if (altMatch) {
          frames.push({
            function: '<anonymous>',
            file: altMatch[1] || '<unknown>',
            line: parseInt(altMatch[2] || '1'),
            column: parseInt(altMatch[3] || '1'),
          });
        }
      }
    }

    return frames;
  }

  getDebugCapabilities(): LanguageDebugCapabilities {
    return {
      supportsBreakpoints: true,
      supportsConditionalBreakpoints: true,
      supportsStepInto: true,
      supportsStepOver: true,
      supportsStepOut: true,
      supportsVariableInspection: true,
      supportsWatchExpressions: true,
      supportsHotReload: true,
      supportsRemoteDebugging: false,
      // Legacy properties for backward compatibility
      breakpoints: true,
      stepDebugging: true,
      variableInspection: true,
      callStackInspection: true,
      conditionalBreakpoints: true,
      hotReload: true,
      profiling: true,
      memoryInspection: true,
    };
  }

  async createDebugSession(_config: LanguageDebugConfig): Promise<LanguageDebugSession> {
    // This would integrate with Node.js debugger or Chrome DevTools Protocol
    throw new Error('Debug session creation not implemented yet');
  }

  async analyzePerformance(source: string): Promise<PerformanceAnalysis> {
    const complexity = this.calculateComplexity(source);
    return {
      complexity,
      suggestions: this.getPerformanceSuggestions(source),
      metrics: {
        linesOfCode: source.split('\n').length,
        cyclomaticComplexity: this.calculateCyclomaticComplexity(source),
      },
    };
  }

  protected getErrorPatterns(): RegExp[] {
    return [
      /error TS\d+: (.+)/,
      /SyntaxError: (.+)/,
      /ReferenceError: (.+)/,
      /TypeError: (.+)/,
      /RangeError: (.+)/,
      /Error: (.+)/,
    ];
  }

  private async findExecutable(name: string): Promise<string | undefined> {
    // Try 'which' first
    try {
      const result = await this.runCommand('which', [name]);
      if (result.exitCode === 0) {
        return result.stdout.trim();
      }
    } catch {
      // Continue to fallback search
    }

    // Search in common node_modules locations and bun cache
    const { resolve } = await import('path');
    const searchPaths = [
      resolve(process.cwd(), 'node_modules', '.bin', name),
      resolve(process.cwd(), '..', 'node_modules', '.bin', name),
      resolve(__dirname, '..', '..', 'node_modules', '.bin', name),
      resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', name),
      resolve(process.cwd(), 'node_modules', 'typescript', 'bin', name),
      resolve(process.cwd(), '..', 'node_modules', 'typescript', 'bin', name),
      resolve(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', name),
    ];

    // Also search bun's global cache for typescript
    try {
      const { glob } = await import('fast-glob');
      const bunCachePaths = await glob('**/node_modules/typescript/bin/' + name, {
        cwd: resolve(process.cwd(), 'node_modules', '.bun'),
        absolute: true,
        onlyFiles: true,
        followSymbolicLinks: true,
      });
      searchPaths.push(...bunCachePaths);
    } catch {
      // Ignore glob errors
    }

    const { access } = await import('fs/promises');
    for (const candidate of searchPaths) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue searching
      }
    }

    return undefined;
  }

  private async runCommand(
    command: string,
    args: string[]
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', data => {
        stdout += data.toString();
      });

      child.stderr?.on('data', data => {
        stderr += data.toString();
      });

      child.on('close', code => {
        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
        });
      });

      child.on('error', reject);
    });
  }

  private calculateComplexity(source: string): number {
    const patterns = [
      /\bif\b/g,
      /\belse\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bswitch\b/g,
      /\bcatch\b/g,
      /\?\s*:/g, // ternary operator
      /\binterface\b/g,
      /\btype\b/g,
      /\bclass\b/g,
    ];

    let complexity = 1;
    for (const pattern of patterns) {
      const matches = source.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return complexity;
  }

  private calculateCyclomaticComplexity(source: string): number {
    return this.calculateComplexity(source);
  }

  private getPerformanceSuggestions(source: string): string[] {
    const suggestions: string[] = [];

    if (source.includes('any')) {
      suggestions.push('Avoid using "any" type for better type safety and performance');
    }

    if (source.includes('document.getElementById')) {
      suggestions.push('Consider caching DOM element references');
    }

    if (source.includes('for (') && source.includes('.length')) {
      suggestions.push('Cache array length in loops for better performance');
    }

    if (source.match(/\+\s*["'`]/)) {
      suggestions.push('Consider using template literals instead of string concatenation');
    }

    if (source.includes('JSON.parse') && !source.includes('try')) {
      suggestions.push('Wrap JSON.parse in try-catch for error handling');
    }

    return suggestions;
  }
}
