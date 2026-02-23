/**
 * Test Setup
 * 
 * Global test configuration and utilities.
 */

import { beforeAll, afterAll } from 'bun:test';

// Global test configuration
process.env.NODE_ENV = 'test';
process.env.KORYPHAIOS_DATA_DIR = '/tmp/koryphaios-test';

// Clean up function
export async function cleanup(): Promise<void> {
  // Cleanup logic if needed
}

// Run once before all tests
beforeAll(async () => {
  // Ensure test environment
  console.log('Setting up test environment...');
});

// Run once after all tests
afterAll(async () => {
  await cleanup();
  console.log('Test environment cleaned up');
});
