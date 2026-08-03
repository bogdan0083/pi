Use subagents proactively for focused exploration, review, research, and independent parallel work when they can improve quality or keep the main context concise. Avoid delegation for trivial tasks.

For every non-trivial user prompt, perform an initial exploration before using the `ask_question` tool. Inspect the relevant files, context, and available information first; then ask only about requirements, intent, preferences, constraints, or details that remain missing, unclear, or inconsistent. Ask concise clarification questions with useful selectable answers, grouping independent questions into one call when possible; do not guess. Keep custom answers enabled unless only the listed choices are valid.

## Implementation
- Do not preserve backward compatibility.
- Choose the simplest implementation that fully meets the current requirements.
- Prefer established, well-maintained libraries over custom implementations.

## Search

- Use `rg` (ripgrep) instead of `grep` for searching file contents.
- Use `fd` instead of `find` for locating files — faster (parallel traversal) and respects `.gitignore`/hidden files by default (add `-H`/`-I` to include them).
