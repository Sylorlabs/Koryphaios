# Staged blind review: data-visualization

Status: staged, not ingested. Ledger persistence belongs to the coordinator.

- assignmentId: blind-v5-05bdd1ead4ed64d4c92a
- skill: data-visualization
- scenarioId: data-visualization-full-task-1-individual
- pairId: data-visualization-full-task-1-individual:9beb8e91-0ab1-4fa0-a8f2-cd1ca95be529
- reviewerAdapter: scripts/kory-logfare-stateless-reviewer
- reviewerModel: deepseek-v4.1-flash-1017
- reviewerThread: logfare-stateless-e058c6ab-290d-409e-b2e5-803bee1baedb
- verdict: {"artifactA":{"passed":false,"quality":0.55,"verification":0.3},"artifactB":{"passed":true,"quality":0.85,"verification":0.8},"preference":"B"}
- producer: scripts/run-skill-v5-blind-review-campaign.ts --skill=data-visualization --concurrency=1
- produced: 2026-11-08T04:05:06.519Z

Files: `import.json` (envelope the importer consumes), `review-attestation.json`,
`reviewer-events.json`, `review-task.prompt.txt` (sealed prompt snapshot), and the
completing reviewer result text.

The reviewer route reports identity and isolation as unverified by design
(`stageOnlyAttemptAllowed`). Coordinator qualification is required before ingestion.
