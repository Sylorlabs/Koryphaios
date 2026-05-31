/**
 * Tests for ProcessManager utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  ProcessManager,
  type ProcessOptions,
  type ProcessInfo,
} from '../../../src/utils/process-manager.js';

// Create a factory function for mock child processes
const createMockChildProcess = () => ({
  pid: 12345,
  stdout: new EventEmitter(),
  stderr: new EventEmitter(),
  stdin: new EventEmitter(),
  kill: vi.fn(),
  on: vi.fn(),
});

let mockChildProcess: ReturnType<typeof createMockChildProcess>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockChildProcess),
  exec: vi.fn(),
}));

// Mock helpers
vi.mock('../../../src/utils/helpers.js', () => ({
  generateId: vi.fn(() => 'proc-test-id'),
}));

describe('ProcessManager', () => {
  let processManager: ProcessManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Create a fresh mock for each test
    mockChildProcess = createMockChildProcess();
    const { spawn, exec } = vi.mocked(await import('child_process'));
    spawn.mockClear();
    exec.mockClear();
    // Update the spawn mock to return the fresh mock
    spawn.mockReturnValue(mockChildProcess);
    processManager = new ProcessManager();
  });

  afterEach(() => {
    processManager.cleanup();
  });

  describe('Constructor', () => {
    it('should create ProcessManager instance', () => {
      expect(processManager).toBeInstanceOf(ProcessManager);
      expect(processManager).toBeInstanceOf(EventEmitter);
    });
  });

  describe('spawn()', () => {
    it('should spawn a process successfully', async () => {
      const { spawn } = vi.mocked(await import('child_process'));

      // Simulate successful spawn
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')?.[1];
        if (spawnHandler) spawnHandler();
      }, 0);

      const result = await processManager.spawn('node', ['--version']);

      expect(spawn).toHaveBeenCalledWith('node', ['--version'], expect.any(Object));
      expect(result.id).toBe('proc-test-id');
      expect(result.process).toBe(mockChildProcess);
    });

    it('should spawn process with custom options', async () => {
      const { spawn } = vi.mocked(await import('child_process'));
      const options: ProcessOptions = {
        cwd: '/test/dir',
        env: { NODE_ENV: 'test' },
        timeout: 5000,
      };

      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')?.[1];
        if (spawnHandler) spawnHandler();
      }, 0);

      await processManager.spawn('node', ['--version'], options);

      expect(spawn).toHaveBeenCalledWith(
        'node',
        ['--version'],
        expect.objectContaining({
          cwd: '/test/dir',
          env: { NODE_ENV: 'test' },
        })
      );
    });

    it('should handle spawn errors', async () => {
      setTimeout(() => {
        const errorHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'error')[1];
        errorHandler(new Error('Spawn failed'));
      }, 0);

      await expect(processManager.spawn('invalid-command')).rejects.toThrow('Spawn failed');
    });

    it('should set up event handlers', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      await processManager.spawn('node', ['--version']);

      expect(mockChildProcess.on).toHaveBeenCalledWith('spawn', expect.any(Function));
      expect(mockChildProcess.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockChildProcess.on).toHaveBeenCalledWith('exit', expect.any(Function));
    });

    it('should handle process timeout', async () => {
      vi.useFakeTimers();

      const options: ProcessOptions = { timeout: 1000 };

      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      const promise = processManager.spawn('node', ['--version'], options);

      // Fast-forward time to trigger timeout
      vi.advanceTimersByTime(1000);

      await promise;

      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');

      vi.useRealTimers();
    });
  });

  describe('exec()', () => {
    it('should execute command and return output', async () => {
      // Set up the mock to automatically trigger events
      let spawnHandler: (() => void) | undefined;
      let exitHandler: ((code: number) => void) | undefined;

      mockChildProcess.on.mockImplementation((event: string, handler: any) => {
        if (event === 'spawn') {
          spawnHandler = handler;
          // Trigger spawn immediately in next tick
          process.nextTick(() => handler());
        } else if (event === 'exit') {
          exitHandler = handler;
        }
        return mockChildProcess;
      });

      // Start the exec process
      const execPromise = processManager.exec('echo', ['Hello World']);

      // Wait for spawn to be triggered
      await new Promise(resolve => process.nextTick(resolve));
      await new Promise(resolve => process.nextTick(resolve));

      // Simulate stdout data
      mockChildProcess.stdout.emit('data', 'Hello ');
      mockChildProcess.stdout.emit('data', 'World');

      // Simulate stderr data
      mockChildProcess.stderr.emit('data', 'Warning: test');

      // Simulate process exit
      if (exitHandler) {
        exitHandler(0);
      }

      const result = await execPromise;

      expect(result.stdout).toBe('Hello World');
      expect(result.stderr).toBe('Warning: test');
      expect(result.exitCode).toBe(0);
    });

    it('should handle exec errors', async () => {
      const execPromise = processManager.exec('invalid-command');

      // Use setImmediate for proper event loop handling
      await new Promise(resolve => setImmediate(resolve));

      const errorHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'error')?.[1];
      if (errorHandler) {
        errorHandler(new Error('Exec failed'));
      }

      await expect(execPromise).rejects.toThrow('Exec failed');
    });

    it('should handle null exit code', async () => {
      // Set up the mock to automatically trigger events
      let spawnHandler: (() => void) | undefined;
      let exitHandler: ((code: number | null) => void) | undefined;

      mockChildProcess.on.mockImplementation((event: string, handler: any) => {
        if (event === 'spawn') {
          spawnHandler = handler;
          // Trigger spawn immediately in next tick
          process.nextTick(() => handler());
        } else if (event === 'exit') {
          exitHandler = handler;
        }
        return mockChildProcess;
      });

      const execPromise = processManager.exec('test-command');

      // Wait for spawn to be triggered
      await new Promise(resolve => process.nextTick(resolve));
      await new Promise(resolve => process.nextTick(resolve));

      // Simulate process exit with null code
      if (exitHandler) {
        exitHandler(null);
      }

      const result = await execPromise;
      expect(result.exitCode).toBe(-1);
    });
  });

  describe('kill()', () => {
    it('should kill process by id', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      const { id } = await processManager.spawn('node', ['--version']);

      const result = processManager.kill(id);

      expect(result).toBe(true);
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should kill process with custom signal', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      const { id } = await processManager.spawn('node', ['--version']);

      processManager.kill(id, 'SIGKILL');

      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should return false for non-existent process', () => {
      const result = processManager.kill('non-existent-id');
      expect(result).toBe(false);
    });

    it('should handle kill errors', async () => {
      mockChildProcess.kill.mockImplementation(() => {
        throw new Error('Kill failed');
      });

      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      const { id } = await processManager.spawn('node', ['--version']);

      const errorHandler = vi.fn();
      processManager.on('process:error', errorHandler);

      const result = processManager.kill(id);

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalledWith({
        id,
        error: expect.any(Error),
      });
    });
  });

  describe('killAll()', () => {
    it('should kill all processes', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      await processManager.spawn('node', ['--version']);

      processManager.killAll();

      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should kill all processes with custom signal', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      await processManager.spawn('node', ['--version']);

      processManager.killAll('SIGKILL');

      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });

  describe('Process Information', () => {
    it('should get process by id', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      const { id } = await processManager.spawn('node', ['--version']);

      const process = processManager.getProcess(id);
      expect(process).toBe(mockChildProcess);
    });

    it('should get process info by id', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      const { id } = await processManager.spawn('node', ['--version']);

      const info = processManager.getProcessInfo(id);
      expect(info).toMatchObject({
        id: 'proc-test-id',
        command: 'node',
        args: ['--version'],
        pid: 12345,
        status: 'running',
      });
    });

    it('should list all processes', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      await processManager.spawn('node', ['--version']);

      const processes = processManager.listProcesses();
      expect(processes).toHaveLength(1);
      expect(processes[0].command).toBe('node');
    });

    it('should get running processes', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      await processManager.spawn('node', ['--version']);

      const runningProcesses = processManager.getRunningProcesses();
      expect(runningProcesses).toHaveLength(1);
      expect(runningProcesses[0].status).toBe('running');
    });

    it('should check if process is running', async () => {
      setTimeout(() => {
        const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')[1];
        spawnHandler();
      }, 0);

      const { id } = await processManager.spawn('node', ['--version']);

      expect(processManager.isProcessRunning(id)).toBe(true);
      expect(processManager.isProcessRunning('non-existent')).toBe(false);
    });
  });

  describe('Utility Methods', () => {
    it('should run linter', async () => {
      // Set up the mock to automatically trigger events
      let exitHandler: ((code: number) => void) | undefined;

      mockChildProcess.on.mockImplementation((event: string, handler: any) => {
        if (event === 'spawn') {
          // Trigger spawn immediately in next tick
          process.nextTick(() => handler());
        } else if (event === 'exit') {
          exitHandler = handler;
        }
        return mockChildProcess;
      });

      const linterPromise = processManager.runLinter('eslint', ['src/**/*.js']);

      // Wait for spawn to be triggered
      await new Promise(resolve => process.nextTick(resolve));
      await new Promise(resolve => process.nextTick(resolve));

      // Trigger exit event
      if (exitHandler) {
        exitHandler(0);
      }

      const result = await linterPromise;
      expect(result.exitCode).toBe(0);
    });

    it('should run type checker', async () => {
      // Set up the mock to automatically trigger events
      let exitHandler: ((code: number) => void) | undefined;

      mockChildProcess.on.mockImplementation((event: string, handler: any) => {
        if (event === 'spawn') {
          // Trigger spawn immediately in next tick
          process.nextTick(() => handler());
        } else if (event === 'exit') {
          exitHandler = handler;
        }
        return mockChildProcess;
      });

      const typeCheckerPromise = processManager.runTypeChecker('tsc', 'tsconfig.json');

      // Wait for spawn to be triggered
      await new Promise(resolve => process.nextTick(resolve));
      await new Promise(resolve => process.nextTick(resolve));

      // Trigger exit event
      if (exitHandler) {
        exitHandler(0);
      }

      const result = await typeCheckerPromise;
      expect(result.exitCode).toBe(0);
    });

    it('should run tests', async () => {
      // Set up the mock to automatically trigger events
      let exitHandler: ((code: number) => void) | undefined;

      mockChildProcess.on.mockImplementation((event: string, handler: any) => {
        if (event === 'spawn') {
          // Trigger spawn immediately in next tick
          process.nextTick(() => handler());
        } else if (event === 'exit') {
          exitHandler = handler;
        }
        return mockChildProcess;
      });

      const testsPromise = processManager.runTests('jest', ['test/**/*.test.js']);

      // Wait for spawn to be triggered
      await new Promise(resolve => process.nextTick(resolve));
      await new Promise(resolve => process.nextTick(resolve));

      // Trigger exit event
      if (exitHandler) {
        exitHandler(0);
      }

      const result = await testsPromise;
      expect(result.exitCode).toBe(0);
    });

    it('should run build', async () => {
      // Set up the mock to automatically trigger events
      let exitHandler: ((code: number) => void) | undefined;

      mockChildProcess.on.mockImplementation((event: string, handler: any) => {
        if (event === 'spawn') {
          // Trigger spawn immediately in next tick
          process.nextTick(() => handler());
        } else if (event === 'exit') {
          exitHandler = handler;
        }
        return mockChildProcess;
      });

      const buildPromise = processManager.runBuild('npm', 'run build');

      // Wait for spawn to be triggered
      await new Promise(resolve => process.nextTick(resolve));
      await new Promise(resolve => process.nextTick(resolve));

      // Trigger exit event
      if (exitHandler) {
        exitHandler(0);
      }

      const result = await buildPromise;
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Debug and Profiling Methods', () => {
    it('should start debug session', async () => {
      const debugPromise = processManager.startDebugSession('node', 'app.js', ['--inspect']);

      // Wait for next tick to ensure event handlers are set up
      await new Promise(resolve => setTimeout(resolve, 0));

      const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')?.[1];
      if (spawnHandler) spawnHandler();

      const result = await debugPromise;
      expect(result.id).toBe('proc-test-id');
      expect(result.process).toBe(mockChildProcess);
    });

    it('should attach debugger', async () => {
      const attachPromise = processManager.attachDebugger('node', 12345);

      // Wait for next tick to ensure event handlers are set up
      await new Promise(resolve => setTimeout(resolve, 0));

      const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')?.[1];
      if (spawnHandler) spawnHandler();

      const result = await attachPromise;
      expect(result.id).toBe('proc-test-id');
    });

    it('should start profiler', async () => {
      const profilerPromise = processManager.startProfiler('node', 'app.js', 30000);

      // Wait for next tick to ensure event handlers are set up
      await new Promise(resolve => setTimeout(resolve, 0));

      const spawnHandler = mockChildProcess.on.mock.calls.find(call => call[0] === 'spawn')?.[1];
      if (spawnHandler) spawnHandler();

      const result = await profilerPromise;
      expect(result.id).toBe('proc-test-id');
    });

    it('should analyze memory', async () => {
      // Set up the mock to automatically trigger events
      let exitHandler: ((code: number) => void) | undefined;

      mockChildProcess.on.mockImplementation((event: string, handler: any) => {
        if (event === 'spawn') {
          // Trigger spawn immediately in next tick
          process.nextTick(() => handler());
        } else if (event === 'exit') {
          exitHandler = handler;
        }
        return mockChildProcess;
      });

      const memoryPromise = processManager.analyzeMemory('heapdump', 'app.js');

      // Wait for spawn to be triggered
      await new Promise(resolve => process.nextTick(resolve));
      await new Promise(resolve => process.nextTick(resolve));

      // Trigger exit event
      if (exitHandler) {
        exitHandler(0);
      }

      const result = await memoryPromise;
      expect(result.exitCode).toBe(0);
    });
  });

  describe('cleanup()', () => {
    it('should cleanup all processes', async () => {
      vi.useFakeTimers();

      // Set up the mock to automatically trigger spawn event
      mockChildProcess.on.mockImplementation((event: string, handler: any) => {
        if (event === 'spawn') {
          // Trigger spawn immediately in next tick
          process.nextTick(() => handler());
        }
        return mockChildProcess;
      });

      // Spawn multiple processes to test cleanup
      const spawnPromise1 = processManager.spawn('node', ['--version']);
      const spawnPromise2 = processManager.spawn('node', ['--help']);

      // Wait for spawn to be triggered
      await new Promise(resolve => process.nextTick(resolve));
      await Promise.all([spawnPromise1, spawnPromise2]);

      // Clear previous kill calls
      mockChildProcess.kill.mockClear();

      // Mock the killAll method to track calls properly
      const killAllSpy = vi.spyOn(processManager, 'killAll');

      processManager.cleanup();

      // Verify SIGTERM was called first
      expect(killAllSpy).toHaveBeenCalledWith('SIGTERM');
      expect(killAllSpy).toHaveBeenCalledTimes(1);

      // Fast-forward to trigger SIGKILL timeout
      vi.advanceTimersByTime(5000);

      // Verify SIGKILL was called after timeout
      expect(killAllSpy).toHaveBeenCalledWith('SIGKILL');
      expect(killAllSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });
});
