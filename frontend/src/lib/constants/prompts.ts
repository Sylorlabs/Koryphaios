export type PromptTemplate = {
  id: 'prd' | 'bugfix' | 'refactor' | 'ship';
  label: string;
  content: string;
};

export const promptTemplates: PromptTemplate[] = [
  {
    id: 'prd',
    label: 'Insert PRD Template',
    content: `Build Spec
- Problem:
- Target user:
- Success metrics:

Requirements
- Must have:
- Nice to have:
- Out of scope:

Execution plan
- Milestone 1:
- Milestone 2:
- Milestone 3:

Open questions
- `,
  },
  {
    id: 'bugfix',
    label: 'Insert Bugfix Template',
    content: `Bug Report
- Expected:
- Actual:
- Repro steps:
- Environment:

Debug plan
- Suspected root cause:
- Verification steps:
- Regression risks:

Definition of done
- `,
  },
  {
    id: 'refactor',
    label: 'Insert Refactor Template',
    content: `Refactor Goal
- Why now:
- Scope:
- Constraints:

Current pain points
-

Refactor approach
- Architecture changes:
- Migration steps:
- Test strategy:

Acceptance criteria
- `,
  },
  {
    id: 'ship',
    label: 'Insert Ship Checklist',
    content: `Ship Checklist
- Feature complete
- Tests passing
- Edge cases reviewed
- Docs updated
- Monitoring/alerts defined
- Rollback plan prepared

Release notes
- `,
  },
];
