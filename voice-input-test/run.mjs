// Test harness for ~/.pi/agent/extensions/voice-input.ts
//
// Runs the real extension file under Node's native TypeScript type-stripping,
// stubbing only the two bare package specifiers. The push-to-talk state
// machine (PushToTalk) is driven with synthetic Kitty CSI-u and legacy raw
// byte sequences, a fake clock, and fake effects — no microphone or network.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(TEST_DIR);
const STUB_AGENT = join(TEST_DIR, "stub-agent.mjs");
const VOICE_EXTENSION = join(ROOT_DIR, "agent/extensions/voice-input.ts");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: pathToFileURL(STUB_AGENT).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const {
  FOQUZ_CORE_PROFILE,
  GLOBAL_ASR_PROFILE,
  GLOBAL_VOCABULARY,
  REFINEMENT_SYSTEM_PROMPT,
  applySpokenFormMap,
  mergeAsrProfiles,
  PushToTalk,
  buildAsrContextMessages,
  buildAsrContextText,
  buildHotwords,
  buildRecArgs,
  buildRefinementMessages,
  cleanTranscript,
  extractRefinementText,
  prepareTranscriptForInsert,
  refineTranscriptWithOpenRouter,
  resolveAsrProjectProfile,
  spokenFormOf,
  transcribeAudio,
} = await import(pathToFileURL(VOICE_EXTENSION).href);

// ─── Helpers ─────────────────────────────────────────────────────────────────

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else {
    failures++;
    console.error("  FAIL " + msg);
  }
}
function eq(got, want, msg) {
  ok(JSON.stringify(got) === JSON.stringify(want), `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 8) {
  for (let i = 0; i < n; i++) await tick();
}

function makeEffects() {
  const state = {
    nowMs: 0,
    timers: new Map(), // id -> { at, fn }
    nextId: 1,
    captures: [], // { autoStopOnSilence }
    captureResolve: null,
    stops: 0,
    sent: [],
    cleanups: [],
    status: undefined,
    notifies: [],
    transcriptResult: "hello world",
    transcribeError: null,
    lastCaptureErr: "",
    refineResult: null, // when set, refineTranscript resolves to this instead of its input
    refined: [],        // every input passed to refineTranscript
  };
  const effects = {
    notify: (msg, type) => state.notifies.push({ msg, type }),
    setStatus: (t) => {
      state.status = t;
    },
    startCapture: (autoStopOnSilence) =>
      new Promise((resolve) => {
        state.captures.push({ autoStopOnSilence });
        state.captureResolve = resolve; // test resolves this later, like a real rec exit
      }),
    stopCapture: () => {
      state.stops++;
    },
    lastCaptureError: () => state.lastCaptureErr,
    cleanupAudio: async (path) => state.cleanups.push(path),
    transcribe: async () => {
      if (state.transcribeError) throw state.transcribeError;
      return state.transcriptResult;
    },
    refineTranscript: async (t) => {
      state.refined.push(t);
      return state.refineResult === null ? t : state.refineResult;
    },
    insertTranscript: (t) => {
      state.sent.push(t); // `sent` is retained as the test's transcript-output bucket.
    },
    now: () => state.nowMs,
    schedule: (fn, ms) => {
      const id = state.nextId++;
      state.timers.set(id, { at: state.nowMs + ms, fn });
      return id;
    },
    cancelSchedule: (id) => {
      state.timers.delete(id);
    },
    state,
    advance(ms) {
      const target = state.nowMs + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of state.timers) {
          if (t.at <= target && (due === null || t.at < due.at)) due = { id, at: t.at, fn: t.fn };
        }
        if (!due) break;
        state.timers.delete(due.id);
        state.nowMs = due.at;
        due.fn();
      }
      state.nowMs = target;
    },
  };
  return effects;
}

// Kitty may omit the default `:1` event type on presses.
const K_PRESS = "\x1b[57441;2u";
const K_REPEAT = "\x1b[57441;2:2u";
const K_RELEASE = "\x1b[57441;1:3u";
const K_RIGHT_PRESS = "\x1b[57447;1u";
const K_RIGHT_RELEASE = "\x1b[57447;1:3u";
const K_LEFT_CTRL_PRESS = "\x1b[57442;5u";
const K_CTRL_SHIFT_PRESS = "\x1b[57441;6u";
const K_SHIFTED_A = "\x1b[97:65:97;2:1u";
const K_SPACE = "\x1b[32;1:1u";

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("capture: /voice SoX arguments stop after trailing silence");
{
  eq(
    buildRecArgs("/tmp/capture.wav", false),
    ["-q", "-c", "1", "-r", "16000", "-b", "16", "/tmp/capture.wav"],
    "hold-Shift capture has no silence effect",
  );
  eq(
    buildRecArgs("/tmp/capture.wav", true),
    [
      "-q",
      "-c",
      "1",
      "-r",
      "16000",
      "-b",
      "16",
      "/tmp/capture.wav",
      "silence",
      "1",
      "0.1",
      "2%",
      "1",
      "2.0",
      "2%",
    ],
    "/voice starts on speech and stops after trailing silence",
  );
}

console.log("project context: selects a trusted foquz-core Git repository and its worktrees");
{
  const dir = await mkdtemp(join(tmpdir(), "pi-asr-project-test-"));
  const repo = join(dir, "repo-with-any-name");
  const worktree = join(dir, "worktree-with-any-name");
  const nestedRepo = join(repo, "vendor/unrelated-repository");

  try {
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "remote.origin.url",
      "git@doxsw.gitlab.yandexcloud.net:doxsw/foquz-core.git",
    ]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=ASR Test",
      "-c",
      "user.email=asr-test@example.invalid",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "initial",
    ]);
    await mkdir(join(repo, "ko/pages"), { recursive: true });
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", "-q", worktree]);
    await mkdir(join(worktree, "ko/pages"), { recursive: true });

    eq(
      resolveAsrProjectProfile(join(repo, "ko/pages"), true)?.id,
      "foquz-core",
      "nested cwd in a foquz-core clone selects profile",
    );
    eq(
      resolveAsrProjectProfile(join(worktree, "ko/pages"), true)?.id,
      "foquz-core",
      "arbitrarily located foquz-core worktree selects profile",
    );
    eq(
      resolveAsrProjectProfile(repo, false),
      undefined,
      "untrusted foquz-core clone gets no profile",
    );

    execFileSync("git", ["init", "-q", nestedRepo]);
    execFileSync("git", [
      "-C",
      nestedRepo,
      "config",
      "remote.origin.url",
      "git@example.invalid:unrelated/repository.git",
    ]);
    eq(
      resolveAsrProjectProfile(nestedRepo, true),
      undefined,
      "nearest unrelated nested repository gets no ancestor profile",
    );
    eq(resolveAsrProjectProfile(undefined, true), undefined, "missing cwd gets no profile");

    eq(buildAsrContextText(), "", "no profile → no context text");
    eq(buildAsrContextMessages(), [], "no profile → no context messages");

    const profileText = buildAsrContextText(FOQUZ_CORE_PROFILE);
    ok(profileText.includes("Current software project: foquz-core."), "profile description included");
    ok(profileText.includes("PHP 8.2 and Yii 2"), "project description included");

    const contextMessages = buildAsrContextMessages(
      mergeAsrProfiles(GLOBAL_ASR_PROFILE, FOQUZ_CORE_PROFILE),
    );
    ok(
      contextMessages.length >= 2 && contextMessages.length <= 4,
      "context fits the documented 4-turn budget",
    );
    eq(contextMessages[0].role, "user", "context turns are user messages");
    eq(contextMessages[0].content[0].type, "input_text", "context uses input_text (DashScope §7.3)");
    ok(
      contextMessages[0].content[0].text.includes("Current software project: foquz-core."),
      "first turn has the description",
    );
    const allContextText = contextMessages.map((m) => m.content[0].text).join("\n");
    ok(allContextText.includes("FoquzQuestion"), "vocabulary terms included in context turns");
    ok(allContextText.includes("doxswf"), "hard-word terms included in context turns");
    ok(
      contextMessages.every((m) => m.content[0].text.length <= 400),
      "each context turn within the 400-char limit",
    );

    const hotwords = buildHotwords(GLOBAL_VOCABULARY);
    eq(hotwords["foquz"], 4, "plain term keeps the normal hotword weight");
    eq(hotwords["foquz question"], 50, "camelCase term boosted via its spoken form");
    eq(hotwords["poll vue app"], 50, "hyphenated identifier boosted via its spoken form");
    eq(
      Object.keys(hotwords).length,
      new Set(GLOBAL_VOCABULARY.map(spokenFormOf)).size,
      "every distinct spoken form becomes a hotword (foquz-question and FoquzQuestion share one)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("global profile: hard-word vocabulary applies to every session");
{
  eq(GLOBAL_ASR_PROFILE.id, "global", "global profile id");
  eq(GLOBAL_ASR_PROFILE.vocabulary, GLOBAL_VOCABULARY, "global profile carries the full global vocabulary");
  eq(
    mergeAsrProfiles(GLOBAL_ASR_PROFILE, undefined),
    GLOBAL_ASR_PROFILE,
    "no project profile → global alone",
  );

  const merged = mergeAsrProfiles(GLOBAL_ASR_PROFILE, FOQUZ_CORE_PROFILE);
  eq(merged.id, "foquz-core", "merged profile keeps the project id");
  eq(merged.displayName, "foquz-core", "merged profile keeps the project display name");
  ok(merged.context.length >= 4, "merged profile keeps the project description");
  ok(merged.vocabulary.includes("foquz"), "merged vocabulary includes global terms");
  ok(merged.vocabulary.length >= GLOBAL_VOCABULARY.length, "merged vocabulary is global + project");

  const globalMessages = buildAsrContextMessages(GLOBAL_ASR_PROFILE);
  eq(globalMessages.length, 1, "global profile alone produces a single term-list turn");
  const globalText = globalMessages.map((m) => m.content[0].text).join("\n");
  ok(globalText.includes("poll-vue-app (poll vue app)"), "written and spoken forms both in context");
  ok(globalText.includes("foquz-core"), "global vocabulary terms reach the context turns");
  ok(globalText.includes("knockout"), "global vocabulary includes knockout");
  ok(!globalText.includes("PHP 8.2"), "no foquz-core-specific description in the global profile");
  ok(!globalText.includes("anna.kuznetsova"), "no username-like terms in the global profile");
}

console.log("transcription: sends the global profile merged with foquz-core as DashScope context");
{
  const dir = await mkdtemp(join(tmpdir(), "pi-asr-request-test-"));
  const audioPath = join(dir, "capture.wav");
  const originalFetch = globalThis.fetch;
  let request;

  try {
    await writeFile(audioPath, Uint8Array.from([1, 2, 3]));
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({ text: "recognized FoquzQuestion" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    eq(
      await transcribeAudio(
        audioPath,
        "test-key",
        "https://example.maas.aliyuncs.com",
        mergeAsrProfiles(GLOBAL_ASR_PROFILE, FOQUZ_CORE_PROFILE),
      ),
      "recognized FoquzQuestion",
      "transcript parsed from top-level text",
    );
    eq(
      request.url,
      "https://example.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      "native DashScope generation endpoint used",
    );
    eq(request.options.method, "POST", "POST request used");
    eq(request.options.headers.Authorization, "Bearer test-key", "API key sent");

    const payload = JSON.parse(request.options.body);
    eq(payload.model, "qwen-audio-3.0-asr-flash", "Qwen ASR model selected");
    ok(payload.input.messages.length >= 2, "context message precedes audio");
    const contextMessage = payload.input.messages[0];
    eq(contextMessage.role, "user", "context role is user");
    eq(contextMessage.content[0].type, "input_text", "context uses input_text (DashScope §7.3)");
    ok(contextMessage.content[0].text.includes("Current software project: foquz-core."), "foquz-core selected");
    ok(contextMessage.content[0].text.includes("PHP 8.2 and Yii 2"), "project description included");
    const audioMessage = payload.input.messages[payload.input.messages.length - 1];
    eq(audioMessage.role, "user", "audio role is user");
    eq(audioMessage.content[0].type, "input_audio", "audio message type used");
    eq(
      audioMessage.content[0].input_audio.data,
      "data:audio/wav;base64,AQID",
      "audio sent as a WAV data URI",
    );
    eq(payload.parameters.format, "wav", "WAV format sent");
    eq(payload.parameters.sample_rate, "16000", "16 kHz sample rate sent");
    eq(payload.parameters.language_hints, ["en"], "English language hint sent");
    eq(payload.parameters.vocabulary["foquz"], 4, "inline hotword for foquz");
    eq(payload.parameters.vocabulary["foquz question"], 50, "camelCase term boosted via spoken hotword");
    eq(payload.parameters.vocabulary["poll vue app"], 50, "hyphenated identifier boosted via spoken hotword");
    ok(payload.messages === undefined, "no chat-completions messages shape");
    ok(payload.temperature === undefined, "no temperature parameter");
    ok(payload.reasoning === undefined, "no reasoning parameter");
    ok(!JSON.stringify(payload).includes("Convert the user's audio"), "no Gemini cleanup prompt");

    await transcribeAudio(audioPath, "test-key", "https://example.maas.aliyuncs.com");
    const genericPayload = JSON.parse(request.options.body);
    eq(genericPayload.input.messages.length, 1, "transcribeAudio without a profile sends only the audio message");
    eq(genericPayload.parameters.vocabulary, undefined, "no hotwords without a profile");
    ok(!JSON.stringify(genericPayload).includes("FoquzQuestion"), "no vocabulary without a profile");

    await transcribeAudio(audioPath, "test-key", "https://example.maas.aliyuncs.com", GLOBAL_ASR_PROFILE);
    const globalPayload = JSON.parse(request.options.body);
    ok(globalPayload.input.messages.length >= 2, "global profile adds context turns");
    ok(
      globalPayload.input.messages[0].content[0].text.includes("poll-vue-app (poll vue app)"),
      "global term list used without a project profile",
    );
    eq(globalPayload.parameters.vocabulary["foquz"], 4, "global hotword for foquz");
    eq(globalPayload.parameters.vocabulary["foquz question"], 50, "global spoken super hotword for camelCase term");
    ok(
      !JSON.stringify(globalPayload).includes("PHP 8.2"),
      "no foquz-core-specific description in the global request",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("spoken forms: recognized speech normalized to canonical spellings");
{
  eq(spokenFormOf("poll-vue-app"), "poll vue app", "hyphens become spaces");
  eq(spokenFormOf("foquz-frontend-vue"), "foquz frontend vue", "multi-hyphen term split");
  eq(spokenFormOf("FoquzQuestion"), "foquz question", "camelCase is split");
  eq(spokenFormOf("ViewModel"), "view model", "camelCase is split (2)");
  eq(spokenFormOf("NPS"), "nps", "acronyms lowercase");
  eq(spokenFormOf("knockout"), "knockout", "plain word unchanged");
  eq(
    applySpokenFormMap("show me the poll vue app repo"),
    "show me the poll-vue-app repo",
    "spoken form normalized to canonical spelling",
  );
  eq(applySpokenFormMap("the foquz core backend"), "the foquz-core backend", "hyphenated term normalized");
  eq(applySpokenFormMap("plain prose stays untouched"), "plain prose stays untouched", "no rewrite without a match");
  eq(prepareTranscriptForInsert("open the poll vue app"), "Open the poll-vue-app", "insert path normalizes spoken forms");
}

console.log("cleanTranscript: deterministic filler removal and tidying");
{
  // Disfluency fillers (any casing, repetition, hyphenation, trailing comma).
  eq(cleanTranscript("Uh can you show me uh the latest projects."), "Can you show me the latest projects.", "uh removed at sentence start and mid-sentence");
  eq(
    cleanTranscript("Hey, how are you doing today? Uh can you show me uh the latest projects I've been working on."),
    "Hey, how are you doing today? Can you show me the latest projects I've been working on.",
    "user example cleaned deterministically",
  );
  eq(cleanTranscript("uh-huh, sure"), "Sure", "hyphenated filler removed with its comma");
  eq(cleanTranscript("tell 'em, um, that"), "Tell 'em, that", "'em pronoun survives, um removed");
  eq(cleanTranscript("Oh, I see"), "I see", "oh removed");
  eq(cleanTranscript("so, the plan is simple"), "The plan is simple", "sentence-initial so removed");
  eq(cleanTranscript("er, let me think"), "Let me think", "er filler removed");

  // Real-word collisions must survive.
  eq(cleanTranscript("To err is human"), "To err is human", "verb err kept");
  eq(cleanTranscript("Err on the side of caution"), "Err on the side of caution", "err on kept");
  eq(cleanTranscript("Use an em dash here"), "Use an em dash here", "em dash kept");
  eq(cleanTranscript("Make it 5 mm thick"), "Make it 5 mm thick", "mm measurement kept");

  // Discourse markers: sentence-initial, comma-bounded, trailing, cascades.
  eq(cleanTranscript("okay, let's start"), "Let's start", "sentence-initial okay removed");
  eq(cleanTranscript("okay."), "Okay.", "standalone acknowledgment kept (sentence capitalized)");
  eq(cleanTranscript("well, let's get started"), "Let's get started", "sentence-initial well removed");
  eq(cleanTranscript("Well done!"), "Well done!", "content well kept");
  eq(cleanTranscript("so we decided to leave"), "We decided to leave", "sentence-initial so without comma removed");
  eq(cleanTranscript("So that we can win"), "So that we can win", "purpose so that kept");
  eq(cleanTranscript("I mean, it's fine"), "It's fine", "sentence-initial I mean removed");
  eq(cleanTranscript("I mean it"), "I mean it", "content I mean kept");
  eq(cleanTranscript("you know, it's hard"), "It's hard", "sentence-initial you know removed");
  eq(cleanTranscript("You know the answer"), "You know the answer", "content you know kept");
  eq(cleanTranscript("it's, you know, tricky"), "It's tricky", "comma-bounded you know removed");
  eq(cleanTranscript("it's tricky, you know."), "It's tricky.", "trailing you know removed");
  eq(cleanTranscript("like, really?"), "Really?", "sentence-initial like removed");
  eq(cleanTranscript("it's, like, really cool"), "It's really cool", "comma-bounded like removed");
  eq(cleanTranscript("it's like 10 minutes"), "It's 10 minutes", "like <number> approximation removed");
  eq(cleanTranscript("I like 10 of those"), "I like 10 of those", "content like kept");
  eq(cleanTranscript("well, you know, it's fine"), "It's fine", "cascading markers fully cleaned");
  eq(cleanTranscript("Okay so let's go"), "Let's go", "okay + so cascade cleaned");

  // Tidying: whitespace, punctuation, sentence capitalization.
  eq(cleanTranscript("hello   world"), "Hello world", "whitespace collapsed and sentence capitalized");
  eq(cleanTranscript("wait , what"), "Wait, what", "space before comma removed");
  eq(cleanTranscript("first . second"), "First. Second", "each sentence capitalized");
  eq(cleanTranscript("um, uh, I mean, like, let's go"), "Let's go", "filler storm reduces to the real request");

  eq(prepareTranscriptForInsert("hello world"), "Hello world", "clean transcript prepared");
  eq(prepareTranscriptForInsert("uh"), null, "filler only → no speech");
  eq(prepareTranscriptForInsert("um um um"), null, "repeated fillers → no speech");
  eq(prepareTranscriptForInsert("Uh."), null, "punctuation-only leftover → no speech");
  eq(prepareTranscriptForInsert("   \n"), null, "blank → no speech");
}

console.log("refinement: Gemini 3.5 Flash Lite prompt and response parsing");
{
  ok(
    REFINEMENT_SYSTEM_PROMPT.includes("Only delete") &&
      REFINEMENT_SYSTEM_PROMPT.includes("Never rephrase"),
    "prompt is deletion-only",
  );
  ok(REFINEMENT_SYSTEM_PROMPT.includes("repeated sentences"), "prompt targets repeated sentences");
  ok(REFINEMENT_SYSTEM_PROMPT.includes("ASR repetition loops"), "prompt targets ASR loops");

  const messages = buildRefinementMessages("we need to we need to deploy");
  eq(messages.length, 2, "system + user messages");
  eq(messages[0].role, "system", "system message first");
  eq(messages[1].role, "user", "user message second");
  eq(messages[1].content, "we need to we need to deploy", "raw transcript sent verbatim");

  eq(
    extractRefinementText({ choices: [{ message: { content: "we need to deploy" } }] }),
    "we need to deploy",
    "plain content parsed",
  );
  eq(
    extractRefinementText({ choices: [{ message: { content: "```text\nwe need to deploy\n```" } }] }),
    "we need to deploy",
    "code fences stripped",
  );
  eq(extractRefinementText({ choices: [] }), null, "empty choices → null");
  eq(extractRefinementText({}), null, "missing choices → null");
  eq(
    extractRefinementText({ choices: [{ message: { content: "" } }] }),
    null,
    "empty content → null",
  );
}

console.log("refinement: short utterances and missing keys skip the network");
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
  };
  try {
    eq(await refineTranscriptWithOpenRouter("yes", "test-key"), "yes", "1-word utterance skipped");
    eq(
      await refineTranscriptWithOpenRouter("deploy", "test-key"),
      "deploy",
      "under-3-word utterance skipped",
    );
    eq(
      await refineTranscriptWithOpenRouter("we need to we need to deploy", ""),
      "we need to we need to deploy",
      "missing key keeps the raw transcript",
    );
    eq(calls, 0, "no network request for skipped cases");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("refinement: OpenRouter request shape, success, and failure fallback");
{
  const originalFetch = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "we need to deploy" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    eq(
      await refineTranscriptWithOpenRouter("we need to we need to deploy", "test-key"),
      "we need to deploy",
      "cleaned transcript returned on success",
    );
    eq(request.url, "https://openrouter.ai/api/v1/chat/completions", "OpenRouter chat endpoint used");
    eq(request.options.method, "POST", "POST request used");
    eq(request.options.headers.Authorization, "Bearer test-key", "API key sent");
    const payload = JSON.parse(request.options.body);
    eq(payload.model, "google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite model selected");
    eq(payload.temperature, 0, "temperature 0");
    ok(payload.max_tokens >= 512, "generous output budget");
    eq(payload.messages[0].role, "system", "system message first");
    eq(payload.messages[1].content, "we need to we need to deploy", "raw transcript sent verbatim");

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
    eq(
      await refineTranscriptWithOpenRouter("we need to we need to deploy", "test-key"),
      "we need to we need to deploy",
      "permanent API failure keeps the raw transcript",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("wiring: raw transcript is refined before insertion");
{
  const e = makeEffects();
  e.state.transcriptResult = "deploy deploy the app now";
  e.state.refineResult = "deploy the app now";
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(2000);
  e.state.captureResolve("/tmp/fake/capture.wav");
  await settle();
  eq(e.state.refined, ["deploy deploy the app now"], "raw transcript sent to refinement");
  eq(e.state.sent, ["deploy the app now"], "refined transcript inserted");
}

console.log("kitty: quick Shift tap does nothing and never records");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  eq(ptt.handleInput(K_PRESS), { consume: true }, "press consumed");
  e.advance(100);
  eq(ptt.handleInput(K_RELEASE), { consume: true }, "early release consumed");
  eq(e.state.captures, [], "no capture");
  eq(e.state.sent, [], "nothing sent");
  eq(e.state.status, undefined, "no status set");
}

console.log("kitty: quick Shift tap resets; a later hold still works");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(100);
  ptt.handleInput(K_RELEASE);
  e.advance(300);
  ptt.handleInput(K_PRESS);
  e.advance(2000);
  eq(e.state.captures.length, 1, "second gesture records");
  e.state.captureResolve("/tmp/fake/capture.wav");
  await settle();
  eq(e.state.sent, ["hello world"], "transcript sent");
}

console.log("kitty: hold Shift 2s → record; release → transcribe + insert");
{
  const e = makeEffects();
  e.state.transcriptResult = "deploy the app";
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(2000);
  eq(e.state.captures.length, 1, "capture started after 2s hold");
  eq(e.state.captures[0].autoStopOnSilence, false, "key capture is not silence auto-stop");
  ok(e.state.status.includes("Listening"), "listening status shown");
  eq(ptt.handleInput(K_REPEAT), { consume: true }, "repeat consumed while recording");
  eq(ptt.handleInput(K_RELEASE), { consume: true }, "release consumed while recording");
  eq(e.state.stops, 1, "stopCapture called on release");
  e.state.captureResolve("/tmp/fake/capture.wav");
  await settle();
  eq(e.state.sent, ["deploy the app"], "transcript auto-sent");
  eq(e.state.status, undefined, "status cleared after send");
}

console.log("kitty: right Shift uses the same precise hold gesture");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  eq(ptt.handleInput(K_RIGHT_PRESS), { consume: true }, "right Shift press consumed");
  e.advance(1999);
  eq(e.state.captures.length, 0, "not triggered before exactly 2s");
  e.advance(1);
  eq(e.state.captures.length, 1, "right Shift triggers at 2s");
  eq(ptt.handleInput(K_RIGHT_RELEASE), { consume: true }, "right Shift release consumed");
  eq(e.state.stops, 1, "right Shift release stops capture");
  e.state.captureResolve("/tmp/fake/capture.wav");
  await settle();
  eq(e.state.sent, ["hello world"], "transcript sent");
}

console.log("kitty: release winning the exact-threshold race still starts and stops capture");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  // Put the clock at the threshold without running the due hold timer, modeling
  // stdin release dispatch winning the event-loop race against setTimeout.
  e.state.nowMs = 2000;
  eq(ptt.handleInput(K_RELEASE), { consume: true }, "threshold release consumed");
  eq(e.state.captures.length, 1, "threshold release still starts capture");
  eq(e.state.stops, 1, "threshold release immediately requests stop");
  e.state.captureResolve(null);
  await settle();
}

console.log("typing: a shifted character cancels pending PTT; Space is untouched");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(500);
  eq(ptt.handleInput(K_SHIFTED_A), undefined, "shifted CSI-u character reaches the editor");
  e.advance(2000);
  eq(e.state.captures, [], "normal Shift typing does not record");
  eq(ptt.handleInput(K_RELEASE), { consume: true }, "stray Shift release consumed");
  eq(ptt.handleInput(K_SPACE), undefined, "CSI-u Space reaches the editor unchanged");
  eq(ptt.handleInput(" "), undefined, "raw Space also reaches the editor unchanged");
}

console.log("modifiers: Control and Ctrl+Shift cannot trigger PTT");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  eq(ptt.handleInput(K_LEFT_CTRL_PRESS), { consume: true }, "left Control event consumed");
  eq(ptt.handleInput(K_CTRL_SHIFT_PRESS), { consume: true }, "Ctrl+Shift event consumed");
  e.advance(3000);
  eq(e.state.captures, [], "non-bare Shift modifiers do not record");
}

console.log("kitty: releasing a second Shift does not end the initiating hold");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(100);
  ptt.handleInput(K_RIGHT_PRESS);
  e.advance(100);
  eq(ptt.handleInput(K_RIGHT_RELEASE), { consume: true }, "second Shift release consumed");
  e.advance(1800);
  eq(e.state.captures.length, 1, "initiating left Shift still triggers at 2s");
  eq(ptt.handleInput(K_RELEASE), { consume: true }, "initiating Shift release consumed");
  eq(e.state.stops, 1, "initiating Shift release stops capture");
  e.state.captureResolve(null);
  await settle();
}

console.log("kitty: empty transcript → no send, warning");
{
  const e = makeEffects();
  e.state.transcriptResult = "   \n";
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(2000);
  e.state.captureResolve("/tmp/fake/capture.wav");
  await settle();
  eq(e.state.sent, [], "nothing sent");
  ok(e.state.notifies.some((n) => n.msg.includes("No speech")), "no-speech warning");
  eq(e.state.status, undefined, "status cleared");
}

console.log("kitty: transcription error → error notify, no send");
{
  const e = makeEffects();
  e.state.transcribeError = new Error("DashScope ASR returned 401");
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(2000);
  e.state.captureResolve("/tmp/fake/capture.wav");
  await settle();
  eq(e.state.sent, [], "nothing sent");
  ok(e.state.notifies.some((n) => n.msg.includes("Transcription failed")), "error notify");
}

console.log("kitty: failed capture (mic) → error with permission hint");
{
  const e = makeEffects();
  e.state.lastCaptureErr = "default audio input device could not be opened";
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(2000);
  e.state.captureResolve(null);
  await settle();
  eq(e.state.sent, [], "nothing sent");
  ok(e.state.notifies.some((n) => n.msg.includes("Microphone")), "mic permission hint");
}

console.log("kitty: recording capped at 60s");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(2000);
  eq(e.state.captures.length, 1, "capture started");
  e.advance(60_000);
  ok(e.state.stops >= 1, "stopCapture on cap");
  ok(e.state.notifies.some((n) => n.msg.includes("limit")), "limit notification");
  e.state.captureResolve("/tmp/fake/capture.wav");
  await settle();
  eq(e.state.sent, ["hello world"], "still transcribed after cap");
}

console.log("kitty: Shift during transcription is consumed and cannot start a second capture");
{
  const e = makeEffects();
  let resolveTranscribe;
  e.state.transcriptResult = new Promise((r) => {
    resolveTranscribe = r;
  });
  const ptt = new PushToTalk(e);
  ptt.handleInput(K_PRESS);
  e.advance(2000);
  e.state.captureResolve("/tmp/fake/capture.wav");
  await tick();
  eq(ptt.handleInput(K_PRESS), { consume: true }, "Shift press consumed while transcribing");
  e.advance(2000);
  eq(ptt.handleInput(K_RELEASE), { consume: true }, "Shift release consumed while transcribing");
  eq(ptt.handleInput(" "), undefined, "normal text remains available while transcribing");
  await ptt.runVoiceCommand();
  ok(e.state.notifies.some((n) => n.msg.includes("busy")), "still reports busy");
  eq(e.state.captures.length, 1, "no second capture");
  resolveTranscribe("first message");
  await settle();
  eq(e.state.sent, ["first message"], "first transcript still sent");
}

console.log("shutdown: pending capture and transcription cannot submit stale messages");
{
  const duringCapture = makeEffects();
  const pttCapture = new PushToTalk(duringCapture);
  pttCapture.handleInput(K_PRESS);
  duringCapture.advance(2000);
  pttCapture.shutdown();
  duringCapture.state.captureResolve("/tmp/fake/pending.wav");
  await settle();
  eq(duringCapture.state.sent, [], "shutdown capture sends nothing");
  eq(duringCapture.state.cleanups, ["/tmp/fake/pending.wav"], "shutdown capture is cleaned");

  const duringTranscription = makeEffects();
  let resolveTranscribe;
  duringTranscription.state.transcriptResult = new Promise((r) => {
    resolveTranscribe = r;
  });
  const pttTranscription = new PushToTalk(duringTranscription);
  pttTranscription.handleInput(K_PRESS);
  duringTranscription.advance(2000);
  duringTranscription.state.captureResolve("/tmp/fake/transcribing.wav");
  await tick();
  pttTranscription.shutdown();
  resolveTranscribe("stale message");
  await settle();
  eq(duringTranscription.state.sent, [], "shutdown transcription sends nothing");
  eq(duringTranscription.state.status, undefined, "shutdown clears status");
}

console.log("legacy input: no raw byte can imitate a standalone Shift event");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  eq(ptt.handleInput(" "), undefined, "space forwarded");
  eq(ptt.handleInput("A"), undefined, "letters forwarded");
  e.advance(10_000);
  eq(e.state.captures, [], "raw terminal input does not record");
}

console.log("voice: /voice records until silence, then transcribes + inserts");
{
  const e = makeEffects();
  const ptt = new PushToTalk(e);
  await ptt.runVoiceCommand();
  eq(e.state.captures.length, 1, "voice capture started");
  eq(e.state.captures[0].autoStopOnSilence, true, "silence auto-stop");
  eq(e.state.stops, 0, "no manual stop needed");
  e.state.captureResolve("/tmp/fake/capture.wav");
  await settle();
  eq(e.state.sent, ["hello world"], "voice transcript sent");
}

console.log("voice: /voice is refused while busy");
{
  const e = makeEffects();
  e.state.transcriptResult = new Promise(() => {});
  const ptt = new PushToTalk(e);
  await ptt.runVoiceCommand();
  e.state.captureResolve("/tmp/fake/capture.wav");
  await tick();
  await ptt.runVoiceCommand();
  ok(e.state.notifies.some((n) => n.msg.includes("busy")), "busy notification");
  eq(e.state.captures.length, 1, "no second voice capture");
}

console.log("voice: either Shift key stops /voice immediately");
{
  const left = makeEffects();
  const leftPtt = new PushToTalk(left);
  await leftPtt.runVoiceCommand();
  eq(leftPtt.handleInput(K_PRESS), { consume: true }, "left Shift press consumed");
  eq(left.state.stops, 1, "left Shift immediately stops capture");
  eq(leftPtt.handleInput(K_RELEASE), { consume: true }, "left Shift release consumed");
  eq(left.state.stops, 1, "left Shift release does not stop twice");

  const right = makeEffects();
  const rightPtt = new PushToTalk(right);
  await rightPtt.runVoiceCommand();
  eq(rightPtt.handleInput(K_RIGHT_PRESS), { consume: true }, "right Shift press consumed");
  eq(right.state.stops, 1, "right Shift immediately stops capture");
}

console.log("wiring: default export registers /voice and the input listener");
{
  const pi = {
    handlers: {},
    sent: [],
    commands: {},
    on: (ev, h) => {
      pi.handlers[ev] = h;
    },
    sendUserMessage: (text, opts) => {
      pi.sent.push({ text, opts });
    },
    registerCommand: (name, opts) => {
      pi.commands[name] = opts;
    },
  };
  const mod = await import(pathToFileURL(VOICE_EXTENSION).href);
  mod.default(pi);
  eq(Object.keys(pi.commands), ["voice"], "registers /voice");
  ok(typeof pi.handlers.session_start === "function", "session_start handler");
  let inputHandler = null;
  const ctx = {
    cwd: ROOT_DIR,
    isProjectTrusted: () => true,
    mode: "tui",
    hasUI: true,
    ui: {
      onTerminalInput: (h) => {
        inputHandler = h;
        return () => {};
      },
      notify: () => {},
      setStatus: () => {},
      pasteToEditor: () => {},
      getEditorText: () => "",
      setEditorText: () => {},
    },
  };
  const originalWrite = process.stdout.write;
  const originalIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const protocolWrites = [];
  let pressResult;
  let releaseResult;
  let spaceResult;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.stdout.write = (chunk) => {
      protocolWrites.push(String(chunk));
      return true;
    };
    pi.handlers.session_start({}, ctx);
    pi.handlers.session_start({}, ctx); // setup must be idempotent
    pressResult = inputHandler(K_PRESS);
    releaseResult = inputHandler(K_RELEASE);
    spaceResult = inputHandler(" ");
    pi.handlers.session_shutdown();
  } finally {
    process.stdout.write = originalWrite;
    if (originalIsTty) Object.defineProperty(process.stdout, "isTTY", originalIsTty);
    else delete process.stdout.isTTY;
  }

  ok(typeof inputHandler === "function", "input listener registered on session_start");
  eq(protocolWrites, ["\x1b[>15u", "\x1b[<u"], "keyboard protocol pushed and restored once");
  eq(pressResult, { consume: true }, "wired handler consumes Shift press");
  eq(releaseResult, { consume: true }, "wired handler consumes Shift release");
  eq(spaceResult, undefined, "wired handler leaves Space untouched");
}

console.log("");
if (failures === 0) {
  console.log("ALL TESTS PASSED");
  process.exit(0);
} else {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
