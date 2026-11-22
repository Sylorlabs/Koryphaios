import { listSkills, type SkillSource } from '../kory/skills';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

const MAX_DETAIL_CHARS = 24_000;

/** Read-only progressive disclosure for a skill already installed locally. */
export class LoadSkillDetailTool implements Tool {
  readonly name = 'load_skill_detail';
  readonly role = 'any' as const;
  readonly description =
    'Load the full instructions for an active local Koryphaios skill when the compact system-prompt representation omitted detail needed for the current task. This is read-only and never grants tools, scripts, network access, or broader authority.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact active skill name from the prompt manifest.' },
      source: {
        type: 'string',
        enum: ['personal', 'project'],
        description: 'Required only when both personal and project copies exist.',
      },
    },
    required: ['name'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const name = typeof call.input.name === 'string' ? call.input.name.trim() : '';
    const source =
      call.input.source === 'personal' || call.input.source === 'project'
        ? (call.input.source as SkillSource)
        : undefined;
    const candidates = listSkills(ctx.workingDirectory).filter(
      (skill) =>
        skill.state === 'active' && skill.name === name && (!source || skill.source === source),
    );
    if (!name || candidates.length === 0) {
      return this.result(call, `No active local skill named ${name || '(empty)'}.`, true);
    }
    if (candidates.length > 1) {
      return this.result(
        call,
        `Skill ${name} has personal and project copies. Retry with source set explicitly.`,
        true,
      );
    }
    const skill = candidates[0];
    // SkillRevision carries both `instructions` (the rendered full-text
    // guidance) and `content` (the raw SKILL.md source). Prefer the rendered
    // instructions; fall back to raw content if instructions are empty.
    const full = skill.instructions?.trim() || skill.content || '';
    const content = full.slice(0, MAX_DETAIL_CHARS);
    // The full text now lives in this agent's context as a tool result. The
    // host records it so the skill feeder feeds this skill as a minimal
    // pointer instead of re-stuffing the same guidance on later turns. The
    // tracking is cleared when compaction, pruning, or a context shrink
    // removes the result from the live context.
    try {
      ctx.onSkillDetailLoaded?.(skill.name);
    } catch {
      // Tracking is an optimization, never a delivery failure.
    }
    return this.result(
      call,
      `# ${skill.name} (${skill.source})\nRevision: ${skill.hash}\n${content}${content.length < full.length ? '\n\n[Full detail truncated at the read-only tool limit.]' : ''}`,
      false,
    );
  }

  private result(call: ToolCallInput, output: string, isError: boolean): ToolCallOutput {
    return { callId: call.id, name: this.name, output, isError, durationMs: 0 };
  }
}

/**
 * Agent control over the skill feeder. The feeder recompiles skill guidance
 * into the system prompt every turn; this tool lets the agent see what is
 * being fed and refuse a skill it already ate or does not want ("no more
 * feeding of this skill"). Blocks are per chat: they last until the agent
 * unblocks them or the chat is deleted/erased. A block only stops the
 * automatic feeder; it never edits or disables the skill itself.
 */
export class ManageSkillFeedingTool implements Tool {
  readonly name = 'manage_skill_feeding';
  readonly role = 'any' as const;
  readonly description =
    'Control which skills the host feeds into your system prompt. Actions: report (list fed, ' +
    'blocked, and already-in-context skills), block (stop feeding one or more skills — they ' +
    'disappear from future turns unless a selected skill strictly requires one, which then ' +
    'stays a minimal stub), unblock (resume feeding). Use this when a skill keeps reappearing ' +
    'that you have already absorbed or that hurts the current task. Blocks are per chat: they ' +
    'last until you unblock the skill or the chat is deleted or erased.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['report', 'block', 'unblock'],
        description: 'What to do',
      },
      skills: {
        anyOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'string', description: 'One skill name, or a JSON array of names as a string' },
        ],
        description: 'Exact skill names (from the prompt manifest) for block/unblock',
      },
      reason: { type: 'string', description: 'Optional why, recorded in the report' },
    },
    required: ['action'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const fail = (output: string): ToolCallOutput => ({
      callId: call.id,
      name: this.name,
      output,
      isError: true,
      durationMs: 0,
    });
    if (!ctx.manageSkillFeeding) {
      return fail(
        'Skill feeding control is not available for this agent. Workers and Critics receive the skills their manager assigned.',
      );
    }
    try {
      return {
        callId: call.id,
        name: this.name,
        output: await ctx.manageSkillFeeding(call.input),
        isError: false,
        durationMs: 0,
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
}
