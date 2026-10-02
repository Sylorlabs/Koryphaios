import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { PromptManifest, PromptRole, TaskContract } from './prompts';
import type { ResolvedSkill } from './skills';

const skillNames = z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/));

export const SkillAssignmentSchema = z
  .object({
    worker: skillNames.default([]),
    critic: skillNames.default([]),
  })
  .strict();

export type SkillAssignment = z.infer<typeof SkillAssignmentSchema>;

/** Copy at the delegation boundary so retries cannot mutate the manager's assignment. */
export function normalizeSkillAssignment(value: unknown = {}): SkillAssignment {
  const assignment = SkillAssignmentSchema.parse(value);
  return {
    worker: [...new Set(assignment.worker)],
    critic: [...new Set(assignment.critic)],
  };
}

export interface DeliveredSkill {
  name: string;
  version: string;
  source: string;
  hash: string;
  assigned: boolean;
  representation: ResolvedSkill['representation'];
  promptText: string;
  promptTextHash: string;
}

/** Receipt for instructions supplied to a provider, not proof that it followed them. */
export interface SkillDeliveryEvidence {
  schemaVersion: 1;
  role: PromptRole;
  promptManifestHash: string;
  taskContractHash: string;
  requiredSkills: string[];
  skills: DeliveredSkill[];
  hash: string;
}

export interface SkillReviewContext {
  taskContract: TaskContract;
  delivery?: SkillDeliveryEvidence;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function createSkillDeliveryEvidence(
  manifest: PromptManifest,
  selected: ResolvedSkill[],
  requiredSkills: string[],
): SkillDeliveryEvidence {
  const receipt = {
    schemaVersion: 1 as const,
    role: manifest.role,
    promptManifestHash: manifest.hash,
    taskContractHash: manifest.taskContractHash,
    requiredSkills: [...requiredSkills],
    skills: selected.map(({ skill, representation, promptText }) => ({
      name: skill.name,
      version: skill.metadata.version,
      source: skill.source,
      hash: skill.hash,
      assigned: requiredSkills.includes(skill.name),
      representation,
      promptText,
      promptTextHash: sha256(promptText),
    })),
  };
  return { ...receipt, hash: sha256(JSON.stringify(receipt)) };
}

export function validateSkillDeliveryEvidence(
  evidence: SkillDeliveryEvidence,
  contract: TaskContract,
): boolean {
  const { hash, ...receipt } = evidence;
  const names = evidence.skills.map((skill) => skill.name);
  return (
    evidence.schemaVersion === 1 &&
    evidence.role === 'worker' &&
    evidence.taskContractHash === sha256(JSON.stringify(contract)) &&
    hash === sha256(JSON.stringify(receipt)) &&
    names.length === new Set(names).size &&
    evidence.requiredSkills.length === new Set(evidence.requiredSkills).size &&
    evidence.requiredSkills.every((name) => names.includes(name)) &&
    (contract.skillAssignment?.worker ?? []).every((name) =>
      evidence.requiredSkills.includes(name),
    ) &&
    evidence.skills.every(
      (skill) => skill.assigned === evidence.requiredSkills.includes(skill.name),
    ) &&
    evidence.skills.every((skill) => skill.promptTextHash === sha256(skill.promptText))
  );
}

/** Store outside the worker worktree; only the host supplies this receipt to reviewers. */
export function persistSkillDeliveryEvidence(
  projectRoot: string,
  agentId: string,
  evidence: SkillDeliveryEvidence,
): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new Error('Invalid skill delivery agent id');
  const directory = join(projectRoot, '.koryphaios', 'skills', 'delivery');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${agentId}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}
