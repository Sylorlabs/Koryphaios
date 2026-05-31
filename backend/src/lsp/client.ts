/**
 * LSP Client - Type-aware AI coding
 *
 * Provides AI agents with access to language server features:
 * - Hover (type info)
 * - Go to definition
 * - Document symbols
 * - Diagnostics
 */

import { spawn, type Subprocess } from 'bun';
import { koryLog } from '../logger';

interface LSPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

interface LSPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface HoverResult {
  contents:
    | string
    | { language: string; value: string }
    | Array<{ language: string; value: string }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface DefinitionResult {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface DocumentSymbol {
  name: string;
  kind: number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  selectionRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface Diagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: 1 | 2 | 3 | 4; // Error, Warning, Information, Hint
  message: string;
  source?: string;
  code?: string | number;
}

export class LSPClient {
  private proc: Subprocess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, (response: LSPResponse) => void>();
  private buffer = '';
  private initialized = false;
  private documentVersions = new Map<string, number>();
  private diagnostics = new Map<string, Diagnostic[]>();

  constructor(
    private language: 'typescript' | 'rust' | 'python' | 'go',
    private rootPath: string,
  ) {}

  async start(): Promise<boolean> {
    const command = this.getLanguageServerCommand();
    if (!command) {
      koryLog.warn({ language: this.language }, 'No LSP server available');
      return false;
    }

    try {
      this.proc = spawn({
        cmd: command,
        cwd: this.rootPath,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      });

      // Read responses
      this.readLoop();

      // Initialize
      const initResult = await this.request('initialize', {
        processId: process.pid,
        rootUri: `file://${this.rootPath}`,
        capabilities: {
          textDocument: {
            hover: { dynamicRegistration: false },
            definition: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true },
          },
        },
      });

      if (initResult.error) {
        koryLog.error({ error: initResult.error }, 'LSP initialization failed');
        return false;
      }

      await this.notify('initialized', {});
      this.initialized = true;

      koryLog.info({ language: this.language }, 'LSP client started');
      return true;
    } catch (err) {
      koryLog.error({ err, language: this.language }, 'Failed to start LSP');
      return false;
    }
  }

  private getLanguageServerCommand(): string[] | null {
    switch (this.language) {
      case 'typescript':
        return ['typescript-language-server', '--stdio'];
      case 'rust':
        return ['rust-analyzer'];
      case 'python':
        return ['pylsp'];
      case 'go':
        return ['gopls'];
      default:
        return null;
    }
  }

  private async readLoop(): Promise<void> {
    if (!this.proc?.stdout) return;
    if (!(this.proc.stdout instanceof ReadableStream)) return;

    const reader = this.proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.handleData(new TextDecoder().decode(value));
      }
    } catch (err) {
      koryLog.error({ err }, 'LSP read error');
    }
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Parse LSP messages (Content-Length protocol)
    while (true) {
      const headerMatch = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
      if (!headerMatch) break;

      const contentLength = parseInt(headerMatch[1]);
      const headerEnd = headerMatch.index! + headerMatch[0].length;
      const messageEnd = headerEnd + contentLength;

      if (this.buffer.length < messageEnd) break;

      const message = this.buffer.slice(headerEnd, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

      try {
        const parsed = JSON.parse(message) as LSPResponse | { method: string; params: unknown };

        // Handle responses
        if ('id' in parsed && this.pendingRequests.has(parsed.id)) {
          const resolver = this.pendingRequests.get(parsed.id)!;
          this.pendingRequests.delete(parsed.id);
          resolver(parsed as LSPResponse);
        }

        // Handle notifications (like diagnostics)
        if ('method' in parsed && parsed.method === 'textDocument/publishDiagnostics') {
          const params = parsed.params as { uri: string; diagnostics: Diagnostic[] };
          const path = params.uri.replace(`file://${this.rootPath}/`, '');
          this.diagnostics.set(path, params.diagnostics);
        }
      } catch (err) {
        koryLog.error({ err, message: message.slice(0, 200) }, 'Failed to parse LSP message');
      }
    }
  }

  private async request(method: string, params: unknown): Promise<LSPResponse> {
    if (!this.proc?.stdin) {
      return { jsonrpc: '2.0', id: -1, error: { code: -1, message: 'LSP not connected' } };
    }
    if (!(this.proc.stdin instanceof WritableStream)) {
      return { jsonrpc: '2.0', id: -1, error: { code: -1, message: 'LSP stdin not writable' } };
    }

    const id = ++this.requestId;
    const request: LSPRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const message = JSON.stringify(request);
    const fullMessage = `Content-Length: ${message.length}\r\n\r\n${message}`;

    const writer = this.proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(fullMessage));
    writer.releaseLock();

    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve({ jsonrpc: '2.0', id, error: { code: -1, message: 'Request timeout' } });
        }
      }, 5000);
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (!this.proc?.stdin) return;
    if (!(this.proc.stdin instanceof WritableStream)) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const message = JSON.stringify(notification);
    const fullMessage = `Content-Length: ${message.length}\r\n\r\n${message}`;

    const writer = this.proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(fullMessage));
    writer.releaseLock();
  }

  async openDocument(path: string, content: string): Promise<void> {
    const version = (this.documentVersions.get(path) ?? 0) + 1;
    this.documentVersions.set(path, version);

    await this.notify('textDocument/didOpen', {
      textDocument: {
        uri: `file://${this.rootPath}/${path}`,
        languageId: this.language,
        version,
        text: content,
      },
    });
  }

  async updateDocument(path: string, content: string): Promise<void> {
    const version = (this.documentVersions.get(path) ?? 0) + 1;
    this.documentVersions.set(path, version);

    await this.notify('textDocument/didChange', {
      textDocument: {
        uri: `file://${this.rootPath}/${path}`,
        version,
      },
      contentChanges: [{ text: content }],
    });
  }

  async getHover(path: string, line: number, character: number): Promise<HoverResult | null> {
    const response = await this.request('textDocument/hover', {
      textDocument: { uri: `file://${this.rootPath}/${path}` },
      position: { line, character },
    });

    if (response.error || !response.result) return null;
    return response.result as HoverResult;
  }

  async getDefinition(
    path: string,
    line: number,
    character: number,
  ): Promise<DefinitionResult | null> {
    const response = await this.request('textDocument/definition', {
      textDocument: { uri: `file://${this.rootPath}/${path}` },
      position: { line, character },
    });

    if (response.error || !response.result) return null;
    const result = response.result as DefinitionResult | DefinitionResult[];
    return Array.isArray(result) ? result[0] : result;
  }

  async getDocumentSymbols(path: string): Promise<DocumentSymbol[]> {
    const response = await this.request('textDocument/documentSymbol', {
      textDocument: { uri: `file://${this.rootPath}/${path}` },
    });

    if (response.error || !response.result) return [];
    return response.result as DocumentSymbol[];
  }

  getDiagnostics(path: string): Diagnostic[] {
    return this.diagnostics.get(path) ?? [];
  }

  hasErrors(path: string): boolean {
    return this.getDiagnostics(path).some((d) => d.severity === 1);
  }

  getErrorSummary(path: string): string {
    const diags = this.getDiagnostics(path);
    const errors = diags.filter((d) => d.severity === 1);
    const warnings = diags.filter((d) => d.severity === 2);

    if (errors.length === 0 && warnings.length === 0) return 'No issues';

    const parts = [];
    if (errors.length > 0) parts.push(`${errors.length} error${errors.length > 1 ? 's' : ''}`);
    if (warnings.length > 0)
      parts.push(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`);

    return parts.join(', ');
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    try {
      await this.request('shutdown', {});
      await this.notify('exit', {});
    } catch (err) {
      koryLog.error({ err }, 'LSP shutdown error');
    }

    this.proc?.kill();
    this.initialized = false;
  }
}

// LSP Manager - manages multiple language clients
export class LSPManager {
  private clients = new Map<string, LSPClient>();

  async getClient(language: string, rootPath: string): Promise<LSPClient | null> {
    const key = `${language}:${rootPath}`;

    if (this.clients.has(key)) {
      return this.clients.get(key)!;
    }

    const client = new LSPClient(language as 'typescript' | 'rust' | 'python' | 'go', rootPath);
    const started = await client.start();

    if (started) {
      this.clients.set(key, client);
      return client;
    }

    return null;
  }

  async detectLanguage(rootPath: string): Promise<string | null> {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    if (existsSync(join(rootPath, 'package.json'))) return 'typescript';
    if (existsSync(join(rootPath, 'Cargo.toml'))) return 'rust';
    if (
      existsSync(join(rootPath, 'requirements.txt')) ||
      existsSync(join(rootPath, 'pyproject.toml'))
    )
      return 'python';
    if (existsSync(join(rootPath, 'go.mod'))) return 'go';

    return null;
  }

  async shutdownAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.shutdown();
    }
    this.clients.clear();
  }
}

export const lspManager = new LSPManager();
