import { DELIVERY_SKILL_PLAYBOOKS } from './skill-playbook-delivery';
import { EXPERIENCE_SKILL_PLAYBOOKS } from './skill-playbook-experience';
import { FOUNDATION_SKILL_PLAYBOOKS } from './skill-playbook-foundations';
import { RESEARCH_RISK_SKILL_PLAYBOOKS } from './skill-playbook-research-risk';
import { SPECIALIST_SKILL_PLAYBOOKS } from './specialist-skill-definitions';

/**
 * Long-form practice is deliberately separate from selection metadata. The
 * resolver loads only the chosen skill's playbook, never an entire discipline.
 */
export const SKILL_PLAYBOOKS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(FOUNDATION_SKILL_PLAYBOOKS).map(([name, content]) => [
      name,
      `## Professional practice\n\n${content}`,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(EXPERIENCE_SKILL_PLAYBOOKS).map(([name, playbook]) => [
      name,
      `## Professional practice\n\n${playbook.content}`,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(DELIVERY_SKILL_PLAYBOOKS).map(([name, content]) => [
      name,
      `## Professional practice\n\n${content}`,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(RESEARCH_RISK_SKILL_PLAYBOOKS).map(([name, playbook]) => [
      name,
      `## ${playbook.title}\n\n${playbook.body}`,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(SPECIALIST_SKILL_PLAYBOOKS).map(([name, content]) => [
      name,
      `## Professional practice\n\n${content}`,
    ]),
  ),
};

export function skillPlaybook(name: string): string {
  return SKILL_PLAYBOOKS[name] ?? '';
}
