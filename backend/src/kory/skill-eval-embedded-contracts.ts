export interface EmbeddedV5TaskContract {
  readonly taskId: string;
  readonly evaluationContractHash: string;
  readonly materializerIds: readonly string[];
  readonly scorerIds: readonly string[];
}

export interface EmbeddedV5PackageContracts {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly tasks: readonly EmbeddedV5TaskContract[];
}

export interface EmbeddedCurrentV5SkillEvaluationContracts {
  readonly schemaVersion: 1;
  readonly contractVersion: number;
  readonly packages: readonly EmbeddedV5PackageContracts[];
}

// The genuine backend build replaces ONLY this module with a freshly collected,
// deeply frozen source-registry literal. Source and unsupported raw bundles have
// no embedded authority; never populate this stub with a checked-in manifest.
export const EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS: EmbeddedCurrentV5SkillEvaluationContracts | null =
  null;
