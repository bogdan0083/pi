// One-shot smoke test: refine a real transcript through OpenRouter (GPT-OSS
// 120B hard-pinned to Groq) using the exact code path the
// extension uses (stubbing the agent package only): the curl transport
// (which honors the local http_proxy/https_proxy/ALL_PROXY settings that
// Node's fetch ignores), passing the same merged ASR profile (project
// context + vocabulary) that DashScope receives, then run the deterministic
// pass that would precede insertion. Makes one tiny paid call; the default
// sample costs fractions of a cent.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(TEST_DIR, "..");
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
  GLOBAL_ASR_PROFILE,
  FOQUZ_CORE_PROFILE,
  mergeAsrProfiles,
  prepareTranscriptForInsert,
  refineTranscriptWithOpenRouter,
} = await import(pathToFileURL(VOICE_EXTENSION).href);

const apiKey = process.env.OPENROUTER_API_KEY;
const sample =
  process.argv[2] ??
  "okay so um we need to we need to refactor the poll view app module " +
    "let's refactor the module to use the new api and check the dox sw integration";
// The same merged profile the extension sends to DashScope (global vocabulary
// + foquz-core project description), so the LLM corrects terminology with
// exactly the context and keywords the ASR stage was given.
const profile = mergeAsrProfiles(GLOBAL_ASR_PROFILE, FOQUZ_CORE_PROFILE);

if (!apiKey) {
  console.error('usage: OPENROUTER_API_KEY=.. node refine-smoke.mjs ["transcript text"]');
  process.exit(2);
}

console.log("RAW:      ", JSON.stringify(sample));
const startedAt = performance.now();
const refined = await refineTranscriptWithOpenRouter(sample, apiKey, profile);
const refineMs = Math.round(performance.now() - startedAt);
console.log("REFINED:  ", JSON.stringify(refined));
console.log(`REFINE MS: ${refineMs}`);
const prepared = prepareTranscriptForInsert(refined);
console.log("INSERTED: ", JSON.stringify(prepared));
