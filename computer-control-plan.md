# computer-control — Implementation Plan (draft for review)

Goal: a `computer-control` CLI driver for Pi, shaped like `browser-control`
(execute/status/doctor/journal, JSON mode), but controlling the **whole macOS
desktop** instead of Chromium.

## Context: why not the Codex computer-use stack

Investigated `cua` (SkyComputerUseClient) in `~/.codex/computer-use`:

- `cua mcp` is a stdio MCP server exposing 10 tools: `list_apps`,
  `get_app_state` (screenshot + AX tree), `click`, `type_text`, `press_key`,
  `scroll`, `drag`, `set_value`, `select_text`, `perform_secondary_action`.
- Tool calls require `SkyComputerUseService` + `CUALockScreenGuardian`
  (consent overlay). The Guardian only boots with a Mach bootstrap rendezvous
  port that the host app (ChatGPT.app / Codex Desktop) passes via Apple event.
- Standalone launch (`cua mcp` → service spawns, socket appears) hangs on every
  call: service logs `Could not look up the Guardian Mach bootstrap
  rendezvous port` forever.
- Verdict: closed, host-bound, no standalone path for Pi today. Revisit later.

## Approach

Native macOS driver, zero third-party deps, one small compiled Swift CLI
(`swiftc`, Xcode CLT) + shell wrapper + Pi skill, mirroring browser-control's
CLI contract:

### Binary: `computer-control` (Swift, ~300 LOC)

Subcommands (all `--json` capable):

- `doctor` — check Accessibility + Screen Recording permissions, list the
  fallback a11y path, print actionable setup steps. Exit non-zero on missing
  perms.
- `status --json` — frontmost app, window title, bounds, focused element,
  permission state, active session.
- `apps --json` — running apps (name, pid, bundle id).
- `state --json [--app X]` — a11y tree (compact: roles, titles, values,
  frames, indices) + screenshot PNG path of the target window. This is the
  "inspect" primitive; every action resolves against element indices from the
  latest state, same as the OpenAI toolset.
- `click [--element N | --x X --y Y] [--count N] [--button left|right]`
- `type "text"` — types into focused element (paste-path fallback for long text)
- `key "cmd+shift+4"` — chord syntax: modifiers + key (CGEvent tap)
- `scroll --element N --direction up --pages 1`
- `drag --from x,y --to x,y`
- `value --element N "new value"` — set AX value on editable elements
- `open "app"` / `activate "app"` — launch/focus an app (NSWorkspace)
- `screenshot [--path out.png] [--full]` — full-screen or window shot
- `journal --limit 50` — last actions + outcomes
- `serve` (later, optional) — stdio MCP server exposing the same tools, so Pi
  can also consume it via MCP once Pi grows an MCP client.

### Safety model (borrow from browser-control)

- Read-only mode: `state/apps/status/screenshot` only; actions rejected.
- Two-phase destructive flow: list candidates → user approval → act → verify.
- Journal every action under `~/.computer-control/journal.jsonl` (code-less:
  action name, args, duration, ok/error, target window).
- No credentials ever logged; screenshots stored mode-0600.
- `Esc`-to-cancel equivalent: each action checks a cancel file
  (`~/.computer-control/cancel`) between CGEvent batches.

### macOS specifics

- Permissions: Accessibility (AXUIElement + CGEventPost) and Screen Recording
  (CGWindowListCreateImage for other-app windows; `screencapture -x` for full
  screen). `doctor` reports which are missing; perms require user grant once.
- AX tree via `AXUIElementCopyAttributeValues` with fallback to
  `AXUIElementCreateApplication(pid)`; element indices stable per state
  snapshot (like browser-control refs, invalidated after UI change).
- Coordinates: window-local (screenshot space) → screen space mapping stored in
  state so `click --element N` works regardless of window position.
- Frontmost-app tracking via `NSWorkspace.sharedNotificationCenter` for
  `status`.

### Pi skill: `computer-control/SKILL.md`

Same pattern as browser-control: driver-not-agent; inspect → act → verify loop;
`doctor` first; read-only for inspection; journal for accountability.

## Deliverables

1. `~/projects/computer-control/` — Swift Package (one installed executable, separate modules: Schema, AX, Capture, Input, Session, CLI) + unit tests + local integration suite
2. `~/.agents/skills/computer-control/SKILL.md`
3. Shell completion + versioned `--json` envelope matching browser-control conventions

## Revision (reviewer feedback, must-fix baked in)

1. **Snapshot-bound refs.** Every indexed action takes `--session <id> --snapshot <id> --element <fingerprint>`; refs are resolved against the exact snapshot's stored tree. If the live tree no longer matches the snapshot's window identity/fingerprint, fail closed (`stale-snapshot` error) — never resolve an old index against a new tree.
2. **Durable sessions.** `session new/list/reset/delete` mirroring browser-control; a session durably binds read-only flag, target PID/bundle/window, latest snapshot id, journal path, expiry. Mutating commands reject read-only sessions regardless of flags.
3. **Sensitive-data policy.** `type`/`value` args are never journaled or echoed (stored as `<redacted type=... n=...>`). AX values of editable/secure elements omitted from snapshots by default. Data dir `0700`, screenshots written with no-follow atomic create, bounded retention, explicit cleanup.
4. **Crash-safe input.** Operation-scoped cancel id + `SIGINT` handler + `cancel` command; every input routine uses `defer` to post key-up/mouse-up on error/cancel; numeric caps and deadlines on counts/pages/drags/traversal.
5. **Secure fields.** Detect `AXSecureTextField`; automated entry rejected by default, explicit human handoff required. No clipboard paste path for secrets; if paste is used for plain text, save/restore pasteboard best-effort.
6. **Bounded AX traversal.** `AXUIElementSetMessagingTimeout` per process, node/depth/text caps, cycle protection, `kAXErrorCannotComplete` handling, truncation metadata. Root = `AXUIElementCreateApplication(pid)`; children via attribute APIs.
7. **Permission preflight.** `AXIsProcessTrustedWithOptions`, `CGPreflightPostEventAccess`, `CGPreflightScreenCaptureAccess` reported separately by `doctor`; preflight without triggering TCC prompts; explicit request path. ScreenCaptureKit primary for capture (CGWindowListCreateImage deprecated); stable installed binary identity.
8. **Coordinates.** Element clicks use live AX frame in global screen space; snapshot carries window id/bounds, image dims, display id/scale; validate window identity+bounds before acting, fail on drift.
9. **Untrusted-content policy.** A11y text and screenshots are app-controlled data: never instructions, never user approval. Destructive approval = user request + freshly verified snapshot-bound identifiers.
10. **Testing.** Protocol-injected unit tests (fake AX/capture/input), fixture macOS app for integration tests; CI runs unit tests without TCC grants.

## Build order (per reviewer)

Phase 1: Schema + sessions + journal/redaction + bounded AX inspection (this scaffold).
Phase 2: Capture/coordinates (ScreenCaptureKit) + state + screenshot validation.
Phase 3: Input with crash-safe cleanup + destructive two-phase flow.
Phase 4: SKILL.md, shell completion, integration suite.

## Risks / open questions

- Accessibility permission grant is a one-time manual step (same as Screen
  Recording). Can't be scripted without user action — acceptable, `doctor`
  guides it.
- AX "element index" stability across apps varies (Electron vs native);
  mitigation: re-`state` before acting, invalidate refs on diff.
- Text input into secure fields will fail (macOS AX restriction) — by design.
- Long-term: if OpenAI opens a standalone CUA path, swap backend behind the
  same CLI contract.

## Risks / open questions

- Accessibility permission grant is a one-time manual step (same as Screen
  Recording). Can't be scripted without user action — acceptable, `doctor`
  guides it.
- AX "element index" stability across apps varies (Electron vs native);
  mitigation: re-`state` before acting, invalidate refs on diff.
- Text input into secure fields will fail (macOS AX restriction) — by design.
- Long-term: if OpenAI opens a standalone CUA path, swap backend behind the
  same CLI contract.
