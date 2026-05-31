/**
 * Go language handler implementation
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

export class GoHandler extends BaseLanguageHandler {
  private goPath: string | undefined;
  private golintPath: string | undefined;
  private govetPath: string | undefined;

  constructor(options: Record<string, unknown> = {}, logger?: Logger) {
    super(SupportedLanguage.GO, options, logger);
  }

  getFileExtensions(): string[] {
    return ['.go'];
  }

  getConfigFiles(): string[] {
    return ['go.mod', 'go.sum', '.golangci.yml', '.golangci.yaml', 'Makefile'];
  }

  protected async doInitialize(): Promise<void> {
    // Find Go compiler
    this.goPath = await this.findExecutable('go');
    if (!this.goPath) {
      throw new Error('Go compiler not found. Please install Go to use Go error detection.');
    }

    // Find linting tools
    this.golintPath = await this.findExecutable('golint');
    this.govetPath = await this.findExecutable('go');

    this.logger.info('Go handler initialized', {
      goPath: this.goPath,
      golintPath: this.golintPath,
      govetPath: this.govetPath,
    });
  }

  protected async doDispose(): Promise<void> {
    this.goPath = undefined;
    this.golintPath = undefined;
    this.govetPath = undefined;
  }

  protected async checkAvailability(): Promise<boolean> {
    try {
      const result = await this.runCommand(this.goPath!, ['version']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async detectErrors(source: string, options?: DetectionOptions): Promise<LanguageError[]> {
    const errors: LanguageError[] = [];

    // Syntax validation using Go compiler
    const syntaxErrors = await this.validateSyntax(source);
    errors.push(...syntaxErrors);

    // Go vet analysis
    if (options?.enableLinting !== false) {
      const vetErrors = await this.runGoVet(source, options?.filePath || 'temp.go');
      errors.push(...vetErrors);

      // Golint if available
      if (this.golintPath) {
        const lintErrors = await this.runGolint(source, options?.filePath || 'temp.go');
        errors.push(...lintErrors);
      }
    }

    return errors;
  }

  protected async validateSyntax(source: string): Promise<LanguageError[]> {
    try {
      const tempDir = `/tmp/go-syntax-check-${Date.now()}`;
      const tempFile = `${tempDir}/main.go`;

      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(tempFile, source);

      // Initialize go module
      await this.runCommand(this.goPath!, ['mod', 'init', 'temp'], { cwd: tempDir });

      const result = await this.runCommand(this.goPath!, ['build', '.'], { cwd: tempDir });

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      if (result.exitCode === 0) {
        return [];
      }

      return this.parseGoErrors(result.stderr, 'temp.go');
    } catch (error) {
      return [
        this.createError(
          `Syntax validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'temp.go',
          1,
          1,
          'error'
        ),
      ];
    }
  }

  private async runGoVet(source: string, filePath: string): Promise<LanguageError[]> {
    try {
      const tempDir = `/tmp/go-vet-check-${Date.now()}`;
      const tempFile = `${tempDir}/main.go`;

      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(tempFile, source);

      // Initialize go module
      await this.runCommand(this.goPath!, ['mod', 'init', 'temp'], { cwd: tempDir });

      const result = await this.runCommand(this.goPath!, ['vet', '.'], { cwd: tempDir });

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      return this.parseGoVetOutput(result.stderr, filePath);
    } catch (error) {
      this.logger.debug('Go vet execution failed', error);
      return [];
    }
  }

  private async runGolint(source: string, filePath: string): Promise<LanguageError[]> {
    if (!this.golintPath) {
      return [];
    }

    try {
      const tempFile = `/tmp/golint-check-${Date.now()}.go`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand(this.golintPath, [tempFile]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      return this.parseGolintOutput(result.stdout, filePath);
    } catch (error) {
      this.logger.debug('Golint execution failed', error);
      return [];
    }
  }

  private parseGoErrors(stderr: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = stderr.split('\n');

    for (const line of lines) {
      // Parse Go compiler errors: ./main.go:5:2: expected declaration, found 'IDENT' foo
      const match = line.match(/\.\/(.+):(\d+):(\d+): (.+)/);
      if (match) {
        errors.push(
          this.createError(
            match[4] || 'Unknown error',
            filePath,
            parseInt(match[2] || '1'),
            parseInt(match[3] || '1'),
            'error'
          )
        );
      }
    }

    return errors;
  }

  private parseGoVetOutput(stderr: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = stderr.split('\n');

    for (const line of lines) {
      // Parse go vet output: ./main.go:5:2: unreachable code
      const match = line.match(/\.\/(.+):(\d+):(\d+): (.+)/);
      if (match) {
        errors.push(
          this.createError(
            match[4] || 'Unknown warning',
            filePath,
            parseInt(match[2] || '1'),
            parseInt(match[3] || '1'),
            'warning'
          )
        );
      }
    }

    return errors;
  }

  private parseGolintOutput(stdout: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = stdout.split('\n');

    for (const line of lines) {
      // Parse golint output: main.go:5:1: exported function Foo should have comment
      const match = line.match(/(.+):(\d+):(\d+): (.+)/);
      if (match) {
        errors.push(
          this.createError(
            match[4] || 'Unknown info',
            filePath,
            parseInt(match[2] || '1'),
            parseInt(match[3] || '1'),
            'info'
          )
        );
      }
    }

    return errors;
  }

  parseStackTrace(stackTrace: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = stackTrace.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // Go stack trace format: main.main() /path/to/main.go:10 +0x20
      const match = line.match(/(.+)\(\)\s+(.+):(\d+)\s+\+0x[0-9a-f]+/);
      if (match) {
        frames.push({
          function: match[1] || '<unknown>',
          file: match[2] || '<unknown>',
          line: parseInt(match[3] || '1'),
          column: 1, // Go stack traces don't include column info
        });
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
      supportsHotReload: false,
      supportsRemoteDebugging: false,
      // Legacy properties for backward compatibility
      breakpoints: true,
      stepDebugging: true,
      variableInspection: true,
      callStackInspection: true,
      conditionalBreakpoints: true,
      hotReload: false,
      profiling: true,
      memoryInspection: true,
    };
  }

  async createDebugSession(_config: LanguageDebugConfig): Promise<LanguageDebugSession> {
    // This would integrate with Delve debugger
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
      /syntax error: (.+)/,
      /undefined: (.+)/,
      /cannot use (.+) as (.+) in (.+)/,
      /invalid operation: (.+)/,
      /missing return at end of function/,
      /unreachable code/,
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
    args: string[],
    options?: { cwd?: string }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: 'pipe',
        cwd: options?.cwd,
      });
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
      /\bswitch\b/g,
      /\bcase\b/g,
      /\bselect\b/g,
      /\bgo\b/g, // goroutines add complexity
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

    if (source.includes('fmt.Sprintf') && !source.includes('log')) {
      suggestions.push(
        'Consider using string concatenation or strings.Builder for better performance'
      );
    }

    if (source.includes('append(') && source.includes('for ')) {
      suggestions.push('Consider pre-allocating slice capacity when size is known');
    }

    if (source.includes('make(map') && !source.includes(', ')) {
      suggestions.push('Consider pre-allocating map capacity when size is known');
    }

    return suggestions;
  }
}
