export interface ProseFinding {
  line: number;
  column: number;
  offset: number;
  character: string;
  codePoint: string;
}
export function lintProse(
  text: string,
  options?: { literals?: string[] },
): {
  findings: ProseFinding[];
  protectedCharacters: number;
  semanticReviewRequired: true;
};
