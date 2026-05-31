/**
 * Cursor IDE Extension Entry Point
 * Main extension file for Cursor IDE integration
 */

// Conditional import for cursor module - may not be available in all environments
let cursor: any;
try {
  cursor = require('cursor');
} catch (error) {
  // Cursor module not available - create mock interface
  cursor = {
    window: {
      showErrorMessage: (message: string) => console.error(`[Cursor Mock] ${message}`),
      showInformationMessage: (message: string) => console.info(`[Cursor Mock] ${message}`),
      showWarningMessage: (message: string) => console.warn(`[Cursor Mock] ${message}`),
      createStatusBarItem: () => ({
        text: '',
        show: () => {},
        hide: () => {},
        dispose: () => {},
      }),
    },
    workspace: {
      onDidChangeTextDocument: () => ({ dispose: () => {} }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
      getConfiguration: () => ({
        get: () => undefined,
        update: () => Promise.resolve(),
      }),
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: () => {},
        clear: () => {},
        dispose: () => {},
      }),
      registerCodeActionsProvider: () => ({ dispose: () => {} }),
      registerHoverProvider: () => ({ dispose: () => {} }),
    },
    commands: {
      registerCommand: () => ({ dispose: () => {} }),
    },
  };
}

import { DevelopmentEnvironment } from '../debug/development-environment.js';
import type { CursorIntegrationConfig } from './cursor-integration.js';
import { CursorIntegration } from './cursor-integration.js';
import { Logger } from '../utils/logger.js';

let devEnvironment: DevelopmentEnvironment | undefined;
let cursorIntegration: CursorIntegration | undefined;
let logger: Logger;
let statusBarItem: any;
let diagnosticCollection: any;

/**
 * Extension activation function
 */
export async function activate(context: any): Promise<void> {
  logger = new Logger('info', {
    logFile: undefined,
    enableConsole: true,
  });

  logger.info('Activating Error Debugging MCP Server extension for Cursor');

  try {
    // Initialize development environment
    await initializeDevelopmentEnvironment();

    // Initialize Cursor integration
    await initializeCursorIntegration();

    // Register commands
    registerCommands(context);

    // Set up providers
    setupProviders(context);

    // Create status bar item
    createStatusBarItem(context);

    // Set up event handlers
    setupEventHandlers();

    // Set context as active
    await cursor.commands.executeCommand('setContext', 'errorDebugging.active', true);

    logger.info('Error Debugging MCP Server extension activated successfully');
  } catch (error) {
    logger.error('Failed to activate extension', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    cursor.window.showErrorMessage(`Failed to activate Error Debugging MCP Server: ${message}`);
    throw error;
  }
}

/**
 * Extension deactivation function
 */
export async function deactivate(): Promise<void> {
  logger.info('Deactivating Error Debugging MCP Server extension');

  try {
    // Set context as inactive
    await cursor.commands.executeCommand('setContext', 'errorDebugging.active', false);

    // Dispose resources
    if (cursorIntegration) {
      await cursorIntegration.dispose();
    }

    if (devEnvironment) {
      await devEnvironment.dispose();
    }

    if (statusBarItem) {
      statusBarItem.dispose();
    }

    if (diagnosticCollection) {
      diagnosticCollection.dispose();
    }

    logger.info('Error Debugging MCP Server extension deactivated');
  } catch (error) {
    logger.error('Error during deactivation', error);
  }
}

/**
 * Initialize development environment
 */
async function initializeDevelopmentEnvironment(): Promise<void> {
  const config = cursor.workspace.getConfiguration('errorDebugging');

  devEnvironment = new DevelopmentEnvironment({
    enableErrorDetection: config.get('enabled', true),
    enablePerformanceMonitoring: config.get('performance.enabled', true),
    enableDebugSessions: config.get('debugIntegration', true),
    logLevel: config.get('logLevel', 'info') as any,
  });

  await devEnvironment.start();
  logger.info('Development environment initialized');
}

/**
 * Initialize Cursor integration
 */
async function initializeCursorIntegration(): Promise<void> {
  if (!devEnvironment) {
    throw new Error('Development environment not initialized');
  }

  const config = cursor.workspace.getConfiguration('errorDebugging');

  const integrationConfig: CursorIntegrationConfig = {
    enabled: config.get('enabled', true),
    aiAssistance: config.get('aiAssistance', true),
    realTimeAnalysis: config.get('realTimeAnalysis', true),
    contextSharing: config.get('contextSharing', true),
    autoSuggestions: config.get('autoSuggestions', true),
    debugIntegration: config.get('debugIntegration', true),
    performanceInsights: config.get('performanceInsights', true),
    codeActions: config.get('codeActions', true),
    hoverProvider: config.get('hoverProvider', true),
    completionProvider: config.get('completionProvider', false),
  };

  cursorIntegration = new CursorIntegration(devEnvironment, integrationConfig);
  await cursorIntegration.initialize();

  logger.info('Cursor integration initialized');
}

/**
 * Register extension commands
 */
function registerCommands(context: any): void {
  const commands = [
    cursor.commands.registerCommand('errorDebugging.start', async () => {
      try {
        if (!devEnvironment) {
          await initializeDevelopmentEnvironment();
        }
        if (!cursorIntegration) {
          await initializeCursorIntegration();
        }
        await cursor.commands.executeCommand('setContext', 'errorDebugging.active', true);
        updateStatusBar('active');
        cursor.window.showInformationMessage('Error Debugging MCP Server started');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        cursor.window.showErrorMessage(`Failed to start: ${message}`);
      }
    }),

    cursor.commands.registerCommand('errorDebugging.stop', async () => {
      try {
        if (cursorIntegration) {
          await cursorIntegration.dispose();
          cursorIntegration = undefined;
        }
        if (devEnvironment) {
          await devEnvironment.dispose();
          devEnvironment = undefined;
        }
        await cursor.commands.executeCommand('setContext', 'errorDebugging.active', false);
        updateStatusBar('inactive');
        cursor.window.showInformationMessage('Error Debugging MCP Server stopped');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        cursor.window.showErrorMessage(`Failed to stop: ${message}`);
      }
    }),

    cursor.commands.registerCommand('errorDebugging.analyze', async () => {
      const editor = cursor.window.activeTextEditor;
      if (!editor || !cursorIntegration) {
        cursor.window.showWarningMessage('No active editor or integration not initialized');
        return;
      }

      try {
        const document = editor.document;
        const diagnostics = await cursorIntegration.provideDiagnostics(
          document.uri.toString(),
          document.getText(),
          document.languageId
        );

        // Convert and set diagnostics
        const cursorDiagnostics = diagnostics.map(diag => ({
          range: new cursor.Range(
            new cursor.Position(diag.range.start.line, diag.range.start.character),
            new cursor.Position(diag.range.end.line, diag.range.end.character)
          ),
          message: diag.message,
          severity: mapSeverity(diag.severity),
          source: diag.source,
          code: diag.code,
        }));

        diagnosticCollection.set(document.uri, cursorDiagnostics);
        cursor.window.showInformationMessage(
          `Analysis complete: ${diagnostics.length} issue(s) found`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        cursor.window.showErrorMessage(`Analysis failed: ${message}`);
      }
    }),

    cursor.commands.registerCommand('errorDebugging.analyzePerformance', async () => {
      const editor = cursor.window.activeTextEditor;
      if (!editor || !devEnvironment) {
        cursor.window.showWarningMessage('No active editor or environment not initialized');
        return;
      }

      try {
        const document = editor.document;
        const language = mapLanguage(document.languageId);

        if (!language) {
          cursor.window.showWarningMessage(`Language ${document.languageId} not supported`);
          return;
        }

        const analysis = await devEnvironment.analyzePerformance(document.getText(), language);

        const panel = cursor.window.createWebviewPanel(
          'performanceAnalysis',
          'Performance Analysis',
          cursor.ViewColumn.Two,
          { enableScripts: true }
        );

        panel.webview.html = generatePerformanceReport(analysis);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        cursor.window.showErrorMessage(`Performance analysis failed: ${message}`);
      }
    }),

    cursor.commands.registerCommand('errorDebugging.fixAll', async () => {
      cursor.window.showInformationMessage('Auto-fix functionality coming soon!');
    }),

    cursor.commands.registerCommand('errorDebugging.showStatistics', async () => {
      if (!cursorIntegration || !devEnvironment) {
        cursor.window.showWarningMessage('Integration not initialized');
        return;
      }

      const stats = {
        integration: cursorIntegration.getStatistics(),
        environment: devEnvironment.getStatistics(),
      };

      const panel = cursor.window.createWebviewPanel(
        'statistics',
        'Error Debugging Statistics',
        cursor.ViewColumn.Two,
        { enableScripts: true }
      );

      panel.webview.html = generateStatisticsReport(stats);
    }),

    cursor.commands.registerCommand('errorDebugging.openSettings', async () => {
      await cursor.commands.executeCommand('workbench.action.openSettings', 'errorDebugging');
    }),
  ];

  commands.forEach(command => context.subscriptions.push(command));
  logger.info('Commands registered');
}

/**
 * Set up language providers
 */
function setupProviders(context: any): void {
  if (!cursorIntegration) {
    return;
  }

  // Diagnostic collection
  diagnosticCollection = cursor.languages.createDiagnosticCollection('errorDebugging');
  context.subscriptions.push(diagnosticCollection);

  // Code action provider
  const codeActionProvider = cursor.languages.registerCodeActionsProvider(
    ['typescript', 'javascript', 'python', 'go', 'rust'],
    {
      provideCodeActions: async (document: any, range: any, context: any) => {
        if (!cursorIntegration) return [];

        const actions = await cursorIntegration.provideCodeActions(
          document.uri.toString(),
          {
            start: { line: range.start.line, character: range.start.character },
            end: { line: range.end.line, character: range.end.character },
          },
          {
            diagnostics: context.diagnostics.map((diag: any) => ({
              range: {
                start: { line: diag.range.start.line, character: diag.range.start.character },
                end: { line: diag.range.end.line, character: diag.range.end.character },
              },
              severity:
                diag.severity === cursor.DiagnosticSeverity.Error
                  ? 'error'
                  : diag.severity === cursor.DiagnosticSeverity.Warning
                    ? 'warning'
                    : diag.severity === cursor.DiagnosticSeverity.Information
                      ? 'info'
                      : 'hint',
              message: diag.message,
              source: diag.source || '',
              code: diag.code as string,
            })),
          }
        );

        return actions.map(action => ({
          title: action.title,
          kind: cursor.CodeActionKind.QuickFix,
          isPreferred: action.isPreferred,
        }));
      },
    }
  );

  // Hover provider
  const hoverProvider = cursor.languages.registerHoverProvider(
    ['typescript', 'javascript', 'python', 'go', 'rust'],
    {
      provideHover: async (document: any, position: any) => {
        if (!cursorIntegration) return null;

        const hoverInfo = await cursorIntegration.provideHover(document.uri.toString(), {
          line: position.line,
          character: position.character,
        });

        if (!hoverInfo) return null;

        const contents = hoverInfo.contents.map(
          content => new cursor.MarkdownString(content.value)
        );

        return new cursor.Hover(contents);
      },
    }
  );

  context.subscriptions.push(codeActionProvider, hoverProvider);
  logger.info('Language providers registered');
}

/**
 * Create status bar item
 */
function createStatusBarItem(context: any): void {
  statusBarItem = cursor.window.createStatusBarItem();
  statusBarItem.command = 'errorDebugging.showStatistics';
  updateStatusBar('active');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

/**
 * Update status bar
 */
function updateStatusBar(status: 'active' | 'inactive' | 'error'): void {
  if (!statusBarItem) return;

  switch (status) {
    case 'active':
      statusBarItem.text = '$(check) Error Debugging';
      statusBarItem.color = undefined;
      statusBarItem.tooltip = 'Error Debugging MCP Server is active';
      break;
    case 'inactive':
      statusBarItem.text = '$(circle-slash) Error Debugging';
      statusBarItem.color = 'yellow';
      statusBarItem.tooltip = 'Error Debugging MCP Server is inactive';
      break;
    case 'error':
      statusBarItem.text = '$(error) Error Debugging';
      statusBarItem.color = 'red';
      statusBarItem.tooltip = 'Error Debugging MCP Server has errors';
      break;
  }
}

/**
 * Set up event handlers
 */
function setupEventHandlers(): void {
  if (!cursorIntegration) return;

  // Document change handler
  cursor.workspace.onDidChangeTextDocument(async (event: any) => {
    if (cursorIntegration) {
      await cursorIntegration.onDocumentChange(
        event.document.uri.toString(),
        event.document.getText(),
        event.document.languageId
      );
    }
  });

  // Configuration change handler
  cursor.workspace.onDidChangeConfiguration(async (event: any) => {
    if (event.affectsConfiguration('errorDebugging')) {
      logger.info('Configuration changed, updating integration');

      if (cursorIntegration) {
        const config = cursor.workspace.getConfiguration('errorDebugging');
        cursorIntegration.updateConfig({
          enabled: config.get('enabled', true),
          aiAssistance: config.get('aiAssistance', true),
          realTimeAnalysis: config.get('realTimeAnalysis', true),
          contextSharing: config.get('contextSharing', true),
          autoSuggestions: config.get('autoSuggestions', true),
          debugIntegration: config.get('debugIntegration', true),
          performanceInsights: config.get('performanceInsights', true),
          codeActions: config.get('codeActions', true),
          hoverProvider: config.get('hoverProvider', true),
          completionProvider: config.get('completionProvider', false),
        });
      }
    }
  });

  logger.info('Event handlers set up');
}

/**
 * Map Cursor diagnostic severity to our format
 */
function mapSeverity(severity: string): any {
  switch (severity) {
    case 'error':
      return 0; // Error
    case 'warning':
      return 1; // Warning
    case 'info':
      return 2; // Information
    case 'hint':
      return 3; // Hint
    default:
      return 2; // Information
  }
}

/**
 * Map language ID to our supported languages
 */
function mapLanguage(languageId: string): any {
  const languageMap: Record<string, string> = {
    typescript: 'typescript',
    javascript: 'javascript',
    python: 'python',
    go: 'go',
    rust: 'rust',
  };

  return languageMap[languageId] || null;
}

/**
 * Generate performance analysis report HTML
 */
function generatePerformanceReport(analysis: any): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Performance Analysis</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .metric { margin: 10px 0; padding: 10px; border-left: 4px solid #007acc; }
        .suggestion { margin: 5px 0; padding: 8px; background: #f0f8ff; border-radius: 4px; }
      </style>
    </head>
    <body>
      <h1>Performance Analysis Results</h1>
      <div class="metric">
        <strong>Complexity Score:</strong> ${analysis.complexity || 'N/A'}
      </div>
      <h2>Suggestions:</h2>
      ${(analysis.suggestions || []).map((s: string) => `<div class="suggestion">${s}</div>`).join('')}
      <h2>Metrics:</h2>
      <pre>${JSON.stringify(analysis.metrics || {}, null, 2)}</pre>
    </body>
    </html>
  `;
}

/**
 * Generate statistics report HTML
 */
function generateStatisticsReport(stats: any): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Error Debugging Statistics</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .stat { margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
        pre { background: #f5f5f5; padding: 10px; border-radius: 4px; overflow: auto; }
      </style>
    </head>
    <body>
      <h1>Error Debugging Statistics</h1>
      <div class="stat">
        <h2>Integration Status</h2>
        <pre>${JSON.stringify(stats.integration, null, 2)}</pre>
      </div>
      <div class="stat">
        <h2>Environment Status</h2>
        <pre>${JSON.stringify(stats.environment, null, 2)}</pre>
      </div>
    </body>
    </html>
  `;
}
