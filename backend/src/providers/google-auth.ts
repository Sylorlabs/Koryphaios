// Google Auth Manager — handles Gemini CLI authentication via gcloud.
// Note: The previous "Antigravity" internal Google tool integration has been removed
// as it was an unsupported, reverse-engineered feature that could break at any time.

import { spawn } from "bun";
import { providerLog } from "../logger";

export class GoogleAuthManager {
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
