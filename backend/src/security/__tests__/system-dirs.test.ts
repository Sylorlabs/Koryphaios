// Tests for validateBashCommand system-directory write blocking.
// The systemDirs list is platform-aware (Linux vs macOS); we stub
// process.platform to exercise both paths.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { validateBashCommand } from '../../security';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform() {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
}

describe('validateBashCommand — system directory writes', () => {
  afterEach(() => restorePlatform());

  describe('Linux system dirs', () => {
    beforeEach(() => setPlatform('linux'));

    it('blocks writes to /boot', () => {
      expect(validateBashCommand('echo bad > /boot/evil').safe).toBe(false);
    });

    it('blocks appends to /sys', () => {
      expect(validateBashCommand('echo bad >> /sys/foo').safe).toBe(false);
    });

    it('blocks writes to /proc/sys', () => {
      expect(validateBashCommand('echo 1 > /proc/sys/kernel/foo').safe).toBe(false);
    });

    it('blocks writes to /usr/sbin', () => {
      expect(validateBashCommand('echo x > /usr/sbin/evil').safe).toBe(false);
    });

    it('blocks writes to /sbin', () => {
      expect(validateBashCommand('echo x > /sbin/evil').safe).toBe(false);
    });

    it('allows writes to normal project paths', () => {
      expect(validateBashCommand('echo x > ./output.txt').safe).toBe(true);
    });
  });

  describe('macOS system dirs', () => {
    beforeEach(() => setPlatform('darwin'));

    it('blocks writes to /System', () => {
      expect(validateBashCommand('echo bad > /System/evil').safe).toBe(false);
    });

    it('blocks appends to /Library', () => {
      expect(validateBashCommand('echo bad >> /Library/LaunchAgents/evil').safe).toBe(false);
    });

    it('blocks writes to /usr/sbin', () => {
      expect(validateBashCommand('echo x > /usr/sbin/evil').safe).toBe(false);
    });

    it('blocks writes to /sbin', () => {
      expect(validateBashCommand('echo x > /sbin/evil').safe).toBe(false);
    });

    it('blocks writes to /private/etc', () => {
      expect(validateBashCommand('echo x > /private/etc/evil').safe).toBe(false);
    });

    it('blocks writes to /etc (symlink to /private/etc)', () => {
      expect(validateBashCommand('echo x > /etc/evil').safe).toBe(false);
    });

    it('blocks writes to /bin', () => {
      expect(validateBashCommand('echo x > /bin/evil').safe).toBe(false);
    });

    it('does NOT block Linux-only dirs on macOS', () => {
      // /boot, /sys, /proc/sys don't exist on macOS; they should not be in
      // the macOS systemDirs list, so a write to them would NOT be caught by
      // the system-dir check (other patterns like $() may still block).
      // We verify the dirs are absent by checking that a simple redirect
      // to a non-existent Linux path is allowed.
      expect(validateBashCommand('echo x > /boot/evil').safe).toBe(true);
    });

    it('allows writes to normal project paths', () => {
      expect(validateBashCommand('echo x > ./output.txt').safe).toBe(true);
    });
  });
});
