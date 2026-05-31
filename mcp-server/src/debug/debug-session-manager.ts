/**
 * Debug session manager for coordinating debugging across multiple languages
 */

import { EventEmitter } from 'events';
import type {
  LanguageDebugSession,
  LanguageDebugConfig,
  SupportedLanguage,
} from '../types/languages.js';
import { LanguageHandlerManager } from '../languages/language-handler-manager.js';
import { Logger } from '../utils/logger.js';

export interface DebugSessionInfo {
  id: string;
  language: SupportedLanguage;
  config: LanguageDebugConfig;
  session: LanguageDebugSession;
  status: 'starting' | 'running' | 'paused' | 'stopped' | 'error';
  createdAt: Date;
  lastActivity: Date;
}

export interface DebugBreakpoint {
  id: string;
  file: string;
  line: number;
  column: number;
  condition?: string | undefined;
  enabled: boolean;
  verified: boolean;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string;
  scope: 'local' | 'global' | 'closure';
  children?: DebugVariable[];
}

export interface DebugStackFrame {
  id: string;
  name: string;
  file: string;
  line: number;
  column: number;
  variables: DebugVariable[];
}

export class DebugSessionManager extends EventEmitter {
  private sessions = new Map<string, DebugSessionInfo>();
  private breakpoints = new Map<string, DebugBreakpoint[]>();
  private languageManager: LanguageHandlerManager;
  private logger: Logger;
  private sessionCounter = 0;

  constructor(languageManager: LanguageHandlerManager) {
    super();
    this.languageManager = languageManager;
    this.logger = new Logger('debug', {
      logFile: undefined,
      enableConsole: true,
    });
  }

  /**
   * Create a new debug session
   */
  async createSession(language: SupportedLanguage, config: LanguageDebugConfig): Promise<string> {
    const sessionId = `debug-session-${++this.sessionCounter}`;

    try {
      this.logger.info(`Creating debug session for ${language}`, { sessionId, config });

      const handler = this.languageManager.getHandler(language);
      if (!handler) {
        throw new Error(`No handler available for language: ${language}`);
      }

      const capabilities = handler.getDebugCapabilities();
      if (!capabilities.supportsBreakpoints) {
        throw new Error(`Language ${language} does not support debugging`);
      }

      const session = await handler.createDebugSession(config);

      const sessionInfo: DebugSessionInfo = {
        id: sessionId,
        language,
        config,
        session,
        status: 'starting',
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      this.sessions.set(sessionId, sessionInfo);
      this.breakpoints.set(sessionId, []);

      // Set up session event handlers
      this.setupSessionEventHandlers(sessionId, session);

      this.emit('sessionCreated', sessionInfo);
      this.logger.info(`Debug session created successfully`, { sessionId });

      return sessionId;
    } catch (error) {
      this.logger.error(`Failed to create debug session`, { sessionId, error });
      this.emit('sessionError', sessionId, error);
      throw error;
    }
  }

  /**
   * Get session information
   */
  getSession(sessionId: string): DebugSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): DebugSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Stop a debug session
   */
  async stopSession(sessionId: string): Promise<void> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      this.logger.info(`Stopping debug session`, { sessionId });

      // Stop the actual debug session
      if (sessionInfo.session && typeof sessionInfo.session.terminate === 'function') {
        await sessionInfo.session.terminate();
      }

      // Update status
      sessionInfo.status = 'stopped';
      sessionInfo.lastActivity = new Date();

      // Clean up
      this.sessions.delete(sessionId);
      this.breakpoints.delete(sessionId);

      this.emit('sessionStopped', sessionInfo);
      this.logger.info(`Debug session stopped`, { sessionId });
    } catch (error) {
      this.logger.error(`Failed to stop debug session`, { sessionId, error });
      sessionInfo.status = 'error';
      this.emit('sessionError', sessionId, error);
      throw error;
    }
  }

  /**
   * Set breakpoint
   */
  async setBreakpoint(
    sessionId: string,
    file: string,
    line: number,
    column?: number,
    condition?: string
  ): Promise<string> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const breakpointId = `bp-${sessionId}-${Date.now()}`;
    const breakpoint: DebugBreakpoint = {
      id: breakpointId,
      file,
      line,
      column: column || 1,
      condition: condition || undefined,
      enabled: true,
      verified: false,
    };

    try {
      // Set breakpoint in the actual debug session
      if (sessionInfo.session && typeof sessionInfo.session.setBreakpoint === 'function') {
        await sessionInfo.session.setBreakpoint(file, line, condition);
        breakpoint.verified = true;
      }

      // Store breakpoint
      const sessionBreakpoints = this.breakpoints.get(sessionId) || [];
      sessionBreakpoints.push(breakpoint);
      this.breakpoints.set(sessionId, sessionBreakpoints);

      this.emit('breakpointSet', sessionId, breakpoint);
      this.logger.debug(`Breakpoint set`, { sessionId, breakpoint });

      return breakpointId;
    } catch (error) {
      this.logger.error(`Failed to set breakpoint`, { sessionId, breakpoint, error });
      throw error;
    }
  }

  /**
   * Remove breakpoint
   */
  async removeBreakpoint(sessionId: string, breakpointId: string): Promise<void> {
    const sessionBreakpoints = this.breakpoints.get(sessionId) || [];
    const breakpointIndex = sessionBreakpoints.findIndex(bp => bp.id === breakpointId);

    if (breakpointIndex === -1) {
      throw new Error(`Breakpoint not found: ${breakpointId}`);
    }

    const breakpoint = sessionBreakpoints[breakpointIndex];
    if (!breakpoint) {
      throw new Error(`Breakpoint not found: ${breakpointId}`);
    }

    const sessionInfo = this.sessions.get(sessionId);

    try {
      // Remove breakpoint from the actual debug session
      if (sessionInfo?.session && typeof sessionInfo.session.removeBreakpoint === 'function') {
        await sessionInfo.session.removeBreakpoint(breakpoint.file, breakpoint.line);
      }

      // Remove from our storage
      sessionBreakpoints.splice(breakpointIndex, 1);
      this.breakpoints.set(sessionId, sessionBreakpoints);

      this.emit('breakpointRemoved', sessionId, breakpoint);
      this.logger.debug(`Breakpoint removed`, { sessionId, breakpointId });
    } catch (error) {
      this.logger.error(`Failed to remove breakpoint`, { sessionId, breakpointId, error });
      throw error;
    }
  }

  /**
   * Get breakpoints for a session
   */
  getBreakpoints(sessionId: string): DebugBreakpoint[] {
    return this.breakpoints.get(sessionId) || [];
  }

  /**
   * Continue execution
   */
  async continue(sessionId: string): Promise<void> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      if (sessionInfo.session && typeof sessionInfo.session.continue === 'function') {
        await sessionInfo.session.continue();
      }

      sessionInfo.status = 'running';
      sessionInfo.lastActivity = new Date();

      this.emit('sessionContinued', sessionInfo);
      this.logger.debug(`Debug session continued`, { sessionId });
    } catch (error) {
      this.logger.error(`Failed to continue debug session`, { sessionId, error });
      throw error;
    }
  }

  /**
   * Step over
   */
  async stepOver(sessionId: string): Promise<void> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      if (sessionInfo.session && typeof sessionInfo.session.stepOver === 'function') {
        await sessionInfo.session.stepOver();
      }

      sessionInfo.lastActivity = new Date();
      this.emit('sessionStepped', sessionInfo, 'over');
      this.logger.debug(`Debug session stepped over`, { sessionId });
    } catch (error) {
      this.logger.error(`Failed to step over in debug session`, { sessionId, error });
      throw error;
    }
  }

  /**
   * Step into
   */
  async stepInto(sessionId: string): Promise<void> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      if (sessionInfo.session && typeof sessionInfo.session.stepInto === 'function') {
        await sessionInfo.session.stepInto();
      }

      sessionInfo.lastActivity = new Date();
      this.emit('sessionStepped', sessionInfo, 'into');
      this.logger.debug(`Debug session stepped into`, { sessionId });
    } catch (error) {
      this.logger.error(`Failed to step into in debug session`, { sessionId, error });
      throw error;
    }
  }

  /**
   * Step out
   */
  async stepOut(sessionId: string): Promise<void> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      if (sessionInfo.session && typeof sessionInfo.session.stepOut === 'function') {
        await sessionInfo.session.stepOut();
      }

      sessionInfo.lastActivity = new Date();
      this.emit('sessionStepped', sessionInfo, 'out');
      this.logger.debug(`Debug session stepped out`, { sessionId });
    } catch (error) {
      this.logger.error(`Failed to step out in debug session`, { sessionId, error });
      throw error;
    }
  }

  /**
   * Get current stack trace
   */
  async getStackTrace(sessionId: string): Promise<DebugStackFrame[]> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      if (sessionInfo.session && typeof sessionInfo.session.getCallStack === 'function') {
        const callStack = await sessionInfo.session.getCallStack();
        // Convert CallStackFrame to DebugStackFrame
        return callStack.map(frame => ({
          id: `frame-${frame.id || Math.random()}`,
          name: frame.name,
          file: (frame as any).source?.path || frame.name || 'unknown',
          line: frame.line,
          column: frame.column,
          variables: [], // Would need to fetch variables separately
        }));
      }
      return [];
    } catch (error) {
      this.logger.error(`Failed to get stack trace`, { sessionId, error });
      throw error;
    }
  }

  /**
   * Evaluate expression
   */
  async evaluateExpression(sessionId: string, expression: string): Promise<DebugVariable> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      if (sessionInfo.session && typeof sessionInfo.session.evaluateExpression === 'function') {
        const result = await sessionInfo.session.evaluateExpression(expression);
        return {
          name: expression,
          value: result.result,
          type: result.type || 'unknown',
          scope: 'local' as const,
        };
      }

      throw new Error('Expression evaluation not supported');
    } catch (error) {
      this.logger.error(`Failed to evaluate expression`, { sessionId, expression, error });
      throw error;
    }
  }

  /**
   * Set up event handlers for a debug session
   */
  private setupSessionEventHandlers(sessionId: string, _session: LanguageDebugSession): void {
    // Event handling would be implemented here if the session supports it
    // For now, we'll rely on polling or explicit status updates
    this.logger.debug('Debug session event handlers setup', { sessionId });
  }

  /**
   * Clean up inactive sessions
   */
  async cleanupInactiveSessions(maxInactiveMinutes: number = 30): Promise<void> {
    const now = new Date();
    const maxInactiveMs = maxInactiveMinutes * 60 * 1000;

    for (const [sessionId, sessionInfo] of this.sessions) {
      const inactiveMs = now.getTime() - sessionInfo.lastActivity.getTime();

      if (inactiveMs > maxInactiveMs && sessionInfo.status !== 'running') {
        this.logger.info(`Cleaning up inactive debug session`, {
          sessionId,
          inactiveMinutes: inactiveMs / 60000,
        });

        try {
          await this.stopSession(sessionId);
        } catch (error) {
          this.logger.error(`Failed to cleanup inactive session`, { sessionId, error });
        }
      }
    }
  }

  /**
   * Get debug session statistics
   */
  getStatistics() {
    const sessions = Array.from(this.sessions.values());
    const breakpointCounts = Array.from(this.breakpoints.values()).map(bps => bps.length);

    return {
      totalSessions: sessions.length,
      sessionsByStatus: {
        starting: sessions.filter(s => s.status === 'starting').length,
        running: sessions.filter(s => s.status === 'running').length,
        paused: sessions.filter(s => s.status === 'paused').length,
        stopped: sessions.filter(s => s.status === 'stopped').length,
        error: sessions.filter(s => s.status === 'error').length,
      },
      sessionsByLanguage: sessions.reduce(
        (acc, s) => {
          acc[s.language] = (acc[s.language] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
      totalBreakpoints: breakpointCounts.reduce((sum, count) => sum + count, 0),
      averageBreakpointsPerSession:
        breakpointCounts.length > 0
          ? breakpointCounts.reduce((sum, count) => sum + count, 0) / breakpointCounts.length
          : 0,
    };
  }

  /**
   * Dispose all sessions and cleanup
   */
  async dispose(): Promise<void> {
    this.logger.info('Disposing debug session manager');

    const stopPromises = Array.from(this.sessions.keys()).map(sessionId =>
      this.stopSession(sessionId).catch(error =>
        this.logger.error(`Failed to stop session during disposal`, { sessionId, error })
      )
    );

    await Promise.allSettled(stopPromises);

    this.sessions.clear();
    this.breakpoints.clear();
    this.removeAllListeners();

    this.logger.info('Debug session manager disposed');
  }
}
