import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from "./registry";
import { shellManager } from "./shell-manager";

export class ShellManageTool implements Tool {
  readonly name = "shell_manage";
  readonly role = "manager" as const;
  readonly description = "List, view logs, or kill background processes (terminals) stored by the manager. Use after starting processes with bash (isBackground: true). Actions: list, logs (requires processId), kill (requires processId).";

  readonly inputSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "logs", "kill"],
        description: "Action to perform.",
      },
      processId: {
        type: "string",
        description: "The ID of the background process (required for 'logs' and 'kill').",
      },
    },
    required: ["action"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { action, processId } = call.input as {
      action: "list" | "logs" | "kill";
      processId?: string;
    };

    if (action === "list") {
      const procs = shellManager.listProcesses();
      if (procs.length === 0) {
        return {
          callId: call.id,
          name: this.name,
          output: "No background processes running.",
          isError: false,
          durationMs: 0,
        };
      }

      const output = procs.map(p => 
        `ID: ${p.id}\nName: ${p.name}\nCommand: ${p.command}\nStatus: ${p.status}\nPID: ${p.pid}\nStarted: ${new Date(p.startTime).toISOString()}`
      ).join("\n---\n");

      return {
        callId: call.id,
        name: this.name,
        output: `Active Background Processes:\n${output}`,
        isError: false,
        durationMs: 0,
      };
    }

    if (!processId) {
      return {
        callId: call.id,
        name: this.name,
        output: "Error: processId is required for 'logs' and 'kill' actions.",
        isError: true,
        durationMs: 0,
      };
    }

    const proc = shellManager.getProcess(processId);
    if (!proc) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: Background process with ID ${processId} not found.`,
        isError: true,
        durationMs: 0,
      };
    }

    if (action === "logs") {
      let output = `Logs for process ${proc.name} (${proc.id}):\n`;
      if (proc.stdout) output += `\nSTDOUT:\n${proc.stdout}`;
      if (proc.stderr) output += `\nSTDERR:\n${proc.stderr}`;
      if (!proc.stdout && !proc.stderr) output += "\n(No logs available yet)";
      
      return {
        callId: call.id,
        name: this.name,
        output,
        isError: false,
        durationMs: 0,
      };
    }

    if (action === "kill") {
      const success = shellManager.killProcess(processId);
      return {
        callId: call.id,
        name: this.name,
        output: success ? `Process ${proc.name} (${processId}) killed.` : `Failed to kill process ${processId}.`,
        isError: !success,
        durationMs: 0,
      };
    }

    return {
      callId: call.id,
      name: this.name,
      output: `Unknown action: ${action}`,
      isError: true,
      durationMs: 0,
    };
  }
}
