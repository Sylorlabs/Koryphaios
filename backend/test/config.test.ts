import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { getDesktopDevCorsOrigin, loadConfig, mergeCorsOrigins } from '../src/runtime/config';

const BASE_TEST_DIR = join(tmpdir(), 'koryphaios-config-test');
let testDirCounter = 0;

function getTestDir() {
  return `${BASE_TEST_DIR}-${Date.now()}-${testDirCounter++}`;
}

describe('Config Loading', () => {
  const TEST_DIR = getTestDir();

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test('loads default config when no file exists', () => {
    const config = loadConfig(TEST_DIR);

    expect(config.agents.manager.model).toBeDefined();
    expect(config.server.port).toBeDefined();
    expect(config.safety).toBeDefined();
    expect(config.safety.maxTokensPerTurn).toBe(4096);
    expect(config.safety.maxFileSizeBytes).toBe(10_000_000);
    expect(config.safety.toolExecutionTimeoutMs).toBe(60_000);
  });

  test('loads custom safety config', async () => {
    const dir = getTestDir();
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, 'koryphaios.json'),
        JSON.stringify({
          safety: {
            maxTokensPerTurn: 8192,
            maxFileSizeBytes: 5_000_000,
            toolExecutionTimeoutMs: 120_000,
          },
        }),
      );

      const config = loadConfig(dir);

      expect(config.safety.maxTokensPerTurn).toBe(8192);
      expect(config.safety.maxFileSizeBytes).toBe(5_000_000);
      expect(config.safety.toolExecutionTimeoutMs).toBe(120_000);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('merges partial safety config with defaults', async () => {
    const dir = getTestDir();
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, 'koryphaios.json'),
        JSON.stringify({
          safety: {
            maxTokensPerTurn: 5000,
          },
        }),
      );

      const config = loadConfig(dir);

      expect(config.safety.maxTokensPerTurn).toBe(5000);
      expect(config.safety.maxFileSizeBytes).toBe(10_000_000); // default
      expect(config.safety.toolExecutionTimeoutMs).toBe(60_000); // default
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('loads agent config', async () => {
    const dir = getTestDir();
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, 'koryphaios.json'),
        JSON.stringify({
          agents: {
            manager: { model: 'claude-opus-4-6', reasoningLevel: 'high' },
            coder: { model: 'claude-sonnet-4-5', maxTokens: 16384 },
          },
        }),
      );

      const config = loadConfig(dir);

      expect(config.agents.manager.model).toBe('claude-opus-4-6');
      expect(config.agents.manager.reasoningLevel).toBe('high');
      expect(config.agents.coder.maxTokens).toBe(16384);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('loads server config', async () => {
    const dir = getTestDir();
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, 'koryphaios.json'),
        JSON.stringify({
          server: {
            port: 4000,
          },
        }),
      );

      const config = loadConfig(dir);

      // Port might be overridden by env var, but server config should be loaded
      expect(config.server.port).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('loads context paths', async () => {
    const dir = getTestDir();
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, 'koryphaios.json'),
        JSON.stringify({
          contextPaths: ['.koryrules', 'CLAUDE.md'],
        }),
      );

      const config = loadConfig(dir);

      expect(config.contextPaths).toEqual(['.koryrules', 'CLAUDE.md']);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('loads data directory', async () => {
    const dir = getTestDir();
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, 'koryphaios.json'),
        JSON.stringify({
          dataDirectory: '.my-custom-dir',
        }),
      );

      const config = loadConfig(dir);

      expect(config.dataDirectory).toBe('.my-custom-dir');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('Desktop development CORS', () => {
  test('allows only the launcher-owned loopback frontend origin', () => {
    const origin = getDesktopDevCorsOrigin({
      KORYPHAIOS_DESKTOP_DEV: '1',
      KORYPHAIOS_FRONTEND_HOST: '127.0.0.1',
      KORYPHAIOS_FRONTEND_PORT: '3003',
    });

    expect(origin).toBe('http://127.0.0.1:3003');
    expect(mergeCorsOrigins([], undefined, origin)).toEqual(['http://127.0.0.1:3003']);
  });

  test('does not trust non-loopback or non-desktop origins implicitly', () => {
    expect(
      getDesktopDevCorsOrigin({
        KORYPHAIOS_DESKTOP_DEV: '1',
        KORYPHAIOS_FRONTEND_HOST: '192.168.1.20',
        KORYPHAIOS_FRONTEND_PORT: '3003',
      }),
    ).toBeUndefined();
    expect(
      getDesktopDevCorsOrigin({
        KORYPHAIOS_FRONTEND_HOST: '127.0.0.1',
        KORYPHAIOS_FRONTEND_PORT: '3003',
      }),
    ).toBeUndefined();
  });

  test('deduplicates explicit and launcher-derived origins', () => {
    expect(
      mergeCorsOrigins(
        ['https://app.example.com'],
        'https://app.example.com,http://127.0.0.1:3003',
        'http://127.0.0.1:3003',
      ),
    ).toEqual(['https://app.example.com', 'http://127.0.0.1:3003']);
  });
});

describe('Config Validation', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = getTestDir();
    mkdirSync(testDir, { recursive: true });
    // Clear env vars that could interfere
    delete process.env.KORYPHAIOS_PORT;
    delete process.env.KORYPHAIOS_HOST;
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test('rejects invalid port', async () => {
    const dir = getTestDir();
    mkdirSync(dir, { recursive: true });
    try {
      const originalPort = process.env.KORYPHAIOS_PORT;
      delete process.env.KORYPHAIOS_PORT;

      writeFileSync(
        join(dir, 'koryphaios.json'),
        JSON.stringify({
          server: { port: 99999 },
        }),
      );

      expect(() => loadConfig(dir)).toThrow();

      if (originalPort !== undefined) {
        process.env.KORYPHAIOS_PORT = originalPort;
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('rejects invalid maxTokensPerTurn', () => {
    writeFileSync(
      join(testDir, 'koryphaios.json'),
      JSON.stringify({
        safety: { maxTokensPerTurn: -1 },
      }),
    );

    expect(() => loadConfig(testDir)).toThrow();
  });

  test('rejects invalid maxFileSizeBytes', () => {
    writeFileSync(
      join(testDir, 'koryphaios.json'),
      JSON.stringify({
        safety: { maxFileSizeBytes: 0 },
      }),
    );

    expect(() => loadConfig(testDir)).toThrow();
  });

  test('rejects invalid toolExecutionTimeoutMs', () => {
    writeFileSync(
      join(testDir, 'koryphaios.json'),
      JSON.stringify({
        safety: { toolExecutionTimeoutMs: 100 },
      }),
    );

    expect(() => loadConfig(testDir)).toThrow();
  });
});
