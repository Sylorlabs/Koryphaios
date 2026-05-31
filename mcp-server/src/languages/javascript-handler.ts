/**
 * JavaScript language handler implementation
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

export class JavaScriptHandler extends BaseLanguageHandler {
  private eslintPath: string | undefined;
  private nodePath: string | undefined;

  constructor(options: Record<string, unknown> = {}, logger?: Logger) {
    super(SupportedLanguage.JAVASCRIPT, options, logger);
  }

  getFileExtensions(): string[] {
    return ['.js', '.jsx', '.mjs', '.cjs'];
  }

  getConfigFiles(): string[] {
    return [
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml',
      'eslint.config.js',
      'package.json',
    ];
  }

  protected async doInitialize(): Promise<void> {
    // Find Node.js
    this.nodePath = await this.findExecutable('node');
    if (!this.nodePath) {
      throw new Error(
        'Node.js not found. Please install Node.js to use JavaScript error detection.'
      );
    }

    // Find ESLint
    this.eslintPath = await this.findExecutable('eslint');
    if (!this.eslintPath) {
      this.logger.warn('ESLint not found. Linting capabilities will be limited.');
    }

    this.logger.info('JavaScript handler initialized', {
      nodePath: this.nodePath,
      eslintPath: this.eslintPath,
    });
  }

  protected async doDispose(): Promise<void> {
    // Cleanup any resources
    this.nodePath = undefined;
    this.eslintPath = undefined;
  }

  protected async checkAvailability(): Promise<boolean> {
    try {
      const result = await this.runCommand('node', ['--version']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async detectErrors(source: string, options?: DetectionOptions): Promise<LanguageError[]> {
    const errors: LanguageError[] = [];

    // Syntax validation using Node.js
    const syntaxErrors = await this.validateSyntax(source);
    errors.push(...syntaxErrors);

    // ESLint validation if available
    if (this.eslintPath && options?.enableLinting !== false) {
      const lintErrors = await this.runESLint(source, options?.filePath || 'temp.js');
      errors.push(...lintErrors);
    }

    return errors;
  }

  protected async validateSyntax(source: string): Promise<LanguageError[]> {
    try {
      // Create a temporary file to check syntax
      const tempFile = `/tmp/js-syntax-check-${Date.now()}.js`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand('node', ['--check', tempFile]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      if (result.exitCode === 0) {
        return [];
      }

      // Parse Node.js syntax errors
      return this.parseNodeErrors(result.stderr, 'temp.js');
    } catch (error) {
      return [
        this.createError(
          `Syntax validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'temp.js',
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
      const tempFile = `/tmp/eslint-check-${Date.now()}.js`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand(this.eslintPath, [
        '--format',
        'json',
        '--no-eslintrc',
        '--config',
        JSON.stringify({
          env: { browser: true, node: true, es2021: true },
          extends: ['eslint:recommended'],
          parserOptions: { ecmaVersion: 2021, sourceType: 'module' },
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

  private parseNodeErrors(stderr: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = stderr.split('\n');

    for (const line of lines) {
      if (line.includes('SyntaxError')) {
        const match = line.match(/SyntaxError: (.+)/);
        if (match) {
          errors.push(
            this.createError(match[1] || 'Syntax error', filePath, 1, 1, 'error', 'SyntaxError')
          );
        }
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
      const match = line.match(/\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
      if (match) {
        frames.push({
          function: match[1] || '<unknown>',
          file: match[2] || '<unknown>',
          line: parseInt(match[3] || '1'),
          column: parseInt(match[4] || '1'),
        });
      } else {
        // Try alternative format
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
      /SyntaxError: (.+) at line (\d+), column (\d+)/,
      /ReferenceError: (.+)/,
      /TypeError: (.+)/,
      /RangeError: (.+)/,
      /Error: (.+)/,
    ];
  }

  private async findExecutable(name: string): Promise<string | undefined> {
    try {
      const result = await this.runCommand('which', [name]);
      return result.exitCode === 0 ? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
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
    // Simple complexity calculation based on control structures
    const patterns = [
      /\bif\b/g,
      /\belse\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bswitch\b/g,
      /\bcatch\b/g,
      /\?\s*:/g, // ternary operator
    ];

    let complexity = 1; // Base complexity
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

    if (source.includes('document.getElementById')) {
      suggestions.push('Consider caching DOM element references');
    }

    if (source.includes('for (') && source.includes('.length')) {
      suggestions.push('Cache array length in loops for better performance');
    }

    if (source.match(/\+\s*["']/)) {
      suggestions.push('Consider using template literals instead of string concatenation');
    }

    return suggestions;
  }
}
