---
name: commit-messages
description: Write commit messages for Foquz projects using Russian Redmine task titles and numbered fix references. Use only when preparing commits in Foquz repositories.
---

- Apply only to Foquz projects; use `foquz-projects-overview` if ownership is unclear.
- Write commit messages in Russian, without feat/fix/chore prefixes.
- Format: `NNNN Exact Redmine task title`.
- For fixes, append `. Доработки.` (avoid duplicating an existing period).
- For numbered fixes, append `п1, п3, п7`. Use `п1-10` only if every item in that range is fixed.
- Reference only fixes included in this commit, not fixes made elsewhere.
- Get the task ID and exact title from Redmine; use the `redmine` skill as needed. Do not substitute the branch number for the task ID.
- Ask if the task is unknown. Use an explicitly supplied commit message verbatim.

Example: `6735 Фронтенд. Переводы в новом интерфейсе. Доработки. п23-26, п30`
