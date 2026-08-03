// One-shot smoke test: refine a real transcript through OpenRouter (Gemini
// 3.5 Flash Lite) using the exact code path the extension uses (stubbing the
// agent package only), then run the deterministic pass that would precede
// insertion. Makes one tiny paid call; the default sample costs fractions of
// a cent.
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
  prepareTranscriptForInsert,
  refineTranscriptWithOpenRouter,
} = await import(pathToFileURL(VOICE_EXTENSION).href);

const apiKey = process.env.OPENROUTER_API_KEY;
const sample =
  process.argv[2] ??
  "okay so um we need to we need to refactor the poll vue app module " +
    "let's refactor the module to use the new api";

if (!apiKey) {
  console.error('usage: OPENROUTER_API_KEY=.. node refine-smoke.mjs ["transcript text"]');
  process.exit(2);
}

console.log("RAW:      ", JSON.stringify(sample));
const startedAt = performance.now();
const refined = await refineTranscriptWithOpenRouter(sample, apiKey);
const refineMs = Math.round(performance.now() - startedAt);
console.log("REFINED:  ", JSON.stringify(refined));
console.log(`REFINE MS: ${refineMs}`);
const prepared = prepareTranscriptForInsert(refined);
console.log("INSERTED: ", JSON.stringify(prepared));
