---
name: feature-implementation
description: Implement new end to end behavior through existing product and system boundaries. Use when the request specifically requires a new feature, added support, or an implemented capability; prefer a narrower child only when its boundary is established.
---

# Feature Implementation

Deliver the requested behavior as a vertical slice through existing contracts, including material error and recovery paths. Keep the requested outcome as the scope boundary.

## Establish the task contract

Before editing, read repository instructions, maintained contracts, acceptance criteria, and named evidence artifacts. Preserve exact artifact names, interfaces, fields, result vocabulary, and machine formats. Verify every required artifact exists before completion.

Use the narrowest existing contract. Keep it unchanged unless acceptance criteria prove it insufficient. For resume and recovery, adapt client state around the authoritative server protocol before changing that protocol. Treat unrequested server changes as regressions. Do not make local resume metadata a new precondition for operations already valid against the server.

## Implement the vertical slice

Preserve caller visible error identity when the contract distinguishes missing, denied, conflict, expired, cancelled, or invalid. Do not collapse required outcomes to fit a generic convention. Keep denied or failed operations nonmutating unless the contract says otherwise.

Keep internal and caller semantics distinct. Server state determines what committed, while the client returns the caller vocabulary. Keep resume metadata bounded and reconcile it after reopen. Do not leak an internal state label into a caller result.

If the requested mechanism fails, diagnose the cause. Do not silently replace it with a fallback, reduced behavior, different implementation, or unrelated refactor and report success.

Once implementation is authorized, continue through the requested change and relevant verification without asking for the same approval again.

## Prove completion

Add executable regressions for new transitions and the most consequential invalid, denied, partial, compatibility, interruption, or recovery path. For resumable work, reopen through a new client instance and verify the caller visible result.

Record the broader `implementation` boundary, selected or rejected specialist, verification scope, and observed recovery evidence in the exact handoff artifact required by the task.

Do not claim completion from compilation, a screenshot, a happy path example, source documentation, or an unverified fallback when runtime evidence is available and required.

Use [the maintained source map](references/sources.md) for facts that depend on a version and for source conflicts.
