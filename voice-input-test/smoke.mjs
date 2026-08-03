// One-shot smoke test: transcribe a real WAV through the DashScope API using
// the exact code path the extension uses (stubbing the agent package only).
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
  FOQUZ_CORE_PROFILE,
  GLOBAL_ASR_PROFILE,
  mergeAsrProfiles,
  transcribeAudio,
} = await import(pathToFileURL(VOICE_EXTENSION).href);

const audioPath = process.argv[2];
const apiKey = process.env.DASHSCOPE_API_KEY;
const baseUrl = process.env.DASHSCOPE_BASE_URL;
if (!audioPath || !apiKey || !baseUrl) {
  console.error("usage: DASHSCOPE_API_KEY=.. DASHSCOPE_BASE_URL=.. node smoke.mjs <wav>");
  process.exit(2);
}

const withProfile = await transcribeAudio(
  audioPath,
  apiKey,
  baseUrl,
  mergeAsrProfiles(GLOBAL_ASR_PROFILE, FOQUZ_CORE_PROFILE),
);
console.log("WITH global+foquz-core profile:", JSON.stringify(withProfile));

const globalOnly = await transcribeAudio(audioPath, apiKey, baseUrl, GLOBAL_ASR_PROFILE);
console.log("WITH global profile only:      ", JSON.stringify(globalOnly));
