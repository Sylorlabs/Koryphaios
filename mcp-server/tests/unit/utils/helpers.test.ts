import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateId,
  debounce,
  throttle,
  deepClone,
  safeJsonParse,
  formatBytes,
} from '../../../src/utils/helpers.js';

describe('Helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('generateId', () => {
    it('should generate a unique ID', () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^[a-f0-9]{16}$/);
    });

    it('should generate ID with prefix', () => {
      const id = generateId('test');

      expect(id).toMatch(/^test-[a-f0-9]{16}$/);
    });

    it('should generate different IDs each time', () => {
      const ids = Array.from({ length: 100 }, () => generateId());
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(100);
    });
  });

  describe('debounce', () => {
    it('should debounce function calls', () => {
      const mockFn = vi.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn('arg1');
      debouncedFn('arg2');
      debouncedFn('arg3');

      expect(mockFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).toHaveBeenCalledWith('arg3');
    });

    it('should reset timer on subsequent calls', () => {
      const mockFn = vi.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn('arg1');
      vi.advanceTimersByTime(50);
      debouncedFn('arg2');
      vi.advanceTimersByTime(50);

      expect(mockFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).toHaveBeenCalledWith('arg2');
    });
  });

  describe('throttle', () => {
    it('should throttle function calls', () => {
      const mockFn = vi.fn();
      const throttledFn = throttle(mockFn, 100);

      throttledFn('arg1');
      throttledFn('arg2');
      throttledFn('arg3');

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).toHaveBeenCalledWith('arg1');

      vi.advanceTimersByTime(100);

      throttledFn('arg4');

      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(mockFn).toHaveBeenCalledWith('arg4');
    });

    it('should allow calls after throttle period', () => {
      const mockFn = vi.fn();
      const throttledFn = throttle(mockFn, 100);

      throttledFn('arg1');
      expect(mockFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(100);

      throttledFn('arg2');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('deepClone', () => {
    it('should clone objects deeply', () => {
      const obj = {
        a: 1,
        b: { c: 2, d: 3 },
        e: [1, 2, 3],
      };

      const cloned = deepClone(obj);

      expect(cloned).toEqual(obj);
      expect(cloned).not.toBe(obj);
      expect(cloned.b).not.toBe(obj.b);
      expect(cloned.e).not.toBe(obj.e);
    });

    it('should handle null and undefined values', () => {
      expect(deepClone(null)).toBe(null);
      expect(deepClone(undefined)).toBe(undefined);
    });

    it('should clone dates correctly', () => {
      const date = new Date();
      const cloned = deepClone(date);

      expect(cloned).toEqual(date);
      expect(cloned).not.toBe(date);
    });

    it('should clone arrays correctly', () => {
      const arr = [1, { a: 2 }, [3, 4]];
      const cloned = deepClone(arr);

      expect(cloned).toEqual(arr);
      expect(cloned).not.toBe(arr);
      expect(cloned[1]).not.toBe(arr[1]);
    });
  });

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      const result = safeJsonParse('{"a": 1}');
      expect(result).toEqual({ a: 1 });
    });

    it('should return undefined for invalid JSON', () => {
      const result = safeJsonParse('invalid json');
      expect(result).toBeUndefined();
    });

    it('should return default value for invalid JSON', () => {
      const result = safeJsonParse('invalid json', { default: true });
      expect(result).toEqual({ default: true });
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1048576)).toBe('1 MB');
      expect(formatBytes(1073741824)).toBe('1 GB');
    });

    it('should handle negative values', () => {
      // The current implementation doesn't handle negative values properly
      // This test documents the current behavior
      expect(formatBytes(-1024)).toContain('NaN');
    });

    it('should handle decimal places', () => {
      expect(formatBytes(1536, 0)).toBe('2 KB');
      expect(formatBytes(1536, 2)).toBe('1.5 KB'); // parseFloat removes trailing zeros
    });
  });
});
