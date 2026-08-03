import type { ProviderRegistry } from '../providers';
import { collectResourceBudgetSnapshot } from '../billing/resource-budget';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

export class GetResourceBudgetTool implements Tool {
  readonly name = 'get_resource_budget';
  readonly role = 'any' as const;
  readonly description = 'Read a secret-free snapshot of provider-reported API balances and subscription quota windows. Use it for cost/capacity decisions, but never treat missing data as zero or invent subscription dollar balances.';
  readonly inputSchema = { type: 'object', properties: {} };

  constructor(private providers: ProviderRegistry) {}

  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const snapshot = await collectResourceBudgetSnapshot(this.providers.getConfigs());
    return { callId: call.id, name: this.name, output: JSON.stringify(snapshot), isError: false, durationMs: 0 };
  }
}
