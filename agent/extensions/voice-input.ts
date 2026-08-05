/**
 * Voice Input — hold-Shift ASR dictation for Pi
 * ==============================================
 *
 * Hold either Shift key for ~2 seconds to start recording from the built-in
 * microphone. Release Shift to stop; the audio is transcribed through
 * Alibaba DashScope with `qwen-audio-3.0-asr-flash` and a recognition
 * profile selected from the Pi session's current project, then inserted into
 * the editor at the current cursor position.
 *
 * A quick Shift tap does nothing. Starting to type a shifted character
 * cancels a pending gesture, so normal capitalization keeps working.
 *
 * Controls
 * --------
 * - Hold Shift ≥ 2 s → listen; release Shift → transcribe + insert at cursor.
 * - Tap Shift        → no action.
 * - /voice           → record from the microphone until silence, then
 *                      transcribe + insert (same engine; press Shift to stop).
 *
 * Multiple sessions
 * -----------------
 * Each Pi session owns its push-to-talk machine and terminal-input listener,
 * so hold-Shift works in every open session and the transcript is inserted
 * into the editor of the session where recording was triggered — not into
 * whichever session started first or last. Only one recording can run at a
 * time across all sessions (there is a single microphone); a second session
 * that tries to record gets a clear "already recording" notice.
 *
 * Requirements
 * ------------
 * 1. `rec` from SoX:            brew install sox
 * 2. `DASHSCOPE_API_KEY` and `DASHSCOPE_BASE_URL` in the environment or in
 *    `~/.pi/agent/.env` (the extension never logs them).
 * 3. `OPENROUTER_API_KEY` in the environment or in `~/.pi/agent/.env`
 *    (optional): enables the LLM transcript-refinement stage (GPT-OSS
 *    120B, served by Groq). Without it dictation still works; only
 *    that stage is skipped.
 *    The stage calls OpenRouter through `curl` (which honors
 *    http_proxy/https_proxy/ALL_PROXY; `OPENROUTER_PROXY` overrides them),
 *    because undici's fetch ignores the proxy environment and OpenRouter
 *    rejects those direct connections with HTTP 403.
 * 4. Microphone permission for your terminal app:
 *    System Settings → Privacy & Security → Microphone → enable your terminal.
 *
 * Transcription
 * -------------
 * POST {DASHSCOPE_BASE_URL}/api/v1/services/aigc/multimodal-generation/generation
 * model: qwen-audio-3.0-asr-flash (native DashScope endpoint; the
 * OpenAI-compatible route does not serve this model). If DASHSCOPE_BASE_URL
 * is set to the OpenAI-compatible form (.../compatible-mode/v1) — e.g. by
 * the shell — the suffix is stripped automatically so the native endpoint
 * is always used.
 * Audio: 16 kHz mono 16-bit WAV, base64 as a data URI in an input_audio
 * message; parameters format=wav, sample_rate=16000, language_hints=["en"].
 * Recognition context: a global hard-word vocabulary (foquz, doxsw, yii,
 * knockout, …) is always injected as an input_text message before the audio
 * (DashScope guide §7.3) and as inline hotwords in parameters.vocabulary
 * (§7.1). Hotwords are sent under their spoken forms ("poll vue app" for
 * poll-vue-app) because DashScope requires hotwords to be real words or
 * phrases; hyphenated/camelCase identifiers are boosted to the super-hotword
 * weight (50) the model documents for exactly this case. The context turns
 * carry both spellings, so the model hears "poll vue app" and knows to write
 * "poll-vue-app". When the session's project matches a curated profile
 * (currently foquz-core), its project description is merged on top. Before
 * insertion, recognized spoken forms are normalized back to the canonical
 * written spellings. The model returns the raw transcript.
 *
 * Transcript cleanup: the transcript is refined in two stages before
 * insertion.
 *
 * Stage 1 — LLM refinement (OpenRouter · GPT-OSS 120B on Groq):
 * the raw text is posted to openai/gpt-oss-120b on OpenRouter,
 * hard-pinned to the Groq provider, with instructions that remove repeated
 * words and sentences, stutters, false starts, and ASR repetition loops,
 * then conservatively correct mangled project terms to their canonical
 * spellings using the same context and terminology the ASR stage received,
 * and join dictated file names and identifiers into properly cased tokens
 * ("quiz question model dot js" → QuizQuestionModel.js,
 * "extra question type" → EXTRA_QUESTION_TYPE), spell out "slash" paths
 * ("home slash projects slash focus repositories slash focus core" →
 * /home/projects/foquz-repositories/foquz-core), and follow PHP conventions
 * for .php files (PascalCase filename = class name, PSR-4).
 * Punctuation, numbers, and code identifiers are preserved. Best-effort: it
 * is skipped for transcripts under three words, when OPENROUTER_API_KEY is
 * unset, or on any request failure, and it never blocks dictation. The call
 * goes through `curl` so it honors the proxy environment (see Requirements).
 *
 * Stage 2 — deterministic post-processing (regex-only, no LLM): disfluency
 * fillers (uh, um, em, oh, er, erm, ah, eh, hmm, mm, mhm — any casing,
 * repeated letters, hyphenated forms like uh-huh) are removed wherever
 * they stand alone; empty discourse markers (okay, so, well, you know, I
 * mean, like) are removed only in clearly filler positions
 * (sentence-initial, comma-bounded, or "like <number>"); whitespace is
 * collapsed, each sentence is capitalized, and recognized spoken forms are
 * normalized back to canonical spellings. A transcript that cleans down to
 * nothing is treated as no speech.
 *
 * When the editor is empty, the transcript is inserted with a short prefix —
 * "User voice transcription — may contain misspellings: " — so the coding
 * agent knows the text came from dictation and may contain wrong words.
 * Appending to an existing editor buffer inserts the plain transcript.
 *
 * Privacy
 * -------
 * Recorded audio and the global hard-word vocabulary (general software
 * terms) are uploaded for every session; a matched project profile (e.g.
 * the foquz-core description) is uploaded only while working in that
 * repository. The local cwd itself is never uploaded. For the LLM
 * refinement stage, the raw transcript text — plus the project context and
 * terminology list — is additionally sent to OpenRouter, which forwards it
 * to Groq (GPT-OSS 120B); audio is never sent there. Without
 * OPENROUTER_API_KEY nothing is uploaded for cleanup. Generated transcripts
 * are treated like normal chat messages.
 *
 * Key handling
 * ------------
 * The extension enables Kitty keyboard protocol flag 8 so compatible
 * terminals report standalone left/right Shift press, repeat, and release
 * events. Ghostty, iTerm2, Warp, VS Code, Alacritty, WezTerm and kitty support
 * this protocol. Legacy terminals such as Terminal.app cannot report a Shift
 * key by itself, so hold-Shift dictation is unavailable there; `/voice` still
 * works.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ─── Configuration ───────────────────────────────────────────────────────────

const MODEL = "qwen-audio-3.0-asr-flash";
/** Native DashScope multimodal-generation endpoint (see the DashScope guide). */
const ENDPOINT_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
const FORMAT = "wav";
const SAMPLE_RATE = 16000;
/** Doc §6: forcing English avoids cross-language hallucinations on dictation. */
const LANGUAGE_HINTS = ["en"] as const;
/** Doc §7.1: normal hotword weight (4 recommended). */
const HOTWORD_WEIGHT = 4;
/** Doc §7.1: "super hotword" weight (50) — qwen-audio-3.0-asr-flash only,
 *  at most 50 such entries per request. Reserved for invented identifiers
 *  (hyphenated/camelCase terms) that ASR reliably mangles; plain real words
 *  stay at 4 so common speech (you, focus, view, …) is not over-boosted. */
const SUPER_HOTWORD_WEIGHT = 50;
/** Doc §7.3: the model retains up to 5 turns; keep 4 context turns so the
 *  audio message always fits within the budget. */
const MAX_CONTEXT_TURNS = 4;
/** Doc §7.3: per-turn context limit; excess is silently truncated. */
const MAX_CONTEXT_CHARS = 400;
const GIT_IDENTITY_TIMEOUT_MS = 1000;
const FOQUZ_CORE_ORIGINS = new Set([
  "git@doxsw.gitlab.yandexcloud.net:doxsw/foquz-core.git",
]);

export interface AsrProjectProfile {
  id: string;
  displayName: string;
  context: readonly string[];
  vocabulary: readonly string[];
}

/**
 * Global hard words and preferred spellings applied to every session —
 * terms ASR tends to mangle that are common across Foquz projects and the
 * Pi coding agent itself.
 *
 * The spoken form used for hotwords is derived automatically (hyphens and
 * camelCase become words: "poll-vue-app" → "poll vue app",
 * "ViewModel" → "view model"), so editing this list is all that's
 * needed to add or trim keywords.
 */
export const GLOBAL_VOCABULARY = [
  "foquz",
  "foquz-poll",
  "foquz-core",
  "foquz-quiz",
  "foquz-ui",
  "poll-vue-app",
  "pi-coding-agent",
  "foquz-frontend-vue",
  "devfoquz",
  "doxsw",
  "doxswf",
  "yii",
  "yii2",
  "Vue",
  "NPS",
  "DTO",
  "redmine",
  "reka-ui",
  "knockout",
  "ko",
  "vite",
  "gitlab",
  "localhost",
  "iframe",
  "textarea",
  "ViewModel",
] as const;

/** Base profile merged into every session; carries the global vocabulary. */
export const GLOBAL_ASR_PROFILE: AsrProjectProfile = {
  id: "global",
  displayName: "General software development",
  context: [],
  vocabulary: GLOBAL_VOCABULARY,
};

/**
 * Repo-specific recognition profile for foquz-core. The hard-word
 * vocabulary is global now; this profile only adds the project description.
 */
export const FOQUZ_CORE_PROFILE: AsrProjectProfile = {
  id: "foquz-core",
  displayName: "foquz-core",
  context: [
    "Foquz's legacy/core survey and polling platform.",
    "The backend uses PHP 8.2 and Yii 2 with MySQL, Redis, and RabbitMQ.",
    "The frontend uses Knockout.js, JavaScript/TypeScript, Webpack, LESS, and MVVM view models.",
    "Important areas include answers, poll-answers, answers-external, and the legacy iframe widget in ko/widgets/poll_new.",
  ],
  vocabulary: [],
};

/** Merge the always-on global profile with a matched project profile. */
export function mergeAsrProfiles(
  base: AsrProjectProfile,
  project: AsrProjectProfile | undefined,
): AsrProjectProfile {
  if (!project) return base;
  return {
    id: project.id,
    displayName: project.displayName,
    context: [...base.context, ...project.context],
    vocabulary: [...base.vocabulary, ...project.vocabulary],
  };
}

/**
 * The form the user actually speaks: hyphens become spaces, camelCase is
 * split, everything lowercased. "poll-vue-app" → "poll vue app",
 * "ViewModel" → "view model", "NPS" → "nps", "knockout" stays
 * "knockout".
 */
export function spokenFormOf(term: string): string {
  return term
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/-/g, " ")
    .toLowerCase();
}

/**
 * Doc §7.1: invented identifiers — terms whose spoken form differs from
 * their written spelling (hyphenated/camelCase) — are boosted as super
 * hotwords; plain real words keep the normal weight.
 */
export function hotwordWeightFor(written: string, spoken: string): number {
  return spoken === written.toLowerCase() ? HOTWORD_WEIGHT : SUPER_HOTWORD_WEIGHT;
}

export function buildRecArgs(outputPath: string, autoStopOnSilence: boolean): string[] {
  const args = ["-q", "-c", "1", "-r", String(SAMPLE_RATE), "-b", "16", outputPath];
  if (autoStopOnSilence) {
    // Start after 0.1 s of speech and stop after 2 s of trailing silence.
    args.push("silence", "1", "0.1", "2%", "1", "2.0", "2%");
  }
  return args;
}

/**
 * Select a curated profile from a trusted session's nearest Git repository.
 * Matching the origin rather than a directory name also supports arbitrary
 * worktree locations and avoids leaking a profile from an unrelated nested
 * repository. Neither cwd nor the origin is included in the ASR request.
 * The caller merges the result with GLOBAL_ASR_PROFILE so the global
 * vocabulary applies to every session.
 */
export function resolveAsrProjectProfile(
  cwd: string | undefined,
  projectTrusted: boolean,
): AsrProjectProfile | undefined {
  if (!cwd || !projectTrusted) return undefined;

  try {
    const origin = execFileSync(
      "git",
      ["-C", cwd, "config", "--get", "remote.origin.url"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_IDENTITY_TIMEOUT_MS,
      },
    ).trim();
    if (FOQUZ_CORE_ORIGINS.has(origin)) return FOQUZ_CORE_PROFILE;
  } catch {
    // A non-Git cwd, missing origin, or unavailable Git gets no profile.
  }

  return undefined;
}

/** Project description for the first context turn (DashScope guide §7.3).
 *  The description itself carries exact terms (PHP, Yii 2, Knockout.js, …),
 *  which is what the model matches against the audio; a generic instruction
 *  line would only crowd out those terms, so it is omitted. */
export function buildAsrContextText(profile?: AsrProjectProfile): string {
  if (!profile) return "";
  return [`Current software project: ${profile.displayName}.`, ...profile.context].join("\n");
}

/**
 * Split a line list into ≤maxChars chunks, one line at a time, so no term is
 * cut mid-word. Stops once maxTurns chunks are produced.
 */
function splitIntoTurns(lines: readonly string[], maxChars: number, maxTurns: number): string[] {
  const turns: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current === "" ? line : `${current}\n${line}`;
    if (candidate.length > maxChars) {
      if (current !== "") {
        turns.push(current);
        if (turns.length >= maxTurns) return turns;
      }
      current = line.length > maxChars ? line.slice(0, maxChars) : line;
    } else {
      current = candidate;
    }
  }
  if (current !== "") turns.push(current);
  return turns;
}

export interface AsrContextMessage {
  role: "user";
  content: Array<{ type: "input_text"; text: string }>;
}

/**
 * Build the input_text context messages that precede the audio message
 * (DashScope guide §7.3). The guide says the context text "must contain the
 * exact words to be recognized in the audio" and that a terminology list
 * normally needs a single message, so the whole vocabulary goes into one
 * term-list turn — each term as its written spelling with the spoken form in
 * parentheses ("poll-vue-app (poll vue app)"). A curated project profile
 * gets its description as a separate first turn; the always-on global
 * profile has no description and goes straight to the term list. Every turn
 * stays within the documented 400-char limit and the total within the
 * documented 5-turn retention budget. With no profile there is no context —
 * the wiring always passes the merged global profile, so in practice the
 * hard-word vocabulary is always present.
 */
/**
 * One line per vocabulary term — canonical spelling, with its spoken form in
 * parentheses when they differ ("poll-vue-app (poll vue app)"). Shared by the
 * DashScope context turns and the LLM refinement prompt so post-processing
 * sees exactly the terminology the ASR stage was told.
 */
export function formatTerminologyLines(vocabulary: readonly string[]): string[] {
  return vocabulary.map((term) => {
    const spoken = spokenFormOf(term);
    return spoken === term.toLowerCase() ? term : `${term} (${spoken})`;
  });
}

export function buildAsrContextMessages(profile?: AsrProjectProfile): AsrContextMessage[] {
  if (!profile) return [];
  const turns: string[] = [];
  if (profile.context.length > 0) {
    turns.push(buildAsrContextText(profile).slice(0, MAX_CONTEXT_CHARS));
  }
  const termLines = formatTerminologyLines(profile.vocabulary);
  turns.push(...splitIntoTurns(termLines, MAX_CONTEXT_CHARS, MAX_CONTEXT_TURNS - turns.length));
  return turns
    .filter((text) => text.length > 0)
    .slice(0, MAX_CONTEXT_TURNS)
    .map((text) => ({ role: "user", content: [{ type: "input_text", text }] }));
}

/** Doc §7.1 hotword constraints that can be checked locally. */
function isValidHotword(term: string): boolean {
  if (!term.trim()) return false;
  const hasNonAscii = /[^\x00-\x7F]/.test(term);
  if (hasNonAscii) return [...term].length <= 15; // non-ASCII words: max 15 chars
  return term.trim().split(/\s+/).length <= 7; // ASCII words: max 7 space-separated segments
}

/**
 * Inline hotwords (DashScope guide §7.1) from the profile vocabulary. Each
 * term is sent under its spoken form — "poll vue app" for poll-vue-app —
 * because DashScope requires hotwords to be real words/phrases; a bare
 * hyphenated identifier like "poll-vue-app" may be ignored. Invented
 * identifiers are boosted to the super-hotword weight (50). Terms that still
 * fail the documented constraints are skipped locally; the context turns
 * carry the full list regardless.
 */
export function buildHotwords(vocabulary: readonly string[]): Record<string, number> {
  const hotwords: Record<string, number> = {};
  for (const term of vocabulary) {
    const spoken = spokenFormOf(term);
    if (!isValidHotword(spoken)) continue;
    hotwords[spoken] = hotwordWeightFor(term, spoken);
  }
  return hotwords;
}

const HOLD_MS = 2000; // Shift must be held this long before listening starts.
const MAX_RECORDING_MS = 180_000; // Hard cap on one recording (model allows 5 min; 10 MB base64 ≈ 3.5–4 min at 16 kHz).
const MAX_ATTEMPTS = 3; // Transcription retries for transient failures.
const REQUEST_TIMEOUT_MS = 120_000; // Doc §4/§8: 120 s request timeout.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const STATUS_KEY = "voice-input";
/** `proper-lockfile` appends `.lock`; the target itself need not exist because
 *  realpath is disabled below. */
const CAPTURE_LOCK_TARGET = join(getAgentDir(), "voice-input-capture");
const CAPTURE_LOCK_STALE_MS = 30_000;
const CAPTURE_LOCK_UPDATE_MS = 10_000;

interface ProperLockfileApi {
  lock(
    file: string,
    options: {
      realpath: false;
      stale: number;
      update: number;
      retries: number;
      onCompromised(error: Error): void;
    },
  ): Promise<() => Promise<void>>;
}

// proper-lockfile is a pi-coding-agent runtime dependency. Anchor resolution
// at the running CLI. The `which pi` fallback supports the standalone test
// harness, whose argv points at the harness rather than the Pi executable.
let properLockfile: ProperLockfileApi;
try {
  properLockfile = createRequire(process.argv[1])("proper-lockfile") as ProperLockfileApi;
} catch {
  const piCli = realpathSync(
    execFileSync("which", ["pi"], { encoding: "utf8" }).trim(),
  );
  properLockfile = createRequire(piCli)("proper-lockfile") as ProperLockfileApi;
}

// LLM transcript refinement (OpenRouter · GPT-OSS 120B on Groq).
const REFINEMENT_MODEL = "openai/gpt-oss-120b";
/** Hard-pin the refinement stage to the Groq provider (fast LPU inference,
 *  fraction of the Gemini price). With allow_fallbacks:false, a Groq outage
 *  surfaces as a request failure and the stage keeps the raw transcript —
 *  dictation never depends on this stage. */
const REFINEMENT_PROVIDER_ROUTING = { only: ["Groq"], allow_fallbacks: false } as const;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_CHAT_PATH = "/chat/completions";
/** Utterances shorter than this cannot contain sentence-level repeats. */
const MIN_REFINEMENT_WORDS = 3;
const REFINEMENT_TIMEOUT_MS = 10_000;
const REFINEMENT_ATTEMPTS = 2;
const REFINEMENT_MAX_TOKENS = 1024;

// ─── OpenRouter transport (curl, not fetch) ─────────────────────────────────

/** Suffix curl appends via --write-out after the response body. */
const CURL_STATUS_MARKER = "__PI_CURL_STATUS__";
/** Backstop SIGKILL; curl's own --max-time governs the request. */
const CURL_PROCESS_TIMEOUT_MS = REFINEMENT_TIMEOUT_MS + 5_000;

/**
 * curl in place of fetch for the OpenRouter stage. undici ignores the
 * standard proxy environment variables (http_proxy/https_proxy/ALL_PROXY),
 * so a fetch from this machine connects directly and OpenRouter's security
 * policy rejects it with HTTP 403; curl honors those variables natively and
 * the proxied connection is accepted. An explicit OPENROUTER_PROXY (from
 * the environment or ~/.pi/agent/.env) overrides them via --proxy.
 *
 * The API key travels in a temporary 0600 header file, never in argv (which
 * is visible in the process list). Resolves to a fetch-compatible Response
 * so the retry logic stays the same; throws a transient TypeError when no
 * HTTP response arrives (connect failure, timeout, missing curl).
 */
export async function postChatCompletionWithCurl(
  url: string,
  payload: string,
  apiKey: string,
): Promise<Response> {
  const dir = await mkdtemp(join(tmpdir(), "pi-refine-"));
  const headerFile = join(dir, "headers.txt");
  try {
    await writeFile(
      headerFile,
      `Authorization: Bearer ${apiKey}\nContent-Type: application/json\n`,
      { mode: 0o600 },
    );
    const proxy = getRefinementProxy();
    const args = [
      "-sS",
      "--max-time", String(Math.ceil(REFINEMENT_TIMEOUT_MS / 1000)),
      "-X", "POST",
      "--data-binary", "@-",
      "-w", `\n${CURL_STATUS_MARKER}%{http_code}`,
      "-H", `@${headerFile}`,
      ...(proxy ? ["--proxy", proxy] : []),
      url,
    ];
    const { stdout, error } = await runCurl(args, payload);
    if (error !== null) throw new TypeError(`curl request failed: ${error}`);
    const parsed = parseCurlOutput(stdout);
    if (!parsed) throw new TypeError("curl produced no usable HTTP response");
    return new Response(parsed.body, {
      status: parsed.status,
      headers: { "content-type": "application/json" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Split curl's stdout into the response body and the --write-out status. */
export function parseCurlOutput(
  stdout: string,
): { body: string; status: number } | null {
  const markerIndex = stdout.lastIndexOf(`\n${CURL_STATUS_MARKER}`);
  if (markerIndex === -1) return null;
  const body = stdout.slice(0, markerIndex);
  const status = Number(stdout.slice(markerIndex + 1 + CURL_STATUS_MARKER.length).trim());
  if (!Number.isInteger(status) || status < 200 || status > 599) return null;
  return { body, status };
}

function runCurl(
  args: string[],
  input: string,
): Promise<{ stdout: string; error: string | null }> {
  return new Promise((resolve) => {
    // spawn, not execFile: execFile's `input` option never closes curl's
    // stdin pipe, so `--data-binary @-` blocks forever waiting for EOF.
    const child = spawn("curl", args);
    let stdout = "";
    const killTimer = setTimeout(() => child.kill("SIGKILL"), CURL_PROCESS_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", () => {
      // Progress/error chatter is ignored; failures surface via the exit
      // code and the missing status marker.
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(killTimer);
      resolve({ stdout, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        resolve({ stdout, error: `curl exited with code ${code}` });
        return;
      }
      resolve({ stdout, error: null });
    });
    child.stdin.on("error", () => {
      // The child may exit before stdin finishes writing (EPIPE).
    });
    try {
      child.stdin.write(input, "utf8");
      child.stdin.end();
    } catch {
      // Spawn failure already resolved via the 'error' event.
    }
  });
}

function getRefinementProxy(): string | undefined {
  if (process.env.OPENROUTER_PROXY === undefined) {
    try {
      loadDotEnvIfPresent(join(getAgentDir(), ".env"));
    } catch {
      // Fall through to the environment check below.
    }
  }
  return process.env.OPENROUTER_PROXY;
}

export type RefinementTransport = (
  url: string,
  payload: string,
  apiKey: string,
) => Promise<Response>;

/** Swappable transport for tests; the extension always uses curl. */
let refinementTransport: RefinementTransport = postChatCompletionWithCurl;
export function setRefinementTransport(transport: RefinementTransport): void {
  refinementTransport = transport;
}

// Kitty functional key codepoints. Flag 8 is required for terminals to report
// modifier keys as standalone events.
const SHIFT_KEY_EVENT = /^\x1b\[(57441|57447)(?:;(\d+))?(?::([123]))?u$/;
const MODIFIER_KEY_EVENT = /^\x1b\[(?:5744[1-9]|5745[0-4])(?:;\d+)?(?::[123])?u$/;
const LOCK_KEY_EVENT = /^\x1b\[(?:57358|57359|57360)(?:;\d+)?(?::[123])?u$/;
const LOCK_MODIFIER_MASK = 64 | 128; // Caps Lock | Num Lock.
const ENABLE_STANDALONE_KEY_EVENTS = "\x1b[>15u"; // Push flags 1 | 2 | 4 | 8.
const RESTORE_KEYBOARD_PROTOCOL = "\x1b[<u"; // Pop the mode pushed above.
// DEC focus tracking is per terminal surface. Ghostty reports the current
// split immediately when enabled, then reports every split focus transition.
const ENABLE_FOCUS_TRACKING = "\x1b[?1004h";
const DISABLE_FOCUS_TRACKING = "\x1b[?1004l";
const FOCUS_EVENT = /\x1b\[([IO])/g;

interface ShiftKeyEvent {
  key: 57441 | 57447;
  type: 1 | 2 | 3;
}

function parseShiftKeyEvent(data: string): ShiftKeyEvent | undefined {
  const match = data.match(SHIFT_KEY_EVENT);
  if (!match) return undefined;

  // Accept bare Shift whether or not the terminal includes the pressed Shift
  // in its modifier mask. Reject Ctrl/Alt/Super+Shift gestures.
  const modifierField = match[2] === undefined ? 1 : Number(match[2]);
  const modifiers = (modifierField - 1) & ~LOCK_MODIFIER_MASK;
  if (modifiers !== 0 && modifiers !== 1) return undefined;

  return {
    key: Number(match[1]) as ShiftKeyEvent["key"],
    type: (match[3] === undefined ? 1 : Number(match[3])) as ShiftKeyEvent["type"],
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type KeyHandlerResult = { consume?: boolean; data?: string } | undefined;

/**
 * Effects the state machine needs. Everything side-effecting goes through
 * this interface so the decision logic is testable without a terminal,
 * a microphone, or the network.
 */
export interface CaptureEffects {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(text: string | undefined): void;
  /**
   * Begin microphone capture. Resolves with the WAV path when the capture
   * ends (killed, silence auto-stop, or error), or null on failure.
   */
  startCapture(autoStopOnSilence: boolean): Promise<string | null>;
  /** Stop an in-progress capture (SIGINT, then SIGKILL after 2 s). */
  stopCapture(): void;
  /** Sanitized diagnostic message from the last failed capture. */
  lastCaptureError(): string;
  /** Transcribe a WAV file; resolves to the transcript ("" when no speech). */
  transcribe(audioPath: string): Promise<string>;
  /**
   * Best-effort LLM refinement of a transcript (repeats, stutters, false
   * starts). Must never throw; returns the input unchanged on any failure.
   */
  refineTranscript(text: string): Promise<string>;
  /** Insert the transcript into the editor at its current cursor position. */
  insertTranscript(text: string): void;
  /** Delete the temporary capture directory. */
  cleanupAudio(audioPath: string): Promise<void>;
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancelSchedule(handle: unknown): void;
}

type PttState = "idle" | "pending" | "recording" | "transcribing";

// ─── Push-to-talk state machine ──────────────────────────────────────────────

export class PushToTalk {
  private state: PttState = "idle";
  private gestureKey: ShiftKeyEvent["key"] | undefined;
  private gestureStart = 0;
  private triggerTimer: unknown;
  private capTimer: unknown;
  private finishing = false;
  private voiceCommand = false; // Capture started via /voice (silence auto-stop).
  private stopRequested = false;
  private active = true;
  private focused: boolean | undefined;

  private effects: CaptureEffects;

  constructor(effects: CaptureEffects) {
    this.effects = effects;
  }

  /** Raw terminal input listener (feed from ctx.ui.onTerminalInput). */
  handleInput(data: string): KeyHandlerResult {
    // Focus reports and a key event may be coalesced in one stdin chunk. Strip
    // every report first while preserving any ordinary input for Pi's editor.
    let hadFocusEvent = false;
    data = data.replace(FOCUS_EVENT, (_event, state: "I" | "O") => {
      hadFocusEvent = true;
      this.handleFocusChange(state === "I");
      return "";
    });
    if (!data) return hadFocusEvent ? { consume: true } : undefined;

    // Standalone modifier events can be broadcast across Ghostty splits. The
    // focus report is authoritative; inactive splits consume but never act on
    // those events. Undefined retains support for terminals without mode 1004.
    if (
      this.focused === false &&
      (SHIFT_KEY_EVENT.test(data) || MODIFIER_KEY_EVENT.test(data) || LOCK_KEY_EVENT.test(data))
    ) {
      return { consume: true };
    }

    const shift = parseShiftKeyEvent(data);
    if (!shift) {
      // Shift used for ordinary typing must not become a push-to-talk hold.
      if (this.state === "pending") {
        this.cancelGesture();
        this.state = "idle";
      }
      // Flag 8 also reports other standalone modifier/lock keys. They are
      // terminal state, not editor text, so keep their CSI-u sequences out.
      if (MODIFIER_KEY_EVENT.test(data) || LOCK_KEY_EVENT.test(data)) return { consume: true };
      return hadFocusEvent ? { data } : undefined;
    }

    // Standalone modifier sequences are not editor input; always consume them.
    if (this.state === "transcribing") return { consume: true };
    if (shift.type === 3) return this.onRelease(shift.key);
    return this.onShiftPressOrRepeat(shift.key);
  }

  /** Record from the microphone until silence, then transcribe + insert. */
  async runVoiceCommand(): Promise<void> {
    if (!this.active) return;
    if (this.state !== "idle") {
      this.effects.notify("Voice input is busy.", "warning");
      return;
    }
    this.beginRecording(true);
  }

  /** Cancel an uncommitted gesture when this terminal surface loses focus.
   *  If focus moves during recording, finish the audio at that boundary rather
   *  than letting an inactive editor keep owning the microphone. */
  handleFocusChange(focused: boolean): void {
    this.focused = focused;
    if (focused) return;
    if (this.state === "pending") {
      this.cancelGesture();
      this.state = "idle";
    } else if (this.state === "recording") {
      this.requestStopCapture();
    }
  }

  shutdown(): void {
    this.active = false;
    this.effects.stopCapture();
    this.clearTimers();
    this.effects.setStatus(undefined);
    this.state = "idle";
  }

  // ── Shift events ───────────────────────────────────────────────────────────

  private onShiftPressOrRepeat(key: ShiftKeyEvent["key"]): KeyHandlerResult {
    if (this.state === "recording") {
      // A Shift press stops /voice. Repeats from a key-driven hold are ignored.
      if (this.voiceCommand) this.requestStopCapture();
      return { consume: true };
    }

    if (this.state === "idle") {
      this.gestureKey = key;
      this.gestureStart = this.effects.now();
      this.triggerTimer = this.effects.schedule(() => this.onHoldTrigger(), HOLD_MS);
      this.state = "pending";
    }

    return { consume: true };
  }

  private onRelease(key: ShiftKeyEvent["key"]): KeyHandlerResult {
    if (this.state === "recording") {
      if (this.voiceCommand || key === this.gestureKey) {
        this.requestStopCapture(); // finishCapture() continues when the process exits.
      }
      return { consume: true };
    }

    if (this.state === "pending" && key === this.gestureKey) {
      const heldLong = this.effects.now() - this.gestureStart >= HOLD_MS;
      this.cancelGesture();
      if (heldLong) {
        // If release wins the timer race at exactly 2 s, honor the hold and
        // stop through the pending-stop path even before `rec` has spawned.
        this.beginRecording(false);
        this.requestStopCapture();
      } else {
        this.state = "idle";
      }
    }

    return { consume: true };
  }

  // ── Gesture lifecycle ──────────────────────────────────────────────────────

  private cancelGesture(): void {
    if (this.triggerTimer !== undefined) {
      this.effects.cancelSchedule(this.triggerTimer);
      this.triggerTimer = undefined;
    }
    this.gestureKey = undefined;
    this.gestureStart = 0;
  }

  private onHoldTrigger(): void {
    this.triggerTimer = undefined;
    if (this.state !== "pending") return;
    this.beginRecording(false);
  }

  private requestStopCapture(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.effects.stopCapture();
  }

  private beginRecording(autoStopOnSilence: boolean): void {
    if (!this.active) return;
    this.state = "recording";
    this.voiceCommand = autoStopOnSilence;
    this.stopRequested = false;
    this.effects.setStatus(
      autoStopOnSilence ? "🎙 Listening — stops on silence" : "🎙 Listening — release Shift to insert",
    );
    this.effects.notify(
      autoStopOnSilence ? "Recording… stops on silence." : "Recording… release Shift when done.",
      "info",
    );
    this.capTimer = this.effects.schedule(() => {
      this.effects.notify("Reached the recording limit.", "warning");
      this.requestStopCapture();
    }, MAX_RECORDING_MS);
    void this.startCaptureFlow();
  }

  private async startCaptureFlow(): Promise<void> {
    const path = await this.effects.startCapture(this.voiceCommand);
    if (!this.active) {
      if (path) await this.effects.cleanupAudio(path).catch(() => {});
      return;
    }
    await this.finishCapture(path);
  }

  private async finishCapture(path: string | null): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    this.clearTimers();
    if (this.state !== "recording") {
      this.finishing = false;
      return; // Shutdown or an aborted capture.
    }
    if (!path) {
      const detail = this.effects.lastCaptureError();
      if (detail === "another Pi session is already recording") {
        this.effects.notify("Voice input is already recording in another Pi session.", "warning");
      } else if (detail.startsWith("voice capture lock was lost")) {
        this.effects.notify("Voice recording was cancelled because microphone ownership was lost.", "warning");
      } else {
        this.effects.notify(
          `Could not record audio${detail ? ` (${detail})` : ""}. ` +
            "Check microphone permission for your terminal: System Settings → Privacy & Security → Microphone.",
          "error",
        );
      }
      this.resetToIdle();
      return;
    }

    this.state = "transcribing";
    this.effects.setStatus("… Transcribing");
    let text = "";
    try {
      text = await this.effects.transcribe(path);
      // LLM refinement (OpenRouter · GPT-OSS 120B on Groq): removes
      // repeated words/sentences, stutters, false starts, and ASR repetition
      // loops, and corrects mangled project terms to canonical spellings.
      // Best-effort — falls back to the raw transcript; the deterministic
      // pass in insertTranscript still applies afterwards.
      text = await this.effects.refineTranscript(text);
    } catch (error) {
      if (this.active) {
        this.effects.notify(
          `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        this.resetToIdle();
      }
      return;
    } finally {
      await this.effects.cleanupAudio(path).catch(() => {});
    }

    if (!this.active) return;
    const trimmed = text.trim();
    if (!trimmed) {
      this.effects.notify("No speech detected — try again.", "warning");
      this.resetToIdle();
      return;
    }
    this.effects.insertTranscript(trimmed);
    this.resetToIdle();
  }

  private resetToIdle(): void {
    this.state = "idle";
    this.finishing = false;
    this.voiceCommand = false;
    this.stopRequested = false;
    this.gestureKey = undefined;
    this.clearTimers();
    this.effects.setStatus(undefined);
  }

  private clearTimers(): void {
    if (this.triggerTimer !== undefined) {
      this.effects.cancelSchedule(this.triggerTimer);
      this.triggerTimer = undefined;
    }
    if (this.capTimer !== undefined) {
      this.effects.cancelSchedule(this.capTimer);
      this.capTimer = undefined;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal .env loader: sets only keys that are not already in the environment. */
function loadDotEnvIfPresent(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function getDashScopeCredentials(): { apiKey?: string; baseUrl?: string } {
  if (
    process.env.DASHSCOPE_API_KEY === undefined ||
    process.env.DASHSCOPE_BASE_URL === undefined
  ) {
    try {
      loadDotEnvIfPresent(join(getAgentDir(), ".env"));
    } catch {
      // Fall through to the environment check below.
    }
  }
  return {
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseUrl: process.env.DASHSCOPE_BASE_URL,
  };
}

function getOpenRouterKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY === undefined) {
    try {
      loadDotEnvIfPresent(join(getAgentDir(), ".env"));
    } catch {
      // Fall through to the environment check below.
    }
  }
  return process.env.OPENROUTER_API_KEY;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number, retryAfter?: string | null): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  const jitter = 0.5 + Math.random() * 0.5;
  let retryAfterMs = 0;

  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      retryAfterMs = Math.max(0, seconds * 1000);
    } else {
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) retryAfterMs = Math.max(0, retryAt - Date.now());
    }
  }

  return Math.max(base * jitter, retryAfterMs);
}

function isTransient(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch network failure
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return true;
  return false;
}

/** Truncate an error body for display without leaking anything sensitive. */
function sanitize(body: string): string {
  return body.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim().slice(0, 300);
}

function extractTranscript(json: unknown): string {
  const text = (json as { text?: unknown } | null)?.text;
  if (typeof text === "string") return text;
  throw new Error("DashScope response did not contain transcript text.");
}

/**
 * Derive the native DashScope multimodal-generation endpoint from a
 * configured base URL.
 *
 * DashScope exposes two flavors of base URL and both are commonly exported
 * as DASHSCOPE_BASE_URL (the shell or ~/.pi/agent/.env may disagree):
 *
 *   native:            https://<host>
 *   OpenAI-compatible: https://<host>/compatible-mode/v1
 *
 * The ASR model (qwen-audio-3.0-asr-flash) is only served on the native
 * route, so a /compatible-mode/v1 suffix is stripped before the native
 * endpoint path is appended. A base URL that already carries the full native
 * endpoint is used as-is. Never a 404 from a doubled path.
 */
export function buildAsrEndpoint(baseUrl: string): string {
  const normalized = baseUrl
    .replace(/\/compatible-mode\/v1\/?$/, "")
    .replace(/\/compatible-mode\/?$/, "")
    .replace(/\/+$/, "");
  return normalized.endsWith(ENDPOINT_PATH)
    ? normalized
    : `${normalized}${ENDPOINT_PATH}`;
}

export async function transcribeAudio(
  audioPath: string,
  apiKey: string,
  baseUrl: string,
  projectProfile?: AsrProjectProfile,
): Promise<string> {
  const bytes = await readFile(audioPath);
  const dataUri = `data:audio/${FORMAT};base64,${bytes.toString("base64")}`;
  const audioMessage = {
    role: "user",
    content: [{ type: "input_audio", input_audio: { data: dataUri } }],
  };
  const parameters: Record<string, unknown> = {
    format: FORMAT,
    sample_rate: String(SAMPLE_RATE),
    language_hints: LANGUAGE_HINTS,
  };
  if (projectProfile) {
    const hotwords = buildHotwords(projectProfile.vocabulary);
    if (Object.keys(hotwords).length > 0) parameters.vocabulary = hotwords;
  }
  const payload = JSON.stringify({
    model: MODEL,
    input: {
      messages: [...buildAsrContextMessages(projectProfile), audioMessage],
    },
    parameters,
  });
  const endpoint = buildAsrEndpoint(baseUrl);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) return extractTranscript(await response.json());

      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        await response.body?.cancel().catch(() => undefined);
        await delay(backoffMs(attempt, response.headers.get("retry-after")));
        continue;
      }
      const body = await response.text().catch(() => "");
      throw new Error(
        `DashScope ASR returned ${response.status}${body ? `: ${sanitize(body)}` : ""}`,
      );
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      if (isTransient(error)) {
        await delay(backoffMs(attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Transcription failed after retries.");
}

// ─── LLM transcript refinement (OpenRouter · GPT-OSS 120B on Groq) ─────────

/**
 * Instructions for the refinement stage: remove repeated words/sentences,
 * stutters, false starts, and ASR repetition loops, then — conservatively —
 * correct mangled project terms to their canonical spellings using the
 * terminology list in the user message. Anything that is not a repetition
 * or a clear terminology fix survives byte-for-byte: punctuation, numbers,
 * code identifiers, and canonical spellings. The deterministic pass below
 * still guarantees filler removal and exact spoken-form normalization.
 */
export const REFINEMENT_SYSTEM_PROMPT = [
  "You clean up raw speech-to-text dictation that will be sent to a coding agent.",
  "The text is full of transcription errors; your job is to fix them.",
  "",
  "1. Remove repetitions and disfluencies:",
  "- repeated words and stutters, e.g. \"I I want to\" → \"I want to\";",
  "- repeated phrases and repeated sentences, e.g. \"open the file open the file\" → \"open the file\";",
  "- ASR repetition loops, where a word or phrase is repeated several times;",
  "- false starts and restarts, e.g. \"let's refactor the... let's refactor the module\" → \"let's refactor the module\".",
  "Repetitions are always errors: never keep a duplicate just in case.",
  "",
  "2. Correct project terminology:",
  "The user message lists project terms as \"canonical spelling (spoken form)\".",
  "When the transcript contains a word or phrase that is clearly a mis-transcription of one of those terms — a close-sounding variant, a wrong spelling, or an ASR garble of its spoken form — replace it with the exact canonical spelling.",
  "",
  "3. Join dictated file names and identifiers:",
  "When the speech clearly spells an identifier or file name — a phrase ending in \"dot\" plus an extension, or an unambiguous project term — write it as one token with no spaces and the casing the project uses:",
  "- files for components, models, and classes: PascalCase, e.g. \"quiz question model dot js\" → QuizQuestionModel.js, \"address question dot vue\" → AddressQuestion.vue;",
  "- standalone utility files: kebab-case, e.g. \"date formatter dot ts\" → date-formatter.ts;",
  "- variables and plain helpers: camelCase, e.g. \"answer variables dot js\" → answerVariables.js;",
  "- constants: UPPER_SNAKE_CASE, e.g. \"extra question type\" → EXTRA_QUESTION_TYPE;",
  "- composables and stores: \"use\" + PascalCase, e.g. \"use get users\" → useGetUsers.",
  "\"dot\" becomes \".\" and the following word becomes the extension (js, ts, tsx, vue, php, scss, css, json, ...).",
  "Only join when a file name or identifier is clearly meant; keep ordinary prose as words (\"the quiz question model is deprecated\" stays prose).",
  "",
  "4. Join dictated file paths:",
  "When the speech spells a path with \"slash\" separators, write it as a real path:",
  "- \"slash\" becomes \"/\"; multi-word segments are joined in kebab-case, e.g. \"home slash projects slash focus repositories slash focus core\" → /home/projects/foquz-repositories/foquz-core;",
  "- a leading root word (home, root, usr, users, opt, var, ...) makes the path absolute with a leading \"/\";",
  "- \"dot dot\" becomes \"..\" and \"dot\" becomes \".\" inside a path, e.g. \"dot dot slash src\" → ../src.",
  "When a path segment sounds like a project term from the terminology list, write the canonical spelling: \"focus repositories\" → foquz-repositories, \"focus core\" → foquz-core.",
  "Only join when a path is clearly meant; keep ordinary prose as words.",
  "",
  "5. PHP files and classes:",
  "When the extension is php, the file is a PHP class file: write it in PascalCase to match the class it contains (PSR-4: filename = class name) — \"answers controller dot php\" → AnswersController.php, never kebab-case;",
  "Typical PHP class suffixes: Controller, Service, Repository, Dto (or DTO), Normalizer, Helper, Trait, Builder, Component, Model, Entity;",
  "PHP methods and properties are camelCase and constants UPPER_SNAKE_CASE.",
  "",
  "6. Be conservative about terminology:",
  "- only replace when the speech clearly refers to the listed term;",
  "- do not replace ordinary English words that merely sound similar to a term unless the context confirms the term;",
  "- never introduce a term that is not in the list.",
  "",
  "7. Keep everything else byte-for-byte:",
  "Never rephrase, reorder, summarize, add, or rewrite anything outside rules 1-6.",
  "Preserve punctuation, capitalization, numbers, code identifiers, project names, and file paths.",
  "Reply with only the cleaned text. No commentary, quotes, or code fences.",
].join("\n");

/**
 * The user message carries the same context the ASR stage received — project
 * description and terminology list — followed by the transcript to clean, so
 * terminology corrections are informed by exactly the terms DashScope was
 * told about.
 */
export function buildRefinementMessages(
  text: string,
  profile?: AsrProjectProfile,
): Array<{ role: "system" | "user"; content: string }> {
  const parts: string[] = [];
  if (profile) {
    const context = buildAsrContextText(profile);
    if (context) parts.push(`Project context:\n${context}`);
    const terms = formatTerminologyLines(profile.vocabulary);
    if (terms.length > 0) {
      parts.push(`Terminology (canonical spelling (spoken form)):\n${terms.join("\n")}`);
    }
  }
  parts.push(`Transcript to clean:\n${text}`);
  return [
    { role: "system", content: REFINEMENT_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** Strip a wrapping markdown code fence ("```text\n…\n```") if the model
 *  added one despite the instructions. */
function stripCodeFences(text: string): string {
  return text
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

/**
 * Parse the OpenRouter chat-completion response into the cleaned transcript.
 * Returns null when the response has no usable content (which the caller
 * treats as "keep the raw transcript").
 */
export function extractRefinementText(json: unknown): string | null {
  const message = (json as
    | { choices?: Array<{ message?: { content?: unknown } }> }
    | null)?.choices?.[0]?.message;
  const raw = message?.content;
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    // Some providers return content as a list of parts.
    text = raw
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part !== null &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return stripCodeFences(text) || null;
}

/**
 * Best-effort LLM refinement of a transcript via OpenRouter chat
 * completions (GPT-OSS 120B, hard-pinned to Groq). Total function:
 * it never throws and returns the input unchanged when the key is missing,
 * the transcript is too short to contain repeats, the call fails, or the
 * model returns nothing usable. Dictation must never depend on this stage.
 */
export async function refineTranscriptWithOpenRouter(
  text: string,
  apiKey: string,
  profile?: AsrProjectProfile,
): Promise<string> {
  if (!apiKey) return text;
  if (text.trim().split(/\s+/).filter(Boolean).length < MIN_REFINEMENT_WORDS) return text;

  const endpoint = `${OPENROUTER_BASE_URL}${OPENROUTER_CHAT_PATH}`;
  const payload = JSON.stringify({
    model: REFINEMENT_MODEL,
    messages: buildRefinementMessages(text, profile),
    temperature: 0,
    max_tokens: REFINEMENT_MAX_TOKENS,
    provider: REFINEMENT_PROVIDER_ROUTING,
  });

  for (let attempt = 1; attempt <= REFINEMENT_ATTEMPTS; attempt++) {
    try {
      const response = await refinementTransport(endpoint, payload, apiKey);

      if (response.ok) {
        const cleaned = extractRefinementText(await response.json());
        return cleaned !== null && cleaned !== text.trim() ? cleaned : text;
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < REFINEMENT_ATTEMPTS) {
        await response.body?.cancel().catch(() => undefined);
        await delay(backoffMs(attempt, response.headers.get("retry-after")));
        continue;
      }
      // Permanent failure (4xx) or the final retry attempt: keep the raw text.
      return text;
    } catch (error) {
      if (attempt < REFINEMENT_ATTEMPTS && isTransient(error)) {
        await delay(backoffMs(attempt));
        continue;
      }
      return text;
    }
  }
  return text;
}

// ─── Deterministic transcript cleanup (no LLM) ──────────────────────────────

/**
 * Deterministically remove disfluency fillers and empty discourse markers
 * from an ASR transcript, then normalize spacing and sentence casing.
 *
 * Removed everywhere (standalone, any casing, letters may repeat):
 *   uh, um, em, oh, er, erm, ah, eh, hm, hmm, mm, mhm
 *   + hyphenated forms (uh-huh, uh-uh, mm-hmm) and "'em" is preserved.
 *
 * Discourse markers are removed only in clearly filler positions:
 *   - sentence-initial (after start or . ! ?): okay/ok (unless the sentence
 *     is just "okay"), so (unless "so that …"), well (unless "well
 *     done|said|played|known|over|under|…"), I mean (unless "I mean
 *     it|you|that|this|…"), you know, like (comma required for the latter
 *     two); cascading markers like "well, you know," are handled by
 *     repeating the pass.
 *   - comma-bounded: ", you know,", ", I mean,", ", like,", ", okay,"
 *   - trailing: ", you know" / ", I mean" at sentence end
 *   - approximation: "like <number>" after a be-form ("it's like 10" →
 *     "it's 10"), not after a subject like "I like 10…".
 *
 * Finally: whitespace runs collapse, spaces before punctuation are
 * removed, and the start of each sentence is capitalized. This mirrors the
 * filler removal the old LLM cleanup performed, but is fully
 * deterministic and makes no external calls.
 */
export function cleanTranscript(text: string): string {
  let out = text
    // 1. Disfluency fillers: standalone words, any casing, letters may
    //    repeat; an optional trailing comma is eaten. "'em" (pronoun) is
    //    protected with a negative lookbehind, "err" (verb) / "em
    //    dash|space" / "5 mm" (measurement) are kept via guards.
    .replace(
      /(?<!')(?<!\d\s)\b(?:u+h+(?:-u+h+|-h+u+h+)?|u+m+|u+h+m+|e+m+(?!\s+(?:dash|space)\b)|e+r+m+|e+r+(?!\s+(?:on|is|are|was|were|be|been)\b)|o+h+|a+h+|e+h+|h+m+|m+h+m+|m+(?:-h+m+)?)\b,?/gi,
      "",
    )
    // 2. Comma-bounded discourse markers collapse to a single space:
    //    "it's, you know, tricky" → "it's tricky".
    .replace(/,\s*(?:you know|i mean|like|ok(?:ay)?)\s*,/gi, " ")
    // 3. Trailing ", you know" / ", I mean" before sentence end.
    .replace(/,\s*(?:you know|i mean)(?=\s*[.!?]|$)/gi, "");

  // 4. Sentence-initial empty discourse markers. Repeated (bounded) so
  //    cascades like "Okay so …" and "well, you know, …" are fully cleaned:
  //    trimming each round lets a marker that becomes sentence-initial after
  //    an earlier removal be seen by the next round. Each alternative guards
  //    its content usage.
  const SENTENCE_INITIAL_MARKERS =
    /(^|[.!?]["')]*\s+)(?:(?:okay|ok)(?:,|(?=\s+(?!$)))|so(?:,|(?=\s+(?!that\b)))|well(?:,|(?=\s+(?!done\b|said\b|played\b|sung\b|written\b|known\b|being\b|over\b|under\b|off\b|on\b|in\b|out\b|enough\b|ahead\b)))|i mean(?:,|(?=\s+(?!it\b|you\b|that\b|this\b|him\b|her\b|them\b|us\b|what\b)))|(?:you know|like),)/gi;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(SENTENCE_INITIAL_MARKERS, "$1").replace(/\s+/g, " ").trim();
    if (next === out) break;
    out = next;
  }

  return out
    // 5. "like <number>" approximation after a be-form, e.g. "it's like 10
    //    minutes" → "it's 10 minutes" (not after "I like 10…", which is
    //    content).
    .replace(/(?<=\b(?:is|was|were|are|be|been|am|'s|’s)\s+)like\s+(?=\d)/gi, "")
    // 6. Collapse whitespace and drop spaces before sentence punctuation.
    //    A space before "." is kept when the dot starts a token ("../src",
    //    ".env") — only sentence-ending dots collapse ("first . second" →
    //    "first. second").
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:!?]|\.(?=\s|$))/g, "$1")
    .trim()
    // 7. Capitalize the start of each sentence.
    .replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix, letter) => prefix + letter.toUpperCase());
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Last line of defense: normalize a correctly recognized spoken form back to
 * the canonical written spelling — "poll vue app" → "poll-vue-app",
 * "view model" → "ViewModel". Only exact spoken phrases are replaced
 * (word-bounded, case-insensitive), so ordinary prose is never rewritten.
 */
export function applySpokenFormMap(text: string): string {
  let out = text;
  for (const term of GLOBAL_VOCABULARY) {
    const spoken = spokenFormOf(term);
    if (spoken === term.toLowerCase()) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(spoken)}\\b`, "gi"), term);
  }
  return out;
}

/**
 * Clean + trim a transcript for insertion, then normalize recognized spoken
 * forms to their canonical spellings. Returns null when nothing meaningful
 * remains (silence, fillers only, or punctuation-only leftovers such as
 * "Uh.").
 */
export function prepareTranscriptForInsert(text: string): string | null {
  const cleaned = applySpokenFormMap(cleanTranscript(text)).trim();
  if (!cleaned) return null;
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : null;
}

/** Prepended when dictation lands in an empty editor: a brief note that the
 *  text is a voice transcription and may contain misspellings, so the coding
 *  agent does not treat every word as exact. */
export const VOICE_TRANSCRIPTION_PREFIX =
  "User voice transcription — may contain misspellings: ";

/** Prefix dictation only when the editor had no text before insertion. */
export function applyVoicePrefix(editorText: string, cleaned: string): string {
  return editorText.trim() === "" ? `${VOICE_TRANSCRIPTION_PREFIX}${cleaned}` : cleaned;
}

// ─── Extension wiring ────────────────────────────────────────────────────────

export type CaptureLockRelease = () => Promise<void>;

/** Acquire the machine-wide microphone lock. Every Pi session is a separate
 *  OS process, so in-memory `recProc` state alone cannot prevent all of them
 *  from recording and inserting the same utterance. `proper-lockfile` uses an
 *  atomic mkdir, refreshes the lock while recording, and safely recovers a
 *  lock left stale by a terminated Pi process. */
export async function tryAcquireCaptureLock(
  target: string,
  onCompromised: (error: Error) => void = () => {},
): Promise<CaptureLockRelease | null> {
  try {
    return await properLockfile.lock(target, {
      realpath: false,
      stale: CAPTURE_LOCK_STALE_MS,
      update: CAPTURE_LOCK_UPDATE_MS,
      retries: 0,
      onCompromised,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return null;
    throw error;
  }
}

/** Stable identity of the session a context belongs to. Voice state is keyed
 *  by session so a recording is bound to the session (and editor) that
 *  triggered it, not to whichever session started last. */
function sessionKeyOf(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager;
  if (sm) {
    try {
      const id = sm.getSessionId();
      if (id) return `session:${id}`;
    } catch {
      // Fall through to the file/cwd keys below.
    }
    try {
      const file = sm.getSessionFile();
      if (file) return `file:${file}`;
    } catch {
      // Fall through to the cwd key below.
    }
  }
  return `cwd:${ctx.cwd}`;
}

/** Per-session voice state: its own push-to-talk machine, terminal-input
 *  listener, and UI bindings. Everything that happens during a recording —
 *  status, notifications, transcription context, and editor insertion —
 *  is routed through this session's context. */
interface SessionRuntime {
  ctx: ExtensionContext;
  profile: AsrProjectProfile;
  ptt: PushToTalk;
  status: string | undefined;
  /** Unsubscriber for this session's terminal-input listener. */
  unsubscribe: (() => void) | undefined;
}

export default function (pi: ExtensionAPI): void {
  // Per-session voice state. Each session owns a PushToTalk machine and a
  // terminal-input listener, so hold-Shift works in every open session and a
  // transcript lands in the editor of the session that recorded it.
  const sessions = new Map<string, SessionRuntime>();
  let terminalProtocolsEnabled = false;

  // Shared microphone capture backend. `recProc` coordinates sessions hosted
  // by this extension instance; the filesystem lock coordinates the separate
  // OS process used by every other open Pi session.
  let recProc: ChildProcess | undefined;
  let recDir: string | undefined;
  let recError = "";
  let captureResolve: ((path: string | null) => void) | undefined;
  let captureOwner: string | undefined;
  let captureLockRelease: CaptureLockRelease | undefined;
  let captureCompromised = false;
  let pendingStop = false;

  async function releaseActiveCaptureLock(): Promise<void> {
    const release = captureLockRelease;
    captureLockRelease = undefined;
    if (release) await release().catch(() => {});
  }

  function finishCapture(path: string | null): void {
    const resolve = captureResolve;
    captureResolve = undefined;
    captureOwner = undefined;
    resolve?.(path);
  }

  function interruptCapture(proc: ChildProcess): void {
    const interrupt = () => {
      if (recProc !== proc) return;
      proc.kill("SIGINT"); // SoX finalizes the WAV header on SIGINT.
      const hardKill = setTimeout(() => {
        if (recProc === proc) proc.kill("SIGKILL");
      }, 2000);
      hardKill.unref?.();
    };
    if (proc.pid !== undefined) interrupt();
    else proc.once("spawn", interrupt);
  }

  /** Begin a capture on behalf of the given session. Resolves with the WAV
   *  path when the capture ends, or null on failure (including "another
   *  session is already recording"). */
  function startCaptureFor(sessionKey: string, autoStopOnSilence: boolean): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      if (recProc || captureResolve) {
        recError = "another Pi session is already recording";
        resolve(null);
        return;
      }
      captureResolve = resolve;
      captureOwner = sessionKey;
      captureCompromised = false;
      pendingStop = false;

      void (async () => {
        try {
          const release = await tryAcquireCaptureLock(CAPTURE_LOCK_TARGET, (error) => {
            if (captureOwner !== sessionKey) return;
            captureCompromised = true;
            recError = `voice capture lock was lost: ${error.message}`;
            pendingStop = true;
            if (recProc) interruptCapture(recProc);
          });
          if (!release) {
            recError = "another Pi session is already recording";
            finishCapture(null);
            return;
          }
          captureLockRelease = release;

          const dir = await mkdtemp(join(tmpdir(), "pi-asr-"));
          // The session may have closed while the lock or temporary directory
          // was being acquired. Do not start an orphan microphone process.
          if (
            !sessions.has(sessionKey) ||
            captureOwner !== sessionKey ||
            captureCompromised
          ) {
            await rm(dir, { recursive: true, force: true });
            await releaseActiveCaptureLock();
            finishCapture(null);
            return;
          }

          recDir = dir;
          const out = join(dir, "capture.wav");
          recError = "";
          const proc = spawn("rec", buildRecArgs(out, autoStopOnSilence), {
            stdio: ["ignore", "ignore", "pipe"],
          });
          recProc = proc;
          let finalized = false;
          const finalize = async (path: string | null) => {
            if (finalized) return;
            finalized = true;
            if (recProc === proc) recProc = undefined;
            if (recDir === dir) recDir = undefined;
            pendingStop = false;
            let completedPath = captureCompromised ? null : path;
            await releaseActiveCaptureLock();
            // A compromise can race with process exit or lock release; check
            // again before handing audio to transcription.
            if (captureCompromised) completedPath = null;
            if (!completedPath) await rm(dir, { recursive: true, force: true });
            finishCapture(completedPath);
          };
          proc.stderr?.on("data", (chunk: Buffer) => {
            recError = (recError + chunk.toString()).replace(/\s+/g, " ").trim().slice(0, 300);
          });
          proc.on("error", (error: NodeJS.ErrnoException) => {
            recError =
              error.code === "ENOENT"
                ? "rec (SoX) is not installed — run `brew install sox`"
                : error.message;
            // A spawn failure has no child to wait for. Later errors can come
            // from a failed kill signal while `rec` is still alive; retain the
            // cross-process lock until its close event in that case.
            if (proc.pid === undefined) void finalize(null);
          });
          proc.on("close", () => {
            // A valid non-empty WAV means the capture succeeded, even if the
            // exit code is nonzero (SIGINT stop or silence auto-stop).
            let ok = false;
            try {
              ok = statSync(out).size > 44;
            } catch {
              // Shutdown may remove the temporary directory before close.
            }
            void finalize(ok ? out : null);
          });
          if (pendingStop) interruptCapture(proc);
        } catch (error) {
          recError = error instanceof Error ? error.message : String(error);
          await releaseActiveCaptureLock();
          finishCapture(null);
        }
      })();
    });
  }

  /** Stop the in-flight capture, but only if this session owns it. */
  function stopCaptureFor(sessionKey: string): void {
    if (captureOwner !== undefined && captureOwner !== sessionKey) return;
    pendingStop = true;
    const proc = recProc;
    if (proc) interruptCapture(proc);
  }

  /** Stop whatever capture is running (used when the last session closes). */
  function forceStopCapture(): void {
    pendingStop = true;
    const proc = recProc;
    if (proc) interruptCapture(proc);
  }

  /** Build the per-session push-to-talk machine and its UI bindings. All
   *  effects are bound to this session's context, so status messages,
   *  notifications, transcription context, and editor insertion stay in the
   *  session that triggered the recording. */
  function createSessionRuntime(ctx: ExtensionContext, key: string): SessionRuntime {
    const runtime: SessionRuntime = {
      ctx,
      profile: mergeAsrProfiles(
        GLOBAL_ASR_PROFILE,
        resolveAsrProjectProfile(ctx.cwd, ctx.isProjectTrusted()),
      ),
      ptt: undefined!, // Assigned below, before the runtime is used.
      status: undefined,
      unsubscribe: undefined,
    };
    // Always dereference runtime.ctx: session reload/resume can replace the UI
    // context while a capture or transcription is still in flight.
    const notify = (message: string, type?: "info" | "warning" | "error") =>
      runtime.ctx.ui.notify(message, type);
    const setStatus = (text: string | undefined) => {
      runtime.status = text;
      runtime.ctx.ui.setStatus(STATUS_KEY, text);
    };
    const effects: CaptureEffects = {
      notify,
      setStatus,
      startCapture: (autoStopOnSilence) => startCaptureFor(key, autoStopOnSilence),
      stopCapture: () => stopCaptureFor(key),
      lastCaptureError: () => recError,
      cleanupAudio: async (audioPath) => {
        if (!audioPath) return;
        await rm(dirname(audioPath), { recursive: true, force: true }).catch(() => {});
      },
      transcribe: async (audioPath) => {
        const { apiKey, baseUrl } = getDashScopeCredentials();
        if (!apiKey) {
          throw new Error(
            "DASHSCOPE_API_KEY is not set. Add it to ~/.pi/agent/.env or your environment, then /reload.",
          );
        }
        if (!baseUrl) {
          throw new Error(
            "DASHSCOPE_BASE_URL is not set. Add it to ~/.pi/agent/.env or your environment, then /reload.",
          );
        }
        return transcribeAudio(audioPath, apiKey, baseUrl, runtime.profile);
      },
      refineTranscript: async (text) => {
        // Total: a missing key, network failure, or empty result keeps the
        // raw transcript; the deterministic cleanup in insertTranscript still
        // applies afterwards. The merged ASR profile (global + project) is
        // passed along so the LLM sees the same context and terminology
        // that DashScope received.
        const apiKey = getOpenRouterKey();
        if (!apiKey) return text;
        return refineTranscriptWithOpenRouter(text, apiKey, runtime.profile).catch(() => text);
      },
      insertTranscript: (text) => {
        // Deterministic post-processing right before insertion: strips fillers
        // and discourse markers; nothing meaningful left means no speech.
        const cleaned = prepareTranscriptForInsert(text);
        if (!cleaned) {
          runtime.ctx.ui.notify("No speech detected — try again.", "warning");
          return;
        }
        // An empty editor gets a brief voice-transcription note so the agent
        // knows the text came from dictation and may contain errors.
        const toInsert = applyVoicePrefix(runtime.ctx.ui.getEditorText(), cleaned);
        runtime.ctx.ui.pasteToEditor(toInsert);
        const preview = toInsert.length > 100 ? `${toInsert.slice(0, 100)}…` : toInsert;
        runtime.ctx.ui.notify(`Inserted: ${preview}`, "info");
      },
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancelSchedule: (handle) => {
        if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
      },
    };
    runtime.ptt = new PushToTalk(effects);
    return runtime;
  }

  function enableTerminalProtocols(): void {
    if (!process.stdout.isTTY) return;
    if (!terminalProtocolsEnabled) {
      process.stdout.write(ENABLE_STANDALONE_KEY_EVENTS);
      terminalProtocolsEnabled = true;
    }
    // Reissuing mode 1004 asks Ghostty to report the current focus state to a
    // newly installed/replaced listener even when the mode was already on.
    process.stdout.write(ENABLE_FOCUS_TRACKING);
  }

  function restoreTerminalProtocols(): void {
    if (!terminalProtocolsEnabled) return;
    try {
      process.stdout.write(DISABLE_FOCUS_TRACKING);
      process.stdout.write(RESTORE_KEYBOARD_PROTOCOL);
    } finally {
      terminalProtocolsEnabled = false;
    }
  }

  /** Bind (or refresh) voice state for a session. Returns the session's
   *  push-to-talk machine so callers can drive it directly. */
  function setup(ctx: ExtensionContext): SessionRuntime {
    const key = sessionKeyOf(ctx);
    let runtime = sessions.get(key);
    if (!runtime) {
      runtime = createSessionRuntime(ctx, key);
      sessions.set(key, runtime);
    } else {
      // Same session restarted (reload/resume): refresh the context and move
      // the terminal listener to the replacement UI.
      if (runtime.ctx !== ctx) {
        runtime.unsubscribe?.();
        runtime.unsubscribe = undefined;
        runtime.ctx.ui.setStatus(STATUS_KEY, undefined);
        runtime.ctx = ctx;
        runtime.ctx.ui.setStatus(STATUS_KEY, runtime.status);
      }
      runtime.profile = mergeAsrProfiles(
        GLOBAL_ASR_PROFILE,
        resolveAsrProjectProfile(ctx.cwd, ctx.isProjectTrusted()),
      );
    }
    if (ctx.mode === "tui" && ctx.hasUI) {
      const r = runtime;
      if (!r.unsubscribe) {
        // Register before enabling focus tracking: Ghostty immediately reports
        // this split's current focus state in response to CSI ? 1004 h.
        r.unsubscribe = ctx.ui.onTerminalInput((data) => r.ptt.handleInput(data));
        enableTerminalProtocols();
      }
    }
    return runtime;
  }

  pi.on("session_start", (_event, ctx) => {
    setup(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKeyOf(ctx);
    const runtime = sessions.get(key);
    // A reload/resume can replace the context before the old context emits
    // its delayed shutdown. Ignore that stale event; it no longer owns this
    // session runtime.
    if (runtime?.ctx === ctx) {
      runtime.unsubscribe?.();
      runtime.unsubscribe = undefined;
      runtime.ptt.shutdown();
      runtime.ctx.ui.setStatus(STATUS_KEY, undefined);
      sessions.delete(key);
    }
    if (![...sessions.values()].some((candidate) => candidate.unsubscribe)) {
      restoreTerminalProtocols();
    }
    if (sessions.size === 0) {
      // Last session closed: stop any capture so the microphone is released
      // and drop leftover temp audio. The extension stays usable for sessions
      // that start later.
      forceStopCapture();
      if (recDir) {
        const dir = recDir;
        recDir = undefined;
        void rm(dir, { recursive: true, force: true });
      }
    }
  });

  pi.registerCommand("voice", {
    description:
      "Record from the microphone until silence, transcribe (DashScope qwen-audio-3.0-asr-flash), and insert at the editor cursor. Same engine as hold-Shift dictation.",
    handler: async (_args, ctx) => {
      const runtime = setup(ctx);
      await runtime.ptt.runVoiceCommand();
    },
  });
}
