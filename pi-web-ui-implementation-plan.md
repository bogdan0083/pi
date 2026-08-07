# Pi Remote Web UI — Research, Architecture, and Implementation Plan

**Status:** In progress — Phases 0–2 are **complete**; Phase 4 is implemented with physical-device acceptance still pending. See [Phase progress](#phase-progress).  
**Research snapshot:** 2026-08-03  
**Target Pi version for the first implementation:** `@earendil-works/pi-coding-agent` 0.83.0  
**Primary use case:** securely create, resume, observe, and control local Pi coding sessions from a phone  
**Recommended product shape:** a local companion daemon and mobile PWA, not a replacement for Pi

---

## Phase progress

Implementation lives in a dedicated repository: `~/projects/pi-remote` (ADR-8). Each
phase below tracks the plan's deliverable lists; checkboxes reflect what is implemented
and verified on this machine (Pi 0.83.0, tmux 3.6a, Node 24.14.0).

| Phase | Status | Summary |
|---|---|---|
| Phase 0 — terminal + Pi compatibility spike | ✅ **Complete** | go/no-go passed; real Pi TUI over the isolated tmux + relay + xterm.js |
| Phase 1 — local-only vertical slice | ✅ **Complete** | loopback dashboard, tmux supervisor, one PTY relay, controller lease, WS v1, bounded indexer; CI + full PWA polish deferred |
| Phase 2 — core lease and durable reconnect | ✅ **Complete** | private Pi lease build (`bogdan0083/pi@pi-remote-session-lease`, vendored patch); strict lease-gated resume with open-elsewhere 409; protocol v2 `ansi-v1` snapshots with exact barrier; reconcile/state-machine tests |
| Phase 3 — security and remote access | ⏳ Not started | WebAuthn pairing, Tailscale Serve, secure cookies, launchd |
| Phase 4 — phone-quality UX | 🟡 **Implemented; device acceptance pending** | ultra-compact iPhone SE layouts, keyboard-aware viewport, mobile inputs, uploads, QR, PWA |
| Phase 5 — voice, semantic status, notifications | ⏳ Not started | first step: refactor `agent/extensions/voice-input.ts` into a shared host module |
| Phase 6 — hardening and release | ⏳ Not started | |

### Phase 0 checklist — complete

- [x] Start Pi 0.83.0 inside the private tmux server with the isolated config (`config/tmux.conf`; CSI-u, truecolor, `remain-on-exit`). Verified: full TUI renders, all installed extensions load.
- [x] Attach one `node-pty` relay and render with xterm.js (desktop browser verified).
- [x] Verify terminal behavior: resize propagation; alternate screen (observed `?1049h` during Pi startup); truecolor (`COLORTERM=truecolor` + `RGB` terminal-features); CSI-u configured server-side.
- [ ] Formal query-negotiation / bracketed-paste / hyperlink / Unicode-width matrix — partially covered; precise headless barrier is Phase 2 scope (see `docs/protocol.md`).
- [ ] Interactive slash/path/extension autocomplete exercise — inherent to the real TUI; not yet run through a scripted key sequence.
- [ ] Extension compatibility matrix (ask-question dialogs, custom widgets, voice Shift protocol) — extensions load and render; per-extension interactive behaviors pending a dedicated matrix (Phase 5 covers the voice side channel).
- [x] Classify the Mac-microphone voice shortcut as a Phase 5 side channel, not a PTY feature.
- [x] Verify tmux keeps Pi alive across browser disconnect and daemon restart (smoke + reconcile tests).
- [x] Prototype forced redraw/snapshot and sequence replay (`capture-pane -e` snapshot + seq ring + delta replay).
- [ ] Document unsupported inline-image / external-terminal behavior — noted in `docs/protocol.md`; full matrix pending.

Exit criteria: no duplicated/lost keyboard bytes ✅ (input ack + seq arbitration); Shift+Enter/newline and steering keys via explicit toolbar sequences ✅; reconnect restores a coherent screen ✅; Pi survives network/browser loss ✅.

### Phase 1 checklist — complete

- [x] TypeScript npm workspace (protocol / server / web). CI pipeline not yet set up.
- [x] Loopback-only Fastify server (`127.0.0.1:<port>`, no remote access).
- [x] Version-pinned bounded JSONL metadata indexer (fallback until `SessionManager.listMetadata()` lands): 699/699 files verified against Pi's `listAll()`; incremental append tracking keyed by `(device, inode, path)`; never builds `allMessagesText`.
- [x] Project/session dashboard (projects from session cwds + managed runtimes + pinned roots).
- [x] Create new sessions (`--session-id <uuid>` → deterministic id) and attach existing managed runtimes.
- [x] Persisted-session resume — confirmation-based for ownership-unknown sessions (strict lease-gated resume awaits Phase 2).
- [x] Private tmux supervisor and fixed argv-only runner (0600 registry; no shell interpolation).
- [x] One relay PTY per runtime; browser reload never starts a second Pi.
- [x] Terminal WebSocket v1 (`docs/protocol.md`): seq ring, serialized snapshot barrier, delta resume, strict input seq, one frame per message.
- [x] One per-connection controller lease and unified input arbiter; second client/tab read-only; explicit audited takeover.
- [x] Basic mobile PWA shell (manifest + responsive layout). Full phone-quality UX is Phase 4.
- [x] Explicit ownership-unknown warnings (resume confirmation dialog).
- [x] Exit criteria: desktop browser lists/creates/attaches/stops/recovers sessions ✅; browser reload never duplicates Pi ✅; blank/provisional sessions appear correctly ✅; daemon restart reconciles tmux runtimes without duplicating Pi ✅.

Post-review hardening (commit `fea0377`): reconnect replay no longer drops buffered deltas; snapshot handshake serialized per client; expired leases cannot self-revive; per-session resume lock; exact Origin allowlist for state-changing HTTP + WS upgrades; untracked tmux sessions quarantined instead of auto-destroyed; indexer partial-tail duplication and rename semantics fixed; 11 unit tests for indexer + lease.

## 1. Executive summary

Build a **hybrid Pi Remote application** with two surfaces:

1. A browser-native, Codex-inspired dashboard for projects, sessions, status, reconnect, notifications, attachments, and mobile controls.
2. The **actual interactive Pi CLI** rendered in an `xterm.js` terminal, with Pi running inside a private `tmux` server. This preserves Pi's execution path and provides the highest attainable compatibility with its TUI, tools, models, commands, keybindings, autocomplete, extensions, and custom components instead of reimplementing an incomplete subset over RPC. It does not make every host-terminal capability portable; the compatibility boundary is explicit below.

The proposed topology is:

```text
Phone PWA
   │ HTTPS + WSS
   ▼
Tailscale Serve                       default remote ingress
   │ loopback proxy
   ▼
Pi Remote daemon
   ├── dashboard API                  projects, sessions, runtimes, devices
   ├── terminal relay                 auth, controller lease, replay, resize
   ├── runtime supervisor             registry, locks, tmux reconciliation
   ├── voice/upload side channels     mobile microphone and attachments
   └── optional Pi bridge extension   semantic status and notifications
          │
          ▼
private tmux server (`tmux -S <socket>`)
   └── real PTY → real interactive `pi` CLI → existing Pi config/extensions/tools
```

### Why this approach

- **RPC is useful but not full-fidelity.** Pi RPC cannot render custom TUI components, use raw terminal input, expose terminal-oriented autocomplete providers, replace the editor/footer/header, or preserve every extension behavior.
- **A PTY alone is not durable.** `tmux` keeps Pi alive when the phone sleeps, the browser reloads, or the network changes.
- **A raw web terminal alone is not comfortable on a phone.** The dashboard, native mobile composer, shortcut bar, voice button, uploads, reconnect state, and notifications provide the control-plane UX demonstrated by Codex Remote and Claude Code Remote Control.
- **SSH is not needed in the main data path.** The daemon already runs beside Pi. Tailscale Serve provides private HTTPS reachability without opening an inbound Internet port. SSH port forwarding remains a fallback.

### Important limitation

An arbitrary Pi process already running in a normal Terminal.app/Ghostty/iTerm PTY **cannot be safely hijacked and attached from the browser**. Remote-capable live sessions must be started under the Pi Remote supervisor/tmux from the beginning. Existing persisted JSONL sessions can be resumed remotely after their previous Pi process has stopped.

### Build-versus-adopt decision

Build a focused companion rather than fork one of the existing dashboards:

- `agegr/pi-web` is the strongest current structured Pi UI and supports Pi 0.83.0, but it does not provide the required full interactive terminal and its runtime model is broader than this initial need.
- `jmfederico/pi-web` has an excellent persistent daemon/terminal architecture, but its current peer range excludes Pi 0.83 and it is a much larger workspace/federation product.
- `pi-agent-dashboard` has the richest terminal and multi-agent feature set, but currently targets an older Pi line and adds substantial complexity.
- `ygncode/pi-web` is the best lean remote-control/security reference, but RPC cannot provide complete TUI and extension fidelity.
- Generic `tmux-web`, ttyd, and WeTTY preserve terminal bytes but do not understand Pi projects, JSONL sessions, trust, ownership, or mobile agent workflows.

Reuse their architectural patterns and established libraries; do not inherit a large, version-mismatched product.

No application-operated transcript relay is used. Phone voice is intentionally sent from the Mac to the configured DashScope ASR service; optional OpenRouter refinement sends transcript text to another provider and is disabled by default unless the user explicitly enables it.

---

## 2. Goals and non-goals

### 2.1 Goals

A user should be able to:

1. Open a private PWA on a phone and see whether the Mac and Pi Remote daemon are online.
2. See folders/projects previously used by Pi, ordered by active work and recent activity.
3. Open a project and see its persisted Pi sessions with name, last activity, state, and message count.
4. Resume an inactive persisted session in the session's original working directory.
5. Create a new named Pi session in a selected folder.
6. Reconnect to a managed live session without restarting Pi or duplicating the process.
7. Use the **real Pi terminal UI**, including:
   - slash commands;
   - path, session, project, and extension autocomplete;
   - all installed tools and model providers;
   - project and global extensions whose required terminal protocols are supported;
   - terminal-rendered widgets/components;
   - Pi's editor and keybindings covered by the remote input adapter;
   - steering/follow-up behavior;
   - session tree/fork/clone commands;
   - normal ANSI color and safe hyperlink behavior.
8. Type comfortably from a mobile keyboard through a native composer and terminal shortcut toolbar.
9. Use the phone microphone to dictate into Pi without giving provider credentials to the browser.
10. Upload a photo/file from the phone and insert a safe local `@file` reference into Pi.
11. Receive a notification when a managed agent starts, settles, exits, or—after a Pi UI lifecycle hook exists—requires attention.
12. Survive browser backgrounding, network changes, phone sleep, and daemon reconnect without losing the Pi process.
13. Revoke a phone and stop/kill the managed Pi runtime locally.

### 2.2 Security goals

- The service is unreachable from the public Internet by default.
- Remote access is equivalent to privileged shell access and is protected accordingly.
- A malicious website cannot drive the terminal through the user's authenticated browser.
- Only one client controls a runtime at a time; other clients are read-only.
- A session JSONL file has only one Pi writer.
- Browser output is treated as untrusted, including ANSI, OSC, Markdown, filenames, model output, and repository content.
- Pi credentials and complete session transcripts are not copied into app logs or browser storage.

### 2.3 Non-goals for v1

- Multi-user SaaS or public hosting.
- Running Pi in a cloud environment.
- A full browser IDE, Git client, or VS Code replacement.
- Reimplementing every Pi transcript/tool component as native React UI.
- Attaching to arbitrary existing, unmanaged terminal processes.
- Collaborative simultaneous terminal input.
- Public Tailscale Funnel exposure.
- Cloudflare Tunnel as the default.
- Full host-terminal parity. Inline image protocols, host clipboard integration, external editor/app launches, mouse-heavy extensions, and extensions requiring terminal protocols not implemented by the browser adapter may need a fallback or dedicated bridge.
- Reusing the existing Mac-microphone voice shortcut from the phone. Phone voice uses a separate browser-audio bridge while the local shortcut remains unchanged.
- Offline command submission. Pi remains local and the host must be awake and online.

---

## 3. Research findings

### 3.1 Current Pi architecture and capabilities

The canonical repository is now [`earendil-works/pi`](https://github.com/earendil-works/pi), historically `badlogic/pi-mono`. The installed local version is 0.83.0.

Relevant layers:

| Package | Responsibility | Relevance |
|---|---|---|
| `pi-ai` | model/provider abstraction and streaming | Remains inside Pi |
| `pi-agent-core` | agent loop, tools, queues, events | Remains inside Pi |
| `pi-tui` | interactive ANSI TUI, editor, overlays, autocomplete | Preserved by PTY |
| `pi-coding-agent` | CLI, sessions, extensions, tools, RPC/JSON modes | Main integration target |
| experimental protocol/client/server packages | structured remote session protocol | Promising, but currently narrower than full Pi |

Primary source references:

- [`AgentSession`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)
- [`AgentSessionRuntime`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session-runtime.ts)
- [`SessionManager`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)
- [SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Session documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)
- [TUI documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)
- [tmux setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tmux.md)

#### Session storage

Default session files are append-only JSONL:

```text
~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl
```

A header records version, ID, timestamp, cwd, and optional parent session. Entries form a tree using `id` and `parentId`; append order is not the same as the active branch.

The public `SessionManager.listAll()`/`list()` APIs produce session metadata including:

- path and ID;
- cwd;
- name;
- parent session path;
- created/modified timestamps;
- message count;
- first-message and searchable transcript text.

The dashboard should return only the fields it needs. It must not send `allMessagesText` to the phone.

There is **no session-file ownership lock** in Pi 0.83.0. Session entries use direct append/rewrite operations. Two Pi processes opening the same JSONL file can retain different in-memory trees and corrupt logical ownership even if every JSON line remains syntactically valid. A session lease is therefore a prerequisite for safe remote resume.

#### Real CLI session operations

Pi 0.83.0 supports:

```text
pi --continue
pi --resume
pi --session <path|id>
pi --session-id <exact-id>
pi --fork <path|id>
pi --name <name>
pi --session-dir <dir>
```

A blank new session may not create its JSONL file until meaningful activity is persisted. Pi Remote must keep provisional session/runtime metadata independently.

#### Why not use RPC as the primary UI

`pi --mode rpc` is a good structured integration and supports prompt, steer, follow-up, abort, model changes, compaction, bash, session switching, fork/clone, tree/entry inspection, commands, state, and extension dialogs.

However, RPC deliberately degrades terminal-only extension APIs:

- custom TUI components are unavailable;
- custom editor components do not work;
- raw terminal input is unavailable;
- terminal-oriented autocomplete providers are no-ops;
- custom header/footer/theme behavior is unavailable;
- some branch/navigation operations are not represented directly.

A native RPC UI would be more phone-friendly but would not satisfy the requirement to retain “all plugins and autocomplete.” It is appropriate for a later semantic companion surface, not the v1 execution path.

#### Terminal requirements

Pi negotiates terminal capabilities and expects raw input, resize events, bracketed paste, ANSI handling, and enhanced keyboard protocols. Inside tmux, Pi's own documentation recommends:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Local readiness observed during research:

- Pi 0.83.0 on Node 24.14.0;
- tmux 3.6a, including CSI-u support;
- `tmux-256color` terminfo available;
- SoX `rec` and ffmpeg 8.0.1 available;
- Tailscale CLI not installed or not on `PATH`, so remote deployment must include its installation and login.

### 3.2 Codex Remote as the UX reference

OpenAI's documented pattern is **phone as control plane; desktop host as execution environment**:

- pair a phone and host by QR;
- choose host, project/directory, branch/worktree, and chat;
- start or resume work;
- follow progress, terminal output, tests, screenshots, and diffs;
- approve actions;
- choose queue versus steer for a follow-up;
- receive notifications for completion or attention;
- keep all files, tools, credentials, and execution on the host.

Sources:

- [Codex Remote connections](https://developers.openai.com/codex/remote-connections)
- [Codex projects](https://developers.openai.com/codex/projects)
- [Prompting and steering](https://developers.openai.com/codex/prompting)
- [Integrated terminal](https://developers.openai.com/codex/integrated-terminal)
- [Review UI](https://developers.openai.com/codex/app/review)
- [OpenAI product announcement](https://openai.com/index/work-with-codex-from-anywhere/)

The most important lesson is not to shrink a desktop UI onto a phone. Surface the decisions that unblock the agent: **running, waiting, needs approval, failed, and ready to review**. Pi Remote still needs a full terminal for fidelity, but the terminal should sit inside a native mobile shell rather than be the entire product.

### 3.3 Claude Code Remote Control as an operational reference

Claude's implementation provides useful behavior to copy:

- the local process opens an outbound connection;
- no inbound host port is required;
- phone/browser can reconnect after sleep/network loss;
- work remains local while transcript state synchronizes;
- sessions show online status;
- notifications can fire only when attention is required;
- `tmux`/`screen` is recommended when a local process is reached through SSH.

Source: [Claude Code Remote Control](https://docs.anthropic.com/en/docs/claude-code/remote-control).

Pi Remote should not copy Anthropic's transcript relay because the target is self-hosted. It should copy the reconnect semantics, explicit online/offline state, and attention notifications.

### 3.4 Relevant open-source projects

| Project | Useful lesson | Reason not to adopt unchanged |
|---|---|---|
| [`agegr/pi-web`](https://github.com/agegr/pi-web) | current Pi 0.83 support, session/tree UX, mobile PWA, file safety | no full Pi terminal; broader workspace product |
| [`preinpost/pi-web-chat`](https://github.com/preinpost/pi-web-chat) | small direct-SDK chat, PWA layout, per-session URLs | incomplete extension UI, no terminal/workspace, no app auth |
| [`jmfederico/pi-web`](https://github.com/jmfederico/pi-web) | persistent session daemon, terminal, machine/project/workspace model | peer range currently excludes 0.83; large operational surface |
| [`BlackBeltTechnology/pi-agent-dashboard`](https://github.com/BlackBeltTechnology/pi-agent-dashboard) | terminal, bridge extension, PromptBus, device auth patterns | older Pi target and high complexity |
| [`ygncode/pi-web`](https://github.com/ygncode/pi-web) | loopback/token/Tailscale posture, RPC workers, PWA | RPC cannot preserve all TUI extension behavior |
| [`Epsilondelta-ai/pi-web`](https://github.com/Epsilondelta-ai/pi-web) | single-binary and replayable SSE | unsafe wildcard/CORS defaults; manual protocol compatibility |
| [`jbn/piface`](https://github.com/jbn/piface) | mobile recovery, RPC, PTY, voice/audio | alpha and operationally heavy |
| [`tmux-web`](https://github.com/ashutoshpw/tmux-web) | tmux attach, history/replay, terminal-specific UX | no Pi semantics; terminal equals host shell access |
| [`webmux`](https://github.com/windmill-labs/webmux) | worktree/tmux lifecycle and mobile quick controls | Claude/Codex-oriented, not Pi-native |
| [`ttyd`](https://github.com/tsl0922/ttyd) | hardened small PTY-to-WebSocket server | dynamic session integration and Pi registry still need custom code |

### 3.5 Remote transport options

| Option | Decision |
|---|---|
| Tailscale Serve | **Default.** Private tailnet HTTPS, ACLs, no public listener |
| SSH port forwarding | Supported fallback; secure but inconvenient on a phone |
| Cloudflare Tunnel + Access | Later option when tailnet access is impossible; validate Access JWT at origin |
| Raw LAN bind | Development only, disabled by default |
| Tailscale Funnel/public URL | Out of scope and explicitly disabled |
| Mosh | Excellent native mobile shell transport, not a browser transport |
| Apache Guacamole/ShellHub | Too heavy for one local Pi host |

---

## 4. Product design

### 4.1 Information architecture

```text
Connection
  └── This Mac (online/offline, last seen)
       ├── Attention inbox
       └── Projects
            └── Project
                 ├── New session
                 ├── Managed live sessions
                 └── Persisted sessions
                      └── Runtime terminal
                           ├── status/header
                           ├── xterm surface
                           ├── mobile composer
                           ├── key toolbar
                           └── voice/upload actions
```

Only one host is needed in v1, but retaining a host boundary avoids redesign if remote Linux machines are added later.

### 4.2 Project dashboard

Project cards should show:

- display name and abbreviated canonical path;
- Git branch when it can be read cheaply and safely;
- number of active managed runtimes;
- number of persisted sessions;
- last Pi activity;
- semantic state: running, failed, settled, and—only after the upstream UI lifecycle hook—needs attention;
- pinned/recent state;
- “New session” action.

Project discovery is the union of:

1. cwds from Pi session headers;
2. currently managed runtimes;
3. explicitly pinned roots in Pi Remote;
4. trusted project roots from Pi's trust store, exposed as status only;
5. optionally imported known repositories, such as a configured repo list.

Do **not** recursively scan the entire home directory. Do not infer paths from the encoded session-directory name when the JSONL header has an authoritative cwd.

### 4.3 Session list

Each session row should include:

- name; otherwise a safely truncated first user message; otherwise “Untitled session”;
- relative age/last modified;
- message count;
- parent/fork indicator;
- original cwd or “folder missing” warning;
- state badge:
  - `managed-running`;
  - `managed-settled`;
  - `managed-needs-attention` only when backed by the upstream UI lifecycle hook;
  - `managed-exited`;
  - `persisted`;
  - `unmanaged/ownership-unknown`;
  - `lost`;
- action:
  - Attach;
  - Resume;
  - Confirm and resume if ownership is unknown;
  - Recover after lost process;
  - Rename;
  - Open exported transcript later.

Do not label a JSONL file “running” solely because it was recently modified. Every JSONL mutation, including rename, must use the same write lease. For a managed live session, rename is executed by the owning Pi runtime through a future structured bridge/core command. For an inactive session, the server first acquires the core write lease. Ownership-unknown sessions are not modified.

### 4.4 New session flow

1. User taps **New session** on a project.
2. Optional fields: session name, initial-prompt draft, model/thinking preset.
3. Server resolves an opaque project ID to a canonical allowed path.
4. Server creates a runtime ID and exact Pi session ID.
5. Supervisor starts Pi without `--approve`; Pi's normal trust flow remains authoritative.
6. Browser attaches to the terminal.
7. If an initial prompt was supplied, keep it in the browser composer. Do **not** inject it blindly: Pi may still be showing project trust, extension startup, or another modal. The user inserts/submits it after the real editor is visibly ready. Automated insertion is allowed later only after an upstream/bridge `editor_ready` signal and structured `setEditorText` operation.
8. Runtime remains visible even before Pi writes the first JSONL entry.

### 4.5 Resume flow

1. Server resolves an opaque session ID to a canonical JSONL path from its index.
2. Validate that the file remains inside the configured Pi session root and its header ID/cwd match the index.
3. Check the session lease/managed-runtime registry.
4. If already managed, attach to the existing runtime.
5. If another owner holds the core session lease, reject with an “open elsewhere” state.
6. If ownership cannot be proven because an older/unmanaged Pi might still be running, require explicit confirmation that the local process is stopped.
7. Start `pi --session <canonical-path>` through the runner using argv, never a shell-interpolated command.

### 4.6 Terminal screen

Header:

- project/session name;
- connection state;
- agent semantic state when available;
- controller/read-only badge;
- orientation/fit action;
- stop menu.

Main surface:

- `@xterm/xterm`;
- Fit addon;
- WebGL renderer when stable, DOM/canvas fallback;
- safe web-link handler;
- 24-bit color;
- bounded browser scrollback;
- portrait and landscape layouts;
- visible reconnect overlay without clearing the last screen.

Mobile key toolbar:

```text
Esc  Tab  Ctrl  Alt  Shift  ↑  ↓  ←  →  Enter  ⌫  Ctrl+C  Ctrl+D  PgUp  PgDn
```

- Ctrl/Alt/Shift can be one-shot or locked.
- Dedicated actions should emit CSI-u sequences where Pi/tmux requires them.
- Provide explicit **Newline** and **Submit** buttons rather than relying on mobile Shift+Enter.
- Hide autocorrect, autocapitalization, and smart punctuation for terminal input.
- Commit IME text only on `compositionend`.

Two input modes:

1. **Direct terminal mode:** every key reaches Pi; preserves interactive autocomplete.
2. **Mobile composer:** a native multiline textarea with draft persistence, microphone, and attachments. Before an authoritative `editor_ready` + structured `setEditorText` bridge API exists, the composer provides **Paste to terminal** only. It never automatically appends Submit/Enter. The user must visibly confirm the target and submit through direct terminal controls. "Insert and Send," voice auto-insert, and automatic attachment insertion are enabled only after the structured editor API is available and integration-tested.

All server-generated text insertion validates UTF-8, caps character count, normalizes line endings, and rejects NUL, ESC, DEL, C1 controls, and unexpected C0 controls. Only explicitly supported Tab/Newline characters may survive. Bracketed-paste delimiters are generated by trusted code and cannot appear in the payload. Submit is a separate authorized action and is never inferred from payload text.

### 4.7 Voice and audio

The existing local `voice-input.ts` records from the Mac microphone with SoX. A phone microphone cannot travel through PTY bytes, so PTY forwarding alone does not meet the voice requirement.

Implement a side channel:

1. Browser records with `MediaRecorder` after a user gesture.
2. Accept an explicit codec allowlist per platform—initially WebM/Opus from Chromium and MP4/AAC where Safari emits it. Verify MIME from content, not only the request header.
3. Audio uploads over authenticated HTTPS with strict duration, decoded-size, request-size, and timeout limits.
4. Primary v1 capture uses `getUserMedia` + AudioWorklet to collect PCM, downmix and resample to mono 16 kHz, and construct a small canonical PCM WAV in browser memory. The server validates the WAV structure, sample format, channel count, rate, duration, and exact decoded byte count with a small memory-safe parser; it does not invoke a general media demuxer. A MediaRecorder/container fallback is disabled unless ffmpeg runs in a separate low-privilege worker with access only to one input/output directory, no provider credentials or repository access, OS-enforced network denial, resource limits, a minimal decoder build, and a verified absolute binary/version/hash. Protocol whitelisting and an empty environment are defense-in-depth, not a sandbox. If AudioWorklet support fails the spike, explicitly make isolated ffmpeg execution a Phase 5 release gate or omit voice from v1.
5. Reuse the existing extension's DashScope/Qwen ASR profile, vocabulary/normalization, retries, and optional OpenRouter refinement logic. It is not a generic provider abstraction. Provider credentials remain on the Mac.
6. Transcript is returned as text and offered to the current controller for insertion into Pi's editor through the same ordered input arbiter used by terminal input.
7. User reviews and submits.
8. Raw and transcoded audio are deleted on success, error, cancellation, and timeout; a startup janitor removes crash leftovers.

Refactor the concrete transcription pipeline from `agent/extensions/voice-input.ts` into a reusable host module instead of maintaining two divergent implementations.

Optional later enhancement: browser-native text-to-speech for the last assistant response. This is separate from terminal fidelity and must be opt-in because terminal output can contain secrets.

### 4.8 Attachments

- Accept phone camera/photo/file uploads only after authentication.
- Enforce file count, MIME, and size limits.
- Store under a dedicated staging root, not inside an arbitrary project path:

```text
~/.pi/remote/uploads/<device-id>/<random-id>/<safe-name>
```

- Uploading is allowed without terminal control, but inserting the `@absolute-path` requires the current per-connection controller lease and goes through the same ordered input arbiter as keyboard/composer/voice input.
- Show the destination and require confirmation for executable/archive formats.
- Uploads begin in a short-lived staging area. On successful reference or image submission, atomically promote the file to an immutable session-scoped directory with `0700` directories and `0600` files. Retain promoted files for the life of the persisted Pi session, not merely the current runtime; delete them on explicit user action or session deletion according to the documented retention policy. The server never extracts archives or executes uploads.
- Never accept a browser-provided destination path.

Two attachment modes are distinct:

1. **File reference:** insert a quoted local path as prompt text. This does not automatically attach file contents; the agent must read the file.
2. **Image attachment:** after explicit Submit, the authenticated bridge reads and validates the staged image and calls Pi's public `sendUserMessage(TextContent | ImageContent[])` API. This action requires the controller lease and participates in the ordered action arbiter.

The UI labels these modes accurately.

### 4.9 Notifications

PTY output parsing is too fragile for authoritative agent state. Add a small first-party Pi bridge extension to managed sessions that reports only structured metadata over a private Unix socket:

- session/runtime binding;
- `agent_start`;
- `agent_settled`;
- graceful `session_shutdown` when available; structured extension/agent errors that Pi publicly exposes;
- optional title/status updates.

Pi 0.83.0 does not expose a public event whenever another extension opens `ctx.ui.select`, `confirm`, `input`, `editor`, or `custom`. An independent bridge therefore cannot authoritatively detect every approval/question. Attention notifications require an upstream UI lifecycle hook (`ui_request_opened`/`ui_request_closed`) or explicit instrumentation of each supported extension. Do not infer this state by scraping terminal text.

The bridge must not replace Pi's TUI or consume dialogs in v1. Terminal remains the authoritative interaction surface.

Notification rules:

- v1 baseline: notify on start if requested, settled/completed, graceful `session_shutdown` when available, structured extension/agent errors that Pi publicly exposes, and process exit;
- notify on needs-input/approval/question only after the upstream UI lifecycle hook exists;
- suppress while the same runtime is focused;
- deep-link into the runtime;
- no prompt/tool output in lock-screen notification text by default.

On iOS, push is available only for a Home Screen web app on iOS 16.4+ after a user-initiated permission request. The UI feature-detects support and labels notifications unavailable otherwise. A notification deep link may wait for Tailscale to reconnect.

Focused-session suppression is a short TTL renewed by visible-page heartbeats. Use `visibilitychange`/`pagehide` as best effort, but expiry—not a final browser message—is authoritative.

Use a network-first, non-cached app entry document and content-hashed static assets. Show an update/reload prompt before activating an incompatible service worker, and support protocol-version negotiation during rollout.

Drafts are memory-only by default. Any opt-in persisted draft has a short TTL, is clearly disclosed, and is cleared on submit, logout, and device revocation. Audio is never intentionally written to localStorage, IndexedDB, or the service worker cache; it exists in browser memory only until upload, subject to normal browser/OS internals.

Use the Web Push API only after HTTPS/Tailscale is working. A locally delivered notification can be a later fallback on platforms with weak PWA push support.

---

## 5. Architecture decisions

### ADR-1: Hybrid native dashboard + real Pi PTY

**Decision:** Keep Pi interactive and render it through a terminal; use native web UI around it.

**Rejected:** RPC-only or SDK-only chat as v1. It would be cleaner but cannot preserve all extension/TUI behaviors.

**Consequence:** Better fidelity, more difficult terminal/mobile/reconnect engineering.

### ADR-2: tmux owns process durability

**Decision:** Every remotely managed Pi process runs in a dedicated tmux session on a private tmux socket.

```text
tmux -L pi-remote
```

Recommended isolated tmux configuration:

```tmux
set -g status off
set -g prefix None
set -g prefix2 None
set -g mouse off
set -g set-clipboard off
set -g allow-passthrough off
set -g allow-rename off
set -g allow-set-title off
set -g set-titles off
set -g remain-on-exit on
set -g default-terminal 'tmux-256color'
set -g extended-keys on
set -g extended-keys-format csi-u
set -g history-limit 50000
set -as terminal-features ',xterm-256color:RGB:hyperlinks:extkeys'
```

Use an application-owned `-S <absolute-socket-path>` under a `0700` runtime directory rather than a fixed `-L` name. The first session creation must occur under a supervisor startup lock and pass the application config with `-f`. Store a config/boot identity in a tmux user option and refuse to adopt an existing server whose identity or effective options do not match.

Launch the outer relay PTY with `TERM=xterm-256color` and `COLORTERM=truecolor`; verify `tmux-256color` terminfo with `infocmp` during `pi-remote doctor`. Verify effective features with `tmux display-message -p '#{client_termfeatures}'`.

The tmux socket isolates Pi Remote from the user's normal tmux server, but is not a security boundary against other processes running as the same macOS user.

Keep dead panes long enough to read `pane_dead_status`, record the exit, and then explicitly destroy the tmux session.

**Rejected:** one direct `node-pty` child per WebSocket. Browser disconnects and daemon restarts would own/kill processes incorrectly.

### ADR-3: One supervisor PTY relay per runtime

**Decision:** The daemon owns one long-lived `node-pty` attachment to each managed tmux session. Browser clients subscribe to that relay.

Benefits:

- one authoritative terminal size;
- one ordered output stream;
- bounded replay;
- daemon can continue draining output while no phone is connected;
- reconnect does not create multiple competing tmux clients;
- read-only spectators are possible.

A browser WebSocket must never spawn its own independent tmux attachment.

### ADR-4: One controller connection lease and one input arbiter

**Decision:** One connection instance—not merely one device—controls input and resize per runtime. Other connections, including another tab on the same phone, are read-only. Takeover is explicit and audited.

- The holder identity is `(runtimeId, deviceId, connectionId, leaseToken)`.
- Heartbeats renew the lease.
- A disconnected browser does not kill Pi.
- Lease timeout enables takeover, but does not replay unsent input.
- Every editor mutation—direct keys, composer insertion, voice transcript insertion, upload-reference insertion, and future native approval actions—passes through the same ordered input arbiter and requires the current lease token.
- File staging may occur without terminal control within strict per-device and global quotas. Voice capture upload may be staged, but starting ASR, refinement, or inserting the result requires the current controller lease, CSRF protection, and per-device/runtime cost and rate limits.
- Stop/kill/takeover has separate action authorization and recent-auth requirements; holding a terminal lease alone is insufficient for destructive administration.
- A local `pi-remote attach` CLI participates in the same lease system.
- Direct raw attach to the private tmux socket is an emergency/admin bypass and is not collaborative.

### ADR-5: Pi JSONL remains conversation truth; SQLite stores orchestration truth

**Decision:** Do not duplicate transcripts into an app database.

Pi JSONL owns:

- messages;
- branches;
- compaction;
- model/thinking changes;
- extension state;
- session name/history.

Pi Remote SQLite owns:

- pinned projects;
- managed runtime IDs and state;
- tmux/launch identity;
- device pairing and revocation;
- controller leases;
- upload metadata;
- notification subscriptions;
- non-sensitive audit metadata.

### ADR-6: Add a Pi core session lease

**Decision:** Implement an advisory exclusive lease for persistent sessions in Pi itself, using the already-established `proper-lockfile` dependency or an equivalent atomic lock directory.

Required behavior:

- the lease key is `(canonical session root, exact session ID)`, not the possibly nonexistent JSONL path; lock artifacts live in a dedicated private lock namespace such as `~/.pi/agent/session-locks/<sha256(root + NUL + sessionId)>/`;
- the namespace exists before a blank session is launched; a target session ID is locked before its file is opened, loaded, created, forked, cloned, renamed, or rewritten;
- write-capable `AgentSessionRuntime` acquires a lease before opening/creating a persistent session;
- lease metadata includes host identity, boot identity, PID, process-start fingerprint, session path, and optional Pi Remote launch ID;
- `switchSession`, `fork`, `clone`, rename/session-info writes, shutdown, and crash recovery release/reacquire correctly;
- static read/list/export operations do not take a write lease;
- inactive dashboard mutations acquire the same lease; active mutations are delegated to the owning runtime through a structured core/bridge command;
- do not automatically reclaim a lock based only on mtime age; same-host recovery must verify that the exact process instance no longer exists; ambiguous recovery is an explicit local admin action;
- a second writer fails clearly and never silently opens the file;
- the dashboard can report "open elsewhere."

If `proper-lockfile` cannot provide these semantics without age-only stale takeover, use a dedicated atomic lock directory with conservative recovery or an OS-held advisory lock for local files instead. Add suspend/wake, SIGKILL, PID-reuse, and clock-change tests.

Until this ships in the exact Pi binary being launched, unmanaged-session resume remains confirmation-based and cannot be made race-free.

The Pi core change must also make whole-file rewrites reader-safe. Write the complete replacement to a `0600` temporary file in the same directory, fsync it, atomically rename it over the destination, and fsync the directory. Readers that already opened the old inode then see the old complete version; new readers see the new complete version.

Append readers must tolerate and ignore an incomplete final JSONL record. Operations requiring a coherent semantic snapshot—fork, clone, export, or a dashboard mutation—must either obtain a snapshot/read lease or ask the active owning runtime to produce the snapshot. Until atomic rewrites ship, static reads cannot be described as safe without a lease.

### ADR-7: Tailscale Serve is the default ingress

**Decision:** Bind the HTTP daemon to an exact `127.0.0.1:<configured-port>` listener for Tailscale Serve. A separate `0600` Unix socket is used only for local administration and pairing-ticket creation.

**Rejected:** raw `0.0.0.0`, Funnel, direct public reverse proxy.

**Fallback:** SSH local forwarding. **Later option:** Cloudflare Tunnel + Access with origin-side JWT validation.

`pi-remote tailscale enable` configures persistent/background Serve and records the expected FQDN, port, and target. Startup and `doctor` compare the live Serve configuration against that expected configuration and verify that Funnel is disabled for every application port.

Use the narrowest source selector the tailnet can actually enforce: a managed/tagged phone where configured, otherwise the user's tailnet identity. Do not claim per-device ACL enforcement without an explicit device-tagging procedure.

Tailscale identity headers are used for audit/corroboration only, not as the primary authorization mechanism. They may be absent for tagged devices and can represent external users of a shared node. A direct loopback process can spoof them, which is why application authentication remains mandatory.

### ADR-8: Build a small companion, then upstream reusable core changes

The current local directory is a Pi configuration repository, not the Pi source monorepo. Implementation should live in a dedicated repository such as `~/projects/pi-remote`, with:

```text
apps/server
apps/web
packages/protocol
packages/pi-bridge
packages/test-fixtures
```

Upstream the generally useful session-lease and metadata APIs into `earendil-works/pi`. Do not deep-import Pi internals; use package-root public exports and pin an exact supported Pi range.

---

## 6. Detailed system design

### 6.1 Suggested stack

#### Server

- Node 24 + TypeScript.
- Fastify for HTTP, schema validation, limits, and WebSocket integration.
- `@fastify/websocket`/`ws` for WSS terminal transport.
- `node-pty` for the daemon-to-tmux PTY.
- `better-sqlite3` for a small durable orchestration registry.
- keep PTY drain/fan-out on a latency-sensitive event loop; run SQLite/indexing work through a dedicated worker or serialized job queue; never perform large transactions or scans in PTY callbacks; use WAL mode, bounded busy timeout, schema migrations, explicit transactions, checkpoint policy, and startup integrity/recovery handling;
- controller leases are primarily in memory and bound to a daemon boot ID; do not synchronously commit every heartbeat; persist only coarse recovery/audit state; on daemon restart all old WebSockets are dead and old controller leases are invalid immediately;
- define audit-event retention/rotation and the storage/backup policy for the VAPID private key and any key used to encrypt push subscriptions;
- TypeBox or Zod for shared runtime schemas; prefer TypeBox if aligning with Pi.
- `proper-lockfile` for daemon-level resources; Pi core session lease remains separate.
- structured logging with Pino, with explicit redaction.

#### Web

- React + Vite + TypeScript.
- `@xterm/xterm` plus Fit and WebLinks addons.
- TanStack Query for API/server-state handling.
- A small router with deep links for project/session/runtime.
- PWA manifest and minimal service worker caching **only static app assets**, never terminal/session responses.
- Playwright for E2E/mobile viewport tests.

Do not load terminal code, fonts, analytics, or scripts from third-party CDNs.

### 6.2 Components

#### Session indexer

Pi 0.83.0's `SessionManager.listAll()` reads every session and constructs `firstMessage` and `allMessagesText`; merely omitting those fields from the API does not avoid transcript I/O or memory. A metadata-only path is a Phase 1 prerequisite.

Responsibilities:

- use a new public Pi `SessionManager.listMetadata()` streaming API, or a small version-pinned streaming JSONL indexer until that API lands;
- read only the header, entry count, first user-title candidate, latest `session_info`, parent indicator, and required timestamps with bounded per-file memory;
- maintain incremental index state keyed by `(device, inode, canonical path)`: last parsed byte offset, file size, mtime, entry count, latest metadata, and whether the previous final record was incomplete; for append growth, read only new bytes; rebuild from zero on inode change, shrink/truncate, schema/version change, or parser inconsistency; debounce watcher events and place a hard concurrency/I/O budget on reconciliation;
- read/validate authoritative headers;
- group by canonical cwd;
- never retain or return `allMessagesText`;
- detect deleted/moved sessions;
- flag missing cwd;
- merge provisional/managed sessions from SQLite;
- watch session roots for changes, with periodic reconciliation as fallback;
- benchmark large session trees and clear temporary transcript buffers immediately.

Prefer upstreaming `listMetadata()` so the JSONL parser/schema stays owned by Pi rather than duplicating it permanently.

#### Runtime supervisor

Responsibilities:

- start/stop/inspect private tmux server and sessions;
- generate opaque runtime/tmux names;
- invoke a fixed `pi-remote-runner <runtime-id>` command;
- runner loads canonical cwd/session/arguments from trusted local state and spawns Pi with argv;
- never interpolate user names/paths into shell commands;
- bind runtime to expected Pi session ID/path and bridge token;
- attach one relay PTY;
- reconcile after daemon restart;
- never auto-restart Pi after unexpected exit;
- offer explicit recover/resume.
- detect pane/runner termination independently of the bridge;
- read `pane_dead_status` from the retained tmux pane;
- classify graceful exit, signal termination, runner failure, and unknown loss;
- never require a final bridge event to mark a process exited;

Why use a runner: tmux accepts a shell command. Passing only an opaque generated runtime ID to a fixed runner avoids quoting untrusted project/session paths in a shell string. The runner resolves those paths from a user-private `0600` registry and uses `spawn`/`exec` semantics.

#### Terminal relay

Responsibilities:

- consume the single supervisor PTY output stream;
- assign monotonically increasing output sequence numbers;
- keep a bounded byte ring buffer;
- keep a headless terminal model or request a forced tmux redraw for snapshots;
- send snapshot + deltas on reconnect;
- serialize all direct/editor-mutating input through one arbiter;
- enforce the per-connection controller lease token for input and resize;
- deduplicate every input source with one sequence space;
- debounce and bound resize;
- answer/forward supported terminal capability negotiation;
- disable dangerous OSC behaviors such as remote clipboard writes;
- enforce frame and rate limits.
- the supervisor PTY is always drained into the headless model and bounded ring; a slow browser never pauses the shared PTY; each WebSocket has its own bounded outbound queue and applied-sequence acknowledgement window; when a client exceeds either limit, stop sending deltas, mark it `resync-required`, and disconnect or replace its queue with a later snapshot; a slow spectator cannot affect the controller or Pi process;
- The server-side headless terminal is the sole outer-terminal capability responder. Terminal-generated replies use a dedicated, bounded system-input channel to the tmux PTY; they do not require a controller lease and never consume user `clientSeq` values.
- Browser terminals are renderers and user-input producers only. While applying server output, parser-generated `onData` replies are suppressed and are never forwarded upstream. Read-only spectators never send terminal replies.
- Use one fixed, tested capability profile for colors, cell/pixel dimensions, keyboard protocol, clipboard, and unsupported queries. Do not derive protocol replies from whichever browser happens to be connected.

#### Pi bridge extension

Responsibilities:

- connect only to a private Unix socket with a per-launch capability token;
- prove session/runtime identity;
- emit `agent_start`, `agent_end`, and `agent_settled`;
- emit graceful `session_shutdown` when available;
- emit structured extension/agent errors that Pi publicly exposes;
- use a future upstream UI-open/UI-close hook for authoritative approval/question attention; do not claim this state before that hook exists;
- expose lease-safe structured mutations such as rename or `setEditorText` only after corresponding core APIs exist;
- avoid transcript/tool payloads by default;
- preserve normal interactive UI and all other extensions;
- reconnect without blocking Pi;
- never expose an HTTP listener.
- the bridge socket lives in a `0700` runtime directory and is mode `0600`; messages use length-prefixed, versioned schemas with strict size/rate limits; the first message proves launch ID, session ID, runtime ID, random launch capability, and protocol version; mutating requests include an action ID and receive an explicit idempotent acknowledgement;
- capabilities never appear in argv, URLs, logs, push payloads, or terminal output; store only a hash in SQLite; define token delivery and daemon-restart reconnect behavior before enabling bridge mutations;
- this protects against accidental/spoofed IPC but is not a security boundary against arbitrary code already running as the same macOS user; hardened separation requires another OS user or VM;

#### Auth/device service

Responsibilities:

- create pairing tickets **only** from the local CLI or a user-permissioned Unix admin socket; never infer “local admin” from an HTTP loopback peer, because Tailscale/reverse-proxy traffic also arrives from loopback;
- use a 256-bit, single-use, one-minute pairing secret. A QR may put it in the URL fragment so it is not sent in the HTTP request/referrer; client code removes the fragment immediately and POSTs the secret once;
- exchange the ticket for a short-lived WebAuthn registration ceremony;
- register a passkey bound to the stable Tailscale HTTPS RP ID/origin;
- persist WebAuthn credential ID, public key, user/RP binding, signature counter, transports, creation/last-use/revocation timestamps, plus expiring single-use challenges;
- implement assertion login, counter verification, logout, renewal, device list, revoke, and revoke-all;
- issue a secure application cookie only after successful assertion; terminate active WS connections on expiry/revocation;
- validate Tailscale identity as an additional proxy assertion, not the only session mechanism;
- use short-lived single-use WebSocket tickets if cookie-only WS admission is not selected.
- request and verify `userVerification: "required"`;
- use `attestation: "none"` unless a documented hardware-attestation policy is intentionally introduced;
- persist backup eligibility/state (BE/BS) as well as sign count;
- a zero counter is treated as unsupported; a nonzero regression is a risk signal handled according to credential backup state, not an unconditional generic "cloned phone" assertion;
- bind each challenge transaction to ceremony type, claimed pairing ticket, expected RP ID/origin, user handle, and initiating web session; consume it atomically;

Authentication is based on paired WebAuthn credentials. Consumer passkeys may sync across devices, so a credential is not claimed to identify one physical phone. Device revocation means credential + application-session revocation. Strict single-device binding would require a separately documented policy for non-backup-eligible credentials or hardware authenticators and is not the v1 default.

The canonical application origin is exactly `https://<pinned-machine-name>.<tailnet-name>.ts.net` on port 443. The RP ID is that exact host, not the tailnet parent domain, short MagicDNS name, IP address, localhost, or an alternate alias. The server rejects all other Host/Origin values.

`pi-remote doctor` verifies that the configured Serve FQDN, TLS certificate, RP ID, and expected origin still match. Renaming the Tailscale node or tailnet requires local recovery and re-pairing; existing credentials are not assumed to migrate.

### 6.3 Data model

Suggested SQLite tables:

```text
projects
  id, canonical_path, display_name, pinned, created_at, updated_at

runtimes
  id, project_id, pi_session_id, canonical_session_path nullable,
  tmux_name, launch_id, process_state, agent_state, exit_code nullable,
  cols, rows, created_at, started_at, exited_at, last_seen_at

credentials
  id, display_name, webauthn_credential_id, public_key, rp_id,
  user_handle, sign_count, transports_json, created_at,
  last_seen_at, revoked_at

webauthn_challenges
  id_hash, ceremony_type, device_id nullable, expires_at, consumed_at

web_sessions
  id_hash, device_id, expires_at, last_seen_at, revoked_at

controller_leases
  runtime_id, device_id, connection_id, lease_token_hash,
  expires_at, updated_at

uploads
  id, device_id, runtime_id nullable, canonical_path, mime, size,
  created_at, expires_at, consumed_at

push_subscriptions
  id, device_id, endpoint_ciphertext, key_ciphertext, created_at, revoked_at

audit_events
  id, timestamp, device_id nullable, runtime_id nullable,
  event_type, outcome, metadata_json
```

Do not store raw prompts, terminal bytes, provider tokens, or complete transcript content.

### 6.4 Runtime state machine

Process state and agent state are orthogonal:

```text
Process state:
  provisioning -> starting -> alive -> stopping -> exited
                              |         |
                              |         -> lost
                              -> orphaned
  startup failure -> launch-failed

Agent state, valid only while process state is `alive`:
  unknown -> idle
  idle -> running                 on agent_start
  running -> idle                 on agent_settled
  running/idle -> needs-attention on authoritative ui_request_opened
  needs-attention -> running/idle on ui_request_closed
  running -> error -> idle/running on the next valid event
```

`settled` is a dashboard label for `(process=alive, agent=idle)`, not a terminal runtime state. After daemon restart, agent state is `unknown` until the bridge reconnects or emits a new event.

`needs-attention` exists only when backed by the upstream Pi UI lifecycle hook.

Never treat a stale SQLite state as proof that a process exists. On startup verify:

1. private tmux server/session exists;
2. launch ID stored in tmux metadata matches;
3. pane command/process is the fixed runner/Pi chain;
4. expected cwd and Pi session binding match;
5. a single relay can reattach.

If verification fails, mark `orphaned` or `lost`; do not spawn a duplicate automatically.

### 6.5 Terminal WebSocket protocol

Use versioned messages. A simple framing approach:

```text
JSON control frames:
  hello { protocol, runtimeId, streamEpoch?, lastAppliedOutputSeq?, cols, rows }
  welcome { role, leaseToken?, state, latestSeq, snapshotFollows }
  resize { leaseToken, cols, rows, clientSeq }
  input { leaseToken, clientSeq, source, dataBase64 or binaryFrameId }
  ping/pong
  error

Binary frames:
  0x01 + output sequence + PTY bytes
  0x02 + snapshot-format/version + snapshot sequence + ANSI snapshot bytes
  0x03 + input frame

Input binary frame:
  type:u8 | clientSeq:u64be | source:u8 | payloadLength:u32be | payload

The authenticated WebSocket is already bound to the server-issued connection and current controller lease, so the lease token is not repeated in every binary frame. HTTP side-channel insertion requests carry a hashed lease capability plus the same client sequence space.

Define all binary fields, integer widths, endianness, maximum payloads, and error behavior in `docs/protocol.md`.
```

Requirements:

- the server creates `connectionId`; the browser never chooses or reuses it;
- every relay has a random `streamEpoch`;
- resume position is `(streamEpoch, lastAppliedOutputSeq)`;
- a fresh page/client always requests a snapshot; delta-only reconnect is allowed only when the same in-memory browser terminal still exists, the epoch matches, and its last sequence was acknowledged after the xterm.js write callback;
- strict increasing input sequence per controller connection to reject duplicates after reconnect;
- composer, voice, upload-reference, direct terminal, and future structured actions share the same sequence space and arbiter;
- server acknowledges accepted input sequence;
- no automatic retry of unacknowledged destructive input without user confirmation;
- bounded frame size;
- heartbeat and idle timeout;
- reconnect with last received output sequence;
- snapshot when requested sequence has fallen out of the ring;
- protocol and snapshot-format rejection rather than silent compatibility guessing.

### 6.6 Snapshot and replay strategy

Each relay has a random `streamEpoch` and a monotonically increasing `outputSeq`. Sequence identity is the pair `(streamEpoch, outputSeq)`; sequence numbers alone are not valid across relay/daemon restarts.

The daemon maintains a pinned `@xterm/headless` terminal for every live relay, using the same xterm.js version, rows, columns, Unicode provider, scrollback limit, and relevant terminal options as the browser client. Every PTY output chunk is applied to the headless terminal before it is eligible for snapshot/fan-out acknowledgement.

For a fresh client, an epoch mismatch, or ring overflow:

1. Establish a snapshot barrier at output sequence S and wait until the headless parser has applied all output through S.
2. Serialize the headless terminal using the pinned SerializeAddon.
3. Reset the browser terminal, apply the versioned serialized snapshot, then apply deltas beginning at S+1.
4. Reject incompatible snapshot/xterm versions rather than guessing.

After daemon restart, attach a new supervisor tmux client and allow tmux's initial attach redraw to populate a fresh headless model before admitting browser clients. `tmux capture-pane` may be used separately for bounded plain-text history, but it is not the source of terminal modes or an authoritative reconnect snapshot.

If the implementation requests an explicit tmux refresh, the command is `tmux refresh-client -t <client>` with no `-R`; command completion is not treated as an output barrier.

`tmux` keeps process/screen state, not browser xterm state. Define the guarantee as **current visual state plus bounded recent output**, not unlimited historical scrollback or every external-terminal side effect.

The snapshot version explicitly covers visible/alternate-buffer content, ANSI styles, cursor placement, and a bounded history window. It does **not** promise scrollback older than the configured capture/ring limit, Kitty images, OSC clipboard state, or external application state.

Pi/tmux input mode is tracked by the long-lived supervisor client; the browser's mobile input adapter sends known CSI-u/bracketed-paste sequences rather than deriving destructive input from a stale screen snapshot.

Test normal and alternate screen, cursor position, wrapped Unicode, ANSI styles, hyperlinks, bracketed paste, mouse modes if supported, ring overflow, output arriving during snapshot generation, and daemon restart while alternate-screen, bracketed-paste, cursor-hidden, mouse, and extended-key modes are active.

### 6.7 Process and filesystem boundaries

Browser APIs use opaque IDs, never arbitrary paths. Server-side rules:

- canonicalize with `realpath`;
- resolve symlinks before containment checks;
- require a path to be in the project/session/upload allowlist;
- verify session header ID and cwd;
- reject missing/replaced paths between validation and launch where possible;
- use argv-based child creation;
- use a private tmux socket and random internal names;
- run as a non-admin user;
- never run as root;
- do not expose package installation, provider token display, arbitrary file browsing, or generic shell endpoints in v1.
- for a new path, canonicalize and authorize its existing parent directory, then create the child with an application-generated basename, exclusive creation, and no symlink following; after open/create, verify the file descriptor's type, owner, mode, and inode before use; upload finalization uses an atomic rename within the same authorized directory;
- for existing paths, containment checks are separator-aware and use the canonical target; revalidate immediately before launch and record the expected device/inode where practical; document the residual same-UID race that cannot be eliminated with path strings alone;
- a cwd learned from an untrusted/session JSONL header is a discovery candidate, not automatically an allowed root for creating new sessions; new-session roots must be pinned, trusted through a public Pi trust API, or explicitly approved; resume may use the original cwd only after displaying and validating it;

Pi itself can execute arbitrary shell commands and can leave the project directory. Filesystem allowlists protect dashboard APIs, **not Pi**. Strong containment requires a separate OS user or VM.

---

## 7. Security design

### 7.1 Threat model summary

A successful attacker could gain everything available to the macOS user running Pi: repositories, shell execution, SSH credentials, provider tokens, session transcripts, cloud mounts, and API spend. Treat the UI like remote SSH with additional browser/XSS risks.

Threats include:

- Internet/LAN/tailnet attackers;
- a compromised tailnet device;
- a malicious website using CSRF or WebSocket hijacking;
- XSS from model, tool, terminal, filename, Markdown, or ANSI output;
- lost/stolen phone or copied pairing QR;
- replayed cookies/WS tickets;
- concurrent clients and duplicate input;
- malicious Pi extensions/dependencies;
- resource/API-cost denial of service;
- session JSONL concurrent writers.

### 7.2 Required controls before phone access

#### Network

- Bind only to loopback or a Unix socket.
- Use Tailscale Serve, not Funnel.
- Tailnet ACL grants access only from the user's device identity to this service.
- No router port forward or UPnP.
- Fail startup if a production configuration requests unauthenticated wildcard bind.

#### Authentication

- `pi-remote pair` (or a `0600` Unix admin socket) is the only pairing-ticket creation path. Do not offer an unauthenticated HTTP “local admin” endpoint and do not trust loopback source addresses behind a proxy.
- Pair with an expiring single-use QR/code; if the QR carries the secret, use a URL fragment, remove it immediately, never log it, and invalidate it after one POST or one minute.
- Use a complete WebAuthn registration/assertion ceremony tied to a stable HTTPS RP ID/origin, with unpredictable expiring challenges and signature-counter checks.
- Issue `__Host-` cookies with `Secure; HttpOnly; SameSite=Strict; Path=/`, no `Domain` attribute, random server-side session ID, rotation after authentication, and idle/absolute expiry.
- Rotate the session after pairing/authentication; implement logout and renewal.
- Server-side device/session revocation and short idle/absolute expiry; revocation closes active WebSockets and releases the controller connection.
- No reusable bearer tokens in query strings, localStorage, IndexedDB, screenshots, or logs.

#### Browser/API

- Exact Origin allowlist for every state-changing HTTP request and WS handshake.
- CSRF token for state-changing HTTP endpoints.
- Authenticate before WebSocket upgrade and authorize every runtime action.
- Restrictive CSP, `frame-ancestors 'none'`, no third-party scripts, `nosniff`, `no-referrer`, and `Cache-Control: no-store` for private responses.
- Strict schemas, bounded bodies/frames, rate limits, connection limits, backpressure.

#### Output safety

- xterm output is bytes/text, never `innerHTML`.
- Register safe handlers for OSC hyperlinks/title/clipboard.
- Disable OSC 52 clipboard writes by default.
- Open only `https:`/`http:` links after explicit user action; consider requiring confirmation.
- Any later Markdown view uses a strict sanitizer and blocks unsafe SVG/data/javascript schemes.

#### Runtime

- One controller and one Pi writer.
- Explicit takeover.
- Local emergency stop/kill command.
- `stop` requests graceful Pi/session shutdown and then terminates the managed pane process group after a timeout; `kill` force-terminates the managed pane process group; neither operation guarantees removal of deliberately daemonized or independently detached descendants; strong process-tree containment requires the later dedicated-user/VM profile and is not a v1 guarantee;
- No automatic process restart after a crash.
- Resource limits for concurrent runtimes, terminal buffer, upload size, recording duration, and model usage where possible.

#### Secrets and logs

- Structured metadata logs only.
- Redact cookies, headers, paths where appropriate, and all provider credentials.
- Terminal recording disabled by default.
- Push notifications omit prompt/output text by default.
- Static service-worker cache only; no session/API/terminal caching.

### 7.3 Local hardening before deployment

- Audit `/Users/bgdn0083/.pi/agent/.env` permissions; if it contains credentials, set `0600` and rotate any potentially exposed secrets.
- Keep `/Users/bgdn0083/.pi/agent/auth.json` at `0600`.
- Review every configured Pi extension/package as privileged local code.
- Run Pi Remote as the normal non-admin user initially so existing sessions/config work, but understand that the UI then controls that user's full Pi authority.
- Hardened mode should use a dedicated macOS user or VM with only explicit repositories and credentials.
- Use FileVault, device auto-lock, and remote phone revocation.

Authoritative references:

- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale ACLs](https://tailscale.com/docs/features/access-control/acls)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- [xterm.js security guide](https://xtermjs.org/docs/guides/security/)
- [RFC 6455 Origin considerations](https://www.rfc-editor.org/rfc/rfc6455#section-10.2)

---

## 8. API sketch

All resource IDs are opaque. Paths are output-only display fields and are never accepted for runtime/session operations.

```text
GET    /api/v1/health
GET    /api/v1/me
POST   /api/v1/pairing/claim                 consume CLI-created one-time ticket
POST   /api/v1/webauthn/register/options     claimed ceremony only
POST   /api/v1/webauthn/register/verify
POST   /api/v1/webauthn/authenticate/options
POST   /api/v1/webauthn/authenticate/verify
POST   /api/v1/auth/renew
POST   /api/v1/auth/logout
POST   /api/v1/auth/step-up/options
POST   /api/v1/auth/step-up/verify
GET    /api/v1/devices
DELETE /api/v1/devices/:deviceId

GET    /api/v1/projects
POST   /api/v1/projects/:projectId/pin
DELETE /api/v1/projects/:projectId/pin
GET    /api/v1/projects/:projectId/sessions
POST   /api/v1/projects/:projectId/runtimes  new session

POST   /api/v1/sessions/:sessionId/resume
PATCH  /api/v1/sessions/:sessionId           rename

GET    /api/v1/runtimes
GET    /api/v1/runtimes/:runtimeId
POST   /api/v1/runtimes/:runtimeId/stop
POST   /api/v1/runtimes/:runtimeId/kill
POST   /api/v1/runtimes/:runtimeId/takeover
WS     /api/v1/runtimes/:runtimeId/terminal

POST   /api/v1/runtimes/:runtimeId/voice     current controller lease required; transcribe only
POST   /api/v1/runtimes/:runtimeId/uploads   stage only
POST   /api/v1/runtimes/:runtimeId/insert    current controller lease required
DELETE /api/v1/uploads/:uploadId

POST   /api/v1/push/subscriptions
DELETE /api/v1/push/subscriptions/:id
```

WS admission uses the `__Host-` application session cookie, exact Origin validation, a fixed `Sec-WebSocket-Protocol` value, and authorization before upgrade. No bearer credential is accepted in a URL or query string. WebSocket compression/permessage-deflate is disabled.

A successful WebAuthn step-up issues a one-use, <=60-second action grant bound to web session, credential, action type, runtime ID, and server nonce. Stop/kill and forced takeover of a live lease consume this grant atomically. Ordinary acquisition after a genuinely expired lease is not a forced takeover. Session renewal alone is not step-up authentication.

High-risk stop/kill/takeover actions require recent authentication or a local confirmation policy in hardened mode.

---

## 9. Repository structure

```text
pi-remote/
├── apps/
│   ├── server/
│   │   ├── src/auth/
│   │   ├── src/http/
│   │   ├── src/indexer/
│   │   ├── src/runtime/
│   │   ├── src/terminal/
│   │   ├── src/voice/
│   │   ├── src/uploads/
│   │   ├── src/notifications/
│   │   └── src/db/
│   └── web/
│       ├── src/pages/
│       ├── src/components/dashboard/
│       ├── src/components/terminal/
│       ├── src/components/mobile-input/
│       ├── src/components/pairing/
│       └── src/pwa/
├── packages/
│   ├── protocol/
│   ├── pi-bridge/
│   ├── runner/
│   └── test-fixtures/
├── config/
│   └── tmux.conf
├── scripts/
├── docs/
│   ├── threat-model.md
│   ├── operations.md
│   ├── protocol.md
│   └── troubleshooting.md
└── package.json
```

Use one lockfile and exact Pi version pin. The server and runner must fail fast on an unsupported Pi version.

---

## 10. Implementation phases

### Phase 0 — terminal and Pi compatibility spike

> **Status: ✅ COMPLETE** — go/no-go passed; see [Phase 0 checklist](#phase-0-checklist--complete) at the top of this document. Remaining matrix items are tracked as unchecked boxes there.

**Purpose:** retire the highest-risk assumptions before building product UI.

Deliverables:

1. Start Pi 0.83.0 inside `tmux -L pi-remote` with the isolated config.
2. Attach one `node-pty` relay and render with xterm.js.
3. Verify terminal query negotiation, truecolor, alternate screen, resize, hyperlinks, bracketed paste, CSI-u, and Unicode width.
4. Verify Pi's built-in slash/path autocomplete.
5. Build a terminal-compatibility matrix and verify every currently installed extension remotely where applicable:
   - `ask-question.ts` dialogs;
   - provider extensions;
   - prompt/session/path autocomplete;
   - custom widgets, overlays, custom editor, raw-input listeners, mouse behavior, and terminal queries through fixtures;
   - Kitty/CSI-u key press, repeat, and release sequences, including the standalone Shift events expected by `voice-input.ts`;
   - external editor/app launch and clipboard behavior, documenting browser-safe fallback or unsupported status.
6. Verify the existing Mac-microphone voice shortcut locally, but classify phone voice as the separate side-channel feature in Phase 5 rather than claiming PTY compatibility.
7. Verify tmux keeps Pi alive after browser and relay disconnect.
8. Prototype forced redraw/snapshot and sequence replay.
9. Document unsupported inline-image and external-terminal behavior.

Exit criteria:

- no duplicated/lost keyboard bytes;
- Shift+Enter/newline and steering keys work via explicit toolbar sequences;
- reconnect restores a coherent screen;
- Pi survives network/browser loss.

Estimated effort: **2–4 engineering days**.

### Phase 1 — local-only vertical slice

> **Status: ✅ COMPLETE** — see [Phase 1 checklist](#phase-1-checklist--complete). CI pipeline and full PWA polish are the only deferred items (CI is not a release blocker for the local slice; PWA polish is Phase 4).

Deliverables:

- TypeScript workspace and CI;
- loopback-only Fastify server;
- upstream `SessionManager.listMetadata()` or a version-pinned bounded JSONL metadata indexer; do not use `listAll()` as the steady-state index;
- project/session dashboard;
- create new sessions and attach existing managed runtimes; persisted-session resume remains disabled until the core lease is present;
- private tmux supervisor and fixed runner;
- one relay PTY per runtime;
- terminal WebSocket v1;
- one per-connection controller lease and unified input arbiter;
- basic mobile PWA shell;
- explicit warning for ownership-unknown sessions.

No remote access until Phase 3 security gates pass.

Exit criteria:

- desktop browser can list, create, attach, stop, and recover sessions;
- a browser reload never starts a second Pi process;
- blank/provisional sessions appear correctly;
- daemon restart reconciles tmux runtimes.

Estimated effort: **7–10 engineering days**.

### Phase 2 — core lease and durable reconnect

> **Status: ✅ COMPLETE** — the ADR-6 session write lease ships in a pinned private Pi build (`bogdan0083/pi@pi-remote-session-lease`; vendored as `vendor/pi-session-lease-v0.83.0-7c1f13c.patch`; upstream PR to `earendil-works/pi` still pending). The daemon verifies `pi --capabilities` (`sessionWriteLease: 1`) at `init`/`serve` and fails closed without it. Persisted-session resume is strictly lease-gated: a live or unverifiable foreign lease yields HTTP 409 `open-elsewhere` with safe owner metadata; there is no confirmation bypass. Snapshots are protocol v2 `ansi-v1` (pinned `@xterm/headless` model, exact barrier, seed-before-attach ordering, 1000-line bounded scrollback). Exit criteria verified by `scripts/lease-e2e.mjs` (real-Pi concurrent writer rejection) and the `session-lease` / `resume-policy` / `pi-capabilities` / `relay-snapshot` / `runtime-state` test suites.

Deliverables:

- upstream/local Pi session write lease;
- persisted-session resume;
- owner metadata and clear “open elsewhere” error;
- lease lifecycle tests for new/switch/fork/clone/rename/shutdown/crash;
- output sequence ring and snapshot barrier;
- versioned `ansi-v1` tmux capture/redraw snapshot with bounded-history semantics;
- runtime state machine and restart reconciliation;
- bounded logs/buffers and explicit lost/orphaned states.

Exit criteria:

- concurrent writer test always rejects the second Pi process;
- daemon restart during idle and active streaming never duplicates Pi;
- tmux loss marks runtime lost without auto-restarting;
- reconnect after output-ring overflow receives a correct snapshot.

Estimated effort: **8–15 engineering days plus upstream review latency**, including Pi core changes and review.

### Phase 3 — security and remote access

> **Status: ⏳ NOT STARTED** — the local slice already ships the loopback-only bind and an exact browser-Origin allowlist; WebAuthn pairing, Tailscale Serve ingress, CSRF, secure cookies, one-time WS tickets, and launchd are this phase.

Deliverables:

- CLI/Unix-socket-only pairing-ticket creation and device management;
- full WebAuthn registration/assertion/logout/renewal and secure cookies;
- stable HTTPS RP ID/origin and challenge/counter persistence;
- Origin, CSRF, WS authentication, and per-action authorization;
- one-time WS tickets if selected;
- CSP/security headers/no-store policy;
- rate/body/frame/connection limits;
- safe OSC/link/clipboard policy;
- Tailscale Serve setup command and narrow ACL guide;
- audit metadata and local emergency kill command;
- launchd service with loopback-only binding;
- secret-permission preflight checks.

Exit criteria:

- no unauthenticated or wrong-Origin control path;
- revoked phone loses HTTP and active WS access promptly;
- service cannot be configured to public unauthenticated wildcard bind accidentally;
- threat-model test checklist passes.

Estimated effort: **5–8 engineering days**.

### Phase 4 — phone-quality UX

> **Status: 🟡 IMPLEMENTED; PHYSICAL-DEVICE ACCEPTANCE PENDING** — the production implementation now includes an ultra-compact iPhone SE portrait/landscape terminal, `visualViewport` + `100dvh` sizing, safe areas, 8–10 px mobile terminal fonts, direct/composer modes, IME-safe bracketed paste, one-shot/locked modifiers, persistent reconnect/takeover banners, session-scoped uploads with `@file` insertion, built-in CLI pairing QR, generated PWA icons, standalone metadata, and a static-assets-only service worker with an explicit update prompt. Chromium and WebKit mobile tests cover 375×667 portrait, 667×375 landscape, a 667×220 keyboard-height viewport, Unicode split across WS frames, snapshot ordering, IME, paste, arrows, Ctrl, modified Enter, and uploads. Real iPhone Safari/PWA and Android Chrome/PWA runs remain required before the phase exit criteria can be marked complete.

Implementation checklist:

- [x] portrait/landscape and ultra-short responsive terminal;
- [x] `visualViewport`/`100dvh` keyboard handling and safe-area insets;
- [x] shortcut toolbar with one-shot/locked Ctrl, Alt, and Shift;
- [x] direct terminal and native composer modes with composition-aware IME;
- [x] memory-only draft cleared after paste and excluded from service-worker caches;
- [x] connection, reconnect, read-only, and takeover banners;
- [x] bounded camera/file uploads and controller-gated Pi `@file` insertion;
- [x] single-use CLI QR onboarding with fragment scrubbing;
- [x] raster/maskable/Apple PWA icons, standalone metadata, and update prompt;
- [x] automated Chromium + WebKit mobile viewport/input/upload coverage;
- [ ] physical iPhone Safari/PWA acceptance;
- [ ] physical Android Chrome/PWA acceptance.

Deliverables:

- portrait/landscape responsive terminal;
- keyboard-open/closed viewport handling with `100dvh`/safe areas;
- shortcut/modifier toolbar;
- direct and native-composer input modes;
- composition-aware IME;
- local draft that is cleared after insert/send and never placed in service-worker cache;
- connection/reconnect/takeover banners;
- camera/file upload and Pi `@file` insertion;
- QR onboarding;
- PWA icons/standalone mode.

Exit criteria:

- tested on real iPhone Safari/PWA and Android Chrome/PWA;
- orientation and soft-keyboard changes never resize terminal to zero or duplicate input;
- Unicode/IME, paste, arrows, escape, tab, Ctrl+C/D, and modified Enter behavior pass.

Estimated effort: **5–8 engineering days**.

### Phase 5 — voice, semantic status, and notifications

> **Status: ⏳ NOT STARTED** — first step is refactoring the concrete transcription pipeline out of `~/.pi/agent/extensions/voice-input.ts` into a shared host module; the phone microphone side channel, Pi bridge extension, and Web Push follow.

Deliverables:

- shared concrete DashScope/Qwen transcription pipeline;
- browser codec allowlist plus pinned ffmpeg decode/resample to mono 16 kHz WAV;
- phone `MediaRecorder` flow and cleanup on every outcome;
- lease-protected transcript insertion through the unified input arbiter;
- Pi bridge extension over private Unix socket;
- running/settled/error/exit statuses from existing public events;
- upstream Pi UI-open/UI-close lifecycle hook before enabling authoritative attention status;
- Web Push subscriptions and deep links;
- focused-session notification suppression;
- optional browser TTS experiment.

Exit criteria:

- Safari MP4/AAC and Chromium WebM/Opus recordings both transcode and transcribe without exposing provider credentials;
- raw/transcoded audio retention is zero by default, including failures/timeouts;
- settled/error/exit notifications contain no secret content by default;
- needs-input notifications are enabled only if the upstream lifecycle hook passes integration tests;
- bridge failure never blocks or crashes Pi.

Estimated effort: **8–15 engineering days if voice and Web Push remain in scope; voice is omitted rather than shipped with an unisolated general media decoder**.

### Phase 6 — hardening and release

> **Status: ⏳ NOT STARTED**

Deliverables:

- real-device regression matrix;
- chaos tests;
- dependency/license review and SBOM;
- installation/update/rollback docs;
- operational backup/recovery docs;
- diagnostics export with secret redaction;
- optional Cloudflare Access deployment guide;
- beta release.

Estimated effort: **4–7 engineering days**.

### Overall estimate

Engineering effort, excluding external review/merge latency:

- Useful local MVP through Phase 2: **17–29 engineering days**.
- Secure personal beta through Phase 4: **27–45 engineering days**.
- Polished v1 including voice/notifications/hardening: **39–67 engineering days**, plus **30–50% contingency** if WebAuthn/iOS PWA, audio codecs, or terminal snapshot work requires a fallback.

Phase 0 is a go/no-go gate for tmux input fidelity, sole terminal-protocol response, headless serialization, daemon reattach, and launchd environment. Re-estimate after each spike; upstream review latency remains separate.

Calendar time for upstream Pi review/release of the session lease, metadata API, and UI lifecycle hook is separate and may dominate the schedule. If those changes are not accepted in time, pin a private Pi build; do not weaken the ownership or notification claims. A reduced release may omit authoritative needs-input notifications and use the documented tmux redraw snapshot.

The range is dominated by terminal protocol fidelity, mobile Safari behavior, upstream Pi changes, and real-device testing—not by dashboard CRUD.

---

## 11. Testing strategy

### 11.1 Unit tests

- cwd/session canonicalization and containment;
- session header validation;
- metadata redaction;
- project grouping and ordering;
- runtime state transitions;
- per-connection controller lease acquisition, renewal, expiry, same-device second-tab behavior, and takeover;
- unified direct/composer/voice/upload input sequencing and deduplication;
- frame/body/rate limits;
- auth cookie, pairing expiry, revocation;
- upload filename/MIME/TTL rules;
- log redaction.

### 11.2 Pi integration tests

Use a temporary `PI_CODING_AGENT_DIR`, temporary session root, fake provider/model, and fixture extensions.

Test:

- create blank and persisted sessions;
- resume by exact ID/path;
- fork/clone/tree operations inside TUI;
- project trust prompt;
- global/project extension discovery;
- custom command/autocomplete/widget/editor/raw-input/overlay fixtures;
- every currently installed local extension against the documented compatibility matrix;
- standalone modifier press/repeat/release sequences used by the voice extension;
- model/thinking changes;
- compaction and reconnect;
- duplicate write lease;
- process exit while streaming.

### 11.3 Terminal fidelity matrix

- printable ASCII and Unicode;
- combining characters, emoji, CJK width;
- IME composition;
- Enter/newline/steer/follow-up;
- Escape, Tab, Shift+Tab;
- arrows, Home/End, PageUp/PageDown;
- Ctrl/Alt/Shift combinations;
- Ctrl+C, Ctrl+D, Ctrl+L;
- bracketed paste with multiline text;
- mouse/touch selection and copy;
- truecolor and ANSI reset;
- hyperlinks with safe schemes;
- alternate screen;
- cursor show/hide and application modes;
- rapid resize and orientation change.

### 11.4 Browser E2E

Playwright projects:

- Chromium desktop;
- WebKit desktop approximation;
- iPhone and Android viewports;
- PWA-like standalone viewport;
- keyboard-open simulated viewport changes;
- offline/online transitions;
- stale cookie, revoked device, wrong Origin;
- second-client read-only/takeover.

Run final acceptance on physical iOS and Android devices because desktop emulation does not reproduce mobile keyboard, PWA backgrounding, permission, or WebSocket suspension behavior.

### 11.5 Chaos tests

During idle and active agent output:

- close/reopen browser;
- switch Wi-Fi/cellular/Tailscale connectivity;
- background phone for 1, 5, and 20 minutes;
- restart daemon;
- kill relay PTY;
- kill tmux server;
- kill Pi child;
- fill output ring;
- rotate/revoke application session;
- attempt controller takeover;
- rename/delete/move project or JSONL file;
- exhaust disk or reach upload/buffer limit.

Expected behavior must be explicit: reconnect, lost, orphaned, rejected, or manual recovery—never silent duplicate execution.

### 11.6 Security tests

- unauthenticated API and WS access;
- cross-site WebSocket hijacking;
- missing/forged Origin;
- CSRF;
- HTTP attempts to create an admin pairing ticket;
- expired/replayed pairing code and WebAuthn challenge;
- wrong RP ID/origin, cloned credential/sign-counter regression, logout/renewal;
- replayed WS ticket;
- session fixation;
- path traversal and symlink swap;
- arbitrary tmux name/path injection;
- shell metacharacters in project/session names;
- oversized/compressed WS frames;
- output flood/backpressure;
- XSS/unsafe URL/OSC 52/title sequences;
- upload polyglots and executable files;
- malformed WebM/MP4, external-reference containers, decompression bombs, forced-demuxer/protocol bypass, ffmpeg timeout, output cap, and process-group cleanup;
- lost-phone revocation during an active connection;
- dependency audit and malicious extension fixture.

---

## 12. Operational design

### 12.1 Commands

Proposed CLI:

```text
pi-remote init
pi-remote serve
pi-remote status
pi-remote pair
pi-remote devices
pi-remote revoke <device>
pi-remote list
pi-remote attach <runtime>
pi-remote stop <runtime>
pi-remote doctor
pi-remote tailscale enable
pi-remote tailscale disable
```

`pi-remote doctor` should verify:

- supported Node/Pi/tmux versions;
- private tmux config and CSI-u support;
- Pi config/session root permissions;
- daemon bind address;
- Tailscale availability/Serve state;
- auth/device state;
- stale/orphaned runtimes;
- dangerous `.env` permissions;
- writable storage and buffer limits.

### 12.2 Service lifecycle

- Install as a user `launchd` agent on macOS.
- `pi-remote init` resolves and records absolute paths for the supported Node, Pi, tmux, runner, and optional media helper binaries. launchd and the runner never depend on asdf/npm/Homebrew shims being present on `PATH`.
- The launchd plist sets explicit `HOME`, locale, minimal `PATH`, and runtime directory values but contains no provider secrets. A locally administered `0600` environment policy may add approved PATH entries and non-secret tool variables; it is never editable through the browser. Pi continues to load provider credentials through its normal protected configuration.
- `doctor` compares the resolved Pi executable and package version against the configured exact version and verifies the effective environment seen inside a managed tmux pane.
- Keep the Mac awake according to explicit user preference; do not silently disable sleep forever.
- Daemon restart does not kill private tmux/Pi sessions.
- Updating the daemon first drains/reconciles relays; Pi processes continue in tmux.
- Updating Pi requires stopping or settling managed sessions because TUI/runtime behavior can change.
- Back up only Pi JSONL and minimal SQLite orchestration metadata; terminal replay buffers are disposable.

### 12.3 Observability

Metrics/status:

- active runtimes;
- attached/read-only clients;
- relay output/input rates;
- dropped/replayed bytes;
- snapshot count/failures;
- reconnect count;
- process exits;
- auth failures/rate limits;
- upload/audio usage;
- notification delivery state.

Logs contain IDs and state transitions, not terminal content. A diagnostic bundle must redact device credentials, cookies, paths if requested, session text, auth files, environment, and provider headers.

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Duplicate Pi writers | session tree corruption/unpredictable context | Pi core exclusive lease; one managed runtime per canonical path |
| Existing unmanaged live process | duplicate execution | cannot attach; show unknown; require stop/confirm; wrapper for future sessions |
| Mobile keyboard incompatibility | unusable TUI | explicit key toolbar, CSI-u adapter, composition-aware input, real-device tests |
| tmux/client resize races | broken rendering | one supervisor PTY and one controller; debounced bounded resize |
| Browser reconnect loses terminal state | confusing/corrupt screen | ordered ring, sequence handshake, snapshot barrier, forced redraw fallback |
| Voice extension sees Mac mic, not phone | voice unavailable | authenticated browser audio side channel and shared transcriber |
| XSS/terminal escape abuse | remote shell via browser session | xterm text rendering, safe OSC handlers, CSP, no third-party scripts |
| Tailnet device compromise | full Pi control | narrow ACL, app device auth, revocation, short sessions, optional passkey |
| Daemon crash during agent run | status loss | Pi stays in tmux; reconcile; never auto-duplicate |
| tmux crash/host reboot | live run lost | mark lost, recover persisted JSONL explicitly; no false guarantee |
| Pi API/schema drift | startup/runtime breakage | exact version pin, public imports, compatibility tests, fail-fast adapter |
| Extension side effects | host compromise | trusted packages only, review/pin, no remote package installation |
| iOS suspends PWA/WebSocket | apparent disconnect | tmux durability, reconnect banner, deep links, no unsafe auto-replay |
| Session metadata leaks | sensitive prompt/path exposure | authenticated API, minimum fields, no `allMessagesText`, no-store |
| Terminal images/external editor/clipboard differ under tmux/browser | partial terminal capability fidelity | explicit compatibility matrix and safe fallbacks; native artifact/editor support later |
| Pi lacks UI dialog lifecycle events | cannot know every needs-input state | notify only settled/error/exit until upstream UI-open/UI-close hook lands |

---

## 14. Definition of done for v1

The v1 is complete only when all of these are true:

1. From a paired phone on the tailnet, the user can see projects derived from existing Pi sessions and pinned/trusted roots.
2. The user can create a new session in a selected folder and sees the real Pi TUI.
3. The user can resume an inactive existing session with its original cwd, extensions, tools, models, and state.
4. Opening the same runtime twice attaches to one Pi process; it never starts a duplicate.
5. A second device/tab is read-only until explicit controller takeover.
6. Pi continues while the phone sleeps, changes network, closes the PWA, or the WebSocket drops.
7. Reconnect restores a coherent terminal screen without duplicating input.
8. The dashboard daemon can restart and reattach to verified tmux sessions without restarting Pi.
9. Pi/session/tmux loss is shown honestly as lost/orphaned and requires explicit recovery.
10. Slash/path/extension autocomplete and every installed extension pass the documented remote compatibility matrix; unsupported host-terminal capabilities have an explicit fallback or are clearly labeled.
11. Mobile input supports Unicode/IME, paste, Escape, Tab, arrows, Ctrl+C/D, newline, submit, steer, follow-up, and required CSI-u press/release controls.
12. Phone microphone transcription inserts editable text through the current controller's ordered input path, with credentials and raw/transcoded audio kept out of phone storage and logs.
13. Phone attachments can be staged read-only and referenced only by the active controller.
14. Settled/error/exit notifications deep-link to the correct runtime without leaking content on the lock screen; needs-input notifications are a release criterion only after the Pi UI lifecycle hook exists.
15. The server binds only to loopback, uses private Tailscale ingress, app authentication, strict Origin/CSRF checks, and secure WebSocket admission.
16. Revoking a phone terminates its active app session and controller lease.
17. Concurrent session writers are rejected at the Pi core/runtime level.
18. No transcript, terminal stream, provider credential, or bearer token appears in normal logs or caches.
19. Real iPhone and Android acceptance matrices pass.
20. Installation, update, rollback, emergency kill, and recovery procedures are documented and tested.

---

## 15. Recommended first implementation slice

> **Status: ✅ EXECUTED** — this slice is the shipped Phase 1 implementation in `~/projects/pi-remote` (all eight items below).

Do not start with native chat cards, diffs, Git worktrees, or a full IDE. Build this narrow vertical slice first:

1. A loopback dashboard lists projects and sessions using the new metadata-only Pi API or the bounded version-pinned fallback indexer.
2. “New” and “Resume” create a private tmux-managed real Pi process.
3. One xterm.js client receives the real TUI through one supervisor-owned PTY relay.
4. Closing/reopening the browser reattaches without restarting Pi.
5. A hard one-controller rule prevents interleaved input.
6. Run the terminal fidelity spike against the actual local extensions and keybindings.
7. Add the Pi core session lease before allowing unrestricted resume.
8. Only then add Tailscale/pairing and test from a real phone.

This slice proves the core proposition—**the same Pi experience, remotely and durably**—before investing in Codex-like semantic views.

---

## 16. Later roadmap

After v1 is stable:

1. **Structured action inbox:** first add an upstream Pi UI-open/UI-close/interception API, then use the bridge for native confirm/select/input cards while retaining terminal fallback and first-response-wins semantics.
2. **Native progress/tool cards:** consume semantic Pi events without replacing the terminal.
3. **Diff/review viewer:** mobile file list, wrapped diffs, inline review comments inserted as a Pi prompt.
4. **Session tree viewer:** native branch/fork/clone visualization using Pi SDK/read APIs.
5. **Git/worktree support:** isolated branch per task, inspired by Codex and webmux.
6. **Additional hosts:** outbound-connected agents or Tailscale-addressed daemons, with explicit host picker.
7. **Optional RPC mode:** a lightweight native chat for sessions that do not need TUI-only extensions; never run RPC and interactive Pi as concurrent writers of one session.
8. **VM/sandbox profiles:** disposable project environments for untrusted repositories.
9. **Tablet split view:** terminal + files/diff, without turning phone UI into a desktop IDE.

---

## 17. Final recommendation

Proceed with the **hybrid dashboard + private tmux + supervisor-owned PTY relay** design.

It is the only practical route that simultaneously offers:

- real Pi rather than a partial reimplementation;
- the highest practical terminal/TUI, extension, and autocomplete fidelity, with explicit exceptions for unsupported host-terminal capabilities;
- persistent sessions across mobile disconnects;
- a comfortable phone-specific shell around the terminal;
- a path to Codex-style status, approvals, notifications, diffs, voice, and attachments;
- self-hosted execution with no transcript relay service.

Do not use SSH as the primary browser bridge, do not expose a raw ttyd publicly, and do not make RPC the only UI when maximum Pi plugin compatibility is a hard requirement. The two prerequisite engineering investments are **exclusive session ownership** and a **durable, sequence-aware terminal relay**. Without them, the prototype may look functional but can duplicate processes, corrupt session ownership, and fail exactly when the phone disconnects.
