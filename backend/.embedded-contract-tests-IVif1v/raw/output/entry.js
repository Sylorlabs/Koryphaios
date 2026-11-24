// @bun
// backend/src/eval/skills/skill-eval-current-contract.ts
import { createRequire } from "module";
import { sep } from "path";

// backend/src/eval/skills/skill-eval-contract-hash.ts
import { createHash } from "crypto";
var PUBLIC_WEB_EXECUTION_NETWORK_POLICY = "codex-public-web-https-v1";
function skillEvaluationV5ContractHash(input) {
  const payload = {
    contractVersion: input.contractVersion,
    skill: input.skill,
    packageVersion: input.packageVersion,
    scenario: input.scenario,
    materializerIds: [...input.materializerIds].sort(),
    scorerIds: [...input.scorerIds].sort(),
    ...input.scenario.environment.kind === "public-web" ? { executionNetworkPolicy: PUBLIC_WEB_EXECUTION_NETWORK_POLICY } : {}
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

// backend/src/eval/skills/skill-eval-embedded-contracts.ts
var EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS = null;

// backend/src/eval/skills/skill-eval-embedded-contract-validation.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
function isIdentityList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isIdentity) && new Set(value).size === value.length;
}
function isEmbeddedContracts(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.contractVersion) || value.contractVersion <= 0 || !Array.isArray(value.packages))
    return false;
  const packageNames = new Set;
  for (const pkg of value.packages) {
    if (!isRecord(pkg) || !isIdentity(pkg.packageName) || !isIdentity(pkg.packageVersion) || !Array.isArray(pkg.tasks) || packageNames.has(pkg.packageName))
      return false;
    packageNames.add(pkg.packageName);
    const taskIds = new Set;
    for (const task of pkg.tasks) {
      if (!isRecord(task) || !isIdentity(task.taskId) || taskIds.has(task.taskId) || typeof task.evaluationContractHash !== "string" || !/^[a-f0-9]{16}$/.test(task.evaluationContractHash) || !isIdentityList(task.materializerIds) || !isIdentityList(task.scorerIds))
        return false;
      taskIds.add(task.taskId);
    }
  }
  return true;
}
function currentEmbeddedV5SkillEvaluationContracts(skillPackage, contractVersion, embedded) {
  const contracts = new Map;
  if (!isEmbeddedContracts(embedded) || embedded.contractVersion !== contractVersion)
    return contracts;
  const pkg = embedded.packages.find((item) => item.packageName === skillPackage.sidecar.name);
  if (!pkg || pkg.packageVersion !== skillPackage.sidecar.version)
    return contracts;
  const currentTasks = new Map(skillPackage.evaluation.tasks.map((task) => [task.id, task]));
  for (const task of pkg.tasks) {
    const scenario = currentTasks.get(task.taskId);
    if (!scenario)
      return new Map;
    const evaluationContractHash = skillEvaluationV5ContractHash({
      contractVersion,
      skill: skillPackage.sidecar.name,
      packageVersion: skillPackage.sidecar.version,
      scenario,
      materializerIds: task.materializerIds,
      scorerIds: task.scorerIds
    });
    if (evaluationContractHash !== task.evaluationContractHash)
      return new Map;
    contracts.set(task.taskId, Object.freeze({
      evaluationContractVersion: contractVersion,
      evaluationContractHash,
      materializerIds: Object.freeze([...task.materializerIds]),
      scorerIds: Object.freeze([...task.scorerIds])
    }));
  }
  return contracts;
}

// backend/src/eval/skills/skill-eval-current-contract.ts
var isExternalEnvironmentPlaceholder = (id) => id.includes("/external-environment-gate");
function currentV5SkillEvaluationContracts(skillPackage, contractVersion) {
  const contracts = new Map;
  const requireRegistry = createRequire(import.meta.url);
  const registrySpecifier = `.${sep}skill-eval-fixtures`;
  let registryPath;
  try {
    registryPath = requireRegistry.resolve(registrySpecifier);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "MODULE_NOT_FOUND") {
      return currentEmbeddedV5SkillEvaluationContracts(skillPackage, contractVersion, EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS);
    }
    return contracts;
  }
  let registry;
  try {
    registry = requireRegistry(registryPath);
  } catch {
    return contracts;
  }
  const registryEntries = Object.entries(registry);
  const materializers = registryEntries.find(([key]) => key.startsWith("BUILTIN_SKILL_EVAL_") && key.endsWith("MATERIALIZERS"))?.[1];
  const scorers = registryEntries.find(([key]) => key.startsWith("BUILTIN_SKILL_EVAL_") && key.endsWith("SCORERS"))?.[1];
  if (!Array.isArray(materializers) || !Array.isArray(scorers))
    return contracts;
  const materializerRegistry = materializers;
  const scorerRegistry = scorers;
  for (const task of skillPackage.evaluation.tasks) {
    const scenario = {
      ...task,
      skill: skillPackage.sidecar.name,
      category: "full-task",
      expectedSelection: true,
      expectedSkills: [],
      forbiddenSkills: [],
      heldOut: true,
      adjacentSkills: [],
      tags: ["held-out", "full-task"]
    };
    const matched = materializerRegistry.filter((item) => item.matches(scenario));
    const materializerIds = matched.map((item) => item.id).sort();
    const declaringMatchers = matched.some((item) => !isExternalEnvironmentPlaceholder(item.id)) ? matched.filter((item) => !isExternalEnvironmentPlaceholder(item.id)) : matched;
    const readinessBlockers = [...new Set(declaringMatchers.flatMap((item) => {
      const declared = typeof item.readinessBlockers === "function" ? item.readinessBlockers() : item.readinessBlockers;
      return (declared ?? []).filter((entry) => typeof entry === "string" && entry.trim().length > 0);
    }))].sort();
    const scorerIds = scorerRegistry.filter((item) => item.scenarioIds.includes(task.id)).map((item) => item.id).sort();
    if (!materializerIds.length || !scorerIds.length)
      continue;
    contracts.set(task.id, {
      evaluationContractVersion: contractVersion,
      evaluationContractHash: skillEvaluationV5ContractHash({
        contractVersion,
        skill: skillPackage.sidecar.name,
        packageVersion: skillPackage.sidecar.version,
        scenario: task,
        materializerIds,
        scorerIds
      }),
      materializerIds,
      scorerIds,
      ...readinessBlockers.length ? { readinessBlockers } : {}
    });
  }
  return contracts;
}
export {
  currentV5SkillEvaluationContracts,
  EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS
};
