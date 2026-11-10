# Factual research full-task gate

The two individual fixtures in this package are public web exercises. They require a real retrieval run and do not ship copied answers. The task packets in `evals/tasks/` define the environment, source-of-record boundary, hierarchy boundary, negative or interruption path, recovery requirement, and required artifacts.

## Gates

| Gate                 | Observable requirement                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment          | Record the UTC run date, starting URL, scope, and source access result.                                                                                                   |
| Source provenance    | Retrieve the declared HTTPS sources, preserve exact URLs, status, recent UTC timestamps, raw response SHA-256 values, last-modified values, and verbatim excerpts.        |
| Claim verification   | Map each material finding to the independently retrieved source bytes and the applicable date or version. Corroborate consequential claims where the fixture requires it. |
| Failure and recovery | Demonstrate the required blocked or negative behavior and a recovery request or interaction. A controlled outage is a negative control, not live recovery evidence.       |
| Pairing and review   | Same-model skill and no-skill pairing plus blind semantic review remain outer harness responsibilities. They are not established by a candidate report.                   |

The runtime scorer refetches sources independently. It fails closed for an unavailable source, changed response bytes, stale report timestamps, wrong response identity, missing excerpts, or unsupported findings. It labels controlled transports as noncertifying test evidence.

## Reproducibility boundary

Use `research.json` for structured provenance and `result.md` plus `verification.md` for the readable verdict and failure or recovery account. Do not edit the immutable `research-task.json` or `README.md` materialized for a run. Do not copy a prior response, claim a live run without performing it, or replace an inaccessible source with a snippet, mirror, generated body, or assumed current result.

For the historical `research` full-task fixtures, use `skills-v5/research/evals/README.md` and `snapshot-corpus.ts`. Those fixtures remain blocked until every required source role has genuine archive or Git provenance. Controlled test transports exercise rejection logic only and never certify dated source history.
