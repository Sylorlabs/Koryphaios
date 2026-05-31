/**
 * Rust language handler implementation
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

export class RustHandler extends BaseLanguageHandler {
  private rustcPath: string | undefined;
  private cargoPath: string | undefined;
  private clippyPath: string | undefined;

  constructor(options: Record<string, unknown> = {}, logger?: Logger) {
    super(SupportedLanguage.RUST, options, logger);
  }

  getFileExtensions(): string[] {
    return ['.rs'];
  }

  getConfigFiles(): string[] {
    return [
      'Cargo.toml',
      'Cargo.lock',
      'rust-toolchain.toml',
      'rustfmt.toml',
      '.rustfmt.toml',
      'clippy.toml',
    ];
  }

  protected async doInitialize(): Promise<void> {
    // Find Rust compiler
    this.rustcPath = await this.findExecutable('rustc');
    this.cargoPath = await this.findExecutable('cargo');

    if (!this.rustcPath && !this.cargoPath) {
      throw new Error('Rust toolchain not found. Please install Rust to use Rust error detection.');
    }

    // Find Clippy for linting
    this.clippyPath = await this.findExecutable('cargo-clippy');
    if (!this.clippyPath && this.cargoPath) {
      // Check if clippy is available through cargo
      try {
        const result = await this.runCommand(this.cargoPath, ['clippy', '--version']);
        if (result.exitCode === 0) {
          this.clippyPath = this.cargoPath;
        }
      } catch {
        this.logger.warn('Clippy not found. Install clippy for better error detection.');
      }
    }

    this.logger.info('Rust handler initialized', {
      rustcPath: this.rustcPath,
      cargoPath: this.cargoPath,
      clippyPath: this.clippyPath,
    });
  }

  protected async doDispose(): Promise<void> {
    this.rustcPath = undefined;
    this.cargoPath = undefined;
    this.clippyPath = undefined;
  }

  protected async checkAvailability(): Promise<boolean> {
    try {
      if (this.rustcPath) {
        const result = await this.runCommand(this.rustcPath, ['--version']);
        return result.exitCode === 0;
      }
      if (this.cargoPath) {
        const result = await this.runCommand(this.cargoPath, ['--version']);
        return result.exitCode === 0;
      }
      return false;
    } catch {
      return false;
    }
  }

  async detectErrors(source: string, options?: DetectionOptions): Promise<LanguageError[]> {
    const errors: LanguageError[] = [];

    // Syntax validation using rustc
    const syntaxErrors = await this.validateSyntax(source);
    errors.push(...syntaxErrors);

    // Clippy analysis
    if (this.clippyPath && options?.enableLinting !== false) {
      const clippyErrors = await this.runClippy(source, options?.filePath || 'temp.rs');
      errors.push(...clippyErrors);
    }

    return errors;
  }

  protected async validateSyntax(source: string): Promise<LanguageError[]> {
    try {
      if (this.cargoPath) {
        return await this.validateWithCargo(source);
      } else if (this.rustcPath) {
        return await this.validateWithRustc(source);
      }
      return [];
    } catch (error) {
      return [
        this.createError(
          `Syntax validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'temp.rs',
          1,
          1,
          'error'
        ),
      ];
    }
  }

  private async validateWithCargo(source: string): Promise<LanguageError[]> {
    const tempDir = `/tmp/rust-syntax-check-${Date.now()}`;
    const srcDir = `${tempDir}/src`;
    const mainFile = `${srcDir}/main.rs`;
    const cargoFile = `${tempDir}/Cargo.toml`;

    try {
      await fs.mkdir(srcDir, { recursive: true });

      // Create a minimal Cargo.toml
      const cargoToml = `[package]
name = "temp"
version = "0.1.0"
edition = "2021"
`;
      await fs.writeFile(cargoFile, cargoToml);
      await fs.writeFile(mainFile, source);

      const result = await this.runCommand(this.cargoPath!, ['check', '--message-format=json'], {
        cwd: tempDir,
      });

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      return this.parseCargoOutput(result.stdout, 'temp.rs');
    } catch (error) {
      // Cleanup on error
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async validateWithRustc(source: string): Promise<LanguageError[]> {
    const tempFile = `/tmp/rustc-check-${Date.now()}.rs`;

    try {
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand(this.rustcPath!, [
        '--error-format=json',
        '--emit=metadata',
        '--crate-type=bin',
        tempFile,
      ]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      return this.parseRustcOutput(result.stderr, 'temp.rs');
    } catch (error) {
      // Cleanup on error
      await fs.unlink(tempFile).catch(() => {});
      throw error;
    }
  }

  private async runClippy(source: string, filePath: string): Promise<LanguageError[]> {
    if (!this.clippyPath || !this.cargoPath) {
      return [];
    }

    const tempDir = `/tmp/rust-clippy-check-${Date.now()}`;
    const srcDir = `${tempDir}/src`;
    const mainFile = `${srcDir}/main.rs`;
    const cargoFile = `${tempDir}/Cargo.toml`;

    try {
      await fs.mkdir(srcDir, { recursive: true });

      const cargoToml = `[package]
name = "temp"
version = "0.1.0"
edition = "2021"
`;
      await fs.writeFile(cargoFile, cargoToml);
      await fs.writeFile(mainFile, source);

      const result = await this.runCommand(
        this.cargoPath,
        ['clippy', '--message-format=json', '--', '-W', 'clippy::all'],
        { cwd: tempDir }
      );

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      return this.parseCargoOutput(result.stdout, filePath);
    } catch (error) {
      // Cleanup on error
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      this.logger.debug('Clippy execution failed', error);
      return [];
    }
  }

  private parseCargoOutput(output: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);

        if (message.message && message.message.spans) {
          for (const span of message.message.spans) {
            if (span.is_primary) {
              errors.push(
                this.createError(
                  message.message.message,
                  filePath,
                  span.line_start || 1,
                  span.column_start || 1,
                  this.mapRustSeverity(message.message.level),
                  message.message.code?.code
                )
              );
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return errors;
  }

  private parseRustcOutput(output: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);

        if (message.message && message.spans) {
          for (const span of message.spans) {
            if (span.is_primary) {
              errors.push(
                this.createError(
                  message.message,
                  filePath,
                  span.line_start || 1,
                  span.column_start || 1,
                  this.mapRustSeverity(message.level),
                  message.code
                )
              );
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return errors;
  }

  private mapRustSeverity(level: string): 'error' | 'warning' | 'info' | 'hint' {
    switch (level) {
      case 'error':
        return 'error';
      case 'warning':
        return 'warning';
      case 'note':
        return 'info';
      case 'help':
        return 'hint';
      default:
        return 'error';
    }
  }

  parseStackTrace(stackTrace: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = stackTrace.split('\n');

    for (const line of lines) {
      // Rust panic format: at 'main.rs:10:5'
      const match = line.match(/at '(.+):(\d+):(\d+)'/);
      if (match) {
        frames.push({
          function: '<unknown>',
          file: match[1] || '<unknown>',
          line: parseInt(match[2] || '1'),
          column: parseInt(match[3] || '1'),
        });
      } else {
        // Alternative format with function names
        const altMatch = line.match(/(\d+):\s+(.+)\s+at (.+):(\d+):(\d+)/);
        if (altMatch) {
          frames.push({
            function: altMatch[2] || '<unknown>',
            file: altMatch[3] || '<unknown>',
            line: parseInt(altMatch[4] || '1'),
            column: parseInt(altMatch[5] || '1'),
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
    // This would integrate with rust-gdb or lldb
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
      /error\[E\d+\]: (.+)/,
      /warning: (.+)/,
      /note: (.+)/,
      /help: (.+)/,
      /cannot find (.+) in this scope/,
      /mismatched types/,
      /borrow checker error/,
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
      /\bmatch\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bloop\b/g,
      /=>/g, // match arms
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

    if (source.includes('.clone()') && !source.includes('&')) {
      suggestions.push('Consider using references instead of cloning when possible');
    }

    if (source.includes('Vec::new()') && source.includes('push(')) {
      suggestions.push('Consider using Vec::with_capacity() when the size is known');
    }

    if (source.includes('String::new()') && source.includes('push_str(')) {
      suggestions.push('Consider using String::with_capacity() for better performance');
    }

    return suggestions;
  }
}
