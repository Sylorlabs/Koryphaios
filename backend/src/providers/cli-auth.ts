
import { spawn } from "bun";

export class CLIAuthManager {
  /**
   * Generic method to run an auth command and extract a URL or wait for success.
   */
  async runAuthCommand(
    command: string[], 
    urlRegex: RegExp | null, 
    successMessage: string
  ): Promise<{ success: boolean; message: string; url?: string }> {
    return new Promise((resolve) => {
      const proc = spawn(command, {
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
          
          if (urlRegex && !resolved) {
            const match = text.match(urlRegex);
            if (match) {
              resolved = true;
              resolve({ 
                success: true, 
                message: "Auth URL generated", 
                url: match[1] || match[0] 
              });
            }
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
          resolve({ success: true, message: successMessage });
        } else {
          resolve({ success: false, message: `Command exited with code ${code}. Output: ${output.slice(0, 300)}` });
        }
      });
    });
  }

  async authenticateClaude(): Promise<{ success: boolean; message: string; url?: string }> {
    // "claude login" typically opens a browser.
    // We check if "claude" is installed first.
    const check = Bun.spawnSync(["which", "claude"]);
    if (check.exitCode !== 0) {
      return { success: false, message: "Claude CLI not found. Run: npm install -g @anthropic-ai/claude-code" };
    }

    // claude login prints "Visit this URL..."
    return this.runAuthCommand(
      ["claude", "login"], 
      /(https:\/\/claude\.ai\/login\S+)/,
      "Claude authentication successful"
    );
  }

  async authenticateCodex(): Promise<{ success: boolean; message: string; url?: string }> {
    const check = Bun.spawnSync(["which", "codex"]);
    if (check.exitCode !== 0) {
      return { success: false, message: "Codex CLI not found. (Assuming standard OpenAI CLI or alias)" };
    }

    // Hypothetical "codex login" or "openai login"
    return this.runAuthCommand(
      ["codex", "login"],
      /(https:\/\/.*openai\.com\S+)/,
      "Codex authentication successful"
    );
  }
}

export const cliAuth = new CLIAuthManager();
