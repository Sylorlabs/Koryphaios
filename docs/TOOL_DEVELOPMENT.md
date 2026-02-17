# Tool Development Guide

This guide explains how to create custom tools for Koryphaios.

## Tool Interface

All tools must implement the `Tool` interface defined in `backend/src/tools/registry.ts`:

```typescript
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput>;
}
```

## Creating a Plugin

You can add custom tools without modifying the core codebase by placing them in `backend/src/plugins/`.

### Step 1: Create a Tool Class

Create a new file, e.g., `backend/src/plugins/MyTool.ts`:

```typescript
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from "../tools/registry";

export default class MyTool implements Tool {
  name = "my_tool";
  description = "A custom tool that does something useful";

  // JSON Schema for the tool's input
  inputSchema = {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to log" }
    },
    required: ["message"]
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { message } = call.input as { message: string };

    console.log(`[MyTool] ${message}`);

    return {
      callId: call.id,
      name: this.name,
      output: `Logged: ${message}`,
      isError: false,
      durationMs: 0 // calculated by registry
    };
  }
}
```

### Step 2: Restart Server

Restart the Koryphaios backend. The tool will be automatically loaded and available to agents.

## Best Practices

1. **Input Validation**: Validate inputs inside `run()`. The LLM generally follows the schema, but not always.
2. **Error Handling**: Catch errors and return them in the `output` field with `isError: true`. Do not throw exceptions if possible.
3. **Context Usage**: Use `ctx.workingDirectory` for filesystem operations to ensure you respect the workspace root.
4. **Streaming**: If your tool performs long-running operations, consider splitting it or using the `emitFileEdit` callback if it modifies files.
