/**
 * PHP language handler implementation
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

export class PHPHandler extends BaseLanguageHandler {
  private phpPath: string | undefined;
  private phpstanPath: string | undefined;
  private phpcsPath: string | undefined;
  private composerPath: string | undefined;

  constructor(options: Record<string, unknown> = {}, logger?: Logger) {
    super(SupportedLanguage.PHP, options, logger);
  }

  getFileExtensions(): string[] {
    return ['.php', '.phtml', '.php3', '.php4', '.php5', '.phar'];
  }

  getConfigFiles(): string[] {
    return [
      'composer.json',
      'composer.lock',
      'phpunit.xml',
      'phpunit.xml.dist',
      'phpcs.xml',
      'phpcs.xml.dist',
      'phpstan.neon',
      'phpstan.neon.dist',
      'psalm.xml',
      'psalm.xml.dist',
      '.php-cs-fixer.php',
      '.php-cs-fixer.dist.php',
      'php.ini',
    ];
  }

  protected async doInitialize(): Promise<void> {
    // Find PHP executable
    this.phpPath = await this.findExecutable('php');
    if (!this.phpPath) {
      throw new Error('PHP not found. Please install PHP to use PHP error detection.');
    }

    // Find optional tools
    this.phpstanPath = await this.findExecutable('phpstan');
    if (!this.phpstanPath) {
      this.logger.warn('PHPStan not found. Static analysis capabilities will be limited.');
    }

    this.phpcsPath = await this.findExecutable('phpcs');
    if (!this.phpcsPath) {
      this.logger.warn('PHP_CodeSniffer not found. Code style checking will be limited.');
    }

    this.composerPath = await this.findExecutable('composer');
    if (!this.composerPath) {
      this.logger.warn('Composer not found. Dependency management features will be limited.');
    }

    this.logger.info('PHP handler initialized', {
      phpPath: this.phpPath,
      phpstanPath: this.phpstanPath,
      phpcsPath: this.phpcsPath,
      composerPath: this.composerPath,
    });
  }

  protected async doDispose(): Promise<void> {
    this.phpPath = undefined;
    this.phpstanPath = undefined;
    this.phpcsPath = undefined;
    this.composerPath = undefined;
  }

  protected async checkAvailability(): Promise<boolean> {
    try {
      const result = await this.runCommand('php', ['--version']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async detectErrors(source: string, options?: DetectionOptions): Promise<LanguageError[]> {
    const errors: LanguageError[] = [];

    // PHP syntax validation using php -l
    const syntaxErrors = await this.validateSyntax(source);
    errors.push(...syntaxErrors);

    // PHPStan static analysis if available
    if (this.phpstanPath && options?.enableLinting !== false) {
      const staticErrors = await this.runPHPStan(source, options?.filePath || 'temp.php');
      errors.push(...staticErrors);
    }

    // PHP_CodeSniffer if available
    if (this.phpcsPath && options?.enableLinting !== false) {
      const styleErrors = await this.runPHPCS(source, options?.filePath || 'temp.php');
      errors.push(...styleErrors);
    }

    return errors;
  }

  protected async validateSyntax(source: string): Promise<LanguageError[]> {
    try {
      const tempFile = `/tmp/php-syntax-check-${Date.now()}.php`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand('php', ['-l', tempFile]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      if (result.exitCode === 0) {
        return [];
      }

      // Parse PHP syntax errors
      return this.parsePHPErrors(result.stderr + result.stdout, 'temp.php');
    } catch (error) {
      return [
        this.createError(
          `PHP syntax validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'temp.php',
          1,
          1,
          'error'
        ),
      ];
    }
  }

  private async runPHPStan(source: string, filePath: string): Promise<LanguageError[]> {
    if (!this.phpstanPath) {
      return [];
    }

    try {
      const tempFile = `/tmp/phpstan-check-${Date.now()}.php`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand(this.phpstanPath, [
        'analyse',
        '--no-progress',
        '--error-format=json',
        '--level=max',
        tempFile,
      ]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      if (result.stdout) {
        return this.parsePHPStanOutput(result.stdout, filePath);
      }

      return [];
    } catch (error) {
      this.logger.debug('PHPStan execution failed', error);
      return [];
    }
  }

  private async runPHPCS(source: string, filePath: string): Promise<LanguageError[]> {
    if (!this.phpcsPath) {
      return [];
    }

    try {
      const tempFile = `/tmp/phpcs-check-${Date.now()}.php`;
      await fs.writeFile(tempFile, source);

      const result = await this.runCommand(this.phpcsPath, [
        '--report=json',
        '--standard=PSR12',
        tempFile,
      ]);

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      if (result.stdout) {
        return this.parsePHPCSOutput(result.stdout, filePath);
      }

      return [];
    } catch (error) {
      this.logger.debug('PHPCS execution failed', error);
      return [];
    }
  }

  private parsePHPErrors(output: string, filePath: string): LanguageError[] {
    const errors: LanguageError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Parse PHP syntax errors: "Parse error: syntax error, unexpected 'token' in file.php on line X"
      const parseMatch = line.match(/Parse error: (.+) in .+ on line (\d+)/);
      if (parseMatch) {
        errors.push(
          this.createError(
            parseMatch[1] || 'Parse error',
            filePath,
            parseInt(parseMatch[2] || '1'),
            1,
            'error'
          )
        );
        continue;
      }

      // Parse PHP fatal errors: "Fatal error: message in file.php on line X"
      const fatalMatch = line.match(/Fatal error: (.+) in .+ on line (\d+)/);
      if (fatalMatch) {
        errors.push(
          this.createError(
            fatalMatch[1] || 'Fatal error',
            filePath,
            parseInt(fatalMatch[2] || '1'),
            1,
            'error'
          )
        );
        continue;
      }

      // Parse PHP warnings: "Warning: message in file.php on line X"
      const warningMatch = line.match(/Warning: (.+) in .+ on line (\d+)/);
      if (warningMatch) {
        errors.push(
          this.createError(
            warningMatch[1] || 'Warning',
            filePath,
            parseInt(warningMatch[2] || '1'),
            1,
            'warning'
          )
        );
        continue;
      }

      // Parse PHP notices: "Notice: message in file.php on line X"
      const noticeMatch = line.match(/Notice: (.+) in .+ on line (\d+)/);
      if (noticeMatch) {
        errors.push(
          this.createError(
            noticeMatch[1] || 'Notice',
            filePath,
            parseInt(noticeMatch[2] || '1'),
            1,
            'info'
          )
        );
      }
    }

    return errors;
  }

  private parsePHPStanOutput(output: string, filePath: string): LanguageError[] {
    try {
      const result = JSON.parse(output);
      const errors: LanguageError[] = [];

      if (result.files) {
        for (const file of Object.values(result.files) as any[]) {
          for (const message of file.messages || []) {
            errors.push(this.createError(message.message, filePath, message.line || 1, 1, 'error'));
          }
        }
      }

      return errors;
    } catch {
      return [];
    }
  }

  private parsePHPCSOutput(output: string, filePath: string): LanguageError[] {
    try {
      const result = JSON.parse(output);
      const errors: LanguageError[] = [];

      if (result.files) {
        for (const file of Object.values(result.files) as any[]) {
          for (const message of file.messages || []) {
            errors.push(
              this.createError(
                message.message,
                filePath,
                message.line || 1,
                message.column || 1,
                this.mapPHPCSSeverity(message.type),
                message.source
              )
            );
          }
        }
      }

      return errors;
    } catch {
      return [];
    }
  }

  private mapPHPCSSeverity(type: string): 'error' | 'warning' | 'info' | 'hint' {
    switch (type.toLowerCase()) {
      case 'error':
        return 'error';
      case 'warning':
        return 'warning';
      default:
        return 'info';
    }
  }

  parseStackTrace(stackTrace: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = stackTrace.split('\n');

    for (const line of lines) {
      // PHP stack trace format: "#0 /path/file.php(15): function()"
      const match = line.match(/#\d+\s+(.+?)\((\d+)\):\s*(.+)/);
      if (match) {
        frames.push({
          function: match[3] || '<unknown>',
          file: match[1] || '<unknown>',
          line: parseInt(match[2] || '1'),
          column: 1,
        });
      } else {
        // Alternative format: "Fatal error: ... in /path/file.php:10"
        const altMatch = line.match(/in (.+?):(\d+)/);
        if (altMatch) {
          frames.push({
            function: '<main>',
            file: altMatch[1] || '<unknown>',
            line: parseInt(altMatch[2] || '1'),
            column: 1,
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
      supportsRemoteDebugging: true,
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
    // This would integrate with Xdebug
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
      /Parse error: (.+)/,
      /Fatal error: (.+)/,
      /Warning: (.+)/,
      /Notice: (.+)/,
      /Strict Standards: (.+)/,
      /Deprecated: (.+)/,
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
    const patterns = [
      /\bif\b/g,
      /\belse\b/g,
      /\belseif\b/g,
      /\bfor\b/g,
      /\bforeach\b/g,
      /\bwhile\b/g,
      /\bdo\b/g,
      /\bswitch\b/g,
      /\bcatch\b/g,
      /\?\s*:/g, // ternary operator
      /\bclass\b/g,
      /\binterface\b/g,
      /\btrait\b/g,
      /\bfunction\b/g,
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

    if (source.includes('mysql_')) {
      suggestions.push('Consider using PDO or MySQLi instead of deprecated mysql_ functions');
    }

    if (source.includes('eval(')) {
      suggestions.push('Avoid using eval() for security and performance reasons');
    }

    if (source.includes('include') && !source.includes('include_once')) {
      suggestions.push('Consider using include_once or require_once to avoid duplicate includes');
    }

    if (source.includes('foreach') && source.includes('array_push')) {
      suggestions.push('Direct array assignment ($array[] = $value) is faster than array_push()');
    }

    if (source.includes('count(') && source.includes('for (')) {
      suggestions.push('Cache array count in loops for better performance');
    }

    if (source.includes('file_get_contents') && source.includes('http')) {
      suggestions.push(
        'Consider using cURL for HTTP requests for better error handling and performance'
      );
    }

    if (source.includes('preg_match') && source.includes('preg_replace')) {
      suggestions.push('Consider caching compiled regex patterns for repeated use');
    }

    return suggestions;
  }
}
