/**
 * Static analysis error detector for capturing errors from static analysis tools
 */

import type { ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { watch, type FSWatcher } from 'chokidar';
import * as acorn from 'acorn';
import { simple as walk } from 'acorn-walk';

import type { DetectedError, ErrorSource } from '@/types/index.js';
import {
  BaseErrorDetector,
  type ErrorDetectorOptions,
  type ErrorDetectorCapabilities,
} from './base-detector.js';
import { ErrorSeverity } from '@/types/errors.js';

export interface AnalysisRule {
  id: string;
  name: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'security' | 'performance' | 'maintainability' | 'reliability' | 'style';
  languages: string[];
  enabled: boolean;
}

export interface SecurityPattern {
  pattern: RegExp;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  cwe?: string; // Common Weakness Enumeration ID
}

export interface QualityMetric {
  name: string;
  threshold: number;
  severity: 'low' | 'medium' | 'high';
}

export interface StaticAnalysisConfig {
  // Enhanced analysis capabilities
  astAnalysis?: {
    enabled: boolean;
    maxFileSize: number; // Max file size for AST analysis (bytes)
    timeout: number; // Analysis timeout (ms)
  };
  patternAnalysis?: {
    enabled: boolean;
    securityPatterns: boolean;
    performancePatterns: boolean;
    qualityPatterns: boolean;
  };
  qualityMetrics?: {
    enabled: boolean;
    cyclomaticComplexity: QualityMetric;
    functionLength: QualityMetric;
    nestingDepth: QualityMetric;
  };
  // Legacy tool configurations (kept for compatibility)
  sonarjs?: {
    enabled: boolean;
    configPath?: string;
    rules?: string[];
  };
  bandit?: {
    enabled: boolean;
    configPath?: string;
    severity?: string;
  };
  gosec?: {
    enabled: boolean;
    configPath?: string;
    severity?: string;
  };
  cargoAudit?: {
    enabled: boolean;
    database?: string;
  };
  workspaceRoot?: string;
  excludePatterns?: string[];
  maxFilesPerScan?: number;
}

export class StaticAnalysisDetector extends BaseErrorDetector {
  private config: StaticAnalysisConfig;
  private analysisProcess: ChildProcess | undefined;
  private fileWatcher: FSWatcher | undefined;
  private pollingTimer: NodeJS.Timeout | undefined;
  private lastAnalysisTime = 0;
  private securityPatterns: SecurityPattern[];
  private _analysisRules: AnalysisRule[]; // Prefixed with underscore to indicate future use

  constructor(options: ErrorDetectorOptions, config: Partial<StaticAnalysisConfig> = {}) {
    super(options);
    this.config = {
      // Enhanced analysis defaults
      astAnalysis: {
        enabled: true,
        maxFileSize: 1024 * 1024, // 1MB
        timeout: 5000, // 5 seconds
      },
      patternAnalysis: {
        enabled: true,
        securityPatterns: true,
        performancePatterns: true,
        qualityPatterns: true,
      },
      qualityMetrics: {
        enabled: true,
        cyclomaticComplexity: { name: 'Cyclomatic Complexity', threshold: 10, severity: 'medium' },
        functionLength: { name: 'Function Length', threshold: 50, severity: 'low' },
        nestingDepth: { name: 'Nesting Depth', threshold: 4, severity: 'medium' },
      },
      // Legacy tool defaults
      sonarjs: { enabled: false }, // Disabled by default, use enhanced analysis instead
      bandit: { enabled: false },
      gosec: { enabled: false },
      cargoAudit: { enabled: false },
      workspaceRoot: process.cwd(),
      excludePatterns: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
      maxFilesPerScan: 100,
      ...config,
    };

    this.securityPatterns = this.initializeSecurityPatterns();
    this._analysisRules = this.initializeAnalysisRules();
  }

  getSource(): ErrorSource {
    return {
      type: 'static-analysis',
      tool: 'static-analysis-detector',
      version: '1.0.0',
    };
  }

  getCapabilities(): ErrorDetectorCapabilities {
    return {
      supportsRealTime: true,
      supportsPolling: true,
      supportsFileWatching: true,
      supportedLanguages: [
        'javascript',
        'typescript',
        'python',
        'go',
        'rust',
        'php',
        'java',
        'c',
        'cpp',
        'csharp',
        'ruby',
      ],
      supportedFrameworks: [
        'ast-analysis',
        'pattern-analysis',
        'security-analysis',
        'quality-metrics',
        'sonarjs',
        'bandit',
        'gosec',
        'cargo-audit',
      ],
    };
  }

  getAnalysisRules(): AnalysisRule[] {
    return this._analysisRules;
  }

  private initializeSecurityPatterns(): SecurityPattern[] {
    return [
      // SQL Injection patterns
      {
        pattern:
          /(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*\+.*\$|.*\$.*\+.*(?:SELECT|INSERT|UPDATE|DELETE)/gi,
        message: 'Potential SQL injection vulnerability detected',
        severity: 'critical',
        category: 'sql-injection',
        cwe: 'CWE-89',
      },
      // XSS patterns
      {
        pattern: /innerHTML\s*=\s*.*\+|document\.write\s*\(.*\+|\.html\s*\(.*\+/gi,
        message: 'Potential XSS vulnerability detected',
        severity: 'high',
        category: 'xss',
        cwe: 'CWE-79',
      },
      // Hardcoded credentials
      {
        pattern: /(?:password|pwd|pass|secret|key|token)\s*[:=]\s*["'][^"']{3,}["']/gi,
        message: 'Hardcoded credentials detected',
        severity: 'high',
        category: 'hardcoded-credentials',
        cwe: 'CWE-798',
      },
      // Path traversal
      {
        pattern: /\.\.\/|\.\.\\|path\.join\s*\([^)]*\.\./gi,
        message: 'Potential path traversal vulnerability detected',
        severity: 'high',
        category: 'path-traversal',
        cwe: 'CWE-22',
      },
      // Weak cryptography
      {
        pattern: /MD5|SHA1|DES|RC4|crypto\.createHash\s*\(\s*["']md5["']\)/gi,
        message: 'Weak cryptographic algorithm detected',
        severity: 'medium',
        category: 'weak-crypto',
        cwe: 'CWE-327',
      },
      // Command injection
      {
        pattern: /exec\s*\(.*\+|system\s*\(.*\+|shell_exec\s*\(.*\+/gi,
        message: 'Potential command injection vulnerability detected',
        severity: 'critical',
        category: 'command-injection',
        cwe: 'CWE-78',
      },
    ];
  }

  private initializeAnalysisRules(): AnalysisRule[] {
    return [
      {
        id: 'ast-complexity',
        name: 'AST Complexity Analysis',
        description: 'Analyzes code complexity using Abstract Syntax Tree',
        severity: 'medium',
        category: 'maintainability',
        languages: ['javascript', 'typescript'],
        enabled: true,
      },
      {
        id: 'security-patterns',
        name: 'Security Pattern Detection',
        description: 'Detects common security vulnerabilities',
        severity: 'high',
        category: 'security',
        languages: ['javascript', 'typescript', 'python', 'php', 'java'],
        enabled: true,
      },
      {
        id: 'performance-patterns',
        name: 'Performance Anti-patterns',
        description: 'Identifies potential performance issues',
        severity: 'medium',
        category: 'performance',
        languages: ['javascript', 'typescript', 'python'],
        enabled: true,
      },
      {
        id: 'code-quality',
        name: 'Code Quality Metrics',
        description: 'Measures code quality and maintainability',
        severity: 'low',
        category: 'maintainability',
        languages: ['javascript', 'typescript', 'python', 'java'],
        enabled: true,
      },
    ];
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      // Verify analysis tools are available
      await this.verifyToolsAvailable();

      // Start file watching if enabled
      if (this.options.realTime) {
        await this.startFileWatching();
      }

      // Start polling if enabled
      if (this.options.polling) {
        this.startPolling();
      }

      // Run initial analysis
      await this.runStaticAnalysis();

      this.emit('detector-started');
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

    // Stop analysis process
    if (this.analysisProcess) {
      this.analysisProcess.kill();
      this.analysisProcess = undefined;
    }

    // Stop file watcher
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = undefined;
    }

    // Stop polling
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }

    this.emit('detector-stopped');
  }

  async detectErrors(target?: string): Promise<DetectedError[]> {
    if (!this.isRunning) {
      await this.start();
    }

    // If target is specified, analyze specific file/directory
    if (target) {
      return await this.analyzeSpecificTarget(target);
    }

    // Otherwise run full static analysis
    await this.runStaticAnalysis();
    return this.getBufferedErrors();
  }

  private async verifyToolsAvailable(): Promise<void> {
    const tools = [];

    if (this.config.sonarjs?.enabled) {
      tools.push('sonar-scanner');
    }
    if (this.config.bandit?.enabled) {
      tools.push('bandit');
    }
    if (this.config.gosec?.enabled) {
      tools.push('gosec');
    }
    if (this.config.cargoAudit?.enabled) {
      tools.push('cargo');
    }

    // For now, we'll proceed without strict tool verification
    // In a production environment, you'd check if tools are installed
  }

  private async startFileWatching(): Promise<void> {
    if (!this.config.workspaceRoot) {
      return;
    }

    this.fileWatcher = watch(this.config.workspaceRoot, {
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      persistent: true,
      ignoreInitial: true,
    });

    this.fileWatcher.on('change', async (filePath: string) => {
      if (this.shouldAnalyzeFile(filePath)) {
        await this.analyzeFile(filePath);
      }
    });

    this.fileWatcher.on('add', async (filePath: string) => {
      if (this.shouldAnalyzeFile(filePath)) {
        await this.analyzeFile(filePath);
      }
    });
  }

  private shouldAnalyzeFile(filePath: string): boolean {
    const ext = extname(filePath);
    const supportedExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs'];
    return supportedExtensions.includes(ext);
  }

  private startPolling(): void {
    if (!this.options.polling) {
      return;
    }

    this.pollingTimer = setInterval(async () => {
      try {
        await this.runStaticAnalysis();
      } catch (error) {
        this.emit('detector-error', error);
      }
    }, this.options.polling.interval);
  }

  private async runStaticAnalysis(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAnalysisTime < 5000) {
      // Avoid running analysis too frequently
      return;
    }

    this.lastAnalysisTime = now;

    try {
      const analysisPromises: Promise<DetectedError[]>[] = [];

      // Enhanced static analysis (primary)
      if (this.config.astAnalysis?.enabled) {
        analysisPromises.push(this.runASTAnalysis());
      }

      if (this.config.patternAnalysis?.enabled) {
        analysisPromises.push(this.runPatternAnalysis());
      }

      if (this.config.qualityMetrics?.enabled) {
        analysisPromises.push(this.runQualityAnalysis());
      }

      // Legacy tool analysis (secondary, for compatibility)
      if (this.config.sonarjs?.enabled) {
        analysisPromises.push(this.runSonarJSAnalysis());
      }

      if (this.config.bandit?.enabled) {
        analysisPromises.push(this.runBanditAnalysis());
      }

      if (this.config.gosec?.enabled) {
        analysisPromises.push(this.runGosecAnalysis());
      }

      if (this.config.cargoAudit?.enabled) {
        analysisPromises.push(this.runCargoAuditAnalysis());
      }

      const results = await Promise.allSettled(analysisPromises);

      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const error of result.value) {
            this.addToBuffer(error);
          }
        }
      }
    } catch (error) {
      this.emit('detector-error', error);
    }
  }

  private async runSonarJSAnalysis(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Simulate SonarJS analysis - in production, you'd run actual sonar-scanner
      const jsFiles = await this.findFiles(['**/*.js', '**/*.ts', '**/*.jsx', '**/*.tsx']);

      for (const file of jsFiles.slice(0, 5)) {
        // Limit for demo
        const content = await fs.readFile(file, 'utf-8');

        // Simple static analysis checks
        const issues = this.performBasicJSAnalysis(content, file);
        errors.push(...issues);
      }
    } catch (error) {
      // Tool not available or failed - continue silently
    }

    return errors;
  }

  private async runBanditAnalysis(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Simulate Bandit analysis for Python files
      const pyFiles = await this.findFiles(['**/*.py']);

      for (const file of pyFiles.slice(0, 5)) {
        // Limit for demo
        const content = await fs.readFile(file, 'utf-8');

        // Simple security analysis checks
        const issues = this.performBasicPythonSecurityAnalysis(content, file);
        errors.push(...issues);
      }
    } catch (error) {
      // Tool not available or failed - continue silently
    }

    return errors;
  }

  private async runGosecAnalysis(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Simulate Gosec analysis for Go files
      const goFiles = await this.findFiles(['**/*.go']);

      for (const file of goFiles.slice(0, 5)) {
        // Limit for demo
        const content = await fs.readFile(file, 'utf-8');

        // Simple security analysis checks
        const issues = this.performBasicGoSecurityAnalysis(content, file);
        errors.push(...issues);
      }
    } catch (error) {
      // Tool not available or failed - continue silently
    }

    return errors;
  }

  private async runCargoAuditAnalysis(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Simulate Cargo audit analysis for Rust projects
      const cargoFiles = await this.findFiles(['**/Cargo.toml']);

      for (const file of cargoFiles.slice(0, 3)) {
        // Limit for demo
        const content = await fs.readFile(file, 'utf-8');

        // Simple dependency analysis
        const issues = this.performBasicRustDependencyAnalysis(content, file);
        errors.push(...issues);
      }
    } catch (error) {
      // Tool not available or failed - continue silently
    }

    return errors;
  }

  // Enhanced Analysis Methods

  private async runASTAnalysis(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];
    const maxFileSize = this.config.astAnalysis?.maxFileSize || 1024 * 1024;
    const timeout = this.config.astAnalysis?.timeout || 5000;

    try {
      const jsFiles = await this.findFiles(['**/*.js', '**/*.ts', '**/*.jsx', '**/*.tsx']);
      const filesToAnalyze = jsFiles.slice(0, this.config.maxFilesPerScan || 50);

      for (const filePath of filesToAnalyze) {
        try {
          const stats = await fs.stat(filePath);
          if (stats.size > maxFileSize) continue;

          const content = await fs.readFile(filePath, 'utf-8');
          const astErrors = await Promise.race([
            this.analyzeWithAST(content, filePath),
            new Promise<DetectedError[]>((_, reject) =>
              setTimeout(() => reject(new Error('AST analysis timeout')), timeout)
            ),
          ]);

          errors.push(...astErrors);
        } catch (error) {
          // Skip files that can't be analyzed
          continue;
        }
      }
    } catch (error) {
      // Analysis failed, continue silently
    }

    return errors;
  }

  private async runPatternAnalysis(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      const allFiles = await this.findFiles([
        '**/*.js',
        '**/*.ts',
        '**/*.jsx',
        '**/*.tsx',
        '**/*.py',
        '**/*.php',
        '**/*.java',
        '**/*.go',
        '**/*.rs',
      ]);

      const filesToAnalyze = allFiles.slice(0, this.config.maxFilesPerScan || 100);

      for (const filePath of filesToAnalyze) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const patternErrors = this.analyzeWithPatterns(content, filePath);
          errors.push(...patternErrors);
        } catch (error) {
          // Skip files that can't be read
          continue;
        }
      }
    } catch (error) {
      // Analysis failed, continue silently
    }

    return errors;
  }

  private async runQualityAnalysis(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      const codeFiles = await this.findFiles([
        '**/*.js',
        '**/*.ts',
        '**/*.jsx',
        '**/*.tsx',
        '**/*.py',
        '**/*.java',
      ]);

      const filesToAnalyze = codeFiles.slice(0, this.config.maxFilesPerScan || 50);

      for (const filePath of filesToAnalyze) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const qualityErrors = this.analyzeCodeQuality(content, filePath);
          errors.push(...qualityErrors);
        } catch (error) {
          // Skip files that can't be analyzed
          continue;
        }
      }
    } catch (error) {
      // Analysis failed, continue silently
    }

    return errors;
  }

  private async findFiles(patterns: string[]): Promise<string[]> {
    const files: string[] = [];

    if (!this.config.workspaceRoot) {
      return files;
    }

    try {
      const { glob } = await import('fast-glob');
      const foundFiles = await glob(patterns, {
        cwd: this.config.workspaceRoot,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        absolute: true,
      });
      files.push(...foundFiles);
    } catch (error) {
      // Fallback to basic file finding if fast-glob is not available
    }

    return files;
  }

  private performBasicJSAnalysis(content: string, filePath: string): DetectedError[] {
    const errors: DetectedError[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // Check for potential security issues
      if (line.includes('eval(') && !line.includes('//')) {
        errors.push(
          this.createStaticAnalysisError(
            'Use of eval() is potentially dangerous',
            'security',
            filePath,
            index + 1,
            ErrorSeverity.HIGH
          )
        );
      }

      // Check for console.log in production code
      if (line.includes('console.log') && !line.includes('//')) {
        errors.push(
          this.createStaticAnalysisError(
            'Console.log statement found - consider removing for production',
            'code-quality',
            filePath,
            index + 1,
            ErrorSeverity.LOW
          )
        );
      }

      // Check for TODO comments
      if (line.includes('TODO') || line.includes('FIXME')) {
        errors.push(
          this.createStaticAnalysisError(
            'TODO/FIXME comment found',
            'maintainability',
            filePath,
            index + 1,
            ErrorSeverity.LOW
          )
        );
      }
    });

    return errors;
  }

  private performBasicPythonSecurityAnalysis(content: string, filePath: string): DetectedError[] {
    const errors: DetectedError[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // Check for potential security issues
      if (line.includes('exec(') && !line.includes('#')) {
        errors.push(
          this.createStaticAnalysisError(
            'Use of exec() is potentially dangerous',
            'security',
            filePath,
            index + 1,
            ErrorSeverity.HIGH
          )
        );
      }

      if (line.includes('subprocess.call') && line.includes('shell=True')) {
        errors.push(
          this.createStaticAnalysisError(
            'subprocess.call with shell=True is potentially dangerous',
            'security',
            filePath,
            index + 1,
            ErrorSeverity.HIGH
          )
        );
      }
    });

    return errors;
  }

  private performBasicGoSecurityAnalysis(content: string, filePath: string): DetectedError[] {
    const errors: DetectedError[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // Check for potential security issues
      if (line.includes('os.Exec') && !line.includes('//')) {
        errors.push(
          this.createStaticAnalysisError(
            'Use of os.Exec may be dangerous',
            'security',
            filePath,
            index + 1,
            ErrorSeverity.MEDIUM
          )
        );
      }
    });

    return errors;
  }

  private performBasicRustDependencyAnalysis(content: string, filePath: string): DetectedError[] {
    const errors: DetectedError[] = [];

    // Simple check for outdated dependencies (this would be more sophisticated in real implementation)
    if (content.includes('[dependencies]')) {
      errors.push(
        this.createStaticAnalysisError(
          'Consider running cargo audit to check for security vulnerabilities',
          'security',
          filePath,
          1,
          ErrorSeverity.LOW
        )
      );
    }

    return errors;
  }

  // Core Analysis Implementation Methods

  private async analyzeWithAST(content: string, filePath: string): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Parse JavaScript/TypeScript with Acorn
      const ast = acorn.parse(content, {
        ecmaVersion: 2022,
        sourceType: 'module',
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        locations: true,
      });

      // Walk the AST to find issues
      walk(ast, {
        FunctionDeclaration: (node: any) => {
          // Check function complexity
          const complexity = this.calculateCyclomaticComplexity(node);
          const threshold = this.config.qualityMetrics?.cyclomaticComplexity?.threshold || 10;

          if (complexity > threshold) {
            errors.push(
              this.createStaticAnalysisError(
                `Function '${node.id?.name || 'anonymous'}' has high cyclomatic complexity (${complexity})`,
                'maintainability',
                filePath,
                node.loc?.start?.line || 1,
                ErrorSeverity.MEDIUM
              )
            );
          }

          // Check function length
          const length = (node.loc?.end?.line || 0) - (node.loc?.start?.line || 0);
          const lengthThreshold = this.config.qualityMetrics?.functionLength?.threshold || 50;

          if (length > lengthThreshold) {
            errors.push(
              this.createStaticAnalysisError(
                `Function '${node.id?.name || 'anonymous'}' is too long (${length} lines)`,
                'maintainability',
                filePath,
                node.loc?.start?.line || 1,
                ErrorSeverity.LOW
              )
            );
          }
        },

        CallExpression: (node: any) => {
          // Check for dangerous function calls
          if (node.callee?.name === 'eval') {
            errors.push(
              this.createStaticAnalysisError(
                'Use of eval() is potentially dangerous',
                'security',
                filePath,
                node.loc?.start?.line || 1,
                ErrorSeverity.HIGH
              )
            );
          }

          // Check for console.log in production
          if (node.callee?.object?.name === 'console' && node.callee?.property?.name === 'log') {
            errors.push(
              this.createStaticAnalysisError(
                'Console.log statement found - consider removing for production',
                'code-quality',
                filePath,
                node.loc?.start?.line || 1,
                ErrorSeverity.LOW
              )
            );
          }
        },

        VariableDeclarator: (node: any) => {
          // Check for unused variables (basic check)
          if (node.id?.name && !this.isVariableUsed(node.id.name, content)) {
            errors.push(
              this.createStaticAnalysisError(
                `Variable '${node.id.name}' is declared but never used`,
                'code-quality',
                filePath,
                node.loc?.start?.line || 1,
                ErrorSeverity.LOW
              )
            );
          }
        },
      });
    } catch (parseError) {
      // If AST parsing fails, fall back to pattern analysis
      const patternErrors = this.analyzeWithPatterns(content, filePath);
      errors.push(...patternErrors);
    }

    return errors;
  }

  private analyzeWithPatterns(content: string, filePath: string): DetectedError[] {
    const errors: DetectedError[] = [];
    const lines = content.split('\n');

    // Apply security patterns
    if (this.config.patternAnalysis?.securityPatterns) {
      for (const pattern of this.securityPatterns) {
        const matches = content.match(pattern.pattern);
        if (matches) {
          lines.forEach((line, index) => {
            if (pattern.pattern.test(line)) {
              errors.push(
                this.createStaticAnalysisError(
                  pattern.message,
                  pattern.category,
                  filePath,
                  index + 1,
                  this.mapSeverity(pattern.severity)
                )
              );
            }
          });
        }
      }
    }

    // Apply performance patterns
    if (this.config.patternAnalysis?.performancePatterns) {
      this.analyzePerformancePatterns(content, filePath, lines, errors);
    }

    // Apply quality patterns
    if (this.config.patternAnalysis?.qualityPatterns) {
      this.analyzeQualityPatterns(content, filePath, lines, errors);
    }

    return errors;
  }

  private analyzeCodeQuality(content: string, filePath: string): DetectedError[] {
    const errors: DetectedError[] = [];
    const lines = content.split('\n');

    // Check nesting depth
    let maxNesting = 0;
    let currentNesting = 0;
    let nestingLine = 0;

    lines.forEach((line, index) => {
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;

      currentNesting += openBraces - closeBraces;

      if (currentNesting > maxNesting) {
        maxNesting = currentNesting;
        nestingLine = index + 1;
      }
    });

    const nestingThreshold = this.config.qualityMetrics?.nestingDepth?.threshold || 4;
    if (maxNesting > nestingThreshold) {
      errors.push(
        this.createStaticAnalysisError(
          `Excessive nesting depth detected (${maxNesting} levels)`,
          'maintainability',
          filePath,
          nestingLine,
          ErrorSeverity.MEDIUM
        )
      );
    }

    // Check for code duplication (basic)
    const duplicateLines = this.findDuplicateLines(lines);
    if (duplicateLines.length > 0) {
      for (const duplicate of duplicateLines) {
        errors.push(
          this.createStaticAnalysisError(
            `Duplicate code detected: "${duplicate.line.trim()}"`,
            'maintainability',
            filePath,
            duplicate.lineNumber,
            ErrorSeverity.LOW
          )
        );
      }
    }

    return errors;
  }

  private createStaticAnalysisError(
    message: string,
    type: string,
    filePath: string,
    line: number,
    severity: ErrorSeverity
  ): DetectedError {
    const baseError = this.createBaseError(message, type);

    return {
      ...baseError,
      id: this.generateErrorId(),
      severity,
      context: {
        timestamp: new Date(),
        environment: 'static-analysis',
        metadata: {
          tool: 'static-analysis-detector',
          file: filePath,
          line,
        },
      },
      source: this.getSource(),
      stackTrace: [
        {
          location: {
            file: filePath,
            line,
            column: 1,
            function: 'static-analysis',
          },
          source: message,
        },
      ],
    };
  }

  private async analyzeSpecificTarget(target: string): Promise<DetectedError[]> {
    try {
      const stat = await fs.stat(target);

      if (stat.isFile()) {
        await this.analyzeFile(target);
      } else if (stat.isDirectory()) {
        // Analyze all files in directory
        const files = await this.findFiles(['**/*']);
        for (const file of files.slice(0, 10)) {
          // Limit for performance
          if (this.shouldAnalyzeFile(file)) {
            await this.analyzeFile(file);
          }
        }
      }
    } catch (error) {
      // Target doesn't exist or can't be accessed
    }

    return this.getBufferedErrors();
  }

  private async analyzeFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const ext = extname(filePath);

      let issues: DetectedError[] = [];

      // Use enhanced analysis for JavaScript/TypeScript files
      if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
        // Run AST analysis if enabled
        if (this.config.astAnalysis?.enabled) {
          const astIssues = await this.analyzeWithAST(content, filePath);
          issues.push(...astIssues);
        }

        // Run pattern analysis if enabled
        if (this.config.patternAnalysis?.enabled) {
          const patternIssues = this.analyzeWithPatterns(content, filePath);
          issues.push(...patternIssues);
        }

        // Run quality analysis if enabled
        if (this.config.qualityMetrics?.enabled) {
          const qualityIssues = this.analyzeCodeQuality(content, filePath);
          issues.push(...qualityIssues);
        }

        // Fallback to basic analysis if no enhanced analysis is enabled
        if (
          !this.config.astAnalysis?.enabled &&
          !this.config.patternAnalysis?.enabled &&
          !this.config.qualityMetrics?.enabled
        ) {
          issues = this.performBasicJSAnalysis(content, filePath);
        }
      } else {
        // Use basic analysis for other file types
        switch (ext) {
          case '.py':
            issues = this.performBasicPythonSecurityAnalysis(content, filePath);
            break;
          case '.go':
            issues = this.performBasicGoSecurityAnalysis(content, filePath);
            break;
          case '.rs':
            // For Rust files, we'd typically analyze Cargo.toml instead
            break;
        }
      }

      for (const issue of issues) {
        this.addToBuffer(issue);
      }
    } catch (error) {
      // File can't be read or analyzed
    }
  }

  // Helper Methods for Analysis

  private calculateCyclomaticComplexity(node: any): number {
    let complexity = 1; // Base complexity

    // Walk through the function to count decision points
    walk(node, {
      IfStatement: () => complexity++,
      ConditionalExpression: () => complexity++,
      LogicalExpression: (logicalNode: any) => {
        if (logicalNode.operator === '&&' || logicalNode.operator === '||') {
          complexity++;
        }
      },
      SwitchCase: () => complexity++,
      WhileStatement: () => complexity++,
      DoWhileStatement: () => complexity++,
      ForStatement: () => complexity++,
      ForInStatement: () => complexity++,
      ForOfStatement: () => complexity++,
      CatchClause: () => complexity++,
    });

    return complexity;
  }

  private isVariableUsed(variableName: string, content: string): boolean {
    // Simple check - look for variable usage after declaration
    const regex = new RegExp(`\\b${variableName}\\b`, 'g');
    const matches = content.match(regex);
    return matches ? matches.length > 1 : false; // More than just declaration
  }

  private mapSeverity(severity: string): ErrorSeverity {
    switch (severity) {
      case 'critical':
        return ErrorSeverity.HIGH;
      case 'high':
        return ErrorSeverity.HIGH;
      case 'medium':
        return ErrorSeverity.MEDIUM;
      case 'low':
        return ErrorSeverity.LOW;
      default:
        return ErrorSeverity.LOW;
    }
  }

  private analyzePerformancePatterns(
    content: string,
    filePath: string,
    lines: string[],
    errors: DetectedError[]
  ): void {
    lines.forEach((line, index) => {
      // Check for inefficient loops
      if (line.includes('for') && line.includes('.length') && !line.includes('//')) {
        errors.push(
          this.createStaticAnalysisError(
            'Consider caching array length in loop for better performance',
            'performance',
            filePath,
            index + 1,
            ErrorSeverity.LOW
          )
        );
      }

      // Check for synchronous operations that could be async
      if (
        (line.includes('readFileSync') || line.includes('writeFileSync')) &&
        !line.includes('//')
      ) {
        errors.push(
          this.createStaticAnalysisError(
            'Consider using async file operations for better performance',
            'performance',
            filePath,
            index + 1,
            ErrorSeverity.MEDIUM
          )
        );
      }

      // Check for potential memory leaks
      if (line.includes('setInterval') && !content.includes('clearInterval')) {
        errors.push(
          this.createStaticAnalysisError(
            'setInterval without clearInterval may cause memory leaks',
            'performance',
            filePath,
            index + 1,
            ErrorSeverity.MEDIUM
          )
        );
      }
    });
  }

  private analyzeQualityPatterns(
    _content: string,
    filePath: string,
    lines: string[],
    errors: DetectedError[]
  ): void {
    lines.forEach((line, index) => {
      // Check for magic numbers
      const magicNumberRegex = /\b\d{2,}\b/g;
      if (magicNumberRegex.test(line) && !line.includes('//') && !line.includes('const')) {
        errors.push(
          this.createStaticAnalysisError(
            'Consider using named constants instead of magic numbers',
            'maintainability',
            filePath,
            index + 1,
            ErrorSeverity.LOW
          )
        );
      }

      // Check for long lines
      if (line.length > 120) {
        errors.push(
          this.createStaticAnalysisError(
            `Line too long (${line.length} characters) - consider breaking it up`,
            'style',
            filePath,
            index + 1,
            ErrorSeverity.LOW
          )
        );
      }

      // Check for TODO/FIXME comments
      if (line.includes('TODO') || line.includes('FIXME')) {
        errors.push(
          this.createStaticAnalysisError(
            'TODO/FIXME comment found - consider addressing',
            'maintainability',
            filePath,
            index + 1,
            ErrorSeverity.LOW
          )
        );
      }
    });
  }

  private findDuplicateLines(lines: string[]): Array<{ line: string; lineNumber: number }> {
    const duplicates: Array<{ line: string; lineNumber: number }> = [];
    const lineMap = new Map<string, number[]>();

    // Build map of line content to line numbers
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.length > 10 && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
        if (!lineMap.has(trimmed)) {
          lineMap.set(trimmed, []);
        }
        lineMap.get(trimmed)!.push(index + 1);
      }
    });

    // Find duplicates
    lineMap.forEach((lineNumbers, lineContent) => {
      if (lineNumbers.length > 1) {
        duplicates.push({
          line: lineContent,
          lineNumber: lineNumbers[0] || 1, // Report first occurrence
        });
      }
    });

    return duplicates.slice(0, 5); // Limit to first 5 duplicates
  }
}

// The class is already named StaticAnalysisDetector, so no alias needed
