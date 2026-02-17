import { spawn } from "bun";
import { providerLog } from "../logger";
import { ANTIGRAVITY } from "../constants";

export class GoogleAuthManager {
  /**
   * Starts the Gemini CLI Auth flow.
   * This uses the gemini CLI to open a browser and authenticate.
   */
  async startGeminiCLIAuth(): Promise<{ success: boolean; message: string; url?: string }> {
    return new Promise((resolve) => {
      const proc = spawn(["gemini", "--prompt", "hi"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      let output = "";
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          proc.kill();
          resolve({ success: false, message: "Authentication timed out after 5 minutes" });
        }
      }, 300_000); // 5 minute timeout

      const decoder = new TextDecoder();
      const readStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          output += text;

          const urlMatch = text.match(/(https:\/\/(?:accounts\.google\.com|.*\.google\.com)\/o\/oauth2\/auth\S+)/);
          if (urlMatch && !resolved) {
            resolved = true;
            resolve({
              success: true,
              message: "Auth URL generated",
              url: urlMatch[1]
            });
          }
        }
      };

      readStream(proc.stdout.getReader());
      readStream(proc.stderr.getReader());

      proc.exited.then((code) => {
        clearTimeout(timeout);
        if (resolved) return;
        resolved = true;

        if (code === 0) {
          resolve({ success: true, message: "Authentication successful" });
        } else {
          resolve({ success: false, message: `gemini CLI exited with code ${code}. Output: ${output.slice(0, 200)}` });
        }
      });
    });
  }

  /**
   * Starts the "Antigravity" Auth flow using hijacked credentials.
   */
  async startAntigravityAuth(): Promise<{ success: boolean; message: string; url?: string }> {
    const params = new URLSearchParams({
      client_id: ANTIGRAVITY.CLIENT_ID,
      response_type: "code",
      redirect_uri: ANTIGRAVITY.REDIRECT_URI,
      scope: ANTIGRAVITY.SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
    });

    const url = `${ANTIGRAVITY.ENDPOINTS.AUTH}?${params.toString()}`;

    return {
      success: true,
      message: "Please authenticate in the Antigravity portal. This will hijack a high-tier session for Gemini 3 and Claude 4.5.",
      url: url
    };
  }

  /**
   * Starts a temporary listener on port 51121 to catch the OAuth callback.
   */
  async waitForAntigravityCallback(): Promise<{ success: boolean; token?: string; error?: string }> {
    return new Promise((resolve) => {
      const port = 51121;
      const server = Bun.serve({
        port,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/oauth-callback") {
            const code = url.searchParams.get("code");
            if (code) {
              // Exchange code for token
              try {
                // @ts-ignore - access private method
                const token = await googleAuth.exchangeCodeForAntigravityToken(code);
                resolve({ success: true, token });
                return new Response("Authentication successful! You can close this tab and return to the DAW.", {
                  headers: { "Content-Type": "text/html" }
                });
              } catch (err: any) {
                resolve({ success: false, error: err.message });
                return new Response(`Error: ${err.message}`, { status: 500 });
              } finally {
                setTimeout(() => server.stop(), 1000);
              }
            }
          }
          return new Response("Not found", { status: 404 });
        },
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.stop();
        resolve({ success: false, error: "Timed out waiting for callback" });
      }, 300_000);
    });
  }

  /**
   * Refreshes an Antigravity access token using a refresh token.
   */
  async refreshAntigravityToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const response = await fetch(ANTIGRAVITY.ENDPOINTS.TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY.CLIENT_ID,
        client_secret: ANTIGRAVITY.CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token refresh failed: ${body}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in
    };
  }

  private async exchangeCodeForAntigravityToken(code: string): Promise<string> {
    const response = await fetch(ANTIGRAVITY.ENDPOINTS.TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY.CLIENT_ID,
        client_secret: ANTIGRAVITY.CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: ANTIGRAVITY.REDIRECT_URI,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token exchange failed: ${body}`);
    }

    const data = await response.json();
    return data.refresh_token; // We return refresh_token to be stored
  }
}

export const googleAuth = new GoogleAuthManager();
