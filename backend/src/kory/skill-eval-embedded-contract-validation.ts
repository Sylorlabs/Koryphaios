import { skillEvaluationV5ContractHash } from './skill-eval-contract-hash';
import type { CurrentV5SkillEvaluationContract } from './skill-eval-current-contract';
import type { EmbeddedCurrentV5SkillEvaluationContracts } from './skill-eval-embedded-contracts';
import type { V5CompiledSkillPackage } from './skill-packages';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isIdentityList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isIdentity) &&
    new Set(value).size === value.length
  );
}

function isEmbeddedContracts(value: unknown): value is EmbeddedCurrentV5SkillEvaluationContracts {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.contractVersion) ||
    (value.contractVersion as number) <= 0 ||
    !Array.isArray(value.packages)
  )
    return false;
  const packageNames = new Set<string>();
  for (const pkg of value.packages) {
    if (
      !isRecord(pkg) ||
      !isIdentity(pkg.packageName) ||
      !isIdentity(pkg.packageVersion) ||
      !Array.isArray(pkg.tasks) ||
      packageNames.has(pkg.packageName)
    )
      return false;
    packageNames.add(pkg.packageName);
    const taskIds = new Set<string>();
    for (const task of pkg.tasks) {
      if (
        !isRecord(task) ||
        !isIdentity(task.taskId) ||
        taskIds.has(task.taskId) ||
        typeof task.evaluationContractHash !== 'string' ||
        !/^[a-f0-9]{16}$/.test(task.evaluationContractHash) ||
        !isIdentityList(task.materializerIds) ||
        !isIdentityList(task.scorerIds)
      )
        return false;
      taskIds.add(task.taskId);
    }
  }
  return true;
}

/** Missing/malformed/stale embedded metadata never supplies evidence authority. */
export function currentEmbeddedV5SkillEvaluationContracts(
  skillPackage: V5CompiledSkillPackage,
  contractVersion: number,
  embedded: unknown,
): ReadonlyMap<string, CurrentV5SkillEvaluationContract> {
  const contracts = new Map<string, CurrentV5SkillEvaluationContract>();
  if (!isEmbeddedContracts(embedded) || embedded.contractVersion !== contractVersion)
    return contracts;
  const pkg = embedded.packages.find((item) => item.packageName === skillPackage.sidecar.name);
  if (!pkg || pkg.packageVersion !== skillPackage.sidecar.version) return contracts;
  const currentTasks = new Map(skillPackage.evaluation.tasks.map((task) => [task.id, task]));
  for (const task of pkg.tasks) {
    const scenario = currentTasks.get(task.taskId);
    if (!scenario) return new Map();
    const evaluationContractHash = skillEvaluationV5ContractHash({
      contractVersion,
      skill: skillPackage.sidecar.name,
      packageVersion: skillPackage.sidecar.version,
      scenario,
      materializerIds: task.materializerIds,
      scorerIds: task.scorerIds,
    });
    if (evaluationContractHash !== task.evaluationContractHash) return new Map();
    contracts.set(
      task.taskId,
      Object.freeze({
        evaluationContractVersion: contractVersion,
        evaluationContractHash,
        materializerIds: Object.freeze([...task.materializerIds]),
        scorerIds: Object.freeze([...task.scorerIds]),
      }),
    );
  }
  return contracts;
}
