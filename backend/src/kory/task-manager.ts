// Task Manager - Manages agent tasks and their lifecycle
// Handles task creation, tracking, and completion

import { nanoid } from "nanoid";
import type { WorkerDomain } from "@koryphaios/shared";
import { koryLog } from "../logger";

export interface Task {
    id: string;
    sessionId: string;
    description: string;
    domain: WorkerDomain;
    assignedModel: string;
    assignedProvider: string;
    status: "pending" | "active" | "done" | "failed";
    result?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
    allowedPaths?: string[];
    plan?: string;
}

export class TaskManager {
    private readonly tasks = new Map<string, Task>();
    private readonly activeTasks = new Map<string, Task>();

    /**
     * Create a new task.
     */
    createTask(
        sessionId: string,
        description: string,
        domain: WorkerDomain,
        assignedModel: string,
        assignedProvider: string,
        allowedPaths?: string[],
    ): Task {
        const task: Task = {
            id: nanoid(),
            sessionId,
            description,
            domain,
            assignedModel,
            assignedProvider,
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            allowedPaths,
        };

        this.tasks.set(task.id, task);
        koryLog.info({ taskId: task.id, domain, description }, "Task created");

        return task;
    }

    /**
     * Get a task by ID.
     */
    getTask(taskId: string): Task | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * Get all tasks for a session.
     */
    getSessionTasks(sessionId: string): Task[] {
        return Array.from(this.tasks.values()).filter((t) => t.sessionId === sessionId);
    }

    /**
     * Get all tasks.
     */
    getAllTasks(): Task[] {
        return Array.from(this.tasks.values());
    }

    /**
     * Get active tasks.
     */
    getActiveTasks(): Task[] {
        return Array.from(this.activeTasks.values());
    }

    /**
     * Activate a task.
     */
    activateTask(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task && task.status === "pending") {
            task.status = "active";
            task.updatedAt = Date.now();
            this.activeTasks.set(taskId, task);
            koryLog.info({ taskId }, "Task activated");
        }
    }

    /**
     * Complete a task.
     */
    completeTask(taskId: string, result: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = "done";
            task.result = result;
            task.updatedAt = Date.now();
            this.activeTasks.delete(taskId);
            koryLog.info({ taskId, resultLength: result.length }, "Task completed");
        }
    }

    /**
     * Fail a task.
     */
    failTask(taskId: string, error: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = "failed";
            task.error = error;
            task.updatedAt = Date.now();
            this.activeTasks.delete(taskId);
            koryLog.warn({ taskId, error }, "Task failed");
        }
    }

    /**
     * Update task status.
     */
    updateTaskStatus(taskId: string, status: Task["status"]): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = status;
            task.updatedAt = Date.now();

            if (status === "active") {
                this.activeTasks.set(taskId, task);
            } else {
                this.activeTasks.delete(taskId);
            }

            koryLog.debug({ taskId, status }, "Task status updated");
        }
    }

    /**
     * Cancel all tasks for a session.
     */
    cancelSessionTasks(sessionId: string): number {
        let cancelled = 0;
        for (const [taskId, task] of this.tasks.entries()) {
            if (task.sessionId === sessionId && task.status !== "done") {
                task.status = "failed";
                task.error = "Cancelled by user";
                task.updatedAt = Date.now();
                this.activeTasks.delete(taskId);
                cancelled++;
            }
        }

        if (cancelled > 0) {
            koryLog.info({ sessionId, cancelled }, "Cancelled session tasks");
        }

        return cancelled;
    }

    /**
     * Get task statistics.
     */
    getStats(): {
        total: number;
        pending: number;
        active: number;
        done: number;
        failed: number;
    } {
        let pending = 0;
        let active = 0;
        let done = 0;
        let failed = 0;

        for (const task of this.tasks.values()) {
            switch (task.status) {
                case "pending":
                    pending++;
                    break;
                case "active":
                    active++;
                    break;
                case "done":
                    done++;
                    break;
                case "failed":
                    failed++;
                    break;
            }
        }

        return {
            total: this.tasks.size,
            pending,
            active,
            done,
            failed,
        };
    }

    /**
     * Clean up old tasks.
     */
    cleanup(olderThanMs: number = 3600000): number {
        const cutoff = Date.now() - olderThanMs;
        let cleaned = 0;

        for (const [taskId, task] of this.tasks.entries()) {
            if (task.updatedAt < cutoff && task.status !== "active") {
                this.tasks.delete(taskId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            koryLog.info({ cleaned }, "Cleaned up old tasks");
        }

        return cleaned;
    }
}
