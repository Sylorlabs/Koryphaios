// MCP (Model Context Protocol) client integration.
// Supports connecting to MCP servers via stdio and SSE transports.
// This allows Koryphaios to connect to external tool servers.

import { spawn, type ChildProcess } from "child_process";
import { mcpLog } from "../logger";
import type { Tool, ToolCallInput, ToolContext, ToolCallOutput } from "../tools/registry";

// ─── MCP Protocol Types ─────────────────────────────────────────────────────

interface MCPServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;       // For stdio
  args?: string[];        // For stdio
  env?: Record<string, string>;
  url?: string;           // For SSE
  headers?: Record<string, string>;
}

interface MCPRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

// ─── MCP Client ─────────────────────────────────────────────────────────────

export class MCPClient {
  private process?: ChildProcess;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (value: MCPResponse) => void;
    reject: (reason: Error) => void;
  }>();
  private buffer = "";
  private tools: MCPToolDef[] = [];
  private connected = false;
  private serverName: string;
  private serverCapabilities: Record<string, unknown> = {};

  constructor(private config: MCPServerConfig) {
    this.serverName = config.name;
  }

  get name() { return this.serverName; }
  get isConnected() { return this.connected; }
  get availableTools() { return this.tools; }

  async connect(): Promise<void> {
    if (this.config.transport === "stdio") {
      await this.connectStdio();
    } else {
      await this.connectSSE();
    }
  }

  private async connectStdio(): Promise<void> {
    const { command, args = [], env = {} } = this.config;
    if (!command) throw new Error(`MCP server ${this.serverName}: command is required for stdio transport`);

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`MCP server ${this.serverName}: failed to open stdio pipes`);
    }

    this.process.stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      mcpLog.error({ server: this.serverName, output: data.toString().trim() }, "MCP stderr");
    });

    this.process.on("exit", (code) => {
      mcpLog.info({ server: this.serverName, code }, "MCP process exited");
      this.connected = false;
    });

    // Initialize
    const initResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        roots: { listChanged: false },
      },
      clientInfo: {
        name: "koryphaios",
        version: "0.1.0",
      },
    });

    this.serverCapabilities = (initResult.result as any).capabilities ?? {};

    // Send initialized notification
    this.notify("notifications/initialized", {});

    // List available tools if server supports them
    if (this.serverCapabilities.tools) {
      try {
        const toolsResult = await this.request("tools/list", {});
        this.tools = (toolsResult.result as any)?.tools ?? [];
      } catch (err: any) {
        mcpLog.warn({ server: this.serverName, err: err.message }, "Failed to list tools despite capability");
      }
    }

    this.connected = true;
    mcpLog.info({ server: this.serverName, tools: this.tools.length }, "MCP connected via stdio");
  }

  private async connectSSE(): Promise<void> {
    // SSE transport — connect to HTTP endpoint
    const { url, headers = {} } = this.config;
    if (!url) throw new Error(`MCP server ${this.serverName}: url is required for SSE transport`);

    // For SSE, we call HTTP endpoints for RPC
    // Initialize
    const initResp = await fetch(`${url}/initialize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: "koryphaios", version: "0.1.0" },
        },
      }),
    });

    if (!initResp.ok) {
      throw new Error(`MCP server ${this.serverName}: initialization failed (${initResp.status})`);
    }

    // List tools
    const toolsResp = await fetch(`${url}/tools/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "tools/list",
        params: {},
      }),
    });

    if (toolsResp.ok) {
      const data = await toolsResp.json() as MCPResponse;
      this.tools = (data.result as any)?.tools ?? [];
    }

    this.connected = true;
    mcpLog.info({ server: this.serverName, tools: this.tools.length }, "MCP connected via SSE");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (this.config.transport === "stdio") {
      const response = await this.request("tools/call", { name, arguments: args });
      if (response.error) {
        return {
          content: [{ type: "text", text: `MCP Error: ${response.error.message}` }],
          isError: true,
        };
      }
      return response.result as MCPToolResult;
    } else {
      // SSE transport
      const resp = await fetch(`${this.config.url}/tools/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.config.headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.requestId,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });

      const data = await resp.json() as MCPResponse;
      if (data.error) {
        return {
          content: [{ type: "text", text: `MCP Error: ${data.error.message}` }],
          isError: true,
        };
      }
      return data.result as MCPToolResult;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = undefined;
    }
    this.pending.clear();
  }

  // ── Stdio JSON-RPC helpers ──

  private async request(method: string, params: unknown): Promise<MCPResponse> {
    const id = ++this.requestId;
    const request: MCPRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (val) => { clearTimeout(timeout); resolve(val); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      this.process!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  private notify(method: string, params: unknown): void {
    const notification = { jsonrpc: "2.0", method, params };
    this.process?.stdin?.write(JSON.stringify(notification) + "\n");
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as MCPResponse;
        if (msg.id !== undefined) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            pending.resolve(msg);
          }
        }
      } catch {
        // Ignore non-JSON lines (server logging etc.)
      }
    }
  }
}

// ─── MCP Tool Wrapper ───────────────────────────────────────────────────────
// Wraps an MCP server's tool as a local Tool for the ToolRegistry.

export class MCPToolWrapper implements Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  constructor(
    private client: MCPClient,
    private toolDef: MCPToolDef,
  ) {
    // Prefix with server name to avoid collisions
    this.name = `mcp_${client.name}_${toolDef.name}`;
    this.description = `[MCP:${client.name}] ${toolDef.description}`;
    this.inputSchema = toolDef.inputSchema;
  }

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      const result = await this.client.callTool(this.toolDef.name, call.input);

      const output = result.content
        .map((c) => c.text ?? `[${c.type}: ${c.mimeType ?? "binary"}]`)
        .join("\n");

      return {
        callId: call.id,
        name: this.name,
        output,
        isError: result.isError ?? false,
        durationMs: 0,
      };
    } catch (err: any) {
      return {
        callId: call.id,
        name: this.name,
        output: `MCP tool error: ${err.message}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}

// ─── MCP Manager ────────────────────────────────────────────────────────────
// Manages multiple MCP server connections and registers their tools.

import { ToolRegistry } from "../tools/registry";

export class MCPManager {
  private clients = new Map<string, MCPClient>();

  async connectServer(config: MCPServerConfig, toolRegistry: ToolRegistry): Promise<void> {
    const client = new MCPClient(config);

    try {
      await client.connect();
      this.clients.set(config.name, client);

      // Register all tools from this server
      for (const toolDef of client.availableTools) {
        const wrapper = new MCPToolWrapper(client, toolDef);
        toolRegistry.register(wrapper);
        mcpLog.info({ tool: wrapper.name }, "Registered MCP tool");
      }
    } catch (err: any) {
      mcpLog.error({ server: config.name, err: err.message }, "Failed to connect MCP server");
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      await client.disconnect();
      mcpLog.info({ server: name }, "MCP disconnected");
    }
    this.clients.clear();
  }

  getStatus(): Array<{ name: string; connected: boolean; toolCount: number }> {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      connected: client.isConnected,
      toolCount: client.availableTools.length,
    }));
  }
}
