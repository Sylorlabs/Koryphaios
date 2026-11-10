export const NOTE_WORKSPACE_TEMPLATES = [
  {
    id: 'research',
    label: 'Research investigation',
    title: 'Research investigation',
    tags: ['research'],
    content:
      '---\nstatus: open\n---\n# Research investigation\n\n## Question\n\n## Sources and evidence\nRecord source notes and revisions; distinguish observations from hypotheses.\n\n## Findings\n\n## Contradictions and uncertainty\n\n## Open questions\n\n## Next steps\n',
  },
  {
    id: 'decision',
    label: 'Architecture decision',
    title: 'Architecture decision',
    tags: ['decision'],
    content:
      '---\nstatus: proposed\n---\n# Architecture decision\n\n## Context\n\n## Options\n\n## Decision\n\n## Evidence and trade-offs\n\n## Consequences\n\n## Revisit when\n',
  },
  {
    id: 'bug',
    label: 'Bug investigation',
    title: 'Bug investigation',
    tags: ['bug', 'investigation'],
    content:
      '---\nstatus: open\n---\n# Bug investigation\n\n## Observed behavior\n\n## Expected behavior\n\n## Reproduction\n\n## Evidence\n\n## Root cause\n\n## Repair\n\n## Verification\nSeparate executed checks from proposed checks.\n\n## Remaining risks\n',
  },
  {
    id: 'handoff',
    label: 'Project handoff',
    title: 'Project handoff',
    tags: ['handoff'],
    content:
      '---\nstatus: draft\n---\n# Project handoff\n\n## Objective\n\n## Current state\n\n## Decisions and source notes\n\n## Changes\n\n## Verified checks\n\n## Blockers and uncertainty\n\n## Next steps\n',
  },
] as const;
