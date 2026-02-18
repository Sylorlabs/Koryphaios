// Codex CLI provider — wraps the `codex` CLI as a child process.
// Used for authenticated Codex access via ChatGPT subscription.

import type { ProviderConfig, ModelDef } from "@koryphaios/shared";
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  getModelsForProvider,
} from "./types";

export class CodexProvider implements Provider {
  readonly name = "codex" as const;
  private cliAvailable: boolean | null = null;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    // Check CLI auth token marker or detect CLI in PATH
    if (this.config.authToken?.startsWith("cli:")) return true;
    if (this.cliAvailable === null) {
      const proc = Bun.spawnSync(["which", "codex"], { stdout: "pipe", stderr: "pipe" });
      this.cliAvailable = proc.exitCode === 0;
    }
    return this.cliAvailable;
  }

  async listModels(): Promise<ModelDef[]> {
    return getModelsForProvider("codex");
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const prompt = request.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    const args = ["--model", request.model];

    if (request.systemPrompt) {
      args.push("--system", request.systemPrompt);
    }

    // Add prompt as the final positional argument
    args.push(prompt);

    try {
      const proc = Bun.spawn(["codex", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) {
          yield { type: "content_delta", content: text };
        }
      }

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderrReader = proc.stderr.getReader();
        const { value } = await stderrReader.read();
        const errText = value ? decoder.decode(value) : `Process exited with code ${exitCode}`;
        yield { type: "error", error: errText };
      } else {
        yield { type: "complete", finishReason: "end_turn" };
      }
    } catch (err: any) {
      yield { type: "error", error: "Codex CLI error: " + (err.message ?? String(err)) };
    }
  }
}
