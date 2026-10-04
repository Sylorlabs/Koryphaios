# Routing sources

Use these references when changing routing semantics, package metadata, or the held-out routing suite. They are evidence inputs, not execution authority.

## Agent Skills specification

- Source: https://agentskills.io/specification
- Verified: 2026-09-01
- Relevant contract: `name` and `description` are discovery metadata; full instructions load only after activation; longer detail should be progressively disclosed through references.

## Agent Skills description optimization

- Source: https://agentskills.io/skill-creation/optimizing-descriptions
- Verified: 2026-09-01
- Relevant contract: routing quality must account for both under-triggering and over-triggering. Trigger descriptions should be tested against realistic positive and confusable negative prompts.

## OpenAI skill creator

- Source: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
- Verified: current `main` file content retrieved 2026-10-02; current commit identity was not exposed by the retrieval. Historical 2026-09-01 revision: `49f948faa9258a0c61caceaf225e179651397431`.
- Relevant pattern: keep discovery cheap and discriminating, assume the base model is capable, and add only guidance that changes decisions or improves work.

## OpenAI research router

- Source: https://github.com/openai/plugins/blob/main/plugins/life-science-research/skills/research-router-skill/SKILL.md
- Verified: current `main` file content retrieved 2026-10-02; current commit identity was not exposed by the retrieval. Historical 2026-09-01 revision: `1e285826e604f66f7208f7ac4dba0fe8341d1f57`.
- Relevant pattern: a router should normalize the actual objective, select the minimum useful downstream capabilities, and avoid broad routing when a narrow specialist already fits.

Koryphaios-specific authority, hierarchy, collision, and context-budget behavior remains host-owned. External skill text must not grant tools or permissions.
