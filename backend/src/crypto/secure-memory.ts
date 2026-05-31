// Secure Memory Management
// Protects sensitive data from being swapped or dumped

import { randomBytes } from 'crypto';
import { serverLog } from '../logger';

/**
 * Secure buffer that attempts to lock memory and securely wipe on cleanup
 * Note: Full memory protection requires native addons or platform-specific APIs
 */
export class SecureBuffer {
  private buffer: Buffer;
  private readonly size: number;
  private locked = false;
  private destroyed = false;

  constructor(size: number) {
    this.size = size;
    // Allocate zeroed buffer
    this.buffer = Buffer.alloc(size, 0);

    // Attempt to lock memory (best effort without native addons)
    this.attemptLock();

    // Register cleanup
    this.registerCleanup();
  }

  /**
   * Attempt to lock memory from being swapped
   * This is a best-effort without native addons
   */
  private attemptLock(): void {
    try {
      // On Linux, we can try using process.setuid or native binding
      // For now, we just mark it and document the limitation
      this.locked = true;

      // If we had native bindings, we'd do:
      // mlock(this.buffer)

      serverLog.debug(
        { size: this.size },
        'SecureBuffer allocated (memory locking requires native addon)',
      );
    } catch (err) {
      serverLog.warn({ err }, 'Failed to lock secure memory');
    }
  }

  /**
   * Register cleanup handlers
   */
  private registerCleanup(): void {
    // Cleanup on process exit
    process.on('exit', () => this.destroy());

    // Cleanup on uncaught exceptions
    process.on('uncaughtException', () => {
      this.destroy();
    });
  }

  /**
   * Write string data to buffer
   */
  write(data: string): void {
    if (this.destroyed) {
      throw new Error('SecureBuffer has been destroyed');
    }

    // Clear existing data
    this.buffer.fill(0);

    // Write new data
    const bytes = Buffer.from(data, 'utf8');
    if (bytes.length > this.size) {
      throw new Error(`Data exceeds buffer size: ${bytes.length} > ${this.size}`);
    }
    bytes.copy(this.buffer);

    // Clear temporary buffer
    bytes.fill(0);
  }

  /**
   * Read data from buffer
   */
  read(): string {
    if (this.destroyed) {
      throw new Error('SecureBuffer has been destroyed');
    }

    // Find null terminator or end
    let end = this.size;
    for (let i = 0; i < this.size; i++) {
      if (this.buffer[i] === 0) {
        end = i;
        break;
      }
    }

    return this.buffer.toString('utf8', 0, end);
  }

  /**
   * Get buffer reference (careful!)
   */
  getBuffer(): Buffer {
    if (this.destroyed) {
      throw new Error('SecureBuffer has been destroyed');
    }
    return this.buffer;
  }

  /**
   * Securely destroy buffer
   * Overwrites memory multiple times before deallocation
   */
  destroy(): void {
    if (this.destroyed) return;

    // Multi-pass secure wipe
    // Pass 1: Random data
    const random = randomBytes(this.size);
    random.copy(this.buffer);

    // Pass 2: Inverse random
    for (let i = 0; i < this.size; i++) {
      this.buffer[i] = ~random[i];
    }

    // Pass 3: Pattern
    this.buffer.fill(0xaa);

    // Pass 4: Inverse pattern
    this.buffer.fill(0x55);

    // Final: Zeros
    this.buffer.fill(0);

    // Release reference for GC
    this.buffer = Buffer.alloc(0);
    this.destroyed = true;

    serverLog.debug('SecureBuffer destroyed');
  }

  /**
   * Check if buffer is still valid
   */
  isValid(): boolean {
    return !this.destroyed;
  }
}

/**
 * Secure string that auto-wipes after use
 */
export class SecureString {
  private buffer: SecureBuffer | null;
  private readonly maxAgeMs: number;
  private createdAt: number;
  private accessCount = 0;
  private maxAccesses: number;

  constructor(value: string, options: { maxAgeMs?: number; maxAccesses?: number } = {}) {
    this.maxAgeMs = options.maxAgeMs || 5 * 60 * 1000; // 5 minutes default
    this.maxAccesses = options.maxAccesses || 100;
    this.createdAt = Date.now();

    const size = Buffer.byteLength(value, 'utf8') + 1;
    this.buffer = new SecureBuffer(size);
    this.buffer.write(value);

    // Auto-expire
    if (this.maxAgeMs > 0) {
      setTimeout(() => this.destroy(), this.maxAgeMs);
    }
  }

  /**
   * Access the secure value
   */
  withValue<T>(callback: (value: string) => T): T {
    if (!this.buffer || !this.buffer.isValid()) {
      throw new Error('SecureString has been destroyed or expired');
    }

    this.accessCount++;
    if (this.accessCount > this.maxAccesses) {
      this.destroy();
      throw new Error('SecureString access limit exceeded');
    }

    const value = this.buffer.read();
    try {
      return callback(value);
    } finally {
      // Clear value from stack/heap as best we can
      // In reality, this is hard to guarantee in JavaScript
    }
  }

  /**
   * Get value once and destroy
   */
  consume(): string {
    const value = this.withValue((v) => v);
    this.destroy();
    return value;
  }

  /**
   * Destroy the secure string
   */
  destroy(): void {
    if (this.buffer) {
      this.buffer.destroy();
      this.buffer = null;
    }
  }
}

/**
 * Secure key storage using platform keychain (when available)
 * Falls back to encrypted file storage
 */
export class SecureKeyStorage {
  private static readonly KEY_PREFIX = 'koryphaios.';

  /**
   * Store a key in the platform keychain
   */
  async store(keyId: string, data: string): Promise<void> {
    const prefixedKey = SecureKeyStorage.KEY_PREFIX + keyId;

    try {
      // Try platform-specific storage first
      if (process.platform === 'darwin') {
        await this.storeMacOS(prefixedKey, data);
      } else if (process.platform === 'linux') {
        await this.storeLinux(prefixedKey, data);
      } else if (process.platform === 'win32') {
        await this.storeWindows(prefixedKey, data);
      } else {
        throw new Error('Unsupported platform for secure storage');
      }
    } catch (err) {
      serverLog.warn({ err, keyId }, 'Platform keychain unavailable, using fallback');
      await this.storeFallback(prefixedKey, data);
    }
  }

  /**
   * Retrieve a key from storage
   */
  async retrieve(keyId: string): Promise<string | null> {
    const prefixedKey = SecureKeyStorage.KEY_PREFIX + keyId;

    try {
      if (process.platform === 'darwin') {
        return await this.retrieveMacOS(prefixedKey);
      } else if (process.platform === 'linux') {
        return await this.retrieveLinux(prefixedKey);
      } else if (process.platform === 'win32') {
        return await this.retrieveWindows(prefixedKey);
      }
    } catch (err) {
      return await this.retrieveFallback(prefixedKey);
    }

    return null;
  }

  /**
   * Delete a key from storage
   */
  async delete(keyId: string): Promise<void> {
    const prefixedKey = SecureKeyStorage.KEY_PREFIX + keyId;

    try {
      if (process.platform === 'darwin') {
        await this.deleteMacOS(prefixedKey);
      } else if (process.platform === 'linux') {
        await this.deleteLinux(prefixedKey);
      } else if (process.platform === 'win32') {
        await this.deleteWindows(prefixedKey);
      }
    } catch (err) {
      await this.deleteFallback(prefixedKey);
    }
  }

  // macOS Keychain implementation
  private async storeMacOS(key: string, data: string): Promise<void> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Delete existing first
    try {
      await execAsync(`security delete-generic-password -s "${key}" 2>/dev/null`);
    } catch {
      // Ignore if doesn't exist
    }

    await execAsync(
      `security add-generic-password -s "${key}" -a koryphaios -w "${Buffer.from(data).toString('base64')}"`,
    );
  }

  private async retrieveMacOS(key: string): Promise<string | null> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const { stdout } = await execAsync(`security find-generic-password -s "${key}" -w`);
      return Buffer.from(stdout.trim(), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  private async deleteMacOS(key: string): Promise<void> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      await execAsync(`security delete-generic-password -s "${key}"`);
    } catch {
      // Ignore
    }
  }

  // Linux Secret Service implementation
  private async storeLinux(key: string, data: string): Promise<void> {
    // Would use libsecret via native addon or dbus
    // For now, fallback to file-based
    throw new Error('Linux Secret Service not yet implemented');
  }

  private async retrieveLinux(key: string): Promise<string | null> {
    throw new Error('Linux Secret Service not yet implemented');
  }

  private async deleteLinux(key: string): Promise<void> {
    throw new Error('Linux Secret Service not yet implemented');
  }

  // Windows Credential Manager implementation
  private async storeWindows(key: string, data: string): Promise<void> {
    // Would use Windows Credential API via native addon
    throw new Error('Windows Credential Manager not yet implemented');
  }

  private async retrieveWindows(key: string): Promise<string | null> {
    throw new Error('Windows Credential Manager not yet implemented');
  }

  private async deleteWindows(key: string): Promise<void> {
    throw new Error('Windows Credential Manager not yet implemented');
  }

  // Fallback file-based storage (encrypted)
  private async storeFallback(key: string, data: string): Promise<void> {
    const { writeFileSync, mkdirSync, chmodSync } = await import('fs');
    const { join } = await import('path');
    const { PROJECT_ROOT } = await import('../runtime/paths');

    const keyDir = join(PROJECT_ROOT, '.koryphaios', 'keys');
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });

    const keyPath = join(keyDir, `${key}.enc`);

    // Encrypt before storing (using existing encryption)
    const { secureEncryption } = await import('./secure-encryption');
    const encrypted = await secureEncryption.encrypt(data);
    const serialized = secureEncryption.serialize(encrypted);

    writeFileSync(keyPath, serialized, { mode: 0o600 });
  }

  private async retrieveFallback(key: string): Promise<string | null> {
    const { readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const { PROJECT_ROOT } = await import('../runtime/paths');

    const keyPath = join(PROJECT_ROOT, '.koryphaios', 'keys', `${key}.enc`);

    if (!existsSync(keyPath)) return null;

    try {
      const serialized = readFileSync(keyPath, 'utf8');
      const { secureEncryption } = await import('./secure-encryption');
      const envelope = secureEncryption.parse(serialized);
      return await secureEncryption.decrypt(envelope);
    } catch {
      return null;
    }
  }

  private async deleteFallback(key: string): Promise<void> {
    const { unlinkSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const { PROJECT_ROOT } = await import('../runtime/paths');

    const keyPath = join(PROJECT_ROOT, '.koryphaios', 'keys', `${key}.enc`);
    if (existsSync(keyPath)) {
      unlinkSync(keyPath);
    }
  }
}

// Export singleton
export const secureKeyStorage = new SecureKeyStorage();
