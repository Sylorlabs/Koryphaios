#!/usr/bin/env bun
/**
 * Test all auth, API v1, and provider endpoints. Verifies ALL providers are returned.
 *
 * Usage:
 *   bun run test:endpoints
 *   BASE_URL=http://localhost:3000 bun run scripts/test-all-endpoints.ts
 *   AUTH_USER=admin AUTH_PASS=admin bun run test:endpoints   # also test protected v1 routes
 *
 * Each line shows: [OK|FAIL] METHOD path -> status: exact error message
 * For 4xx/5xx the full response body is shown when the status is unexpected.
 */

import { ProviderName } from "@koryphaios/shared";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;

type TestResult = {
  method: string;
  path: string;
  status: number;
  body: unknown;
  errorMessage: string;
  ok: boolean;
};

async function request(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<TestResult> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }
  try {
    const res = await fetch(url, { method, headers, body });
    let data: unknown;
    const ct = res.headers.get("content-type") ?? "";
    try {
      data = ct.includes("application/json") ? await res.json() : await res.text();
    } catch {
      data = await res.text();
    }
    const errorMessage =
      typeof data === "object" && data !== null && "error" in (data as any)
        ? String((data as any).error)
        : typeof data === "object" && data !== null && "message" in (data as any)
          ? String((data as any).message)
          : typeof data === "string"
            ? data
            : JSON.stringify(data);
    return {
      method,
      path,
      status: res.status,
      body: data,
      errorMessage,
      ok: res.ok,
    };
  } catch (err: any) {
    return {
      method,
      path,
      status: -1,
      body: null,
      errorMessage: err?.message ?? String(err),
      ok: false,
    };
  }
}

function report(result: TestResult, expectedStatus?: number): void {
  const expectOk = expectedStatus !== undefined ? result.status === expectedStatus : result.ok;
  const tag = expectOk ? "OK" : "FAIL";
  const statusStr = result.status >= 0 ? String(result.status) : "ERR";
  const msg =
    typeof result.body === "object" && result.body !== null && "details" in (result.body as any)
      ? `${result.errorMessage} | details: ${JSON.stringify((result.body as any).details)}`
      : result.errorMessage;
  console.log(`[${tag}] ${result.method} ${result.path} -> ${statusStr}: ${msg}`);
  if (!expectOk && result.body !== null && result.body !== undefined) {
    console.log(`       body: ${JSON.stringify(result.body)}`);
  }
}

async function main() {
  console.log(`\n=== Koryphaios endpoint tests (BASE_URL=${BASE_URL}) ===\n`);

  // ─── Auth endpoints ────────────────────────────────────────────────────────
  console.log("--- Auth endpoints ---\n");

  let r = await request("POST", "/api/auth/register");
  report(r, 400);
  r = await request("POST", "/api/auth/register", { body: {} });
  report(r, 400);
  r = await request("POST", "/api/auth/register", { body: { username: "x", password: "" } });
  report(r, 400);
  r = await request("POST", "/api/auth/register", { body: { username: "", password: "x" } });
  report(r, 400);

  r = await request("POST", "/api/auth/login");
  report(r, 400);
  r = await request("POST", "/api/auth/login", { body: {} });
  report(r, 400);
  r = await request("POST", "/api/auth/login", { body: { username: "x", password: "" } });
  report(r, 400);
  r = await request("POST", "/api/auth/login", { body: { username: "nonexistent", password: "wrong" } });
  report(r, 401);

  r = await request("POST", "/api/auth/refresh");
  report(r, 400);
  r = await request("POST", "/api/auth/refresh", { body: {} });
  report(r, 400);
  r = await request("POST", "/api/auth/refresh", { body: { refreshToken: "invalid" } });
  report(r, 401);

  r = await request("POST", "/api/auth/logout");
  report(r, 200);

  r = await request("POST", "/api/auth/logout-all");
  report(r, 401);

  r = await request("GET", "/api/auth/me");
  report(r, 401);

  r = await request("POST", "/api/auth/change-password");
  report(r, 401);

  // ─── API v1 (no auth) ─────────────────────────────────────────────────────
  console.log("\n--- API v1 endpoints (no auth → expect 401) ---\n");

  r = await request("GET", "/api/v1/credentials");
  report(r, 401);
  r = await request("POST", "/api/v1/credentials", { body: { provider: "openai", credential: "x" } });
  report(r, 401);
  r = await request("GET", "/api/v1/credentials/some-id");
  report(r, 401);
  r = await request("PATCH", "/api/v1/credentials/some-id", { body: { metadata: {} } });
  report(r, 401);
  r = await request("DELETE", "/api/v1/credentials/some-id");
  report(r, 401);
  r = await request("POST", "/api/v1/credentials/some-id/rotate");
  report(r, 401);
  r = await request("GET", "/api/v1/credentials/some-id/audit");
  report(r, 401);

  // Keys: no Bearer → guest allowed for GET list; POST create needs auth for non-guest behavior.
  // With no Bearer the code uses guest user, so GET /api/v1/keys may 200. We still test with invalid body for POST.
  r = await request("GET", "/api/v1/keys");
  report(r); // may 200 (guest) or 503
  r = await request("POST", "/api/v1/keys", { body: {} });
  report(r); // 400 validation or 200/201 if guest has write
  r = await request("GET", "/api/v1/keys/some-id");
  report(r);
  r = await request("PATCH", "/api/v1/keys/some-id", { body: {} });
  report(r);
  r = await request("DELETE", "/api/v1/keys/some-id");
  report(r);

  r = await request("GET", "/api/v1/audit");
  report(r, 401);
  r = await request("GET", "/api/v1/audit/me");
  report(r, 401);
  r = await request("GET", "/api/v1/audit/suspicious");
  report(r, 401);

  // ─── API v1 validation errors (with auth) ───────────────────────────────────
  let token: string | null = null;
  if (AUTH_USER && AUTH_PASS) {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
    });
    if (loginRes.ok) {
      const setCookies = loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get("set-cookie")].filter(Boolean);
      for (const setCookie of setCookies) {
        const match = setCookie.match(/koryphaios_session=([^;]+)/);
        if (match) {
          token = decodeURIComponent(match[1].trim());
          break;
        }
      }
    }
  }

  if (token) {
    console.log("\n--- API v1 with auth (validation errors) ---\n");
    const authHeader = { Authorization: `Bearer ${token}` };

    r = await request("POST", "/api/v1/credentials", { headers: authHeader, body: {} });
    report(r, 400);
    r = await request("POST", "/api/v1/credentials", { headers: authHeader, body: { provider: "openai" } });
    report(r, 400);
    r = await request("POST", "/api/v1/credentials", { headers: authHeader, body: { provider: "invalid", credential: "x" } });
    report(r, 400);

    r = await request("PATCH", "/api/v1/credentials/nonexistent-id", { headers: authHeader, body: {} });
    report(r, 400);

    r = await request("POST", "/api/v1/keys", { headers: authHeader, body: {} });
    report(r, 400);
    r = await request("POST", "/api/v1/keys", { headers: authHeader, body: { name: "a".repeat(101) } });
    report(r, 400);

    r = await request("GET", "/api/v1/credentials");
    report(r, 200);
    r = await request("GET", "/api/v1/keys");
    report(r, 200);
    r = await request("GET", "/api/v1/audit/me");
    report(r, 200);
    r = await request("GET", "/api/v1/audit?limit=5");
    report(r, 200);

    r = await request("GET", "/api/v1/credentials/nonexistent-id");
    report(r, 404);
    r = await request("GET", "/api/v1/keys/nonexistent-id");
    report(r, 404);
  } else {
    console.log("\n--- Skip API v1 with auth (set AUTH_USER and AUTH_PASS to test) ---\n");
  }

  // ─── API v1 with invalid Bearer ────────────────────────────────────────────
  console.log("\n--- API v1 with invalid Bearer ---\n");
  r = await request("GET", "/api/v1/credentials", { headers: { Authorization: "Bearer invalid" } });
  report(r, 401);
  r = await request("GET", "/api/v1/credentials", { headers: { Authorization: "Bearer kor_invalid" } });
  report(r, 401);

  // ─── Providers: verify ALL providers returned (guest auth) ──────────────────
  console.log("\n--- Providers (GET /api/providers — verify ALL) ---\n");
  r = await request("GET", "/api/providers");
  report(r, 200);
  const allProviderNames = new Set(Object.values(ProviderName));
  if (r.ok && Array.isArray((r.body as any)?.data)) {
    const data = (r.body as any).data as Array<{ name: string; authMode?: string }>;
    const missing = [...allProviderNames].filter((name) => !data.some((p) => p.name === name));
    const extra = data.filter((p) => !allProviderNames.has(p.name as any));
    if (missing.length > 0) {
      console.log(`[FAIL] GET /api/providers -> missing providers: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      console.log(`[FAIL] GET /api/providers -> unexpected providers: ${extra.map((p) => p.name).join(", ")}`);
    }
    if (missing.length === 0 && extra.length === 0) {
      console.log(`[OK] GET /api/providers -> all ${allProviderNames.size} providers present`);
    }
  }

  console.log("\n=== Done ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
