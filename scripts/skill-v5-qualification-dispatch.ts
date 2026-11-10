import type { SkillInfrastructureFailure } from '../backend/src/kory/skill-evaluations';

export function qualificationInfrastructureStatus(
  withSkillFailure: SkillInfrastructureFailure | undefined,
  withoutSkillFailure: SkillInfrastructureFailure | undefined,
) {
  return {
    withSkillInfrastructureFailure: Boolean(withSkillFailure),
    withoutSkillInfrastructureFailure: Boolean(withoutSkillFailure),
    infrastructureFailure: Boolean(withSkillFailure || withoutSkillFailure),
    detail: [
      withSkillFailure ? `with-skill: ${withSkillFailure.detail}` : null,
      withoutSkillFailure ? `without-skill: ${withoutSkillFailure.detail}` : null,
    ]
      .filter(Boolean)
      .join(' | '),
  };
}

/** Stop new dispatches after a terminal provider failure; in-flight pairs still persist. */
export class QualificationDispatch {
  private cursor = 0;
  stopReason: string | null = null;

  constructor(readonly total: number) {}

  take(): number | undefined {
    if (this.stopReason !== null || this.cursor >= this.total) return undefined;
    return this.cursor++;
  }

  observe(failures: readonly (SkillInfrastructureFailure | undefined)[]): void {
    const terminal = failures.find((failure) => failure?.kind === 'provider' && !failure.retryable);
    if (terminal && this.stopReason === null) this.stopReason = terminal.detail;
  }

  get notStarted(): number {
    return this.total - this.cursor;
  }
}
