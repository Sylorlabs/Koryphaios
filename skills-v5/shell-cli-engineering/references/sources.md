# Source map

Source curation for `shell-cli-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no skill or blind qualification.

## Adopted primary guidance

- **POSIX Shell Command Language**: https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html
  - Adopted: expansion order, field splitting, pathname expansion, quoting, pipeline status, and command exit status are observable script interfaces.
  - Conditional: these are POSIX rules. Bash and Zsh extensions require their own manuals and an explicit shell contract.
  - Limit: POSIX portability does not guarantee identical behavior from non-POSIX platform utilities or shell extensions.
- **POSIX.1-2024 index**: https://pubs.opengroup.org/onlinepubs/9799919799/
  - Preserved use: process, signal, utility, stream, and portability reference discovery.
  - Limit: the index alone is not evidence for a specific shell expansion or exit-status rule.

The real non-interactive invocation controls PATH, startup files, TTY presence, working directory, and environment. Interactive success cannot establish automation behavior.
