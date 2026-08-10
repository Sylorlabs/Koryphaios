/**
 * CORS contract shared by the native desktop launcher and its regression tests.
 *
 * The Tauri development window is a browser origin even though it is a native
 * shell. Backend readiness therefore includes proving that the health response
 * is readable from the exact frontend origin, not merely that the TCP port is
 * serving JSON.
 */

export type LauncherBackendHealth = {
  ok?: boolean;
  data?: {
    id?: string;
    pid?: number;
    version?: string;
    compat?: { serverStartedAt?: number };
  };
};

const BACKEND_SERVICE_ID = 'koryphaios';

function appendOrigin(origins: string[], origin: string): void {
  if (origin !== '*' && !origins.includes(origin)) origins.push(origin);
}

/**
 * Return the exact browser origins served by a frontend listener. Loopback
 * aliases are equivalent listener addresses but distinct browser origins, so
 * both localhost and 127.0.0.1 must be explicitly allowed.
 */
export function resolveFrontendCorsOrigins(frontendUrl: string): string[] {
  const parsed = new URL(frontendUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported desktop frontend protocol: ${parsed.protocol}`);
  }

  const origins: string[] = [];
  appendOrigin(origins, parsed.origin);

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? `:${parsed.port}` : '';
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '0.0.0.0') {
    appendOrigin(origins, `${parsed.protocol}//127.0.0.1${port}`);
    appendOrigin(origins, `${parsed.protocol}//localhost${port}`);
  }

  return origins;
}

/** Merge launcher-required origins into caller configuration without widening to `*`. */
export function mergeCorsOriginEnv(existing: string | undefined, required: string[]): string {
  const merged = (existing ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of required) {
    if (origin === '*') {
      throw new Error('The desktop launcher refuses to inject a wildcard CORS origin.');
    }
    appendOrigin(merged, origin);
  }

  return merged.join(',');
}

/**
 * A backend is launcher-ready only when it is the Koryphaios service and its
 * response proves the requesting browser origin was explicitly allowed.
 */
export function isLauncherBackendReady(
  health: LauncherBackendHealth | null,
  accessControlAllowOrigin: string | null,
  expectedFrontendOrigin: string,
): boolean {
  return (
    health?.ok === true &&
    health.data?.id === BACKEND_SERVICE_ID &&
    typeof health.data.pid === 'number' &&
    typeof health.data.compat?.serverStartedAt === 'number' &&
    accessControlAllowOrigin === expectedFrontendOrigin
  );
}
