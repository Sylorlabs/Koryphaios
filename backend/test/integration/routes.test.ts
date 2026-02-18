// Integration tests for route handlers

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Router } from "../../src/routes/router";
import { RateLimiter } from "../../src/security";
import type { RouteDependencies } from "../../src/routes/types";

// Mock dependencies
const mockProviders = {
    getAvailable: () => [],
    getStatus: async () => [],
    getExpectedEnvVar: (name: string, kind: string) => `${name.toUpperCase()}_${kind.toUpperCase()}`,
    setCredentials: () => ({ success: true }),
    removeApiKey: () => { },
    verifyConnection: async () => ({ success: true }),
};

const mockTools = {
    register: () => { },
    getToolDefsForRole: () => [],
};

const mockKory = {
    processTask: async () => { },
    cancel: () => { },
    isSessionRunning: () => false,
    handleUserInput: () => { },
    handleSessionResponse: () => { },
    setYoloMode: () => { },
    git: {
        getStatus: async () => "",
        getBranch: async () => "main",
        getAheadBehind: async () => ({ ahead: 0, behind: 0 }),
        getDiff: async () => "",
        getFileContent: async () => null,
        stageFile: async () => true,
        unstageFile: async () => true,
        restoreFile: async () => true,
        commit: async () => true,
        checkout: async () => true,
        merge: async () => ({ success: true, output: "", hasConflicts: false }),
        push: async () => ({ success: true, output: "" }),
        pull: async () => ({ success: true, output: "" }),
        getConflicts: async () => [],
    },
};

const mockSessions = {
    list: () => [],
    get: () => null,
    create: () => ({ id: "test-session", title: "Test", messageCount: 0 }),
    update: () => null,
    delete: () => { },
};

const mockMessages = {
    add: () => { },
    getRecent: () => [],
    getAll: () => [],
};

const mockWsManager = {
    broadcast: () => { },
    broadcastToSession: () => { },
    add: () => { },
    remove: () => { },
    subscribeClientToSession: () => { },
    clientCount: 0,
};

describe("Router", () => {
    let router: Router;

    beforeAll(() => {
        const deps: RouteDependencies = {
            providers: mockProviders as any,
            tools: mockTools as any,
            kory: mockKory as any,
            sessions: mockSessions as any,
            messages: mockMessages as any,
            wsManager: mockWsManager as any,
            telegram: undefined,
            mcpManager: undefined,
        };

        const rateLimiter = new RateLimiter(60, 60000);
        router = new Router(deps, { rateLimiter });
    });

    test("should return 404 for unknown routes", async () => {
        const req = new Request("http://localhost/api/unknown");
        const res = await router.handle(req);
        expect(res.status).toBe(404);
    });

    test("should handle session list request", async () => {
        const req = new Request("http://localhost/api/sessions");
        const res = await router.handle(req);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty("ok", true);
    });

    test("should create new session", async () => {
        const req = new Request("http://localhost/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Test Session" }),
        });
        const res = await router.handle(req);
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body).toHaveProperty("ok", true);
        expect(body.data).toHaveProperty("id");
    });

    test("should return 400 for invalid session ID", async () => {
        const req = new Request("http://localhost/api/sessions/invalid@id");
        const res = await router.handle(req);
        expect(res.status).toBe(400);
    });

    test("should handle provider list request", async () => {
        const req = new Request("http://localhost/api/providers");
        const res = await router.handle(req);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty("ok", true);
    });
});

describe("Rate Limiter", () => {
    test("should allow requests within limit", () => {
        const limiter = new RateLimiter(5, 60000);
        for (let i = 0; i < 5; i++) {
            const result = limiter.check("test-key");
            expect(result.allowed).toBe(true);
        }
    });

    test("should block requests exceeding limit", () => {
        const limiter = new RateLimiter(3, 60000);
        for (let i = 0; i < 3; i++) {
            limiter.check("test-key");
        }
        const result = limiter.check("test-key");
        expect(result.allowed).toBe(false);
    });

    test("should reset after window expires", async () => {
        const limiter = new RateLimiter(2, 100);
        limiter.check("test-key");
        limiter.check("test-key");
        expect(limiter.check("test-key").allowed).toBe(false);
        await new Promise((r) => setTimeout(r, 150));
        expect(limiter.check("test-key").allowed).toBe(true);
    });
});