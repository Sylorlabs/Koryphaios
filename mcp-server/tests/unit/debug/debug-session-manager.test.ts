/**
 * Tests for DebugSessionManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DebugSessionManager } from '../../../src/debug/debug-session-manager.js';
import { LanguageHandlerManager } from '../../../src/languages/language-handler-manager.js';
import { SupportedLanguage } from '../../../src/types/languages.js';

// Mock the language handler manager
vi.mock('../../../src/languages/language-handler-manager.js');

describe('DebugSessionManager', () => {
  let debugSessionManager: DebugSessionManager;
  let mockLanguageManager: LanguageHandlerManager;
  let mockHandler: any;

  beforeEach(() => {
    // Create mock debug session
    const mockDebugSession = {
      id: 'mock-session',
      setBreakpoint: vi.fn().mockResolvedValue(undefined),
      removeBreakpoint: vi.fn().mockResolvedValue(undefined),
      continue: vi.fn().mockResolvedValue(undefined),
      stepOver: vi.fn().mockResolvedValue(undefined),
      stepInto: vi.fn().mockResolvedValue(undefined),
      stepOut: vi.fn().mockResolvedValue(undefined),
      getStackTrace: vi.fn().mockResolvedValue([]),
      getCallStack: vi.fn().mockResolvedValue([]),
      evaluate: vi
        .fn()
        .mockResolvedValue({ name: 'test', value: '42', type: 'number', scope: 'local' }),
      evaluateExpression: vi.fn().mockResolvedValue({ result: '42', type: 'number' }),
      stop: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };

    // Create mock handler
    mockHandler = {
      getDebugCapabilities: vi.fn().mockReturnValue({
        supportsBreakpoints: true,
        supportsConditionalBreakpoints: true,
        supportsStepInto: true,
        supportsStepOver: true,
        supportsStepOut: true,
        supportsVariableInspection: true,
        supportsWatchExpressions: true,
        supportsHotReload: false,
        supportsRemoteDebugging: false,
      }),
      createDebugSession: vi.fn().mockResolvedValue(mockDebugSession),
      // Add direct access to the mock session for test assertions
      mockDebugSession,
    };

    // Create mock language manager
    mockLanguageManager = {
      getHandler: vi.fn().mockReturnValue(mockHandler),
    } as any;

    debugSessionManager = new DebugSessionManager(mockLanguageManager);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createSession', () => {
    it('should create a debug session successfully', async () => {
      const config = {
        type: 'launch' as const,
        program: 'test.js',
      };

      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      expect(sessionId).toMatch(/^debug-session-\d+$/);
      expect(mockLanguageManager.getHandler).toHaveBeenCalledWith(SupportedLanguage.JAVASCRIPT);
      expect(mockHandler.getDebugCapabilities).toHaveBeenCalled();
      expect(mockHandler.createDebugSession).toHaveBeenCalledWith(config);

      const session = debugSessionManager.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.language).toBe(SupportedLanguage.JAVASCRIPT);
      expect(session?.config).toEqual(config);
      expect(session?.status).toBe('starting');
    });

    it('should throw error when handler is not available', async () => {
      (mockLanguageManager.getHandler as any).mockReturnValue(undefined);

      const config = { type: 'launch' as const, program: 'test.js' };

      await expect(
        debugSessionManager.createSession(SupportedLanguage.JAVASCRIPT, config)
      ).rejects.toThrow('No handler available for language: javascript');
    });

    it('should throw error when language does not support debugging', async () => {
      mockHandler.getDebugCapabilities.mockReturnValue({
        supportsBreakpoints: false,
        supportsConditionalBreakpoints: false,
        supportsStepInto: false,
        supportsStepOver: false,
        supportsStepOut: false,
        supportsVariableInspection: false,
        supportsWatchExpressions: false,
        supportsHotReload: false,
        supportsRemoteDebugging: false,
      });

      const config = { type: 'launch' as const, program: 'test.js' };

      await expect(
        debugSessionManager.createSession(SupportedLanguage.JAVASCRIPT, config)
      ).rejects.toThrow('Language javascript does not support debugging');
    });
  });

  describe('stopSession', () => {
    it('should stop a debug session successfully', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      await debugSessionManager.stopSession(sessionId);

      expect(mockHandler.mockDebugSession.terminate).toHaveBeenCalled();
      expect(debugSessionManager.getSession(sessionId)).toBeUndefined();
    });

    it('should throw error when session is not found', async () => {
      await expect(debugSessionManager.stopSession('non-existent-session')).rejects.toThrow(
        'Session not found: non-existent-session'
      );
    });
  });

  describe('setBreakpoint', () => {
    it('should set a breakpoint successfully', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      const breakpointId = await debugSessionManager.setBreakpoint(
        sessionId,
        'test.js',
        10,
        5,
        'x > 0'
      );

      expect(breakpointId).toMatch(/^bp-debug-session-\d+-\d+$/);
      expect(mockHandler.mockDebugSession.setBreakpoint).toHaveBeenCalledWith(
        'test.js',
        10,
        'x > 0'
      );

      const breakpoints = debugSessionManager.getBreakpoints(sessionId);
      expect(breakpoints).toHaveLength(1);
      expect(breakpoints[0]).toMatchObject({
        id: breakpointId,
        file: 'test.js',
        line: 10,
        column: 5,
        condition: 'x > 0',
        enabled: true,
        verified: true,
      });
    });

    it('should throw error when session is not found', async () => {
      await expect(
        debugSessionManager.setBreakpoint('non-existent-session', 'test.js', 10)
      ).rejects.toThrow('Session not found: non-existent-session');
    });
  });

  describe('removeBreakpoint', () => {
    it('should remove a breakpoint successfully', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );
      const breakpointId = await debugSessionManager.setBreakpoint(sessionId, 'test.js', 10);

      await debugSessionManager.removeBreakpoint(sessionId, breakpointId);

      expect(mockHandler.mockDebugSession.removeBreakpoint).toHaveBeenCalledWith('test.js', 10);
      expect(debugSessionManager.getBreakpoints(sessionId)).toHaveLength(0);
    });

    it('should throw error when breakpoint is not found', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      await expect(
        debugSessionManager.removeBreakpoint(sessionId, 'non-existent-breakpoint')
      ).rejects.toThrow('Breakpoint not found: non-existent-breakpoint');
    });
  });

  describe('continue', () => {
    it('should continue execution successfully', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      await debugSessionManager.continue(sessionId);

      expect(mockHandler.mockDebugSession.continue).toHaveBeenCalled();

      const session = debugSessionManager.getSession(sessionId);
      expect(session?.status).toBe('running');
    });

    it('should throw error when session is not found', async () => {
      await expect(debugSessionManager.continue('non-existent-session')).rejects.toThrow(
        'Session not found: non-existent-session'
      );
    });
  });

  describe('stepOver', () => {
    it('should step over successfully', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      await debugSessionManager.stepOver(sessionId);

      expect(mockHandler.mockDebugSession.stepOver).toHaveBeenCalled();
    });
  });

  describe('stepInto', () => {
    it('should step into successfully', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      await debugSessionManager.stepInto(sessionId);

      expect(mockHandler.mockDebugSession.stepInto).toHaveBeenCalled();
    });
  });

  describe('stepOut', () => {
    it('should step out successfully', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      await debugSessionManager.stepOut(sessionId);

      expect(mockHandler.mockDebugSession.stepOut).toHaveBeenCalled();
    });
  });

  describe('getStackTrace', () => {
    it('should get stack trace successfully', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      const stackTrace = await debugSessionManager.getStackTrace(sessionId);

      expect(mockHandler.mockDebugSession.getCallStack).toHaveBeenCalled();
      expect(stackTrace).toEqual([]);
    });
  });

  describe('evaluateExpression', () => {
    it('should evaluate expression successfully', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      const result = await debugSessionManager.evaluateExpression(sessionId, 'x + 1');

      expect(mockHandler.mockDebugSession.evaluateExpression).toHaveBeenCalledWith('x + 1');
      expect(result).toEqual({
        name: 'x + 1',
        value: '42',
        type: 'number',
        scope: 'local',
      });
    });
  });

  describe('getAllSessions', () => {
    it('should return all active sessions', async () => {
      const config1 = { type: 'launch' as const, program: 'test1.js' };
      const config2 = { type: 'launch' as const, program: 'test2.js' };

      const sessionId1 = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config1
      );
      const sessionId2 = await debugSessionManager.createSession(
        SupportedLanguage.TYPESCRIPT,
        config2
      );

      const sessions = debugSessionManager.getAllSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.id)).toContain(sessionId1);
      expect(sessions.map(s => s.id)).toContain(sessionId2);
    });
  });

  describe('getStatistics', () => {
    it('should return session statistics', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );
      await debugSessionManager.setBreakpoint(sessionId, 'test.js', 10);
      await debugSessionManager.setBreakpoint(sessionId, 'test.js', 20);

      const stats = debugSessionManager.getStatistics();

      expect(stats).toMatchObject({
        totalSessions: 1,
        sessionsByStatus: {
          starting: 1,
          running: 0,
          paused: 0,
          stopped: 0,
          error: 0,
        },
        sessionsByLanguage: {
          javascript: 1,
        },
        totalBreakpoints: 2,
        averageBreakpointsPerSession: 2,
      });
    });
  });

  describe('cleanupInactiveSessions', () => {
    it('should cleanup inactive sessions', async () => {
      const config = { type: 'launch' as const, program: 'test.js' };
      const sessionId = await debugSessionManager.createSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      // Manually set the session as old
      const session = debugSessionManager.getSession(sessionId);
      if (session) {
        session.lastActivity = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
        session.status = 'stopped';
      }

      await debugSessionManager.cleanupInactiveSessions(30); // 30 minutes

      expect(debugSessionManager.getSession(sessionId)).toBeUndefined();
    });
  });
});
