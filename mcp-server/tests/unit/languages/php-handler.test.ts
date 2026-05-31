/**
 * Tests for PHP language handler
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PHPHandler } from '../../../src/languages/php-handler.js';
import { SupportedLanguage } from '../../../src/types/languages.js';

describe('PHPHandler', () => {
  let handler: PHPHandler;

  beforeEach(() => {
    handler = new PHPHandler();
  });

  describe('Basic Properties', () => {
    it('should have correct language', () => {
      expect(handler.language).toBe(SupportedLanguage.PHP);
    });

    it('should return correct file extensions', () => {
      const extensions = handler.getFileExtensions();
      expect(extensions).toContain('.php');
      expect(extensions).toContain('.phtml');
      expect(extensions).toContain('.phar');
    });

    it('should return correct config files', () => {
      const configFiles = handler.getConfigFiles();
      expect(configFiles).toContain('composer.json');
      expect(configFiles).toContain('phpstan.neon');
      expect(configFiles).toContain('phpcs.xml');
    });

    it('should support PHP files', () => {
      expect(handler.isFileSupported('test.php')).toBe(true);
      expect(handler.isFileSupported('test.phtml')).toBe(true);
      expect(handler.isFileSupported('test.js')).toBe(false);
    });
  });

  describe('Debug Capabilities', () => {
    it('should return correct debug capabilities', () => {
      const capabilities = handler.getDebugCapabilities();
      expect(capabilities.supportsBreakpoints).toBe(true);
      expect(capabilities.supportsVariableInspection).toBe(true);
      expect(capabilities.supportsRemoteDebugging).toBe(true);
      expect(capabilities.supportsHotReload).toBe(false);
    });
  });

  describe('Stack Trace Parsing', () => {
    it('should parse PHP stack traces correctly', () => {
      const stackTrace = `#0 /path/to/file.php(15): someFunction()
#1 /path/to/other.php(25): anotherFunction()
#2 {main}`;

      const frames = handler.parseStackTrace(stackTrace);
      expect(frames).toHaveLength(2);
      expect(frames[0]).toEqual({
        function: 'someFunction()',
        file: '/path/to/file.php',
        line: 15,
        column: 1,
      });
      expect(frames[1]).toEqual({
        function: 'anotherFunction()',
        file: '/path/to/other.php',
        line: 25,
        column: 1,
      });
    });

    it('should parse alternative stack trace format', () => {
      const stackTrace = 'Fatal error: Call to undefined function foo() in /path/file.php:10';

      const frames = handler.parseStackTrace(stackTrace);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual({
        function: '<main>',
        file: '/path/file.php',
        line: 10,
        column: 1,
      });
    });
  });

  describe('Performance Analysis', () => {
    it('should analyze performance and return suggestions', async () => {
      const source = `<?php
        function test() {
          eval('echo "test";');
          mysql_connect('localhost', 'user', 'pass');
          for ($i = 0; $i < count($array); $i++) {
            array_push($result, $array[$i]);
          }
        }
      `;

      const analysis = await handler.analyzePerformance(source);

      // Check that we get suggestions (the exact suggestions may vary)
      expect(analysis.suggestions).toBeDefined();
      expect(Array.isArray(analysis.suggestions)).toBe(true);

      // Check for specific suggestions that should be present
      const suggestionText = analysis.suggestions.join(' ');
      expect(suggestionText).toContain('eval');
      expect(suggestionText).toContain('mysql_');
    });

    it('should calculate complexity correctly', async () => {
      const source = `<?php
        class Test {
          function method() {
            if ($condition) {
              foreach ($items as $item) {
                switch ($item) {
                  case 'a':
                    break;
                  case 'b':
                    break;
                }
              }
            }
          }
        }
      `;

      const analysis = await handler.analyzePerformance(source);
      expect(typeof analysis.complexity).toBe('number');
      expect(analysis.complexity).toBeGreaterThan(1);
    });
  });

  describe('Error Patterns', () => {
    it('should return correct error patterns', () => {
      const patterns = (handler as any).getErrorPatterns();
      expect(patterns).toContainEqual(/Parse error: (.+)/);
      expect(patterns).toContainEqual(/Fatal error: (.+)/);
      expect(patterns).toContainEqual(/Warning: (.+)/);
      expect(patterns).toContainEqual(/Notice: (.+)/);
    });
  });

  describe('Error Detection', () => {
    it('should detect syntax errors', async () => {
      // Mock the validateSyntax method to avoid actual PHP execution in tests
      const mockValidateSyntax = vi.spyOn(handler as any, 'validateSyntax');
      mockValidateSyntax.mockResolvedValue([
        {
          message: 'Parse error: syntax error, unexpected token',
          severity: 'error',
          location: { file: 'test.php', line: 5, column: 1 },
          source: 'php',
        },
      ]);

      const source = '<?php echo "test"'; // Missing semicolon
      const errors = await handler.detectErrors(source);

      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('error');
      expect(errors[0].message).toContain('Parse error');
    });
  });

  describe('Initialization', () => {
    it('should handle initialization gracefully when PHP is not available', async () => {
      // Mock checkAvailability to return false
      const mockCheckAvailability = vi.spyOn(handler as any, 'checkAvailability');
      mockCheckAvailability.mockResolvedValue(false);

      const isAvailable = await handler.isAvailable();
      expect(isAvailable).toBe(false);
    });
  });
});
