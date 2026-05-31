/**
 * Message Replay Buffer - Player
 * Replay execution engine for event playback
 */

import {
  type AgentEvent,
  type AgentEventType,
  type PlayOptions,
  type PlayState,
  type PlaySpeed,
  type ReplayState,
  type UserMessageEvent,
  type LLMResponseEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type StateChangeEvent,
} from './types';

// ============================================================================
// Replay Player
// ============================================================================

export class ReplayPlayer {
  private breakpoints: Set<AgentEventType> = new Set();
  private currentState: PlayState | null = null;
  private events: AgentEvent[] = [];
  private currentIndex: number = 0;
  private paused: boolean = false;
  private finished: boolean = false;

  // ============================================================================
  // Playback Control
  // ============================================================================

  /**
   * Replay events and emit state changes as an async generator
   */
  async *play(events: AgentEvent[], options: PlayOptions = {}): AsyncGenerator<PlayState> {
    // Reset state
    this.events = [...events].sort((a, b) => a.sequence - b.sequence);
    this.currentIndex = options.startSequence
      ? this.events.findIndex((e) => e.sequence >= options.startSequence!)
      : 0;
    this.currentIndex = Math.max(0, this.currentIndex);

    const endIndex = options.endSequence
      ? this.events.findIndex((e) => e.sequence > options.endSequence!)
      : this.events.length;
    const actualEndIndex = endIndex === -1 ? this.events.length : endIndex;

    this.paused = false;
    this.finished = false;

    // Initialize replay state
    let replayState = this.createInitialReplayState(events[0]?.sessionId ?? '');

    for (; this.currentIndex < actualEndIndex; this.currentIndex++) {
      // Check if paused
      while (this.paused) {
        await this.delay(50);
        if (this.finished) break;
      }

      if (this.finished) break;

      const event = this.events[this.currentIndex]!;

      // Apply the event to update replay state
      replayState = this.applyEvent(replayState, event);

      // Create play state
      this.currentState = {
        currentEvent: event,
        currentSequence: event.sequence,
        totalEvents: actualEndIndex - this.currentIndex + this.currentIndex + 1,
        isPaused: this.paused,
        isComplete: this.currentIndex === actualEndIndex - 1,
        replayState,
      };

      // Yield current state
      yield this.currentState;

      // Call optional callback
      if (options.onEvent) {
        await options.onEvent(event, this.currentState);
      }

      // Check for breakpoint
      if (this.breakpoints.has(event.type) || options.breakpoints?.includes(event.type)) {
        this.paused = true;
      }

      // Delay based on speed
      const delay = this.calculateDelay(options.speed ?? 'normal', event);
      if (delay > 0 && !this.paused && !this.currentState.isComplete) {
        await this.delay(delay);
      }
    }

    this.finished = true;

    // Yield final state if we have one
    if (this.currentState) {
      yield {
        ...this.currentState,
        isComplete: true,
      };
    }
  }

  /**
   * Play all events at once without yielding intermediate states
   */
  async playAll(events: AgentEvent[]): Promise<ReplayState> {
    const sortedEvents = [...events].sort((a, b) => a.sequence - b.sequence);
    let replayState = this.createInitialReplayState(events[0]?.sessionId ?? '');

    for (const event of sortedEvents) {
      replayState = this.applyEvent(replayState, event);
    }

    return replayState;
  }

  // ============================================================================
  // Breakpoint Control
  // ============================================================================

  /**
   * Set breakpoints to pause at specific event types
   */
  setBreakpoints(types: AgentEventType[]): void {
    this.breakpoints = new Set(types);
  }

  /**
   * Add a single breakpoint
   */
  addBreakpoint(type: AgentEventType): void {
    this.breakpoints.add(type);
  }

  /**
   * Remove a breakpoint
   */
  removeBreakpoint(type: AgentEventType): void {
    this.breakpoints.delete(type);
  }

  /**
   * Clear all breakpoints
   */
  clearBreakpoints(): void {
    this.breakpoints.clear();
  }

  /**
   * Get current breakpoints
   */
  getBreakpoints(): AgentEventType[] {
    return Array.from(this.breakpoints);
  }

  // ============================================================================
  // Step Control
  // ============================================================================

  /**
   * Pause the playback
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume the playback
   */
  resume(): void {
    this.paused = false;
  }

  /**
   * Check if currently paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Step through events one by one
   */
  async step(): Promise<PlayState | null> {
    if (this.finished) return null;

    this.paused = false;

    // Wait for the current iteration to complete
    await this.delay(10);

    this.paused = true;

    return this.currentState;
  }

  /**
   * Skip to a specific sequence number
   */
  async skipTo(sequence: number): Promise<PlayState | null> {
    const targetIndex = this.events.findIndex((e) => e.sequence >= sequence);
    if (targetIndex === -1) return null;

    this.currentIndex = targetIndex;
    return this.currentState;
  }

  /**
   * Stop the playback
   */
  stop(): void {
    this.finished = true;
    this.paused = false;
  }

  /**
   * Check if playback is finished
   */
  isFinished(): boolean {
    return this.finished;
  }

  /**
   * Reset the player
   */
  reset(): void {
    this.currentIndex = 0;
    this.paused = false;
    this.finished = false;
    this.currentState = null;
    this.events = [];
  }

  // ============================================================================
  // Current State Access
  // ============================================================================

  /**
   * Get the current play state
   */
  getCurrentState(): PlayState | null {
    return this.currentState;
  }

  /**
   * Get the current replay state
   */
  getReplayState(): ReplayState | null {
    return this.currentState?.replayState ?? null;
  }

  /**
   * Get progress (0 to 1)
   */
  getProgress(): number {
    if (this.events.length === 0) return 0;
    return this.currentIndex / this.events.length;
  }

  /**
   * Get current event
   */
  getCurrentEvent(): AgentEvent | null {
    return this.events[this.currentIndex] ?? null;
  }

  /**
   * Get previous event
   */
  getPreviousEvent(): AgentEvent | null {
    return this.events[this.currentIndex - 1] ?? null;
  }

  /**
   * Get next event
   */
  getNextEvent(): AgentEvent | null {
    return this.events[this.currentIndex + 1] ?? null;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private createInitialReplayState(sessionId: string): ReplayState {
    return {
      sessionId,
      messages: [],
      toolCalls: [],
      metadata: {},
    };
  }

  private applyEvent(state: ReplayState, event: AgentEvent): ReplayState {
    const newState: ReplayState = {
      ...state,
      messages: [...state.messages],
      toolCalls: [...state.toolCalls],
      metadata: { ...state.metadata },
    };

    switch (event.type) {
      case 'user_message': {
        const payload = event.payload as UserMessageEvent;
        newState.messages.push({
          role: 'user',
          content: payload.content,
        });
        break;
      }

      case 'llm_response': {
        const payload = event.payload as LLMResponseEvent;
        newState.messages.push({
          role: 'assistant',
          content: payload.content,
        });
        // Store metadata about the response
        newState.metadata.lastModel = payload.model;
        newState.metadata.lastTokensIn = payload.tokensIn;
        newState.metadata.lastTokensOut = payload.tokensOut;
        newState.metadata.lastLatencyMs = payload.latencyMs;
        break;
      }

      case 'tool_call': {
        const payload = event.payload as ToolCallEvent;
        newState.toolCalls.push(payload);
        break;
      }

      case 'tool_result': {
        const payload = event.payload as ToolResultEvent;
        // Store tool result in metadata for reference
        newState.metadata.lastToolResult = {
          toolName: payload.toolName,
          isError: payload.isError,
          durationMs: payload.durationMs,
        };
        break;
      }

      case 'state_change': {
        const payload = event.payload as StateChangeEvent;
        newState.metadata[payload.key] = payload.newValue;
        break;
      }

      case 'llm_request':
        // LLM requests don't directly modify state
        break;
    }

    return newState;
  }

  private calculateDelay(speed: PlaySpeed, event: AgentEvent): number {
    switch (speed) {
      case 'instant':
        return 0;
      case 'fast':
        return 10;
      case 'normal':
      default: {
        // Add some delay based on event type for realistic replay
        switch (event.type) {
          case 'llm_response': {
            const payload = event.payload as LLMResponseEvent;
            // Scale delay by latency (capped at 1 second)
            return Math.min(payload.latencyMs / 10, 1000);
          }
          case 'tool_call':
          case 'tool_result':
            return 100;
          case 'user_message':
            return 200;
          default:
            return 50;
        }
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Player Pool for Multiple Concurrent Playbacks
// ============================================================================

export class ReplayPlayerPool {
  private players: Map<string, ReplayPlayer> = new Map();

  /**
   * Create a new player for a session
   */
  createPlayer(sessionId: string): ReplayPlayer {
    const player = new ReplayPlayer();
    this.players.set(sessionId, player);
    return player;
  }

  /**
   * Get an existing player
   */
  getPlayer(sessionId: string): ReplayPlayer | undefined {
    return this.players.get(sessionId);
  }

  /**
   * Check if a player exists
   */
  hasPlayer(sessionId: string): boolean {
    return this.players.has(sessionId);
  }

  /**
   * Remove a player
   */
  removePlayer(sessionId: string): boolean {
    const player = this.players.get(sessionId);
    if (player) {
      player.stop();
      return this.players.delete(sessionId);
    }
    return false;
  }

  /**
   * Get all active player session IDs
   */
  getActivePlayers(): string[] {
    return Array.from(this.players.keys());
  }

  /**
   * Stop all players
   */
  stopAll(): void {
    this.players.forEach((player) => {
      player.stop();
    });
    this.players.clear();
  }

  /**
   * Get count of active players
   */
  getCount(): number {
    return this.players.size;
  }
}

// ============================================================================
// Singleton Instances
// ============================================================================

let playerPoolInstance: ReplayPlayerPool | null = null;

export function getPlayerPool(): ReplayPlayerPool {
  if (!playerPoolInstance) {
    playerPoolInstance = new ReplayPlayerPool();
  }
  return playerPoolInstance;
}

export function setPlayerPool(pool: ReplayPlayerPool | null): void {
  playerPoolInstance = pool;
}
