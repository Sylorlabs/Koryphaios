// User Input Handler - Manages user input and prompts
// Handles asking the user for input and managing pending responses

import { nanoid } from "nanoid";
import { koryLog } from "../logger";


export interface PendingInput {
    id: string;
    sessionId: string;
    question: string;
    options?: string[];
    multiSelect?: boolean;
    timeout?: number;
    createdAt: number;
    resolvedAt?: number;
    resolution?: string;
}

export class UserInputHandler {
    private readonly pendingInputs = new Map<string, PendingInput>();
    private readonly resolvers = new Map<string, (response: string) => void>();

    /**
     * Ask the user for input.
     */
    async askUser(
        sessionId: string,
        question: string,
        options?: string[],
        multiSelect?: boolean,
        timeout?: number,
    ): Promise<string> {
        const inputId = nanoid();
        const pendingInput: PendingInput = {
            id: inputId,
            sessionId,
            question,
            options,
            multiSelect,
            timeout,
            createdAt: Date.now(),
        };

        this.pendingInputs.set(inputId, pendingInput);

        // Emit event to frontend via WebSocket
        // The payload { question, options, allowOther } would be sent via ws

        // This would be emitted via WebSocket in the actual implementation
        koryLog.info({ inputId, sessionId, question }, "Asking user for input");

        // Wait for response
        return new Promise((resolve, reject) => {
            this.resolvers.set(`${sessionId}:${inputId}`, resolve);

            if (timeout) {
                setTimeout(() => {
                    if (this.pendingInputs.has(inputId)) {
                        this.pendingInputs.delete(inputId);
                        this.resolvers.delete(`${sessionId}:${inputId}`);
                        reject(new Error(`User input timeout after ${timeout}ms`));
                    }
                }, timeout);
            }
        });
    }

    /**
     * Handle user response.
     */
    handleUserResponse(sessionId: string, inputId: string, response: string): void {
        const key = `${sessionId}:${inputId}`;
        const resolver = this.resolvers.get(key);

        if (resolver) {
            const pendingInput = this.pendingInputs.get(inputId);
            if (pendingInput) {
                pendingInput.resolvedAt = Date.now();
                pendingInput.resolution = response;
                this.pendingInputs.delete(inputId);
            }

            resolver(response);
            this.resolvers.delete(key);

            koryLog.info({ inputId, sessionId, response }, "User input received");
        } else {
            koryLog.warn({ inputId, sessionId }, "No resolver found for user input");
        }
    }

    /**
     * Cancel pending input.
     */
    cancelInput(sessionId: string, inputId: string): void {
        const key = `${sessionId}:${inputId}`;
        const resolver = this.resolvers.get(key);

        if (resolver) {
            this.resolvers.delete(key);
            this.pendingInputs.delete(inputId);

            // Reject with cancellation
            try {
                resolver("");
            } catch {
                // Resolver may have already been called
            }

            koryLog.info({ inputId, sessionId }, "User input cancelled");
        }
    }

    /**
     * Cancel all pending inputs for a session.
     */
    cancelSessionInputs(sessionId: string): number {
        let cancelled = 0;

        for (const [inputId, pendingInput] of this.pendingInputs.entries()) {
            if (pendingInput.sessionId === sessionId) {
                this.cancelInput(sessionId, inputId);
                cancelled++;
            }
        }

        return cancelled;
    }

    /**
     * Get pending inputs for a session.
     */
    getPendingInputs(sessionId: string): PendingInput[] {
        return Array.from(this.pendingInputs.values()).filter(
            (input) => input.sessionId === sessionId
        );
    }

    /**
     * Get all pending inputs.
     */
    getAllPendingInputs(): PendingInput[] {
        return Array.from(this.pendingInputs.values());
    }

    /**
     * Clean up expired inputs.
     */
    cleanup(olderThanMs: number = 300_000): number {
        const cutoff = Date.now() - olderThanMs;
        let cleaned = 0;

        for (const [inputId, input] of this.pendingInputs.entries()) {
            if (input.createdAt < cutoff && !input.resolvedAt) {
                // Cancel expired input
                this.cancelInput(input.sessionId, inputId);
                cleaned++;
            }
        }

        return cleaned;
    }

    /**
     * Get statistics.
     */
    getStats(): {
        total: number;
        pending: number;
        resolved: number;
    } {
        let resolved = 0;

        for (const input of this.pendingInputs.values()) {
            if (input.resolvedAt) {
                resolved++;
            }
        }

        return {
            total: this.pendingInputs.size,
            pending: this.pendingInputs.size - resolved,
            resolved,
        };
    }
}
