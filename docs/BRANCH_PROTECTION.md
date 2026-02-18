# Branch Protection Setup

Apply this to the default branch (`main`) in GitHub:

1. Go to `Settings` -> `Branches` -> `Add branch protection rule`.
2. Branch name pattern: `main`.
3. Enable `Require a pull request before merging`.
4. Enable `Require approvals` and set at least `1`.
5. Enable `Dismiss stale pull request approvals when new commits are pushed`.
6. Enable `Require status checks to pass before merging`.
7. Add required status check: `check` (from `.github/workflows/ci.yml` job name).
8. Enable `Require branches to be up to date before merging`.
9. Enable `Require conversation resolution before merging`.
10. Enable `Do not allow bypassing the above settings`.
11. Save changes.

## Notes

- CI gate is defined in `.github/workflows/ci.yml`.
- The `check` status runs:
  - backend TypeScript typecheck
  - frontend Svelte check with `--fail-on-warnings`
