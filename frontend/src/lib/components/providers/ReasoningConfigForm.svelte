<script lang="ts">
  import { Label } from '$lib/components/ui/label';
  import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '$lib/components/ui/select';
  import { Switch } from '$lib/components/ui/switch';
  import { Input } from '$lib/components/ui/input';
  import { ALL_REASONING_MODES, getReasoningModeDescription, getReasoningCostMultiplier, type ReasoningConfig } from '@koryphaios/shared';

  export let config: ReasoningConfig = { mode: 'medium' };
  export let showAdvanced = false;

  $: modeDescription = getReasoningModeDescription(config.mode);
  $: costMultiplier = getReasoningCostMultiplier(config.mode);
</script>

<div class="space-y-4 border rounded-lg p-4">
  <div class="flex items-center justify-between">
    <h3 class="font-medium text-sm">Reasoning Configuration</h3>
    <button
      type="button"
      class="text-xs text-muted-foreground hover:text-foreground"
      on:click={() => showAdvanced = !showAdvanced}
    >
      {showAdvanced ? 'Simple' : 'Advanced'}
    </button>
  </div>

  <div class="space-y-2">
    <Label for="reasoningMode">Reasoning Mode</Label>
    <Select 
      value={config.mode} 
      onValueChange={(v) => config = { ...config, mode: v as any }}
    >
      <SelectTrigger id="reasoningMode">
        <SelectValue placeholder="Select reasoning mode" />
      </SelectTrigger>
      <SelectContent>
        {#each ALL_REASONING_MODES as mode}
          <SelectItem value={mode.value}>
            <div class="flex flex-col">
              <span>{mode.label}</span>
              <span class="text-xs text-muted-foreground">{mode.description}</span>
            </div>
          </SelectItem>
        {/each}
      </SelectContent>
    </Select>
    <p class="text-xs text-muted-foreground">
      {modeDescription}
      {#if costMultiplier > 1}
        <span class="text-orange-500"> (~{costMultiplier}x cost)</span>
      {/if}
    </p>
  </div>

  {#if showAdvanced}
    <div class="space-y-4 pt-2 border-t">
      <div class="space-y-2">
        <Label for="budgetTokens">Token Budget (Optional)</Label>
        <Input
          id="budgetTokens"
          type="number"
          placeholder="Auto"
          min="0"
          max="32768"
          value={config.budgetTokens ?? ''}
          on:input={(e) => {
            const val = e.currentTarget.value;
            config = { 
              ...config, 
              budgetTokens: val ? parseInt(val, 10) : undefined 
            };
          }}
        />
        <p class="text-xs text-muted-foreground">
          Maximum tokens to use for reasoning. Leave empty for automatic.
          Some providers support this (Gemini, Anthropic).
        </p>
      </div>

      <div class="flex items-center space-x-2">
        <Switch
          id="includeThoughts"
          checked={config.includeThoughts ?? false}
          onCheckedChange={(checked) => {
            config = { ...config, includeThoughts: checked };
          }}
        />
        <Label for="includeThoughts" class="cursor-pointer">
          Include thinking in response
        </Label>
      </div>
      <p class="text-xs text-muted-foreground">
        Show the model's reasoning process in the response (if supported by provider).
      </p>
    </div>
  {/if}
</div>
