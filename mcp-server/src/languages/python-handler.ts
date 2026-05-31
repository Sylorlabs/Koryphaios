/**
 * Python language handler implementation
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

export class PythonHandler extends BaseLanguageHandler {
  private pythonPath: string | undefined;
  private pylintPath: string | undefined;
  private flake8Path: string | undefined;

  constructor(options: Record<string, unknown> = {}, logger?: Logger) {
    super(SupportedLanguage.PYTHON, options, logger);
  }

  getFileExtensions(): string[] {
    return ['.py', '.pyw', '.pyi'];
  }

  getConfigFiles(): string[] {
    return [
      'pyproject.toml',
      'setup.cfg',
      '.pylintrc',
      'pylint.ini',
      '.flake8',
      'tox.ini',
      'requirements.txt',
      'Pipfile',
      'poetry.lock',
    ];
  }

  protected async doInitialize(): Promise<void> {
    // Find Python interpreter
    this.pythonPath =
      (await this.findExecutable('python3')) || (await this.findExecutable('python'));
    if (!this.pythonPath) {
      throw new Error(
        'Python interpreter not found. Please install Python to use Python error detection.'
      );
    }

    // Find linting tools
    this.pylintPath = await this.findExecutable('pylint');
    this.flake8Path = await this.findExecutable('flake8');

    if (!this.pylintPath && !this.flake8Path) {
      this.logger.warn(
        'No Python linting tools found. Install pylint or flake8 for better error detection.'
      );
    }

    this.logger.info('Python handler initialized', {
      pythonPath: this.pythonPath,
      pylintPath: this.pylintPath,
      flake8Path: this.flake8Path,
    });
  }

  protected async doDispose(): Promise<void> {
    this.pythonPath = undefined;
    this.pylintPath = undefined;
    this.flake8Path = undefined;
  }

  protected async checkAvailability(): Promise<boolean> {
    try {
      const result = await this.runCommand(this.pythonPath!, ['--version']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async detectErrors(source: string, options?: DetectionOptions): Promise<LanguageError[]> {
    const errors: LanguageError[] = [];

    // Syntax validation using Python
    const syntaxErrors = await this.validateSyntax(source);
    errors.push(...syntaxErrors);

    // Linting with available tools
    if (options?.enableLinting !== false) {
      if (this.pylintPath) {
        const pylintErrors = await this.runPylint(source, options?.filePath || 'temp.py');
        errors.push(...pylintErrors);
      } else if (this.flake8Path) {
        const flake8Errors = await this.runFlake8(source, options?.filePath || 'temp.py');
        errors.push(...flake8Errors);
      }
    }

    return errors;
  }

  protected async validateSyntax(source: string): Promise<LanguageError[]> {
    try {
      const tempFile = `/tmp/py-syntax-check-${Date.now()}.py`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand(this.pythonPath!, ['-m', 'py_compile', tempFile]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      if (result.exitCode === 0) {
        return [];
      }

      return this.parsePythonErrors(result.stderr, 'temp.py');
    } catch (error) {
      return [
        this.createError(
          `Syntax validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'temp.py',
          1,
          1,
          'error'
        ),
      ];
    }
  }

  private async runPylint(source: string, filePath: string): Promise<LanguageError[]> {
    if (!this.pylintPath) {
      return [];
    }

    try {
      const tempFile = `/tmp/pylint-check-${Date.now()}.py`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand(this.pylintPath, [
        '--output-format=json',
        '--disable=all',
        '--enable=syntax-error,undefined-variable,unused-variable,import-error',
        tempFile,
      ]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      if (result.stdout) {
        return this.parsePylintOutput(result.stdout, filePath);
      }

      return [];
    } catch (error) {
      this.logger.debug('Pylint execution failed', error);
      return [];
    }
  }

  private async runFlake8(source: string, filePath: string): Promise<LanguageError[]> {
    if (!this.flake8Path) {
      return [];
    }

    try {
      const tempFile = `/tmp/flake8-check-${Date.now()}.py`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand(this.flake8Path, [
        '--format=%(path)s:%(row)d:%(col)d: %(code)s %(text)s',
        tempFile,
      ]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      return this.parseFlake8Output(result.stdout, filePath);
    } catch (error) {
      this.logger.debug('Flake8 execution failed', error);
      return [];
    }
  }

  private parsePythonErrors(stderr: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = stderr.split('\n');

    for (const line of lines) {
      // Parse Python syntax errors
      const match = line.match(/File "(.+)", line (\d+)/);
      if (match) {
        const nextLine = lines[lines.indexOf(line) + 1];
        if (nextLine && nextLine.includes('SyntaxError')) {
          const errorMatch = nextLine.match(/SyntaxError: (.+)/);
          if (errorMatch) {
            errors.push(
              this.createError(
                errorMatch[1] || 'Syntax error',
                filePath,
                parseInt(match[2] || '1'),
                1,
                'error',
                'SyntaxError'
              )
            );
          }
        }
      }
    }

    return errors;
  }

  private parsePylintOutput(output: string, filePath: string): LanguageError[] {
    try {
      const results = JSON.parse(output);
      const errors: LanguageError[] = [];

      for (const result of results) {
        errors.push(
          this.createError(
            result.message,
            filePath,
            result.line || 1,
            result.column || 1,
            this.mapPylintSeverity(result.type),
            result['message-id']
          )
        );
      }

      return errors;
    } catch {
      return [];
    }
  }

  private parseFlake8Output(output: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const match = line.match(/(.+):(\d+):(\d+): (\w+) (.+)/);
      if (match) {
        errors.push(
          this.createError(
            match[5] || 'Unknown error',
            filePath,
            parseInt(match[2] || '1'),
            parseInt(match[3] || '1'),
            this.mapFlake8Severity(match[4] || ''),
            match[4]
          )
        );
      }
    }

    return errors;
  }

  private mapPylintSeverity(type: string): 'error' | 'warning' | 'info' | 'hint' {
    switch (type) {
      case 'error':
      case 'fatal':
        return 'error';
      case 'warning':
        return 'warning';
      case 'refactor':
      case 'convention':
        return 'info';
      default:
        return 'hint';
    }
  }

  private mapFlake8Severity(code: string): 'error' | 'warning' | 'info' | 'hint' {
    if (code.startsWith('E')) return 'error';
    if (code.startsWith('W')) return 'warning';
    if (code.startsWith('F')) return 'error';
    return 'info';
  }

  parseStackTrace(stackTrace: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = stackTrace.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const match = line.match(/File "(.+)", line (\d+), in (.+)/);
      if (match) {
        frames.push({
          function: match[3] || '<unknown>',
          file: match[1] || '<unknown>',
          line: parseInt(match[2] || '1'),
          column: 1, // Python stack traces don't include column info
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
    // This would integrate with Python debugger (pdb, debugpy)
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
      /SyntaxError: (.+)/,
      /IndentationError: (.+)/,
      /NameError: (.+)/,
      /TypeError: (.+)/,
      /ValueError: (.+)/,
      /AttributeError: (.+)/,
      /ImportError: (.+)/,
      /ModuleNotFoundError: (.+)/,
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
    const patterns = [
      /\bif\b/g,
      /\belif\b/g,
      /\belse\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\btry\b/g,
      /\bexcept\b/g,
      /\bwith\b/g,
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

    if (source.includes('for ') && source.includes(' in range(len(')) {
      suggestions.push('Consider using enumerate() instead of range(len())');
    }

    if (source.includes('list(') && source.includes('.keys())')) {
      suggestions.push('Dictionary keys() already returns an iterable in Python 3');
    }

    if (source.match(/\+\s*=.*\[/)) {
      suggestions.push('Consider using list.extend() instead of += for list concatenation');
    }

    return suggestions;
  }
}
