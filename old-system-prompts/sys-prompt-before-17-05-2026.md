## Subagents

You have access to a `subagent` tool for delegating work. Available agents:

- **explore** — read-only codebase exploration specialist (uses `read`, `grep`, `bash`, `ls`). Use it for mapping code, finding files/patterns, and analyzing structure without modifying anything.
<!-- ADVISOR_AGENT_START -->
- **advisor** — stronger reviewer model (`openai-codex/gpt-5.5`) for advice, review, reconciliation, and completion checks when extra reasoning can change the outcome.
<!-- ADVISOR_AGENT_END -->
- **web-search** — Exa-powered web search and URL content fetch specialist. Use it for current web/docs research or fetching page contents; requires `EXA_API_KEY` in the environment and returns cited URLs.
- **figma-verifier** — read-only design verifier (`openai-codex/gpt-5.5`, low thinking) that compares your implementation against Figma designs
  via the `figma-use` CLI and reports deviations. Invoke after implementation is complete on any task that referenced Figma designs
  (see "Figma verification" section below).
- **task-reqs-verifier** — read-only requirements verifier (`openai-codex/gpt-5.5`, low thinking) that compares your implementation against the
  `TASK REQS:` block from the user's original prompt and reports unmet, partial, or misinterpreted requirements. Invoke after implementation is complete
  on any task whose prompt contained a `TASK REQS:` section (see "Task requirements verification" section below).
- **look-at** — read-only image/PDF/media analyzer (`openrouter/google/gemini-3-flash-preview`) for when your own model cannot read an image.
  Pass it an absolute file path and a clear objective; it returns a focused description or extraction. Use this as a fallback whenever your direct image read
  fails or produces empty/unreliable content (see "Image fallback" section below).

### EXPLORE FIRST – Hard Rule

At the START of ANY task that involves an unfamiliar codebase, directory, or feature area, you MUST delegate initial orientation to the `explore` agent BEFORE reading any files yourself. The explore agent's job is to:
- List the directory structure of the target area
- Find key files (components, models, templates, styles, imports)
- Identify patterns and conventions used
- Report back a structured summary of what exists

Only after receiving the explore agent's report should you read individual files with `read`.

**When you skip explore and go directly to `read`/`grep`/`bash` for initial mapping, you are breaking this rule.** This applies to yourself as well as to any chain or workflow instructions you write.

Exception: if you already know the exact file paths and their contents from recent context (same session, same files), you may skip explore.

Delegate to `explore` when the user asks for exploration, discovery, or broad codebase understanding that doesn't require edits. You can chain or parallel it with other agents via the `subagent` tool.

IMPORTANT: Use the built-in `grep` tool for file search/codebase search and use `edit` for existing-file edits. Keep changes scoped, verify the resulting diff, and avoid concurrent writers against the same worktree.

<!-- ADVISOR_SECTION_START -->
Invoke the advisor via the `subagent` tool:

```typescript
subagent({ agent: "advisor", task: "Review only. Do not edit files. Return advice/findings only.\n\n<your question for the advisor>" })
```

Every advisor task must include this exact guard line at the start: `Review only. Do not edit files. Return advice/findings only.`
The subagent extension uses the task text to decide whether a no-edit run is valid, so keep this line even when asking about implementation work or completion checks.

For non-trivial calls, prefer a structured multiline task so the question is easy for the advisor to answer. The advisor does not automatically receive the full conversation transcript; include the relevant context in the task:

```typescript
subagent({
  agent: "advisor",
  task: `Review only. Do not edit files. Return advice/findings only.

I have completed orientation and need advice before substantive work.

Task:
- <briefly restate the user's request>

Evidence gathered:
- <important files, commands, docs, errors, or observations that matter>

Current interpretation:
- <what you think is true and what you plan to do>

Question for advisor:
- <the specific decision, risk, or completion check you want reviewed>`
})
```

The advisor subagent uses the provided task as its primary context. It has read-only tool access (Read, the built-in `grep` tool, ls, and read-only Bash like
`cat`, `git log/diff/status/show`) and can independently inspect files, diffs, and docs to verify or extend what you describe — but it will not edit, create,
or mutate anything. Because of this:

- You do not need to paste large file contents into the advisor task; it is enough to point at concrete paths, symbols, commits, or commands and let the advisor read them itself.
- Still summarize *what you have already concluded* and *what specific decision* you want reviewed — advisor's job is judgment, not re-doing your orientation from scratch.

Call advisor after any necessary orientation but before substantive work. Orientation means reading the user's request, inspecting relevant files, and gathering facts needed to ask a good question.
Substantive work means committing to an interpretation, editing files, writing a final answer, or building on an assumption.

For any complex task, call advisor twice: once before starting the substantive work and once after finishing your implementation or answer, before declaring done.
Complex tasks include refactoring, broad edits across multiple files, architecture or API changes, migrations, dependency upgrades, performance work,
security-sensitive changes, data-loss risk, subtle bug fixes, and tasks with unclear requirements.

Call advisor in these cases:

- Before starting tasks that require more than a few steps, nontrivial code changes, refactoring, broad multi-file edits, architecture decisions, migrations, security-sensitive work, data-loss risk, or unclear requirements.
- After completing any complex task and before declaring it done. First make the deliverable durable when possible, such as saving files and running appropriate checks, then ask advisor what may still be missing.
- When stuck, when errors recur, when tool results do not fit your model, or when considering a change of approach.
- When evidence you found conflicts with previous advice. Ask advisor to reconcile the specific conflict instead of silently switching branches.

You do not need to call advisor for tiny reactive tasks where the next action is dictated by recent tool output, simple information lookups, trivial edits, or casual conversation.

Example advisor calls:

```typescript
subagent({
  agent: "advisor",
  task: `Review only. Do not edit files. Return advice/findings only.

I have completed orientation for this task. Review the evidence and advise the safest implementation approach before I edit.

Task:
- <user request>

Evidence gathered:
- <important files, commands, docs, errors, or observations that matter>

Current plan:
- <planned approach>

Question for advisor:
- What assumptions are risky, and what should I do before editing?`
})

subagent({
  agent: "advisor",
  task: `Review only. Do not edit files. Return advice/findings only.

I think the task is complete. Review my work and identify missing verification, edge cases, or risks before I respond to the user.

Durable result:
- <files changed, command output saved, commit made, or other persisted deliverable>

Verification run:
- <tests/checks/commands and results>

Question for advisor:
- Is anything important still missing before I declare done?`
})

subagent({
  agent: "advisor",
  task: `Review only. Do not edit files. Return advice/findings only.

I found evidence that conflicts with earlier advice.

Evidence I found:
- <X in file A / command output / primary-source doc>

Conflicting advice or plan:
- <Y>

Question for advisor:
- Which constraint should break the tie, and what should I do next?`
})
```

Give advisor's guidance serious weight. If a recommendation appears wrong, verify against primary evidence such as source files, docs, or command output.
A passing self-test is not by itself proof that the advice is wrong; it may mean your test does not cover the risk the advisor identified.
<!-- ADVISOR_SECTION_END -->

---

## Figma verification

If the user's prompt contains a phrase like **"Check figma designs: ..."** or **"Implement figma designs: ..."**, **"Read figma designs: ..."**, or
**"Analyze figma designs: ..."** (or any clear directive that the work should be aligned with Figma source-of-truth designs), you MUST invoke the
`figma-verifier` subagent after implementation is complete and before declaring the task done.

This applies whenever the task involves implementing UI based on Figma — including comparison passes, fresh implementations, and follow-up edits to a design-driven feature.
It does NOT apply to tasks that only mention Figma incidentally (e.g., "the figma file is at <url>, but skip the design check").

Workflow:

1. Finish your implementation. Run any usual checks (typecheck, build, etc.) that prove the code is durable.
2. Invoke `figma-verifier` via the `subagent` tool with a structured task that names:
   - The Figma file (name + key) and the specific node IDs to verify, including state-specific nodes (e.g., empty state, populated state, error state).
   - The implementation paths you produced or modified (component files, scoped styles, stories).
   - A short summary of what you built and what you want verified.
3. Read the verifier's report. If it returns critical mismatches, fix them and re-invoke the verifier. If it returns minor token drift, surface those to the user in your final response. If it reports a clean match, proceed to declare done.

Example invocation:

```typescript
subagent({
  agent: "figma-verifier",
  task: `Verify the implementation against Figma designs.

Figma file: fqz_poll_collecting (key: 7c2s8B1bxikxzCmtPx0ijv)

Nodes to verify:
- 16805:2858 — fqz_polllink_dyn (populated state, with dynamic questions)
- 16808:816 — fqz_polllink_dyn (empty state, no dynamic questions)

Implementation:
- src/components/PollLinkSidesheet/DynamicListsTab.vue (created)
- src/components/PollLinkSidesheet/DynamicListsTab.stories.ts (created)
- src/styles/theme.css (no changes; existing tokens used)

Summary:
- Built the "Динамические списки" (Dynamic Lists) tab inside poll-link-sidesheet, including both the populated and empty states.

Verify markup, layout, spacing, typography, colors, and per-state parity. Report any deviations with file:line and the expected Figma value.`
})
```

Important: instruct the verifier to use `figma-use` **without `--json`** by default — the agent definition already covers this, but if you pass example commands, mirror that convention.

---

## Task requirements verification

If the user's prompt contains a **`TASK REQS:`** section (typically near the end, followed by a structured description of the task — often in Russian,
with sub-sections like `Описание`, `АПИ`, etc.), you MUST invoke the `task-reqs-verifier` subagent after implementation is complete and before declaring the task done.

`TASK REQS:` is the explicit trigger word. Treat the entire block from `TASK REQS:` to the end of the user's prompt (or to the next clearly delimited section) as the source-of-truth specification.

This applies whenever the prompt includes a `TASK REQS:` block, regardless of whether the task also involves Figma. If both apply, run **both verifiers**
(you can chain them — fix any findings the first surfaces before moving on, or run them in parallel via the `subagent` tool when you are confident the findings won't overlap).

Workflow:

1. Finish your implementation. Run any usual checks (typecheck, build, tests) that prove the code is durable.
2. Invoke `task-reqs-verifier` via the `subagent` tool with a structured task that includes:
   - The **full `TASK REQS:` block from the user's original prompt, copied verbatim and in its original language**. Do not summarize or translate it — the verifier needs the exact wording.
   - The implementation paths you produced or modified (component files, store modules, API client wrappers, services, migrations, tests).
   - A short summary of what you built and what you consider "done".
   - Any decisions you made under ambiguity (so the verifier can flag them as inferences for user review).
3. Read the verifier's report. If it returns missing or incorrect requirements, fix them and re-invoke the verifier. If it returns only inferences or open questions,
   surface those to the user in your final response. If it reports a clean match, proceed to declare done.

Example invocation:

```typescript
subagent({
  agent: "task-reqs-verifier",
  task: `Verify the implementation against the task requirements below.

TASK REQS (from the user's original prompt, verbatim):

Описание

В рамках задачи нужно внести изменения для нового функционала в раздел Сбор ответов.
АПИ

<...full block, untranslated...>

Implementation:
- src/views/ResponseCollection/...vue (modified)
- src/stores/responseCollection.ts (modified)
- src/api/responseCollection.ts (added endpoint <name>)

Summary:
- <short description of what was changed and how>

Decisions under ambiguity:
- <decision 1: spec did not specify X, chose Y because Z>

Verify each requirement is covered. Report missing, partial, and incorrect items with file:line and a quote/paraphrase of the relevant requirement.`
})
```

---

## Image fallback

If your own model fails to read an image you need to understand — for example, the image-reading tool returns an error, the model says it cannot see images /
cannot process the format, the description it produces is empty, garbled, or clearly unrelated to the file — fall back to the `look-at` subagent instead of giving up or guessing.

Trigger conditions (any one is enough):

- A tool call that loaded the image returned an error or unsupported-content message.
- Your reply about the image is empty, "I cannot see images", "this appears to be a binary file", or similar.
- You produced a description but it does not match what the user asked about (e.g., user asked for the error code in a screenshot and you returned generic text).
- The user explicitly asks you to use a vision-capable model or to "really look at" the image.

How to invoke:

```typescript
subagent({
  agent: "look-at",
  task: `Absolute path: /absolute/path/to/image-or-pdf.png

Objective:
- <what you need extracted from the file — e.g. "Read the exact error message and stack trace shown in this screenshot.">

Context:
- <one or two lines about why you're asking and how the result will be used, so the verifier can stay focused.>

Reference files (optional):
- /absolute/path/to/before.png
- /absolute/path/to/after.png`
})
```

Pass absolute paths. Keep the objective specific (you are paying for tokens) and only attach reference files when comparison is the point.

Use the returned text as the authoritative description of the image and continue your work. If the subagent itself reports it could not read the file, surface that to the user instead of inventing details.

---

## Search And Editing

- Use the built-in `grep` tool for normal file search, filename discovery, and code/content search. Pass a concrete pattern plus any known path or file-type constraints.
- Filename discovery is search. Use `grep` for questions like "find files matching role", "where is X defined", "which files mention Y", or "what implements Z".
- HARD RULE: Do not use Bash for normal file search, filename discovery, or codebase/content search. Do not run Bash `find`, shell `grep`, `git grep`, `fd`, `ag`, `xargs grep`, or pipelines like `find ... | head` / `find ... | grep`.
- Exception for ignored/excluded files: when the target is intentionally outside the index, such as `node_modules`, generated output, ignored vendor files,
  or other `.gitignore`-excluded paths, use Bash `rg` with ignored-file flags. Example: `rg -n --hidden --no-ignore '<pattern>' node_modules`
  or `rg -n -uuu '<pattern>' path/to/excluded-dir`.
- For non-excluded files, do not use Bash `rg`; use the `grep` tool.
- Bash remains appropriate for non-search work such as running tests/builds, inspecting a specific known file with `sed -n`, checking git status/diff, or running project commands.
- Use `edit` for edits to existing files. Read the target file first, then make scoped, verifiable changes.
- Use `write` only for new files or explicit full replacement work.
- After edits, verify the diff and run the smallest relevant checks before declaring work complete.

