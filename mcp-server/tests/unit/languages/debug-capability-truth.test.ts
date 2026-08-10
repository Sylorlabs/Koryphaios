import { describe, expect, it } from 'vitest';

import { GoHandler } from '../../../src/languages/go-handler.js';
import { JavaScriptHandler } from '../../../src/languages/javascript-handler.js';
import { PHPHandler } from '../../../src/languages/php-handler.js';
import { PythonHandler } from '../../../src/languages/python-handler.js';
import { RustHandler } from '../../../src/languages/rust-handler.js';
import { TypeScriptHandler } from '../../../src/languages/typescript-handler.js';
import type { LanguageHandler } from '../../../src/types/languages.js';

const handlers: LanguageHandler[] = [
  new JavaScriptHandler(),
  new TypeScriptHandler(),
  new PythonHandler(),
  new GoHandler(),
  new RustHandler(),
  new PHPHandler(),
];

describe('language debugger capability truth', () => {
  for (const handler of handlers) {
    it(`${handler.language} fails closed while no debugger adapter is bundled`, async () => {
      const capabilities = handler.getDebugCapabilities();

      expect(Object.values(capabilities).every(value => value === false)).toBe(true);
      await expect(handler.createDebugSession({ type: 'launch' })).rejects.toThrow(
        'debug sessions are unavailable in this build'
      );
    });
  }
});
