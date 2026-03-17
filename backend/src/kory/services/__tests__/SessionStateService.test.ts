// SessionStateService Tests
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionStateService } from "../SessionStateService";
import type { ISessionStore, IMessageStore } from "../../../stores";
import type { ChangeSummary } from "@koryphaios/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SessionStateService", () => {
  let service: SessionStateService;
  let tempDir: string;
  let mockSessions: ISessionStore;
  let mockMessages: IMessageStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kory-test-"));
    
    mockSessions = {} as ISessionStore;
    mockMessages = {
      add: () => {},
    } as unknown as IMessageStore;

    service = new SessionStateService(tempDir, mockSessions, mockMessages);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("recordChange", () => {
    it("should record changes", () => {
      const change: ChangeSummary = {
        path: "test.ts",
        type: "modified",
        description: "Updated function",
      };
      
      service.recordChange("session-1", change);
      const changes = service.getChanges("session-1");
      
      expect(changes).toHaveLength(1);
      expect(changes[0].path).toBe("test.ts");
    });

    it("should accumulate multiple changes", () => {
      service.recordChange("session-1", { path: "a.ts", type: "added", description: "" });
      service.recordChange("session-1", { path: "b.ts", type: "modified", description: "" });
      
      expect(service.getChanges("session-1")).toHaveLength(2);
    });

    it("should isolate changes by session", () => {
      service.recordChange("session-1", { path: "a.ts", type: "added", description: "" });
      service.recordChange("session-2", { path: "b.ts", type: "added", description: "" });
      
      expect(service.getChanges("session-1")).toHaveLength(1);
      expect(service.getChanges("session-2")).toHaveLength(1);
    });
  });

  describe("checkpoint management", () => {
    it("should save and retrieve checkpoint", () => {
      service.saveCheckpoint("session-1", "abc123");
      expect(service.getCheckpoint("session-1")).toBe("abc123");
    });

    it("should clear checkpoint", () => {
      service.saveCheckpoint("session-1", "abc123");
      service.clearCheckpoint("session-1");
      expect(service.getCheckpoint("session-1")).toBeUndefined();
    });

    it("should return undefined for unknown session", () => {
      expect(service.getCheckpoint("unknown")).toBeUndefined();
    });
  });

  describe("cleanupSession", () => {
    it("should remove all session state", () => {
      service.recordChange("session-1", { path: "a.ts", type: "added", description: "" });
      service.saveCheckpoint("session-1", "abc123");
      
      service.cleanupSession("session-1");
      
      expect(service.getChanges("session-1")).toHaveLength(0);
      expect(service.getCheckpoint("session-1")).toBeUndefined();
    });
  });
});
