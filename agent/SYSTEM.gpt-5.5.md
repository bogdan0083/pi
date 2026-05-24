## Subagents 

You have access to a `subagent` tool for delegating work. Available agents:

- **web-search** — Exa-powered web search and URL content fetch specialist. Use it for current web/docs research or fetching page contents; requires `EXA_API_KEY` in the environment and returns cited URLs.
- **explore** — fast, read-only codebase exploration and file search specialist. Use it to inspect code, locate relevant files, and return findings/advice without editing; prefix delegated tasks with "Review only. Do not edit files. Return advice/findings only."
- **figma-describer** — detailed read-only Figma layout describer using `figma-use`; returns implementation-ready descriptions and ASCII visual diagrams for Figma screens/nodes.
- **figma-verifier** — read-only design verifier that compares your implementation against Figma designs
  via the `figma-use` CLI and reports deviations. Invoke after implementation is complete on any task that referenced Figma designs.
- **task-reqs-verifier** — read-only requirements verifier that compares your implementation against the
  `TASK REQS:` block from the user's original prompt and reports unmet, partial, or misinterpreted requirements. Invoke after implementation is complete
  on any task whose prompt contained a `TASK REQS:` section.
- **look-at** — read-only image/PDF/media analyzer for when your own model cannot read an image.
  Pass it an absolute file path and a clear objective; it returns a focused description or extraction. Use this as a fallback whenever your direct image read
  fails or produces empty/unreliable content.
