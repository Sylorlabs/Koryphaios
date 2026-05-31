/**
 * Multi-Language Compilation Detector
 * Detects compilation issues across multiple programming languages
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { watch, type FSWatcher } from 'chokidar';

import {
  BaseErrorDetector,
  type ErrorDetectorOptions,
  type ErrorDetectorCapabilities,
} from './base-detector.js';
import type { DetectedError, ErrorSource } from '@/types/index.js';
import { ErrorCategory, ErrorSeverity } from '@/types/errors.js';
import { Logger } from '@/utils/logger.js';

export interface LanguageCompilerConfig {
  language: string;
  extensions: string[];
  compiler: string;
  compileArgs: string[];
  checkArgs: string[];
  configFiles: string[];
  outputDir?: string;
  errorPatterns: RegExp[];
  warningPatterns: RegExp[];
  enabled: boolean;
  version?: string;
}

export interface MultiLanguageConfig {
  workspaceRoot: string;
  languages: LanguageCompilerConfig[];
  watchFiles: boolean;
  parallelCompilation: boolean;
  maxConcurrentCompilations: number;
  timeoutMs: number;
  includeWarnings: boolean;
  crossLanguageAnalysis: boolean;
}

export interface CompilationResult {
  language: string;
  success: boolean;
  errors: DetectedError[];
  warnings: DetectedError[];
  duration: number;
  output: string;
  exitCode: number | null;
}

export class MultiLanguageDetector extends BaseErrorDetector {
  private config: MultiLanguageConfig;
  private logger: Logger;
  private fileWatcher: FSWatcher | null = null;
  private compilationQueue: Map<string, Promise<CompilationResult>> = new Map();
  private lastCompilationTimes: Map<string, number> = new Map();

  constructor(options: ErrorDetectorOptions, config?: Partial<MultiLanguageConfig>) {
    super(options);
    this.logger = new Logger('info', { logFile: undefined });

    this.config = {
      workspaceRoot: process.cwd(),
      watchFiles: true,
      parallelCompilation: true,
      maxConcurrentCompilations: 3,
      timeoutMs: 60000,
      includeWarnings: false,
      crossLanguageAnalysis: true,
      languages: this.getDefaultLanguageConfigs(),
      ...config,
    };
  }

  getSource(): ErrorSource {
    return {
      type: 'build',
      tool: 'multi-language-detector',
      version: '1.0.0',
      configuration: {
        enabledLanguages: this.config.languages.filter(l => l.enabled).map(l => l.language),
        parallelCompilation: this.config.parallelCompilation,
        crossLanguageAnalysis: this.config.crossLanguageAnalysis,
      },
    };
  }

  getCapabilities(): ErrorDetectorCapabilities {
    return {
      supportsRealTime: true,
      supportsPolling: true,
      supportsFileWatching: true,
      supportedLanguages: this.config.languages.map(l => l.language),
      supportedFrameworks: [
        'typescript',
        'babel',
        'swc',
        'esbuild',
        'rustc',
        'cargo',
        'go',
        'gofmt',
        'javac',
        'maven',
        'gradle',
        'python',
        'mypy',
        'pyflakes',
        'gcc',
        'clang',
        'make',
        'cmake',
        'csc',
        'msbuild',
        'dotnet',
      ],
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting multi-language detector');

    try {
      // Detect available compilers
      await this.detectAvailableCompilers();

      // Start file watching if enabled
      if (this.options.realTime && this.config.watchFiles) {
        await this.startFileWatching();
      }

      // Start polling if enabled
      if (this.options.polling) {
        this.startPolling();
      }

      this.emit('detector-started');
      this.logger.info('Multi-language detector started successfully');
    } catch (error) {
      this.isRunning = false;
      this.emit('detector-error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.logger.info('Stopping multi-language detector');

    // Stop file watching
    if (this.fileWatcher) {
      await this.fileWatcher.close();
      this.fileWatcher = null;
    }

    // Wait for ongoing compilations to complete
    await Promise.allSettled(this.compilationQueue.values());
    this.compilationQueue.clear();

    this.emit('detector-stopped');
    this.logger.info('Multi-language detector stopped');
  }

  async detectErrors(target?: string): Promise<DetectedError[]> {
    if (!this.isRunning) {
      await this.start();
    }

    const errors: DetectedError[] = [];

    try {
      if (target) {
        // Compile specific file or project
        const targetErrors = await this.compileTarget(target);
        errors.push(...targetErrors);
      } else {
        // Compile all enabled languages
        const compilationResults = await this.compileAllLanguages();
        for (const result of compilationResults) {
          errors.push(...result.errors);
          if (this.config.includeWarnings) {
            errors.push(...result.warnings);
          }
        }
      }

      // Add buffered errors
      const bufferedErrors = this.getBufferedErrors();
      errors.push(...bufferedErrors);

      // Perform cross-language analysis if enabled
      if (this.config.crossLanguageAnalysis && errors.length > 0) {
        const crossLanguageErrors = this.performCrossLanguageAnalysis(errors);
        errors.push(...crossLanguageErrors);
      }
    } catch (error) {
      this.logger.error('Error during multi-language detection', error);
      this.emit('detector-error', error);
    }

    return errors;
  }

  private getDefaultLanguageConfigs(): LanguageCompilerConfig[] {
    return [
      {
        language: 'typescript',
        extensions: ['.ts', '.tsx'],
        compiler: 'tsc',
        compileArgs: ['--noEmit'],
        checkArgs: ['--noEmit', '--skipLibCheck'],
        configFiles: ['tsconfig.json'],
        errorPatterns: [
          /error TS\d+:/i,
          /Cannot find module/i,
          /Type .* is not assignable to type/i,
          /Property .* does not exist on type/i,
        ],
        warningPatterns: [/warning TS\d+:/i],
        enabled: true,
      },
      {
        language: 'rust',
        extensions: ['.rs'],
        compiler: 'rustc',
        compileArgs: ['--check'],
        checkArgs: ['--check', '--emit=metadata'],
        configFiles: ['Cargo.toml'],
        errorPatterns: [/error\[E\d+\]/i, /cannot find/i, /mismatched types/i, /borrow checker/i],
        warningPatterns: [/warning:/i],
        enabled: true,
      },
      {
        language: 'go',
        extensions: ['.go'],
        compiler: 'go',
        compileArgs: ['build', '-o', '/dev/null'],
        checkArgs: ['vet'],
        configFiles: ['go.mod'],
        errorPatterns: [
          /cannot find package/i,
          /undefined:/i,
          /syntax error/i,
          /type .* is not an expression/i,
        ],
        warningPatterns: [/warning:/i],
        enabled: true,
      },
      {
        language: 'java',
        extensions: ['.java'],
        compiler: 'javac',
        compileArgs: ['-cp', '.'],
        checkArgs: ['-Xlint:all'],
        configFiles: ['pom.xml', 'build.gradle'],
        errorPatterns: [
          /error:/i,
          /cannot find symbol/i,
          /incompatible types/i,
          /class .* is public, should be declared in a file named/i,
        ],
        warningPatterns: [/warning:/i, /Note:/i],
        enabled: true,
      },
      {
        language: 'python',
        extensions: ['.py'],
        compiler: 'python',
        compileArgs: ['-m', 'py_compile'],
        checkArgs: ['-m', 'mypy'],
        configFiles: ['pyproject.toml', 'setup.py', 'requirements.txt'],
        errorPatterns: [/SyntaxError/i, /IndentationError/i, /NameError/i, /TypeError/i, /error:/i],
        warningPatterns: [/warning:/i],
        enabled: true,
      },
      {
        language: 'c',
        extensions: ['.c', '.h'],
        compiler: 'gcc',
        compileArgs: ['-c', '-o', '/dev/null'],
        checkArgs: ['-Wall', '-Wextra', '-fsyntax-only'],
        configFiles: ['Makefile', 'CMakeLists.txt'],
        errorPatterns: [
          /error:/i,
          /undefined reference/i,
          /conflicting types/i,
          /implicit declaration/i,
        ],
        warningPatterns: [/warning:/i],
        enabled: true,
      },
      {
        language: 'cpp',
        extensions: ['.cpp', '.cxx', '.cc', '.hpp'],
        compiler: 'g++',
        compileArgs: ['-c', '-o', '/dev/null'],
        checkArgs: ['-Wall', '-Wextra', '-fsyntax-only'],
        configFiles: ['Makefile', 'CMakeLists.txt'],
        errorPatterns: [
          /error:/i,
          /undefined reference/i,
          /no matching function/i,
          /template argument deduction/i,
        ],
        warningPatterns: [/warning:/i],
        enabled: true,
      },
      {
        language: 'csharp',
        extensions: ['.cs'],
        compiler: 'csc',
        compileArgs: ['/nologo', '/t:library'],
        checkArgs: ['/nologo', '/t:library', '/warnaserror'],
        configFiles: ['*.csproj', '*.sln'],
        errorPatterns: [
          /error CS\d+:/i,
          /The name .* does not exist/i,
          /Cannot convert type/i,
          /The type or namespace .* could not be found/i,
        ],
        warningPatterns: [/warning CS\d+:/i],
        enabled: true,
      },
    ];
  }

  private async detectAvailableCompilers(): Promise<void> {
    for (const langConfig of this.config.languages) {
      if (!langConfig.enabled) continue;

      try {
        const process = spawn(langConfig.compiler, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        });

        await new Promise<void>(resolve => {
          let output = '';

          process.stdout?.on('data', data => {
            output += data.toString();
          });

          process.on('close', code => {
            if (code === 0) {
              // Extract version from output
              const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
              if (versionMatch && versionMatch[1]) {
                langConfig.version = versionMatch[1];
              }
              this.logger.debug(
                `${langConfig.language} compiler available: ${langConfig.compiler} ${langConfig.version || ''}`
              );
            } else {
              this.logger.debug(
                `${langConfig.language} compiler not available: ${langConfig.compiler}`
              );
              langConfig.enabled = false;
            }
            resolve();
          });

          process.on('error', () => {
            this.logger.debug(`${langConfig.language} compiler not found: ${langConfig.compiler}`);
            langConfig.enabled = false;
            resolve();
          });
        });
      } catch (error) {
        this.logger.debug(`Failed to check ${langConfig.language} compiler`, error);
        langConfig.enabled = false;
      }
    }
  }

  private async startFileWatching(): Promise<void> {
    const watchPatterns: string[] = [];

    // Add source file patterns
    for (const langConfig of this.config.languages.filter(l => l.enabled)) {
      for (const ext of langConfig.extensions) {
        watchPatterns.push(join(this.config.workspaceRoot, `**/*${ext}`));
      }

      // Add config file patterns
      for (const configFile of langConfig.configFiles) {
        watchPatterns.push(join(this.config.workspaceRoot, configFile));
      }
    }

    this.fileWatcher = watch(watchPatterns, {
      ignored: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/dist/**', '**/build/**'],
      persistent: true,
      ignoreInitial: true,
    });

    this.fileWatcher.on('change', async (filePath: string) => {
      this.logger.debug('File changed', { filePath });
      await this.handleFileChange(filePath);
    });

    this.fileWatcher.on('add', async (filePath: string) => {
      this.logger.debug('File added', { filePath });
      await this.handleFileChange(filePath);
    });

    this.fileWatcher.on('error', (error: Error) => {
      this.logger.error('File watcher error', error);
      this.emit('detector-error', error);
    });
  }

  private async handleFileChange(filePath: string): Promise<void> {
    const ext = extname(filePath);
    const relevantLanguages = this.config.languages.filter(
      lang => lang.enabled && lang.extensions.includes(ext)
    );

    for (const langConfig of relevantLanguages) {
      // Debounce compilation
      const lastCompilation = this.lastCompilationTimes.get(langConfig.language) || 0;
      const now = Date.now();

      if (now - lastCompilation < 1000) {
        // 1 second debounce
        continue;
      }

      this.lastCompilationTimes.set(langConfig.language, now);

      try {
        const result = await this.compileLanguage(langConfig, filePath);

        // Emit errors immediately for real-time feedback
        for (const error of result.errors) {
          this.addToBuffer(error);
          this.emit('error-detected', error);
        }

        if (this.config.includeWarnings) {
          for (const warning of result.warnings) {
            this.addToBuffer(warning);
            this.emit('warning-detected', warning);
          }
        }
      } catch (error) {
        this.logger.error(`Compilation failed for ${langConfig.language}`, error);
      }
    }
  }

  private startPolling(): void {
    const pollInterval = this.options.polling?.interval || 60000; // 1 minute default

    setTimeout(async () => {
      if (this.isRunning) {
        await this.compileAllLanguages();
        this.startPolling(); // Schedule next poll
      }
    }, pollInterval);
  }

  private async compileAllLanguages(): Promise<CompilationResult[]> {
    const enabledLanguages = this.config.languages.filter(l => l.enabled);
    const results: CompilationResult[] = [];

    if (this.config.parallelCompilation) {
      // Compile in parallel with concurrency limit
      const chunks = this.chunkArray(enabledLanguages, this.config.maxConcurrentCompilations);

      for (const chunk of chunks) {
        const promises = chunk.map(lang => this.compileLanguage(lang));
        const chunkResults = await Promise.allSettled(promises);

        for (const result of chunkResults) {
          if (result.status === 'fulfilled') {
            results.push(result.value);
          }
        }
      }
    } else {
      // Compile sequentially
      for (const langConfig of enabledLanguages) {
        const result = await this.compileLanguage(langConfig);
        results.push(result);
      }
    }

    return results;
  }

  private async compileLanguage(
    langConfig: LanguageCompilerConfig,
    specificFile?: string
  ): Promise<CompilationResult> {
    // Generate compilation ID for tracking
    // const compilationId = `${langConfig.language}-${Date.now()}`;

    // Check if compilation is already in progress
    const existingCompilation = this.compilationQueue.get(langConfig.language);
    if (existingCompilation) {
      return await existingCompilation;
    }

    const compilationPromise = this.performCompilation(langConfig, specificFile);
    this.compilationQueue.set(langConfig.language, compilationPromise);

    try {
      const result = await compilationPromise;
      return result;
    } finally {
      this.compilationQueue.delete(langConfig.language);
    }
  }

  private async performCompilation(
    langConfig: LanguageCompilerConfig,
    specificFile?: string
  ): Promise<CompilationResult> {
    const startTime = Date.now();
    const errors: DetectedError[] = [];
    const warnings: DetectedError[] = [];
    let output = '';
    let exitCode: number | null = null;

    try {
      this.logger.info(
        `Compiling ${langConfig.language}${specificFile ? ` (${specificFile})` : ''}`
      );

      let args = [...langConfig.checkArgs];

      if (specificFile) {
        args.push(specificFile);
      } else {
        // Add all source files for the language
        const sourceFiles = await this.findSourceFiles(langConfig);
        args.push(...sourceFiles);
      }

      const process = spawn(langConfig.compiler, args, {
        cwd: this.config.workspaceRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.config.timeoutMs,
      });

      // Collect output
      process.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        this.parseCompilerOutput(chunk, langConfig, errors, warnings);
      });

      process.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        this.parseCompilerOutput(chunk, langConfig, errors, warnings);
      });

      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        process.on('close', (code, signal) => {
          exitCode = code;
          if (signal === 'SIGTERM') {
            reject(new Error('Compilation timeout'));
          } else {
            resolve();
          }
        });

        process.on('error', error => {
          reject(error);
        });
      });
    } catch (error) {
      this.logger.error(`Compilation failed for ${langConfig.language}`, error);

      const compilationError = this.createCompilationError(langConfig, error, specificFile);
      errors.push(compilationError);
    }

    const duration = Date.now() - startTime;
    const success = exitCode === 0 && errors.length === 0;

    return {
      language: langConfig.language,
      success,
      errors,
      warnings,
      duration,
      output,
      exitCode,
    };
  }

  private async findSourceFiles(langConfig: LanguageCompilerConfig): Promise<string[]> {
    const sourceFiles: string[] = [];

    try {
      const findFiles = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            // Skip common build/dependency directories
            if (
              !['node_modules', '.git', 'target', 'dist', 'build', '__pycache__'].includes(
                entry.name
              )
            ) {
              await findFiles(fullPath);
            }
          } else if (entry.isFile()) {
            const ext = extname(entry.name);
            if (langConfig.extensions.includes(ext)) {
              sourceFiles.push(fullPath);
            }
          }
        }
      };

      await findFiles(this.config.workspaceRoot);
    } catch (error) {
      this.logger.error(`Failed to find source files for ${langConfig.language}`, error);
    }

    return sourceFiles.slice(0, 100); // Limit to prevent overwhelming the compiler
  }

  private parseCompilerOutput(
    output: string,
    langConfig: LanguageCompilerConfig,
    errors: DetectedError[],
    warnings: DetectedError[]
  ): void {
    const lines = output.split('\n');

    for (const line of lines) {
      // Check for errors
      for (const pattern of langConfig.errorPatterns) {
        if (pattern.test(line)) {
          const error = this.createCompilerError(langConfig, line, 'error');
          errors.push(error);
          break;
        }
      }

      // Check for warnings
      for (const pattern of langConfig.warningPatterns) {
        if (pattern.test(line)) {
          const warning = this.createCompilerError(langConfig, line, 'warning');
          warnings.push(warning);
          break;
        }
      }
    }
  }

  private createCompilerError(
    langConfig: LanguageCompilerConfig,
    message: string,
    type: 'error' | 'warning'
  ): DetectedError {
    return {
      id: `${langConfig.language}-${type}-${Date.now()}-${Math.random()}`,
      message: message.trim(),
      type: `${langConfig.language}CompilerError`,
      category: type === 'error' ? ErrorCategory.SYNTAX : ErrorCategory.LOGICAL,
      severity: type === 'error' ? ErrorSeverity.HIGH : ErrorSeverity.MEDIUM,
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'compilation',
        metadata: {
          language: langConfig.language,
          compiler: langConfig.compiler,
          version: langConfig.version,
          type,
        },
      },
      source: this.getSource(),
      patterns: [message],
      confidence: 0.9,
    };
  }

  private createCompilationError(
    langConfig: LanguageCompilerConfig,
    error: unknown,
    specificFile?: string
  ): DetectedError {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      id: `${langConfig.language}-compilation-error-${Date.now()}`,
      message: `${langConfig.language} compilation failed: ${errorMessage}`,
      type: 'CompilationError',
      category: ErrorCategory.CONFIGURATION,
      severity: ErrorSeverity.CRITICAL,
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'compilation',
        metadata: {
          language: langConfig.language,
          compiler: langConfig.compiler,
          specificFile,
          error: errorMessage,
        },
      },
      source: this.getSource(),
      patterns: [],
      confidence: 1.0,
    };
  }

  private async compileTarget(target: string): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];
    const ext = extname(target);

    // Find relevant language configurations
    const relevantLanguages = this.config.languages.filter(
      lang => lang.enabled && lang.extensions.includes(ext)
    );

    for (const langConfig of relevantLanguages) {
      const result = await this.compileLanguage(langConfig, target);
      errors.push(...result.errors);

      if (this.config.includeWarnings) {
        errors.push(...result.warnings);
      }
    }

    return errors;
  }

  private performCrossLanguageAnalysis(errors: DetectedError[]): DetectedError[] {
    const crossLanguageErrors: DetectedError[] = [];

    // Group errors by file/location
    const errorsByFile = new Map<string, DetectedError[]>();

    for (const error of errors) {
      const file = (error.context.metadata?.['file'] as string) || 'unknown';
      if (!errorsByFile.has(file)) {
        errorsByFile.set(file, []);
      }
      errorsByFile.get(file)!.push(error);
    }

    // Look for patterns across languages
    for (const [file, fileErrors] of errorsByFile) {
      if (fileErrors.length > 1) {
        const languages = new Set(fileErrors.map(e => e.context.metadata?.['language']));

        if (languages.size > 1) {
          // Multiple languages have errors in the same file - potential interface issue
          const crossLanguageError = this.createCrossLanguageError(file, fileErrors);
          crossLanguageErrors.push(crossLanguageError);
        }
      }
    }

    return crossLanguageErrors;
  }

  private createCrossLanguageError(file: string, errors: DetectedError[]): DetectedError {
    const languages = Array.from(new Set(errors.map(e => e.context.metadata?.['language'])));

    return {
      id: `cross-language-${Date.now()}`,
      message: `Cross-language compilation issues detected in ${file} affecting: ${languages.join(', ')}`,
      type: 'CrossLanguageError',
      category: ErrorCategory.CONFIGURATION,
      severity: ErrorSeverity.HIGH,
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'compilation',
        metadata: {
          file,
          affectedLanguages: languages,
          errorCount: errors.length,
          relatedErrors: errors.map(e => e.id),
        },
      },
      source: this.getSource(),
      patterns: ['cross-language-issue'],
      confidence: 0.7,
      relatedErrors: errors.map(e => e.id),
    };
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  // Public API
  getEnabledLanguages(): LanguageCompilerConfig[] {
    return this.config.languages.filter(l => l.enabled);
  }

  getCompilationQueue(): string[] {
    return Array.from(this.compilationQueue.keys());
  }

  async forceCompilation(language?: string): Promise<CompilationResult[]> {
    if (language) {
      const langConfig = this.config.languages.find(l => l.language === language && l.enabled);
      if (langConfig) {
        const result = await this.compileLanguage(langConfig);
        return [result];
      }
      return [];
    } else {
      return await this.compileAllLanguages();
    }
  }

  updateLanguageConfig(language: string, updates: Partial<LanguageCompilerConfig>): void {
    const langConfig = this.config.languages.find(l => l.language === language);
    if (langConfig) {
      Object.assign(langConfig, updates);
      this.emit('config-updated', { language, updates });
    }
  }
}
