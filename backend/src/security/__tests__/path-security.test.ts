// Security tests for path traversal protection

import { describe, it, expect } from 'bun:test';
import {
  validatePathAccess,
  sanitizePathComponent,
  validatePathParameter,
  validateApiPath,
  safePathJoin,
} from '../path-security';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Path Security', () => {
  const testRoot = tmpdir();

  describe('validatePathAccess', () => {
    it('should allow paths within allowed root', () => {
      const result = validatePathAccess('file.txt', [testRoot]);
      expect(result.allowed).toBe(true);
      expect(result.resolvedPath).toBe(join(testRoot, 'file.txt'));
    });

    it('should block ../ traversal', () => {
      const result = validatePathAccess('../etc/passwd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block deep traversal', () => {
      const result = validatePathAccess('../../../etc/passwd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block traversal in middle of path', () => {
      const result = validatePathAccess('foo/../../etc/passwd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block URL encoded traversal %2e%2e', () => {
      const result = validatePathAccess('%2e%2e/%2e%2e/etc/passwd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block double URL encoded traversal %252e', () => {
      const result = validatePathAccess('%252e%252e/%252e%252e/etc/passwd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block null bytes', () => {
      const result = validatePathAccess('file.txt\0/etc/passwd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block absolute path outside root', () => {
      const result = validatePathAccess('/etc/passwd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should allow absolute path within root', () => {
      const filePath = join(testRoot, 'file.txt');
      const result = validatePathAccess(filePath, [testRoot]);
      expect(result.allowed).toBe(true);
    });

    it('should handle multiple allowed roots', () => {
      const root1 = '/allowed/path1';
      const root2 = '/allowed/path2';

      const result1 = validatePathAccess('file.txt', [root1, root2]);
      expect(result1.allowed).toBe(true);

      const result2 = validatePathAccess('/allowed/path2/file.txt', [root1, root2]);
      expect(result2.allowed).toBe(true);
    });

    it('should normalize . in paths', () => {
      const result = validatePathAccess('./file.txt', [testRoot]);
      expect(result.allowed).toBe(true);
    });

    it('should handle Windows-style backslashes', () => {
      const result = validatePathAccess('..\\etc\\passwd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block ~ expansion attempts', () => {
      const result = validatePathAccess('~/.ssh/id_rsa', [testRoot]);
      expect(result.allowed).toBe(false);
    });
  });

  describe('sanitizePathComponent', () => {
    it('should remove path separators', () => {
      expect(sanitizePathComponent('file/name')).toBe('filename');
      expect(sanitizePathComponent('file\\name')).toBe('filename');
    });

    it('should remove traversal sequences', () => {
      expect(sanitizePathComponent('..file')).toBe('file');
      expect(sanitizePathComponent('file..name')).toBe('filename');
    });

    it('should remove leading dots', () => {
      expect(sanitizePathComponent('.hidden')).toBe('hidden');
      expect(sanitizePathComponent('..hidden')).toBe('hidden');
    });

    it('should remove null bytes', () => {
      expect(sanitizePathComponent('file\0name')).toBe('filename');
    });

    it('should trim whitespace', () => {
      expect(sanitizePathComponent('  file  ')).toBe('file');
    });

    it('should provide default for empty names', () => {
      expect(sanitizePathComponent('')).toBe('unnamed');
      expect(sanitizePathComponent('..')).toBe('unnamed');
      expect(sanitizePathComponent('   ')).toBe('unnamed');
    });

    it('should preserve valid filenames', () => {
      expect(sanitizePathComponent('file.txt')).toBe('file.txt');
      expect(sanitizePathComponent('my-file_name')).toBe('my-file_name');
      expect(sanitizePathComponent('file123')).toBe('file123');
    });
  });

  describe('validatePathParameter', () => {
    it('should validate alphanumeric IDs', () => {
      const result = validatePathParameter('abc123');
      expect(result.valid).toBe(true);
    });

    it('should allow hyphens and underscores', () => {
      const result = validatePathParameter('my-session_id-123');
      expect(result.valid).toBe(true);
    });

    it('should reject empty parameters', () => {
      const result = validatePathParameter('');
      expect(result.valid).toBe(false);
    });

    it('should reject path separators', () => {
      expect(validatePathParameter('abc/def').valid).toBe(false);
      expect(validatePathParameter('abc\\def').valid).toBe(false);
    });

    it('should reject traversal sequences', () => {
      expect(validatePathParameter('..').valid).toBe(false);
      expect(validatePathParameter('abc..def').valid).toBe(false);
    });

    it('should reject URL encoded traversal', () => {
      expect(validatePathParameter('%2e%2e').valid).toBe(false);
    });

    it('should reject special characters', () => {
      expect(validatePathParameter('file<script>').valid).toBe(false);
      expect(validatePathParameter('file;rm -rf').valid).toBe(false);
    });

    it('should enforce max length', () => {
      const longId = 'a'.repeat(300);
      const result = validatePathParameter(longId, { maxLength: 256 });
      expect(result.valid).toBe(false);
    });

    it('should allow custom character sets', () => {
      const result = validatePathParameter('123-456', {
        allowedChars: /^[0-9-]+$/,
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('validateApiPath', () => {
    it('should allow valid API paths', () => {
      const result = validateApiPath('/api/sessions/abc123');
      expect(result).toBeNull();
    });

    it('should reject paths without allowed prefix', () => {
      const result = validateApiPath('/admin/config');
      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(400);
    });

    it('should reject paths with traversal', () => {
      const result = validateApiPath('/api/sessions/../config');
      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(403);
    });

    it('should reject URL encoded traversal', () => {
      const result = validateApiPath('/api/sessions/%2e%2e/config');
      expect(result).toBeInstanceOf(Response);
    });

    it('should reject double slashes', () => {
      const result = validateApiPath('/api//sessions/abc');
      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(400);
    });

    it('should reject null bytes', () => {
      const result = validateApiPath('/api/sessions/abc\0/def');
      expect(result).toBeInstanceOf(Response);
    });

    it('should validate session IDs when required', () => {
      const result = validateApiPath('/api/sessions/invalid@id', {
        requireSessionId: true,
      });
      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(400);
    });

    it('should allow custom prefixes', () => {
      const result = validateApiPath('/health', {
        allowedPrefixes: ['/health', '/ready'],
      });
      expect(result).toBeNull();
    });
  });

  describe('safePathJoin', () => {
    it('should join paths safely', () => {
      const result = safePathJoin('/base', 'dir', 'file.txt');
      expect(result.safe).toBe(true);
      expect(result.fullPath).toBe('/base/dir/file.txt');
    });

    it('should block traversal in segments', () => {
      const result = safePathJoin('/base', '..', 'etc');
      expect(result.safe).toBe(false);
    });

    it('should block path separators in segments', () => {
      const result = safePathJoin('/base', 'dir/subdir', 'file.txt');
      expect(result.safe).toBe(false);
    });

    it('should block Windows separators', () => {
      const result = safePathJoin('/base', 'dir\\subdir');
      expect(result.safe).toBe(false);
    });

    it('should normalize redundant separators', () => {
      const result = safePathJoin('/base//', 'dir');
      expect(result.safe).toBe(true);
      expect(result.fullPath).toBe('/base/dir');
    });

    it('should handle single segment', () => {
      const result = safePathJoin('/base');
      expect(result.safe).toBe(true);
      expect(result.fullPath).toBe('/base');
    });

    it('should handle empty segments', () => {
      const result = safePathJoin('/base', '', 'file.txt');
      expect(result.safe).toBe(true);
    });
  });

  describe('Complex Attack Scenarios', () => {
    it('should block mixed encoding attacks', () => {
      // %252e decodes to %2e which decodes to .
      const result = validatePathAccess('%252e%252e%252fetc%252fpasswd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block null byte injection', () => {
      // Null byte might truncate string in some systems
      const result = validatePathAccess('file.txt%00.php', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block Unicode normalization attacks', () => {
      // Unicode characters that look like ..
      const result = validatePathAccess('..%c0%afetc/passwd', [testRoot]);
      expect(result.allowed).toBe(false);
    });

    it('should block directory bypass with multiple slashes', () => {
      const result = validatePathAccess('/api/sessions//../../etc/passwd', [testRoot]);
      expect(result).toBeDefined();
      if (result) expect(result.allowed).toBe(false);
    });
  });
});
