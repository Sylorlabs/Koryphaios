import { listSkills, renderSkillInstructions, type SkillSource } from '../kory/skills';
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
    const full = renderSkillInstructions(skill, 'full');
    const content = full.slice(0, MAX_DETAIL_CHARS);
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
