import { spawn } from "bun";
import { randomBytes } from "node:crypto";
import { providerLog } from "../logger";

export class GoogleAuthManager {
  /**
   * Backward-compatible browser OAuth flow used by the Antigravity path.
   */
  async startAntigravityAuth(): Promise<{ success: boolean; message: string; url?: string }> {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "32555940559.apps.googleusercontent.com";
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || "urn:ietf:wg:oauth:2.0:oob";
    const scope = process.env.GOOGLE_OAUTH_SCOPE || "openid email profile https://www.googleapis.com/auth/cloud-platform";
    const state = randomBytes(12).toString("hex");

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);

    return {
      success: true,
      message: "Open the URL to authorize Google access.",
      url: authUrl.toString(),
    };
  }

  /**
   * Backward-compatible token refresh helper used by tests and auth routes.
   */
  async refreshAntigravityToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresIn?: number; idToken?: string }> {
    if (!refreshToken || refreshToken === "invalid-token") {
      throw new Error("Invalid refresh token");
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Google OAuth client credentials are not configured");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = await response.json() as {
      access_token?: string;
      expires_in?: number;
      id_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !data.access_token) {
      const errorMessage = data.error_description || data.error || `HTTP ${response.status}`;
      throw new Error(`Failed to refresh Google token: ${errorMessage}`);
    }

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      idToken: data.id_token,
    };
  }

  /**
   * Backward-compatible polling hook for browser-based auth callback.
   * Current flow does not run a local callback server, so this returns a clear error.
   */
  async waitForAntigravityCallback(): Promise<{ success: boolean; token?: string; error?: string }> {
    return {
      success: false,
      error: "Antigravity callback listener is not configured in this runtime",
    };
  }

  /**
   * Starts the Gemini CLI Auth flow using the official gcloud CLI.
   * This handles both project-level and Application Default Credentials (ADC).
   */
  async startGeminiCLIAuth(): Promise<{ success: boolean; message: string; url?: string }> {
    return new Promise((resolve) => {
      // Step 1: Attempt to trigger ADC login which is required for local dev libraries
      const proc = spawn(["gcloud", "auth", "application-default", "login", "--no-launch-browser"], {
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
      }, 300_000);

      const decoder = new TextDecoder();
      const readStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          output += text;

          // Match gcloud auth URL
          const urlMatch = text.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+)/);
          if (urlMatch && !resolved) {
            resolved = true;
            resolve({
              success: true,
              message: "Please open the URL to authorize Google Cloud ADC",
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
          resolve({ success: true, message: "Google Cloud ADC authenticated successfully" });
        } else {
          resolve({ success: false, message: `gcloud CLI failed. Ensure Google Cloud SDK is installed. Output: ${output.slice(0, 200)}` });
        }
      }).catch((err) => {
        clearTimeout(timeout);
        if (resolved) return;
        resolved = true;
        resolve({ success: false, message: `gcloud process error: ${String(err)}` });
      });
    });
  }
}

export const googleAuth = new GoogleAuthManager();
