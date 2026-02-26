// Codex CLI provider — wraps the `codex` CLI as a child process.
// Used for authenticated Codex access via ChatGPT subscription.
// Uses timeout and guaranteed kill/reap to avoid zombie processes.

import type { ProviderConfig, ModelDef } from "@koryphaios/shared";
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  getModelsForProvider,
} from "./types";

const CODEX_STREAM_TIMEOUT_MS = 300_000; // 5 min max per stream

export class CodexProvider implements Provider {
  readonly name = "codex" as const;
  private cliAvailable: boolean | null = null;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    if (this.config.authToken?.startsWith("cli:")) return true;
    if (this.cliAvailable === null) {
      this.cliAvailable = Bun.which("codex") !== null;
    }
    return this.cliAvailable;
  }

  listModels(): ModelDef[] {
    return getModelsForProvider("codex");
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const prompt = request.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    const args = ["--model", request.model];
    if (request.systemPrompt) args.push("--system", request.systemPrompt);
    args.push(prompt);

    const proc = Bun.spawn(["codex", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const killAndReap = (): void => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    };

    const timeoutId = setTimeout(killAndReap, CODEX_STREAM_TIMEOUT_MS);

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) yield { type: "content_delta", content: text };
      }

      clearTimeout(timeoutId);
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
      killAndReap();
      yield { type: "error", error: "Codex CLI error: " + (err.message ?? String(err)) };
    } finally {
      clearTimeout(timeoutId);
      killAndReap();
      try {
        await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 2000))]);
      } catch {
        // ignore
      }
    }
  }
}
