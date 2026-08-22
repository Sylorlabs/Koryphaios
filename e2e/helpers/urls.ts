function port(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new Error(`${name} must be a non-privileged TCP port`);
  }
  return parsed;
}

export const E2E_BACKEND_PORT = port('KORY_E2E_BACKEND_PORT', 3011);
export const E2E_FRONTEND_PORT = port('KORY_E2E_FRONTEND_PORT', 5174);
export const E2E_BACKEND_URL = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
export const E2E_FRONTEND_ORIGIN = `http://127.0.0.1:${E2E_FRONTEND_PORT}`;
