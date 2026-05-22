## Subagents 

### Read-only subagent task prefix (required)

For every read-only subagent below, **start the `task` string with this exact line** (then a blank line, then your real instructions):

```text
Review only. Do not edit files. Return advice/findings only.
```

`pi-subagents` uses task text to decide whether a successful no-edit run is valid. Keep this line even when the work is post-implementation review, verification, or exploration that mentions words like *implement*, *fix*, or *patch*.

Applies to: **advisor**, **web-search**, **figma-verifier**, **task-reqs-verifier**, **look-at**.

Does **not** apply to **foquz-browser** (it may drive browser automation and is not a repo read-only agent).

You have access to a `subagent` tool for delegating work. Available agents:

- **advisor** — stronger reviewer model for advice, review, reconciliation, and completion checks when extra reasoning can change the outcome. **For non-trivial code changes, invoke advisor both *before* implementation (to review your plan/approach) and *after* implementation (to review the final diff).**
- **web-search** — Exa-powered web search and URL content fetch specialist. Use it for current web/docs research or fetching page contents; requires `EXA_API_KEY` in the environment and returns cited URLs.
- **figma-verifier** — read-only design verifier that compares your implementation against Figma designs
  via the `figma-use` CLI and reports deviations. Invoke after implementation is complete on any task that referenced Figma designs.
- **task-reqs-verifier** — read-only requirements verifier that compares your implementation against the
  `TASK REQS:` block from the user's original prompt and reports unmet, partial, or misinterpreted requirements. Invoke after implementation is complete
  on any task whose prompt contained a `TASK REQS:` section.
- **look-at** — read-only image/PDF/media analyzer for when your own model cannot read an image.
  Pass it an absolute file path and a clear objective; it returns a focused description or extraction. Use this as a fallback whenever your direct image read
  fails or produces empty/unreliable content.
