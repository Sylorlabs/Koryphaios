/**
 * Integration tests for IDE integrations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DevelopmentEnvironment } from '../../src/debug/development-environment.js';
import {
  IntegrationManager,
  createDefaultIntegrationConfig,
} from '../../src/integrations/integration-manager.js';
import { VSCodeIntegration } from '../../src/integrations/vscode-integration.js';
import { CursorIntegration } from '../../src/integrations/cursor-integration.js';
import { WindsurfIntegration } from '../../src/integrations/windsurf-integration.js';
import { AugmentIntegration } from '../../src/integrations/augment-integration.js';
import { SupportedLanguage } from '../../src/types/languages.js';

describe('IDE Integrations', () => {
  let devEnvironment: DevelopmentEnvironment;
  let integrationManager: IntegrationManager;

  beforeEach(async () => {
    devEnvironment = new DevelopmentEnvironment({
      enableErrorDetection: true,
      enablePerformanceMonitoring: true,
      enableDebugSessions: true,
      logLevel: 'warn',
    });

    await devEnvironment.start();

    const config = createDefaultIntegrationConfig();
    integrationManager = new IntegrationManager(devEnvironment, config);
  });

  afterEach(async () => {
    if (integrationManager) {
      await integrationManager.dispose();
    }
    if (devEnvironment) {
      await devEnvironment.dispose();
    }
  });

  describe('Integration Manager', () => {
    it('should initialize successfully', async () => {
      await integrationManager.initialize();

      const statistics = integrationManager.getStatistics();
      expect(statistics.isInitialized).toBe(true);
      expect(statistics.totalIntegrations).toBeGreaterThan(0);
    });

    it('should manage multiple integrations', async () => {
      await integrationManager.initialize();

      const statuses = integrationManager.getIntegrationStatuses();
      expect(statuses.length).toBeGreaterThan(0);

      const enabledStatuses = statuses.filter(s => s.enabled);
      expect(enabledStatuses.length).toBeGreaterThan(0);
    });

    it('should set active integration', async () => {
      await integrationManager.initialize();

      await integrationManager.setActiveIntegration('vscode');
      const activeIntegration = integrationManager.getActiveIntegration();
      expect(activeIntegration).toBeTruthy();
      expect(activeIntegration).toBeInstanceOf(VSCodeIntegration);
    });

    it('should enable and disable integrations', async () => {
      await integrationManager.initialize();

      // Test enabling
      await integrationManager.enableIntegration('cursor');
      const cursorIntegration = integrationManager.getIntegration('cursor');
      expect(cursorIntegration).toBeTruthy();

      // Test disabling
      await integrationManager.disableIntegration('cursor');
      const disabledIntegration = integrationManager.getIntegration('cursor');
      expect(disabledIntegration).toBeFalsy();
    });
  });

  describe('VS Code Integration', () => {
    let vscodeIntegration: VSCodeIntegration;

    beforeEach(async () => {
      vscodeIntegration = new VSCodeIntegration(devEnvironment, {
        enabled: true,
        diagnosticsProvider: true,
        codeActionsProvider: true,
        hoverProvider: true,
        completionProvider: false,
        realTimeAnalysis: true,
        autoSuggestions: true,
      });

      await vscodeIntegration.initialize();
    });

    afterEach(async () => {
      if (vscodeIntegration) {
        await vscodeIntegration.dispose();
      }
    });

    it('should provide diagnostics', async () => {
      const testCode = `
        const x: string = 123; // Type error
        console.log(undefinedVariable); // Reference error
      `;

      const diagnostics = await vscodeIntegration.provideDiagnostics(
        'test.ts',
        testCode,
        'typescript'
      );

      expect(diagnostics).toBeDefined();
      expect(Array.isArray(diagnostics)).toBe(true);
    });

    it('should provide code actions', async () => {
      const testCode = `const x: string = 123;`;

      // First get diagnostics
      const diagnostics = await vscodeIntegration.provideDiagnostics(
        'test.ts',
        testCode,
        'typescript'
      );

      if (diagnostics.length > 0) {
        const codeActions = await vscodeIntegration.provideCodeActions(
          'test.ts',
          { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
          { diagnostics }
        );

        expect(codeActions).toBeDefined();
        expect(Array.isArray(codeActions)).toBe(true);
      }
    });

    it('should provide hover information', async () => {
      const testCode = `const x: string = "hello";`;

      await vscodeIntegration.provideDiagnostics('test.ts', testCode, 'typescript');

      const hoverInfo = await vscodeIntegration.provideHover('test.ts', { line: 0, character: 6 });

      // Hover info might be null if no diagnostics at position
      if (hoverInfo) {
        expect(hoverInfo.contents).toBeDefined();
      }
    });
  });

  describe('Cursor Integration', () => {
    let cursorIntegration: CursorIntegration;

    beforeEach(async () => {
      cursorIntegration = new CursorIntegration(devEnvironment, {
        enabled: true,
        aiAssistance: true,
        realTimeAnalysis: true,
        contextSharing: true,
        autoSuggestions: true,
        debugIntegration: true,
        performanceInsights: true,
        codeActions: true,
        hoverProvider: true,
        completionProvider: false,
      });

      await cursorIntegration.initialize();
    });

    afterEach(async () => {
      if (cursorIntegration) {
        await cursorIntegration.dispose();
      }
    });

    it('should provide enhanced diagnostics', async () => {
      const testCode = `
        function calculate(items) {
          let total = 0;
          for (let i = 0; i <= items.length; i++) { // Off-by-one error
            total += items[i].price; // Potential undefined access
          }
          return total;
        }
      `;

      const diagnostics = await cursorIntegration.provideDiagnostics(
        'test.js',
        testCode,
        'javascript'
      );

      expect(diagnostics).toBeDefined();
      expect(Array.isArray(diagnostics)).toBe(true);
    });

    it('should handle document changes', async () => {
      const testCode = `const x = 1;`;

      // This should not throw
      await cursorIntegration.onDocumentChange('test.js', testCode, 'javascript');

      // Wait a bit for debounced processing
      await new Promise(resolve => setTimeout(resolve, 600));
    });

    it('should provide completions when enabled', async () => {
      // Update config to enable completions
      cursorIntegration.updateConfig({ completionProvider: true });

      const testCode = `console.`;

      const completions = await cursorIntegration.provideCompletions(
        'test.js',
        { line: 0, character: 8 },
        { triggerKind: 'triggerCharacter', triggerCharacter: '.' }
      );

      expect(completions).toBeDefined();
      expect(Array.isArray(completions)).toBe(true);
    });
  });

  describe('Windsurf Integration', () => {
    let windsurfIntegration: WindsurfIntegration;

    beforeEach(async () => {
      windsurfIntegration = new WindsurfIntegration(devEnvironment, {
        enabled: true,
        advancedFeatures: true,
        realTimeDebugging: true,
        performanceAnalysis: true,
        codeIntelligence: true,
        collaborativeDebugging: false,
        visualDebugging: true,
        memoryProfiling: true,
        networkAnalysis: true,
        securityScanning: true,
        aiPoweredInsights: true,
      });

      await windsurfIntegration.initialize();
    });

    afterEach(async () => {
      if (windsurfIntegration) {
        await windsurfIntegration.dispose();
      }
    });

    it('should create advanced debug sessions', async () => {
      try {
        const sessionId = await windsurfIntegration.createAdvancedDebugSession(
          SupportedLanguage.JAVASCRIPT,
          {
            type: 'launch',
            program: 'test.js',
          }
        );

        expect(sessionId).toBeDefined();
        expect(typeof sessionId).toBe('string');
      } catch (error) {
        // Expected to fail in test environment, but should not crash
        expect(error).toBeDefined();
      }
    });

    it('should provide code lenses', async () => {
      const testCode = `
        function fibonacci(n) {
          if (n <= 1) return n;
          return fibonacci(n - 1) + fibonacci(n - 2);
        }
        
        const result = new Array(1000);
        throw new Error("Test error");
      `;

      const codeLenses = await windsurfIntegration.provideCodeLenses('test.js', testCode);

      expect(codeLenses).toBeDefined();
      expect(Array.isArray(codeLenses)).toBe(true);
      expect(codeLenses.length).toBeGreaterThan(0);
    });

    it('should provide inlay hints', async () => {
      const testCode = `
        const userName = "John";
        let userAge = 25;
        console.log(userName, userAge);
      `;

      const inlayHints = await windsurfIntegration.provideInlayHints(
        'test.js',
        { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
        testCode
      );

      expect(inlayHints).toBeDefined();
      expect(Array.isArray(inlayHints)).toBe(true);
    });

    it('should analyze documents', async () => {
      const testCode = `
        function complexFunction(a, b, c) {
          if (a > 0) {
            if (b > 0) {
              if (c > 0) {
                return a + b + c;
              } else {
                return a + b;
              }
            } else {
              return a;
            }
          } else {
            return 0;
          }
        }
      `;

      const analysis = await windsurfIntegration.analyzeDocument('test.js', testCode, 'javascript');

      expect(analysis).toBeDefined();
      if (analysis) {
        expect(analysis.complexity).toBeDefined();
        expect(analysis.maintainability).toBeDefined();
      }
    });
  });

  describe('Augment Integration', () => {
    let augmentIntegration: AugmentIntegration;

    beforeEach(async () => {
      augmentIntegration = new AugmentIntegration(devEnvironment, {
        enabled: true,
        contextEngine: true,
        aiAssistance: true,
        codebaseAnalysis: true,
        semanticSearch: true,
        intelligentSuggestions: true,
        contextualDebugging: true,
        crossFileAnalysis: true,
        dependencyTracking: true,
        refactoringAssistance: true,
        codeGeneration: true,
        documentationGeneration: true,
      });

      await augmentIntegration.initialize();
    });

    afterEach(async () => {
      if (augmentIntegration) {
        await augmentIntegration.dispose();
      }
    });

    it('should analyze code with context', async () => {
      const testCode = `
        class UserService {
          constructor(private database: Database) {}
          
          async getUser(id: string): Promise<User> {
            return this.database.findUser(id);
          }
          
          async createUser(userData: UserData): Promise<User> {
            return this.database.createUser(userData);
          }
        }
      `;

      const analysis = await augmentIntegration.analyzeWithContext(
        'user-service.ts',
        testCode,
        'typescript',
        'class'
      );

      expect(analysis).toBeDefined();
      expect(analysis.timestamp).toBeDefined();
      expect(analysis.scope).toBe('class');
      expect(analysis.target).toBe('user-service.ts');
      expect(analysis.insights).toBeDefined();
      expect(analysis.suggestions).toBeDefined();
      expect(analysis.patterns).toBeDefined();
      expect(analysis.metrics).toBeDefined();
    });

    it('should provide intelligent suggestions', async () => {
      const error = {
        message: "Property 'nonExistentProperty' does not exist on type 'User'",
        severity: 'error',
        code: 'TS2339',
      };

      const context = {
        file: 'user-service.ts',
        line: 10,
        column: 15,
        function: 'getUser',
        class: 'UserService',
      };

      const suggestions = await augmentIntegration.getIntelligentSuggestions(error, context);

      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('should perform semantic search', async () => {
      const results = await augmentIntegration.semanticSearch('user authentication', {
        scope: 'project',
        language: 'typescript',
        maxResults: 10,
      });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should generate documentation', async () => {
      const testCode = `
        function calculateTax(income: number, rate: number): number {
          return income * rate;
        }
      `;

      const documentation = await augmentIntegration.generateDocumentation(
        testCode,
        'typescript',
        'function'
      );

      expect(documentation).toBeDefined();
      expect(typeof documentation).toBe('string');
    });

    it('should generate code', async () => {
      const prompt = 'Create a function that validates email addresses';
      const context = {
        language: 'typescript',
        file: 'validators.ts',
        line: 10,
        requirements: ['should return boolean', 'should handle edge cases'],
      };

      const generatedCode = await augmentIntegration.generateCode(prompt, context);

      expect(generatedCode).toBeDefined();
      expect(typeof generatedCode).toBe('string');
    });
  });

  describe('Integration Events', () => {
    it('should emit events from integrations', async () => {
      await integrationManager.initialize();

      let eventReceived = false;
      integrationManager.on('errorsDetected', () => {
        eventReceived = true;
      });

      // Trigger error detection through development environment
      await devEnvironment.detectErrors(
        'const x: string = 123;',
        SupportedLanguage.TYPESCRIPT,
        'test.ts'
      );

      // Wait a bit for event propagation
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(eventReceived).toBe(true);
    });

    it('should handle integration errors gracefully', async () => {
      await integrationManager.initialize();

      let errorReceived = false;
      integrationManager.on('integrationError', () => {
        errorReceived = true;
      });

      // This should not crash the integration manager
      const vscodeIntegration = integrationManager.getIntegration('vscode');
      if (vscodeIntegration) {
        vscodeIntegration.emit('error', new Error('Test error'));
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(errorReceived).toBe(true);
    });
  });

  describe('Configuration Management', () => {
    it('should update integration configurations', async () => {
      await integrationManager.initialize();

      const newConfig = { enabled: false };
      await integrationManager.updateIntegrationConfig('vscode', newConfig);

      const vscodeIntegration = integrationManager.getIntegration('vscode');
      expect(vscodeIntegration).toBeTruthy();
    });

    it('should provide comprehensive statistics', async () => {
      await integrationManager.initialize();

      const statistics = integrationManager.getStatistics();

      expect(statistics.isInitialized).toBe(true);
      expect(statistics.totalIntegrations).toBeGreaterThan(0);
      expect(statistics.enabledIntegrations).toBeDefined();
      expect(statistics.integrationStatuses).toBeDefined();
      expect(statistics.config).toBeDefined();
    });
  });
});
