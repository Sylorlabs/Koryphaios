// Integration tests for API endpoints
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { dirname, join } from "path";

const TEST_PORT = 3301;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
let serverProc: Bun.Subprocess | null = null;
setDefaultTimeout(30000);

type ReqOpts = {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS";
  headers?: Record<string, string>;
  body?: unknown;
};

function request(path: string, opts: ReqOpts = {}) {
  const args = ["-sS", "--path-as-is", "-X", opts.method ?? "GET", "-o", "-", "-w", "\n%{http_code}", `${BASE_URL}${path}`];
  const headers = opts.headers ?? {};
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  if (opts.body !== undefined) {
    args.push("--data-binary", typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
  }

  const proc = Bun.spawnSync(["curl", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    throw new Error(stderr || `curl exited ${proc.exitCode}`);
  }

  const output = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
  const idx = output.lastIndexOf("\n");
  const bodyText = idx >= 0 ? output.slice(0, idx) : "";
  const status = Number(idx >= 0 ? output.slice(idx + 1).trim() : "0");
  let json: any = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    json = null;
  }

  return { status, bodyText, json };
}

async function waitForServerReady(timeoutMs = 20000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = request("/api/health");
      if (res.status === 200) return;
    } catch {
      // Retry until timeout
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Backend did not become ready on ${BASE_URL} within ${timeoutMs}ms`);
}

beforeAll(async () => {
  const backendDir = join(dirname(import.meta.dir), "src", "..");
  serverProc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: backendDir,
    env: { ...process.env, KORYPHAIOS_PORT: String(TEST_PORT) },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForServerReady();
});

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited;
    serverProc = null;
  }
});

describe("API Integration Tests", () => {
  describe("GET /api/health", () => {
    test("returns health status", async () => {
      const res = request("/api/health");

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.data).toHaveProperty("version");
      expect(res.json?.data).toHaveProperty("uptime");
    });
  });

  describe("Sessions API", () => {
    let sessionId: string;

    test("POST /api/sessions creates a new session", async () => {
      const res = request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { title: "Test Session" },
      });

      expect(res.status).toBe(201);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.data).toHaveProperty("id");
      expect(res.json?.data?.title).toBe("Test Session");

      sessionId = res.json.data.id;
    });

    test("GET /api/sessions lists all sessions", async () => {
      const res = request("/api/sessions");

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(Array.isArray(res.json?.data)).toBe(true);
      expect(res.json.data.length).toBeGreaterThan(0);
    });

    test("GET /api/sessions/:id returns session details", async () => {
      const res = request(`/api/sessions/${sessionId}`);

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.data?.id).toBe(sessionId);
    });

    test("PATCH /api/sessions/:id updates session title", async () => {
      const newTitle = "Updated Test Session";
      const res = request(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: { title: newTitle },
      });

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.data?.title).toBe(newTitle);
    });

    test("GET /api/sessions/:id/messages returns array", async () => {
      const res = request(`/api/sessions/${sessionId}/messages`);

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(Array.isArray(res.json?.data)).toBe(true);
    });

    test("DELETE /api/sessions/:id deletes session", async () => {
      const res = request(`/api/sessions/${sessionId}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);

      const getRes = request(`/api/sessions/${sessionId}`);
      expect(getRes.status).toBe(404);
    });
  });

  describe("Providers API", () => {
    test("GET /api/providers returns provider status", async () => {
      const res = request("/api/providers");

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(Array.isArray(res.json?.data)).toBe(true);
    });

    test("PUT /api/providers/copilot rejects apiKey (auth-only)", async () => {
      const res = request("/api/providers/copilot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: { apiKey: "gho_fake" },
      });

      expect(res.status).toBe(400);
      expect(res.json?.ok).toBe(false);
      expect(String(res.json?.error ?? "")).toContain("auth only");
    });

    test("PUT /api/providers/openai rejects missing apiKey", async () => {
      const res = request("/api/providers/openai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: {},
      });

      expect(res.status).toBe(400);
      expect(res.json?.ok).toBe(false);
      expect(String(res.json?.error ?? "")).toContain("apiKey is required");
    });

    test("PUT /api/providers/anthropic accepts dual-mode payload shape and validates", async () => {
      const res = request("/api/providers/anthropic", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: { authToken: "bad-token" },
      });

      expect(res.status).toBe(400);
      expect(res.json?.ok).toBe(false);
      expect(String(res.json?.error ?? "")).not.toContain("apiKey is required");
    });

    test("PUT /api/providers/local requires baseUrl", async () => {
      const res = request("/api/providers/local", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: {},
      });

      expect(res.status).toBe(400);
      expect(res.json?.ok).toBe(false);
      expect(String(res.json?.error ?? "")).toContain("baseUrl is required");
    });
  });

  describe("Agents API", () => {
    test("GET /api/agents/status returns agent status", async () => {
      const res = request("/api/agents/status");

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.data).toHaveProperty("workers");
    });
  });

  describe("Input Validation", () => {
    test("rejects invalid session ID", async () => {
      const res = request("/api/sessions/invalid$$$");

      expect(res.status).toBe(400);
      expect(res.json?.ok).toBe(false);
    });

    test("rejects oversized session title by truncating", async () => {
      const longTitle = "a".repeat(300);
      const res = request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { title: longTitle },
      });

      expect(res.status).toBe(201);
      expect(res.json?.data?.title?.length).toBeLessThanOrEqual(200);
    });
  });

  describe("CORS Headers", () => {
    test("handles preflight OPTIONS request", async () => {
      const res = request("/api/sessions", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      });

      expect(res.status).toBe(204);
    });
  });
});
