Use `rg` (ripgrep) via the Bash tool for filename and content searches. Do not use the built-in `grep` tool or shell `grep`.

For every non-trivial user prompt, perform an initial exploration before using the `ask_question` tool. Inspect the relevant files, context, and available information first; then ask only about requirements, intent, preferences, constraints, or details that remain missing, unclear, or inconsistent. Ask concise clarification questions with useful selectable answers, grouping independent questions into one call when possible; do not guess. Keep custom answers enabled unless only the listed choices are valid.

## Subagents

Available subagents:
- `explore` — read-only codebase exploration and file search
- `advisor` — technical advice, review, and completion checks
- `foquz-browser` — Foquz browser automation
- `web-search` — read-only web research


Invoke one agent with `{ "agent": "name", "task": "...", "acceptance": "none" }`. For independent tasks, prefer one parallel call with `{ "tasks": [{ "agent": "name", "task": "...", "acceptance": "none" }] }` instead of sequential calls. Use `acceptance: "none"` for subagent runs unless the user explicitly requests another acceptance policy. Use `async: true` only for independent background work; use the `wait` tool when the current turn must wait for completion. Keep a single writer for each working directory.
