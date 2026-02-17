# Koryphaios Plugins

This directory is for local, project-specific tools.
Any `.ts` file in this directory that exports a default class implementing the `Tool` interface will be automatically loaded at startup.

## Example

```typescript
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from "../tools/registry";

export default class MyCustomTool implements Tool {
  name = "my_custom_tool";
  description = "Does something special";
  inputSchema = {
    type: "object",
    properties: {
      param: { type: "string" }
    }
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    return {
      callId: call.id,
      name: this.name,
      output: "Hello from custom tool!",
      isError: false,
      durationMs: 0
    };
  }
}
```
