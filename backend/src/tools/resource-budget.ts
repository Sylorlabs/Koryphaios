import type { ProviderRegistry } from '../providers';
import { collectResourceBudgetSnapshot } from '../billing/resource-budget';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

export class GetResourceBudgetTool implements Tool {
  readonly name = 'get_resource_budget';
  readonly role = 'any' as const;
  readonly description = 'Read a secret-free snapshot of provider-reported API balances, subscription quota windows, live rate-limit windows, and this chat spend. Use it before fan-out to avoid assigning an agent that will rate-limit or stop mid-task. Never treat missing data as zero or invent balances.';
  readonly inputSchema = { type: 'object', properties: {} };

  constructor(private providers: ProviderRegistry) {}

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const snapshot = await collectResourceBudgetSnapshot(
      this.providers.getConfigs(),
      {},
      ctx.sessionId,
    );
    return { callId: call.id, name: this.name, output: JSON.stringify(snapshot), isError: false, durationMs: 0 };
  }
}
